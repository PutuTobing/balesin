import { randomUUID } from 'node:crypto';

import {
  createSecretBox,
  deriveKey,
  randomToken,
  Secret,
  type HostLookup,
  type Logger,
  type Redis,
  type SmtpTimeouts,
} from '@balesin/core';
import type { Database } from '@balesin/db';
import { configureZodLocale } from '@balesin/shared';
import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { ApiConfig } from './config';
import { handleError, handleNotFound } from './http/error-handler';
import { trackRoutesForMethodNotAllowed } from './http/method-not-allowed';
import { createRateLimiter } from './http/rate-limit';
import { enforceRouteDeclarations } from './http/route-access';
import { applyBaselineHeaders, securityPlugin } from './http/security';
import { registerAuthHook } from './modules/auth/auth.hook';
import { authRoutes } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { createCsrfProtection } from './modules/auth/csrf';
import { createPasswordHasher } from './modules/auth/password-hasher';
import { createSessionService } from './modules/auth/session.service';
import { brandingRoutes } from './modules/branding/branding.routes';
import type { MailDns } from './modules/email-settings/email-host-detection';
import { emailSettingsRoutes } from './modules/email-settings/email-settings.routes';
import { createEmailSettingsService } from './modules/email-settings/email-settings.service';
import { HEALTH_PATHS, healthRoutes } from './modules/health/health.routes';
import { createReadinessService, type ReadinessProbes } from './modules/health/health.service';
import { createSetupEmailTestMemo } from './modules/setup/setup-email-test-memo';
import { setupRoutes } from './modules/setup/setup.routes';
import { createSetupService } from './modules/setup/setup.service';
import type { EmailNotifier } from './queues/email-queue';

export type AppConfig = Pick<
  ApiConfig,
  | 'appOrigin'
  | 'isProduction'
  | 'trustProxy'
  | 'cookieSecure'
  | 'sessionSecret'
  | 'setupToken'
  | 'masterKey'
  | 'smtpFallback'
  | 'smtpAllowedPorts'
>;

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  /** Pemeriksaan dependensi untuk `GET /ready`. */
  readinessProbes: ReadinessProbes;
  /** Batas waktu tiap pemeriksaan `/ready` (bawaan 2 detik). */
  readinessTimeoutMs?: number;
  db: Database;
  /** Koneksi Redis ber-peran `client` (batas laju, kunci akun). */
  redis: Redis;
  /** Pengantre email notifikasi (dikirim worker). */
  notifier: EmailNotifier;
  /** Titik ganti untuk tes. Tidak diisi di `index.ts`. */
  overrides?: {
    /** Awalan kunci Redis batas laju, supaya tes tidak saling mengganggu. */
    rateLimitPrefix?: string;
    mailLookup?: HostLookup;
    mailDns?: MailDns;
    smtpTimeouts?: Partial<SmtpTimeouts>;
  };
}

/**
 * Batas ukuran body bawaan (1 MiB) — cukup untuk JSON biasa. Rute yang butuh lebih
 * (webhook Meta, unggah media) menetapkan `bodyLimit` sendiri di rutenya.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;
const QUIET_PATHS = new Set<string>(HEALTH_PATHS);

/**
 * Merakit aplikasi Fastify tanpa mulai mendengarkan port, supaya bisa dites dengan
 * `app.inject()`. Semua dependensi luar masuk lewat `deps`.
 */
