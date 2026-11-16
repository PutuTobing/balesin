import { randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';
import {
  createInboxEventPublisher,
  createMetaGraphClient,
  createSessionRevocationPublisher,
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
import { userSessions, type Database } from '@balesin/db';
import { and, eq } from 'drizzle-orm';
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
import { createCsrfRejectionRecorder } from './modules/auth/csrf-rejection';
import { createApiKeyAuthenticator } from './modules/api-keys/api-key-auth';
import { apiKeysRoutes } from './modules/api-keys/api-keys.routes';
import { createApiKeysService } from './modules/api-keys/api-keys.service';
import { outgoingWebhooksRoutes } from './modules/outgoing-webhooks/outgoing-webhooks.routes';
import { createOutgoingWebhooksService } from './modules/outgoing-webhooks/outgoing-webhooks.service';
import { apiDocsRoutes } from './modules/public-api/api-docs.routes';
import { publicApiRoutes } from './modules/public-api/public-api.routes';
import { apiKeyPepper as deriveApiKeyPepper } from './modules/api-keys/api-key-token';
import { registerAuthHook } from './modules/auth/auth.hook';
import { authRoutes } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { createCsrfProtection } from './modules/auth/csrf';
import { createPasswordHasher } from './modules/auth/password-hasher';
import { createSessionService, type SessionService } from './modules/auth/session.service';
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
import { assignmentRoutes } from './modules/inbox/assignment.routes';
import { createAssignmentService } from './modules/inbox/assignment.service';
import { createPanelService } from './modules/inbox/panel.service';
import { createNotificationsService } from './modules/notifications/notifications.service';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { panelRoutes } from './modules/inbox/panel.routes';
import { createContactsService } from './modules/contacts/contacts.service';
import { contactsRoutes } from './modules/contacts/contacts.routes';
import { createTagsService } from './modules/tags/tags.service';
import { tagsRoutes } from './modules/tags/tags.routes';
import { createQuickRepliesService } from './modules/quick-replies/quick-replies.service';
import { quickRepliesRoutes } from './modules/quick-replies/quick-replies.routes';
import { inboxRoutes } from './modules/inbox/inbox.routes';
import { createMediaStore } from './modules/messages/media-store';
import { sendingLimitsRoutes } from './modules/sending-limits/sending-limits.routes';
import { createSendingLimitsService } from './modules/sending-limits/sending-limits.service';
import { outboundRoutes } from './modules/messages/outbound.routes';
import { createOutboundService, type OutboundService } from './modules/messages/outbound.service';
import { createInboxStreamHub, type InboxStreamHub } from './modules/realtime/inbox-stream';
import { inboxStreamRoutes } from './modules/realtime/inbox-stream.routes';
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
import type { OutboundMessageEnqueuer } from './queues/message-queue';
import type { NotificationEnqueuer } from './queues/notification-queue';
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
  | 'mediaDir'
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
  /** Pengantre pesan keluar (dikirim worker ke Meta). */
  messageQueue: OutboundMessageEnqueuer;
  /** Pengantre notifikasi Web Push (dikirim worker). */
  notificationQueue: NotificationEnqueuer;
  /** Titik ganti untuk tes. Tidak diisi di `index.ts`. */
  overrides?: {
    /** Awalan kunci Redis batas laju, supaya tes tidak saling mengganggu. */
    rateLimitPrefix?: string;
    mailLookup?: HostLookup;
    mailDns?: MailDns;
    smtpTimeouts?: Partial<SmtpTimeouts>;
    /** Klien Graph API (mis. `sleep` instan supaya backoff tidak memperlambat tes). */
    meta?: Partial<Omit<MetaGraphClientOptions, 'version' | 'baseUrl' | 'environment'>>;
    /** HANYA tes: webhook keluar boleh ke 127.0.0.1 (server penerima tiruan). */
    webhookAllowLoopback?: boolean;
    /** Origin server push TIRUAN yang boleh didaftarkan (tes saja; produksi: layanan push dikenal). */
    pushEndpointOrigins?: readonly string[];
    /** Selang heartbeat/validasi ulang WebSocket inbox dan batas koneksi per pengguna. */
    inboxStream?: {
      heartbeatMs?: number;
      revalidateMs?: number;
      maxConnectionsPerUser?: number;
      sessionRecheckDelaysMs?: readonly number[];
    };
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
  // WebSocket (inbox real-time). Pesan dari klien tidak dipakai: dibatasi 1 KiB.
  await app.register(websocket, { options: { maxPayload: 1024 } });

  // ── Layanan ───────────────────────────────────────────────────────────────
  if (config.isProduction && !config.sessionSecret) {
    throw new Error('SESSION_SECRET wajib diisi di production');
  }
  // Tanpa SESSION_SECRET (hanya mungkin di development/test) dipakai kunci acak sementara:
  // token CSRF tidak berlaku lagi setelah API dijalankan ulang. Peringatannya ditulis index.ts.
  const sessionSecret = config.sessionSecret ?? new Secret(randomToken(48));

  const csrf = createCsrfProtection(sessionSecret);
  const baseSessions = createSessionService(db, csrf);
  const devices = createTrustedDevices(sessionSecret);
  const hasher = createPasswordHasher();
  const redisPrefix = deps.overrides?.rateLimitPrefix ?? 'balesin';
  // Pencabutan sesi → sinyal `session.revoked` lewat Redis supaya socket inbox pengguna itu ditutup
  // seketika (validasi ulang berkala 30 detik tetap menjadi jaring pengaman).
  const sessionRevocations = createSessionRevocationPublisher(deps.redis, {
    prefix: redisPrefix,
    logger: deps.logger,
  });
  const sessions: SessionService = {
    ...baseSessions,
    async revoke(executor, organizationId, sessionRef) {
      // Pemilik sesi disertakan supaya hub hanya memeriksa socket pengguna itu (review real-time
      // putaran 2 Info 1), bukan seluruh organisasi.
      const [owner] = await executor
        .select({ userId: userSessions.userId })
        .from(userSessions)
        .where(
          and(eq(userSessions.organizationId, organizationId), eq(userSessions.id, sessionRef)),
        )
        .limit(1);
      const revoked = await baseSessions.revoke(executor, organizationId, sessionRef);
      if (revoked) void sessionRevocations.publish({ organizationId, userId: owner?.userId });
      return revoked;
    },
    async revokeAllForUser(executor, organizationId, userId, exceptSessionRef) {
      const count = await baseSessions.revokeAllForUser(
        executor,
        organizationId,
        userId,
        exceptSessionRef,
      );
      if (count > 0) void sessionRevocations.publish({ organizationId, userId });
      return count;
    },
  };
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
  const csrfRejections = createCsrfRejectionRecorder({ db, limiter, logger: app.log });
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

  // Real-time inbox: penerbit (api → Redis) + hub WebSocket (Redis → socket yang berhak).
  const inboxEvents = createInboxEventPublisher(deps.redis, {
    prefix: redisPrefix,
    logger: app.log,
  });
  const inboxStream = createInboxStreamHub({
    db,
    sessions,
    redis: deps.redis,
    prefix: redisPrefix,
    logger: deps.logger,
    ...deps.overrides?.inboxStream,
  });
  app.decorate('inboxStream', inboxStream);
  app.addHook('onClose', () => inboxStream.close());

  // Rem pengiriman: batas harian/per percakapan + rem darurat (SECURITY §5).
  const sendingLimits = createSendingLimitsService({
    db,
    publisher: inboxEvents,
    limiter,
    notifier: deps.notifier,
    twoFactor,
    logger: deps.logger,
  });
  // Ruang chat: kirim pesan (antrean worker), unggah/unduh media (disk `MEDIA_DIR`).
  const outbound = createOutboundService({
    sendingLimits,
    db,
    store: createMediaStore(config.mediaDir),
    meta,
    secretBox,
    queue: deps.messageQueue,
    publisher: inboxEvents,
    logger: deps.logger,
  });
  // Pembersih salinan media kedaluwarsa (retensi organisasi), tiap jam. Idempoten bila api
  // berjalan lebih dari satu proses.
  const mediaJanitor = setInterval(
    () => {
      outbound.purgeExpiredMedia().catch((err: unknown) => {
        deps.logger.warn({ err }, 'Pembersih media gagal');
      });
    },
    60 * 60 * 1000,
  );
  mediaJanitor.unref();
  app.addHook('onClose', (_instance, done) => {
    clearInterval(mediaJanitor);
    done();
  });
  app.decorate('outbound', outbound);

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
  const apiKeyPepper = config.masterKey ? deriveApiKeyPepper(config.masterKey) : null;
  registerAuthHook(app, {
    appOrigin: config.appOrigin,
    cookieSecure: config.cookieSecure,
    sessions,
    csrf,
    accessDenied,
    csrfRejections,
    apiKeys: createApiKeyAuthenticator({
      db,
      limiter,
      pepper: apiKeyPepper,
      logger: deps.logger,
    }),
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
  await app.register(channelsRoutes, {
    db,
    channels,
    limiter,
    cookieSecure: config.cookieSecure,
  });
  await app.register(inboxRoutes, { db, limiter, publisher: inboxEvents });
  await app.register(inboxStreamRoutes, { hub: inboxStream, appOrigin: config.appOrigin });
  await app.register(outboundRoutes, { outbound, limiter });
  await app.register(sendingLimitsRoutes, { sendingLimits, cookieSecure: config.cookieSecure });
  await app.register(assignmentRoutes, {
    db,
    limiter,
    assignment: createAssignmentService({
      db,
      publisher: inboxEvents,
      accessDenied,
      limiter,
      notifications: deps.notificationQueue,
      logger: deps.logger,
    }),
  });
  const contactsService = createContactsService({
    db,
    publisher: inboxEvents,
    twoFactor,
    purgeMedia: (ids) => outbound.purgeMediaFiles(ids),
    logger: deps.logger,
  });
  // Webhook keluar (Fase 3).
  await app.register(outgoingWebhooksRoutes, {
    limiter,
    cookieSecure: config.cookieSecure,
    webhooks: createOutgoingWebhooksService({
      db,
      secretBox,
      twoFactor,
      ...(deps.overrides?.webhookAllowLoopback ? { allowLoopback: true } : {}),
    }),
  });
  // API publik v1 + API key + dokumentasi (Fase 3).
  await app.register(apiKeysRoutes, {
    limiter,
    cookieSecure: config.cookieSecure,
    apiKeys: createApiKeysService({ db, pepper: apiKeyPepper, twoFactor }),
  });
  await app.register(publicApiRoutes, { db, limiter, outbound, contacts: contactsService });
  await app.register(apiDocsRoutes, { db, apiUrl: config.apiUrl });
  // Notifikasi Web Push (Fase 2 butir 10).
  await app.register(notificationsRoutes, {
    limiter,
    notifications: createNotificationsService({
      db,
      secretBox,
      notifications: deps.notificationQueue,
      extraOrigins: deps.overrides?.pushEndpointOrigins ?? [],
    }),
  });
  // Panel detail & quick reply (Fase 2 butir 8–9).
  await app.register(contactsRoutes, {
    db,
    limiter,
    cookieSecure: config.cookieSecure,
    contacts: contactsService,
  });
  await app.register(tagsRoutes, {
    limiter,
    tags: createTagsService({ db, publisher: inboxEvents }),
  });
  await app.register(panelRoutes, {
    db,
    limiter,
    panel: createPanelService({ db, publisher: inboxEvents, accessDenied }),
  });
  await app.register(quickRepliesRoutes, {
    limiter,
    quickReplies: createQuickRepliesService({ db }),
  });
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
    /** Hub WebSocket inbox (lihat `modules/realtime/inbox-stream.ts`). */
    inboxStream: InboxStreamHub;
    /** Layanan ruang chat (kirim, media) — untuk tes pembersih media. */
    outbound: OutboundService;
  }
}
