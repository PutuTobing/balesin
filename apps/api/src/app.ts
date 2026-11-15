import { randomUUID } from 'node:crypto';

import {
  createMetaGraphClient,
  createSecretBox,
  deriveKey,
  plaintextLoginPolicy,
  randomToken,
  Secret,
  type HostLookup,
  type Logger,
  type MetaGraphClientOptions,
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
import { createForwardedForGuard } from './http/forwarded-for-guard';
import { trackRoutesForMethodNotAllowed } from './http/method-not-allowed';
import { createRateLimiter } from './http/rate-limit';
import { enforceRouteDeclarations } from './http/route-access';
import { applyBaselineHeaders, securityPlugin } from './http/security';
import { createAccessDeniedRecorder } from './modules/auth/access-denied';
import { registerAuthHook } from './modules/auth/auth.hook';
import { authRoutes } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { createCsrfProtection } from './modules/auth/csrf';
import { createPasswordHasher } from './modules/auth/password-hasher';
import { createSessionService } from './modules/auth/session.service';
import { createTrustedDevices } from './modules/auth/trusted-device';
import { twoFactorRoutes } from './modules/two-factor/two-factor.routes';
import { createTwoFactorService } from './modules/two-factor/two-factor.service';
import { brandingRoutes } from './modules/branding/branding.routes';
import type { MailDns } from './modules/email-settings/email-host-detection';
import { emailSettingsRoutes } from './modules/email-settings/email-settings.routes';
import { createEmailSettingsService } from './modules/email-settings/email-settings.service';
import { HEALTH_PATHS, healthRoutes } from './modules/health/health.routes';
import { createReadinessService, type ReadinessProbes } from './modules/health/health.service';
import { createSetupEmailTestMemo } from './modules/setup/setup-email-test-memo';
import { createBackgroundTasks, type BackgroundTasks } from './http/background-tasks';
import { createTokenDelivery } from './modules/account-tokens/token-delivery';
import { createEmailTemplatePreview } from './modules/email-settings/email-template-preview';
import { emailVerificationRoutes } from './modules/email-verification/email-verification.routes';
import { createEmailVerificationService } from './modules/email-verification/email-verification.service';
import { invitationRoutes } from './modules/invitations/invitations.routes';
import { createInvitationService } from './modules/invitations/invitations.service';
import { passwordResetRoutes } from './modules/password-reset/password-reset.routes';
import { createPasswordResetService } from './modules/password-reset/password-reset.service';
import { auditRoutes } from './modules/audit/audit.routes';
import { channelsRoutes } from './modules/channels/channels.routes';
import { createChannelsService } from './modules/channels/channels.service';
import { createAuditService } from './modules/audit/audit.service';
import { sessionsRoutes } from './modules/sessions/sessions.routes';
import { createOwnSessionsService } from './modules/sessions/sessions.service';
import { setupRoutes } from './modules/setup/setup.routes';
import { createLockInspector } from './modules/team/lock-state';
import { teamRoutes } from './modules/team/team.routes';
import { createTeamService } from './modules/team/team.service';
import { createSetupService } from './modules/setup/setup.service';
import { createWebhookGuard } from './modules/webhooks/webhook-guard';
import { whatsAppWebhookRoutes } from './modules/webhooks/whatsapp-webhook.routes';
import { createWhatsAppWebhookService } from './modules/webhooks/whatsapp-webhook.service';
import type { EmailNotifier } from './queues/email-queue';
import type { WebhookEventEnqueuer } from './queues/webhook-queue';

export type AppConfig = Pick<
  ApiConfig,
  | 'appUrl'
  | 'appOrigin'
  | 'isProduction'
  | 'trustProxy'
  | 'cookieSecure'
  | 'sessionSecret'
  | 'setupToken'
  | 'masterKey'
  | 'smtpFallback'
  | 'smtpAllowedPorts'
  | 'apiUrl'
  | 'metaGraphVersion'
  | 'metaGraphBaseUrl'
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
  /** Pengantre kejadian webhook masuk (diproses worker). */
  webhookQueue: WebhookEventEnqueuer;
  /** Titik ganti untuk tes. Tidak diisi di `index.ts`. */
  overrides?: {
    /** Awalan kunci Redis batas laju, supaya tes tidak saling mengganggu. */
    rateLimitPrefix?: string;
    mailLookup?: HostLookup;
    mailDns?: MailDns;
    smtpTimeouts?: Partial<SmtpTimeouts>;
    /** Klien Graph API (mis. `sleep` instan supaya backoff tidak memperlambat tes). */
    meta?: Partial<Omit<MetaGraphClientOptions, 'version' | 'baseUrl' | 'environment'>>;
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

  // Production tanpa TRUST_PROXY di belakang proxy → log error sekali (review webhook S3).
  const forwardedForGuard = createForwardedForGuard({
    isProduction: config.isProduction,
    trustProxy: config.trustProxy,
    logger: app.log,
  });
  if (forwardedForGuard) {
    app.addHook('onRequest', (request, _reply, done) => {
      forwardedForGuard(request);
      done();
    });
  }

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
  const devices = createTrustedDevices(sessionSecret);
  const hasher = createPasswordHasher();
  const redisPrefix = deps.overrides?.rateLimitPrefix ?? 'balesin';
  const limiter = createRateLimiter(deps.redis, { prefix: redisPrefix });
  const secretBox = config.masterKey ? createSecretBox(config.masterKey) : null;
  const twoFactor = createTwoFactorService({
    db,
    secretBox,
    hasher,
    limiter,
    notifier: deps.notifier,
    sessions,
    devices,
  });
  const emailSettings = createEmailSettingsService({
    db,
    secretBox,
    fallback: config.smtpFallback,
    allowedPorts: config.smtpAllowedPorts,
    plaintextLogin: plaintextLoginPolicy(config.isProduction),
    lookup: deps.overrides?.mailLookup,
    dns: deps.overrides?.mailDns,
    timeouts: deps.overrides?.smtpTimeouts,
    notifier: deps.notifier,
    twoFactor,
  });
  const auth = createAuthService({
    db,
    sessions,
    hasher,
    limiter,
    notifier: deps.notifier,
    devices,
    twoFactor,
  });
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

  const accessDenied = createAccessDeniedRecorder({ db, limiter, logger: app.log });
  const delivery = createTokenDelivery({ secretBox, fallback: config.smtpFallback });
  const background = createBackgroundTasks();
  const invitations = createInvitationService({
    db,
    appUrl: config.appUrl,
    hasher,
    limiter,
    notifier: deps.notifier,
    sessions,
    devices,
    delivery,
    accessDenied,
    twoFactor,
  });
  const passwordReset = createPasswordResetService({
    db,
    hasher,
    limiter,
    notifier: deps.notifier,
    sessions,
    twoFactor,
    delivery,
    background,
  });
  const emailVerification = createEmailVerificationService({
    db,
    limiter,
    notifier: deps.notifier,
    delivery,
  });
  const templatePreview = createEmailTemplatePreview({ db, appUrl: config.appUrl });
  const ownSessions = createOwnSessionsService({ db, sessions, twoFactor });
  const team = createTeamService({
    db,
    sessions,
    twoFactor,
    notifier: deps.notifier,
    accessDenied,
    locks: createLockInspector({ db, limiter, logger: app.log }),
  });
  const audit = createAuditService({ db, limiter });

  // Server Meta tiruan hanya untuk development/test: config menolaknya di luar itu, dan klien
  // sendiri (lapis kedua, juga melindungi worker) hanya menerima host loopback bila NODE_ENV
  // development/test — selain itu melempar saat dibuat (aplikasi gagal start).
  const meta = createMetaGraphClient({
    version: config.metaGraphVersion,
    baseUrl: config.metaGraphBaseUrl,
    logger: app.log,
    ...deps.overrides?.meta,
  });
  const channels = createChannelsService({
    db,
    secretBox,
    meta,
    twoFactor,
    notifier: deps.notifier,
    apiUrl: config.apiUrl,
  });

  const webhookGuard = createWebhookGuard({ db, limiter });
  const whatsAppWebhooks = createWhatsAppWebhookService({
    db,
    secretBox,
    guard: webhookGuard,
    queue: deps.webhookQueue,
  });

  // Pekerjaan latar belakang (mis. minta atur ulang password) ditunggu selesai saat ditutup.
  app.decorate('backgroundTasks', background);
  app.addHook('onClose', () => background.drain());

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
    accessDenied,
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
  await app.register(twoFactorRoutes, { twoFactor, cookieSecure: config.cookieSecure });
  await app.register(brandingRoutes, { db });
  await app.register(emailSettingsRoutes, {
    emailSettings,
    templatePreview,
    limiter,
    cookieSecure: config.cookieSecure,
  });
  await app.register(invitationRoutes, { invitations, cookieSecure: config.cookieSecure });
  await app.register(passwordResetRoutes, { passwordReset, cookieSecure: config.cookieSecure });
  await app.register(emailVerificationRoutes, { emailVerification });
  await app.register(sessionsRoutes, {
    sessionsService: ownSessions,
    cookieSecure: config.cookieSecure,
  });
  await app.register(teamRoutes, { team, cookieSecure: config.cookieSecure });
  await app.register(auditRoutes, { audit });
  await app.register(channelsRoutes, { channels, limiter, cookieSecure: config.cookieSecure });
  // Publik: penerima webhook Meta (keaslian dari tanda tangan App Secret, bukan sesi).
  await app.register(whatsAppWebhookRoutes, { guard: webhookGuard, webhooks: whatsAppWebhooks });

  // Harus setelah SEMUA rute modul didaftarkan (lihat http/method-not-allowed.ts).
  registerMethodNotAllowedRoutes();

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Pekerjaan setelah jawaban terkirim (lihat `http/background-tasks.ts`). */
    backgroundTasks: BackgroundTasks;
  }
}