export async function buildApp(deps: AppDeps) {
  configureZodLocale();
  const { config, db } = deps;

  // Diketik sebagai logger dasar Fastify supaya tipe plugin dan rute tetap sederhana.
  const loggerInstance: FastifyBaseLogger = deps.logger;

  const app = Fastify({
    loggerInstance,
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      // Healthcheck dipanggil tiap beberapa detik — tidak perlu memenuhi log.
      disableRequestLogging: (request) => QUIET_PATHS.has(request.routeOptions.url ?? ''),
    }),
    // ID dibuat server; header dari klien tidak dipercaya (mencegah pemalsuan jejak log).
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    frameworkErrors: (error, request, reply) => {
      // Error di tingkat ini (URL rusak, parameter terlalu panjang) dijawab sebelum hook mana
      // pun berjalan, jadi header keamanan dasarnya dipasang di sini.
      applyBaselineHeaders(reply, request.id);
      void handleError(error, request, reply);
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Zod memvalidasi request DAN menyaring respons (kolom di luar skema tidak ikut terkirim).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);

  // API hanya menerima body JSON. Parser teks bawaan Fastify dibuang: `text/plain` adalah
  // satu-satunya tipe body yang bisa dikirim lintas situs tanpa preflight CORS.
  app.removeContentTypeParser('text/plain');

  const registerMethodNotAllowedRoutes = trackRoutesForMethodNotAllowed(app);

  await app.register(securityPlugin, {
    appOrigin: config.appOrigin,
    isProduction: config.isProduction,
  });

  // ── Layanan ───────────────────────────────────────────────────────────────
  if (config.isProduction && !config.sessionSecret) {
    throw new Error('SESSION_SECRET wajib diisi di production');
  }
  // Tanpa SESSION_SECRET (hanya mungkin di development/test) dipakai kunci acak sementara:
  // token CSRF tidak berlaku lagi setelah API dijalankan ulang. Peringatannya ditulis index.ts.
  const sessionSecret = config.sessionSecret ?? new Secret(randomToken(48));

  const csrf = createCsrfProtection(sessionSecret);
  const sessions = createSessionService(db, csrf);
  const hasher = createPasswordHasher();
  const redisPrefix = deps.overrides?.rateLimitPrefix ?? 'balesin';
  const limiter = createRateLimiter(deps.redis, { prefix: redisPrefix });
  const emailSettings = createEmailSettingsService({
    db,
    secretBox: config.masterKey ? createSecretBox(config.masterKey) : null,
    fallback: config.smtpFallback,
    allowedPorts: config.smtpAllowedPorts,
    lookup: deps.overrides?.mailLookup,
    dns: deps.overrides?.mailDns,
    timeouts: deps.overrides?.smtpTimeouts,
  });
  const auth = createAuthService({ db, sessions, hasher, limiter, notifier: deps.notifier });
  const setup = createSetupService({
    db,
    setupToken: config.setupToken,
    limiter,
    hasher,
    sessions,
    emailSettings,
    emailTestMemo: createSetupEmailTestMemo({
      redis: deps.redis,
      keyPrefix: redisPrefix,
      fingerprintKey: deriveKey(sessionSecret.reveal(), 'balesin/setup-email-test/v1'),
    }),
  });

  // Hash pembanding untuk email tidak terdaftar dibuat SEBELUM permintaan pertama dilayani;
  // kalau dibuat saat login pertama, login itu lebih lambat dan membuka bahwa emailnya tidak ada.
  app.addHook('onReady', () => hasher.warmUp());

  // ── Penjaga rute: bawaan tolak ────────────────────────────────────────────
  // Urutan penting: setelah plugin keamanan (header + CORS berlaku juga untuk respons yang
  // ditolak), sebelum rute pertama.
  app.decorate('routeDeclarations', enforceRouteDeclarations(app));
  registerAuthHook(app, {
    appOrigin: config.appOrigin,
    cookieSecure: config.cookieSecure,
    sessions,
    csrf,
  });

  // ── Rute ──────────────────────────────────────────────────────────────────
  await app.register(healthRoutes, {
    readiness: createReadinessService({
      probes: deps.readinessProbes,
      logger: app.log,
      timeoutMs: deps.readinessTimeoutMs,
    }),
  });
  await app.register(setupRoutes, {
    setup,
    emailSettings,
    limiter,
    cookieSecure: config.cookieSecure,
  });
  await app.register(authRoutes, { auth, cookieSecure: config.cookieSecure });
  await app.register(brandingRoutes, { db });
  await app.register(emailSettingsRoutes, { emailSettings, limiter });

  // Harus setelah SEMUA rute modul didaftarkan (lihat http/method-not-allowed.ts).
  registerMethodNotAllowedRoutes();

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
