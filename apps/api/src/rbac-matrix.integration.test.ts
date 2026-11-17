/**
 * Tes otorisasi per endpoint (SECURITY.md §2): SEMUA rute terdaftar × 5 peran + tanpa sesi + sesi
 * terbatas "wajib mendaftar 2FA", dibandingkan dengan matriks izin di `@balesin/shared`.
 *
 * Dua lapis:
 *  1. Statis — `ROUTES` di bawah adalah daftar TERTULIS setiap rute modul beserta aksesnya. Rute
 *     baru tanpa entri, entri tanpa rute, atau akses yang berbeda membuat tes gagal. Menambah rute
 *     = menambah satu baris di sini (dan diff-nya dibaca `security`).
 *  2. Dinamis — setiap rute (termasuk HEAD otomatis dan rute pelengkap 405) dipanggil sebagai
 *     setiap pemanggil dengan cookie + CSRF + Origin sah. Hasilnya harus cocok dengan matriks:
 *     ditolak lapisan auth (401 / 403 izin / 403 wajib-2FA) atau lolos ke handler.
 *
 * Body permintaan pengubah data sengaja berupa array JSON (`[]`) supaya permintaan yang LOLOS
 * berhenti di validasi (400) tanpa efek samping; `POST /auth/logout` dipanggil paling akhir.
 */
import { auditLogs, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  ERROR_MESSAGES,
  errorEnvelopeSchema,
  hasPermission,
  USER_ROLES,
  type ApiKeyScope,
  type Permission,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RouteAccess, RouteDeclaration } from './http/route-access';
import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  sessionCookieOf,
  startLogin,
  type IntegrationHarness,
} from './testing/integration';

/** `public` tanpa sesi · `session` cukup sesi penuh · `enrollment` sesi penuh atau sesi terbatas 2FA. */
/** `apikey:<scope>` = API publik (Bearer API key, tanpa sesi); `apikey:*` = key sah apa pun (405). */
/** `mobichat:<scope>` = lapisan kompatibel MobiChat (header `X-API-Key`, tanpa sesi). */
type ApiKeyExpectation =
  `apikey:${ApiKeyScope}` | 'apikey:*' | `mobichat:${ApiKeyScope}` | 'mobichat:*';
type Expectation = 'public' | 'session' | 'enrollment' | Permission | ApiKeyExpectation;
const isApiKeyExpectation = (value: Expectation): value is ApiKeyExpectation =>
  value.startsWith('apikey:') || value.startsWith('mobichat:');

/**
 * SEMUA rute modul (tanpa HEAD otomatis dan pelengkap 405 — keduanya diturunkan dari sini).
 * Urut per modul seperti `buildApp`.
 */
const ROUTES: Readonly<Record<string, Expectation>> = {
  // health
  'GET /health': 'public',
  'GET /ready': 'public',
  // setup (publik; dikunci token setup + 409 setelah selesai)
  'GET /api/v1/setup/status': 'public',
  'POST /api/v1/setup/verify-token': 'public',
  'POST /api/v1/setup/check-password': 'public',
  'POST /api/v1/setup/email/detect-host': 'public',
  'POST /api/v1/setup/email/test-connection': 'public',
  'POST /api/v1/setup/email/send-test': 'public',
  'POST /api/v1/setup/complete': 'public',
  // auth
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/2fa/verify': 'public',
  'POST /api/v1/auth/logout': 'enrollment',
  'GET /api/v1/auth/me': 'enrollment',
  // 2FA milik sendiri
  'GET /api/v1/auth/2fa': 'enrollment',
  'POST /api/v1/auth/2fa/enroll': 'enrollment',
  'POST /api/v1/auth/2fa/enroll/confirm': 'enrollment',
  'POST /api/v1/auth/2fa/backup-codes': 'session',
  'POST /api/v1/auth/2fa/disable': 'session',
  // branding halaman masuk
  'GET /api/v1/branding': 'public',
  'GET /api/v1/branding/logo': 'public',
  // Pengaturan → Email pengirim
  'GET /api/v1/settings/email': 'settings.email.manage',
  'PUT /api/v1/settings/email': 'settings.email.manage',
  'POST /api/v1/settings/email/detect-host': 'settings.email.manage',
  'POST /api/v1/settings/email/test-connection': 'settings.email.manage',
  'POST /api/v1/settings/email/send-test': 'settings.email.manage',
  'GET /api/v1/settings/email/templates/:template/preview': 'settings.email.manage',
  // undangan
  'GET /api/v1/invitations': 'team.invite',
  'POST /api/v1/invitations': 'team.invite',
  'POST /api/v1/invitations/:invitationId/resend': 'team.invite',
  'DELETE /api/v1/invitations/:invitationId': 'team.invite',
  'POST /api/v1/auth/invitation/inspect': 'public',
  'POST /api/v1/auth/invitation/accept': 'public',
  // atur ulang password (publik)
  'GET /api/v1/auth/password-reset': 'public',
  'POST /api/v1/auth/password-reset/request': 'public',
  'POST /api/v1/auth/password-reset/inspect': 'public',
  'POST /api/v1/auth/password-reset/complete': 'public',
  // verifikasi email milik sendiri
  'GET /api/v1/auth/email/verification': 'session',
  'POST /api/v1/auth/email/verification': 'session',
  'POST /api/v1/auth/email/verify': 'public',
  // sesi aktif milik sendiri
  'GET /api/v1/auth/sessions': 'session',
  'DELETE /api/v1/auth/sessions/:sessionId': 'session',
  'POST /api/v1/auth/sessions/revoke-others': 'session',
  // manajemen pengguna (aturan per peran sasaran: `MANAGE_PERMISSIONS`, diuji team.integration)
  'GET /api/v1/users': 'team.manage',
  'GET /api/v1/users/:userId': 'team.manage',
  'PUT /api/v1/users/:userId/role': 'team.manage',
  'POST /api/v1/users/:userId/disable': 'team.manage',
  'POST /api/v1/users/:userId/enable': 'team.manage',
  'POST /api/v1/users/:userId/2fa/reset': 'team.manage',
  'POST /api/v1/users/:userId/2fa/enrollment-window': 'team.manage',
  'POST /api/v1/users/:userId/unlock': 'team.manage',
  'GET /api/v1/users/:userId/sessions': 'team.manage',
  'DELETE /api/v1/users/:userId/sessions/:sessionId': 'team.manage',
  'POST /api/v1/users/:userId/sessions/revoke-all': 'team.manage',
  // audit log
  'GET /api/v1/audit-logs': 'audit.view',
  'GET /api/v1/audit-logs/export': 'audit.view',
  'GET /api/v1/audit-logs/security-summary': 'audit.view',
  // channel: nama untuk inbox = semua peran yang melihat inbox; pengaturan + rahasia = Owner/Admin
  'GET /api/v1/channels': 'inbox.view',
  'GET /api/v1/settings/channels': 'channels.manage',
  'POST /api/v1/settings/channels': 'channels.manage',
  'GET /api/v1/settings/channels/:channelId': 'channels.manage',
  'PATCH /api/v1/settings/channels/:channelId': 'channels.manage',
  'DELETE /api/v1/settings/channels/:channelId': 'channels.manage',
  'POST /api/v1/settings/channels/:channelId/disable': 'channels.manage',
  'POST /api/v1/settings/channels/:channelId/enable': 'channels.manage',
  'POST /api/v1/settings/channels/:channelId/test': 'channels.manage',
  'GET /api/v1/settings/channels/:channelId/webhook': 'channels.manage',
  'GET /api/v1/settings/channels/:channelId/webhook-health': 'channels.manage',
  'POST /api/v1/settings/channels/:channelId/webhook/verify-token': 'channels.manage',
  'GET /api/v1/settings/channels/:channelId/business-profile': 'channels.manage',
  'PUT /api/v1/settings/channels/:channelId/business-profile': 'channels.manage',
  // bot eksternal per channel (saklar, jam kerja bot, batas waktu)
  'GET /api/v1/settings/channels/:channelId/bot': 'integrations.manage',
  'PUT /api/v1/settings/channels/:channelId/bot': 'integrations.manage',
  // rem pengiriman (SECURITY §5): atur & tarik rem = sending.limits.manage; lanjutkan = sending.resume
  'GET /api/v1/settings/sending-limits': 'sending.limits.manage',
  'PUT /api/v1/settings/sending-limits': 'sending.limits.manage',
  'POST /api/v1/settings/sending-limits/pause': 'sending.limits.manage',
  'POST /api/v1/settings/sending-limits/resume': 'sending.resume',
  // inbox (baca): percakapan = inbox.view, kontak = contacts.view (Teknisi: hanya yang di-assign)
  'GET /api/v1/conversations': 'inbox.view',
  'GET /api/v1/conversations/counts': 'inbox.view',
  'POST /api/v1/conversations/:conversationId/read': 'inbox.view',
  // penanganan: ambil/tugaskan = inbox.assign; kembalikan/selesai/buka lagi = inbox.reply (cakupan)
  'POST /api/v1/conversations/:conversationId/claim': 'inbox.assign',
  'POST /api/v1/conversations/:conversationId/assign': 'inbox.assign',
  'POST /api/v1/conversations/:conversationId/unassign': 'inbox.reply',
  'POST /api/v1/conversations/:conversationId/resolve': 'inbox.reply',
  'POST /api/v1/conversations/:conversationId/reopen': 'inbox.reply',
  'POST /api/v1/conversations/:conversationId/bot': 'inbox.reply',
  'POST /api/v1/conversations/start': 'inbox.initiate',
  // template Meta (Fase 4): lihat = inbox.reply (agen memilih template); kelola = templates.manage
  'GET /api/v1/templates': 'inbox.reply',
  'POST /api/v1/templates': 'templates.manage',
  'GET /api/v1/templates/presets': 'templates.manage',
  'POST /api/v1/templates/presets/:presetId': 'templates.manage',
  'POST /api/v1/templates/sync': 'templates.manage',
  'GET /api/v1/templates/:templateId': 'inbox.reply',
  'PATCH /api/v1/templates/:templateId': 'templates.manage',
  'DELETE /api/v1/templates/:templateId': 'templates.manage',
  'POST /api/v1/templates/:templateId/submit': 'templates.manage',
  'GET /api/v1/conversations/:conversationId/events': 'inbox.view',
  'GET /api/v1/inbox/agents': 'inbox.assign',
  // WebSocket inbox: sesi + inbox.view (Origin & batas koneksi dicek sebelum upgrade)
  'GET /api/v1/inbox/stream': 'inbox.view',
  'GET /api/v1/conversations/:conversationId': 'inbox.view',
  'GET /api/v1/conversations/:conversationId/messages': 'inbox.view',
  // ruang chat: balas = inbox.reply (Teknisi: yang di-assign); unduh media = inbox.view
  'POST /api/v1/conversations/:conversationId/messages': 'inbox.reply',
  'POST /api/v1/conversations/:conversationId/media': 'inbox.reply',
  'POST /api/v1/messages/:messageId/retry': 'inbox.reply',
  'GET /api/v1/messages/:messageId/media': 'inbox.view',
  'GET /api/v1/contacts/:contactId': 'contacts.view',
  // UU PDP: hapus kontak = contacts.delete (Owner/Admin, + konfirmasi identitas); ekspor = contacts.export
  'DELETE /api/v1/contacts/:contactId': 'contacts.delete',
  'GET /api/v1/contacts/:contactId/export': 'contacts.export',
  // panel detail (butir 8): ubah kontak & tag kontak = contacts.manage; master tag lihat = inbox.view,
  // buat = contacts.manage, ubah/hapus = settings.workspace.manage; catatan & tanda pesan = inbox.reply
  'PATCH /api/v1/contacts/:contactId': 'contacts.manage',
  'POST /api/v1/contacts/:contactId/tags': 'contacts.manage',
  'DELETE /api/v1/contacts/:contactId/tags/:tagId': 'contacts.manage',
  'GET /api/v1/tags': 'inbox.view',
  'POST /api/v1/tags': 'contacts.manage',
  'PATCH /api/v1/tags/:tagId': 'settings.workspace.manage',
  'DELETE /api/v1/tags/:tagId': 'settings.workspace.manage',
  'GET /api/v1/conversations/:conversationId/notes': 'inbox.view',
  'POST /api/v1/conversations/:conversationId/notes': 'inbox.reply',
  'PATCH /api/v1/conversations/:conversationId/notes/:noteId': 'inbox.reply',
  'DELETE /api/v1/conversations/:conversationId/notes/:noteId': 'inbox.reply',
  'PUT /api/v1/messages/:messageId/star': 'inbox.reply',
  'DELETE /api/v1/messages/:messageId/star': 'inbox.reply',
  // notifikasi push (butir 10): perangkat & preferensi sendiri = inbox.view; cuplikan = organization.manage
  'GET /api/v1/notifications/vapid-public-key': 'inbox.view',
  'POST /api/v1/notifications/subscriptions': 'inbox.view',
  'DELETE /api/v1/notifications/subscriptions': 'inbox.view',
  'GET /api/v1/notifications/preferences': 'inbox.view',
  'PUT /api/v1/notifications/preferences': 'inbox.view',
  'POST /api/v1/notifications/test': 'inbox.view',
  'GET /api/v1/settings/notifications': 'organization.manage',
  'PUT /api/v1/settings/notifications': 'organization.manage',
  // status rem darurat untuk banner semua agen (tanpa rincian)
  'GET /api/v1/inbox/sending-status': 'inbox.view',
  // quick reply (butir 9): pakai = inbox.reply; kelola = quick_replies.manage
  'GET /api/v1/quick-replies': 'inbox.reply',
  'POST /api/v1/quick-replies': 'quick_replies.manage',
  'PATCH /api/v1/quick-replies/:quickReplyId': 'quick_replies.manage',
  'DELETE /api/v1/quick-replies/:quickReplyId': 'quick_replies.manage',
  'POST /api/v1/quick-replies/:quickReplyId/use': 'inbox.reply',
  // Pengaturan → API key (Fase 3): Owner/Admin
  'GET /api/v1/settings/api-keys': 'api_keys.manage',
  'POST /api/v1/settings/api-keys': 'api_keys.manage',
  'POST /api/v1/settings/api-keys/:apiKeyId/revoke': 'api_keys.manage',
  'GET /api/v1/settings/api': 'api_keys.manage',
  'PUT /api/v1/settings/api': 'api_keys.manage',
  // Webhook keluar (Fase 3): Owner/Admin (`integrations.manage`)
  'GET /api/v1/settings/webhooks': 'integrations.manage',
  'POST /api/v1/settings/webhooks': 'integrations.manage',
  'PATCH /api/v1/settings/webhooks/:webhookId': 'integrations.manage',
  'DELETE /api/v1/settings/webhooks/:webhookId': 'integrations.manage',
  'POST /api/v1/settings/webhooks/:webhookId/rotate-secret': 'integrations.manage',
  'POST /api/v1/settings/webhooks/:webhookId/test': 'integrations.manage',
  'GET /api/v1/settings/webhooks/:webhookId/deliveries': 'integrations.manage',
  'POST /api/v1/settings/webhooks/:webhookId/deliveries/:deliveryId/redeliver':
    'integrations.manage',
  'GET /api/v1/settings/webhooks-private-network': 'integrations.manage',
  'PUT /api/v1/settings/webhooks-private-network': 'integrations.manage',
  // API publik v1: HANYA Bearer API key + scope (sesi web apa pun → 401)
  'GET /api/v1/public/conversations': 'apikey:conversations:read',
  'GET /api/v1/public/conversations/:conversationId': 'apikey:conversations:read',
  'GET /api/v1/public/conversations/:conversationId/messages': 'apikey:messages:read',
  'POST /api/v1/public/conversations/:conversationId/messages': 'apikey:messages:send',
  'POST /api/v1/public/conversations/:conversationId/media': 'apikey:messages:send',
  'POST /api/v1/public/conversations/:conversationId/handoff': 'apikey:conversations:write',
  'POST /api/v1/public/messages/template': 'apikey:messages:initiate',
  'GET /api/v1/public/messages/:messageId': 'apikey:messages:read',
  'GET /api/v1/public/contacts': 'apikey:contacts:read',
  'POST /api/v1/public/contacts': 'apikey:contacts:write',
  'GET /api/v1/public/contacts/:contactId': 'apikey:contacts:read',
  'PATCH /api/v1/public/contacts/:contactId': 'apikey:contacts:write',
  'POST /api/v1/public/contacts/:contactId/tags': 'apikey:contacts:write',
  'DELETE /api/v1/public/contacts/:contactId/tags': 'apikey:contacts:write',
  // kompatibel MobiChat: HANYA header X-API-Key + scope (sesi web apa pun → 401)
  'GET /api/public/messages': 'mobichat:messages:read',
  'POST /api/public/messages': 'mobichat:messages:send',
  'GET /api/public/conversation-status': 'mobichat:conversations:read',
  'POST /api/public/conversation-status': 'mobichat:conversations:write',
  'POST /api/public/unassign-agent': 'mobichat:conversations:write',
  'POST /api/public/agents': 'mobichat:conversations:write',
  'POST /api/public/conversation/notes': 'mobichat:conversations:write',
  'PUT /api/public/contacts': 'mobichat:contacts:write',
  'PUT /api/public/tags/whatsapp': 'mobichat:contacts:write',
  // URL media bertanda tangan (HMAC + key penanda tangan dicek ulang) — tanpa header
  'GET /api/public/media/:messageNumber': 'public',
  'POST /api/bot/reply': 'mobichat:messages:send',
  'POST /api/bot/reply/media': 'mobichat:messages:send',
  // dokumentasi API publik (tanpa sesi; bisa dimatikan Pengaturan → API)
  'GET /api/docs': 'public',
  'GET /api/docs/app.css': 'public',
  'GET /api/docs/app.js': 'public',
  'GET /api/docs/openapi.json': 'public',
  // penerima webhook Meta: publik — keaslian dari verify token (GET) / tanda tangan App Secret (POST)
  'GET /webhooks/whatsapp/:channelId': 'public',
  'POST /webhooks/whatsapp/:channelId': 'public',
};

const LOGOUT = 'POST /api/v1/auth/logout';

function accessOf(expectation: Expectation): RouteAccess {
  if (isApiKeyExpectation(expectation)) {
    const mobichat = expectation.startsWith('mobichat:');
    const scope = expectation.slice(expectation.indexOf(':') + 1);
    return {
      kind: 'apiKey',
      scope: scope === '*' ? null : (scope as ApiKeyScope),
      ...(mobichat ? { credential: 'x-api-key' as const } : {}),
    };
  }
  switch (expectation) {
    case 'public':
      return { kind: 'public' };
    case 'session':
      return { kind: 'authenticated' };
    case 'enrollment':
      return { kind: 'authenticated', allowTwoFactorEnrollment: true };
    default:
      return { kind: 'permission', permission: expectation };
  }
}

/** Akses pelengkap 405 yang diharapkan, dihitung dari tabel (bukan dari kode yang diuji). */
function complementExpectation(expectations: readonly Expectation[]): Expectation {
  if (expectations.every((value) => value === 'public')) return 'public';
  if (expectations.every(isApiKeyExpectation)) {
    const scopes = new Set(expectations);
    const [only] = scopes;
    if (scopes.size === 1 && only) return only;
    return expectations.every((value) => value.startsWith('mobichat:')) ? 'mobichat:*' : 'apikey:*';
  }
  const distinct = new Set(expectations);
  const [only] = distinct;
  if (distinct.size === 1 && only !== 'session' && only !== 'enrollment')
    return only as Expectation;
  return 'session';
}

type Principal =
  | { kind: 'anonymous' }
  | { kind: 'enrollment'; role: UserRole; userId: string; cookie: string; csrf: string }
  | { kind: 'full'; role: UserRole; userId: string; cookie: string; csrf: string };

type Outcome = 'allowed' | 'unauthenticated' | 'forbidden' | 'enrollment_required';
/** HEAD tanpa body: 403 tidak bisa dibedakan (versi GET-nya yang memeriksa kodenya). */
type Observed = Outcome | 'forbidden_head';

function matches(expected: Outcome, observed: Observed): boolean {
  if (observed === 'forbidden_head') {
    return expected === 'forbidden' || expected === 'enrollment_required';
  }
  return expected === observed;
}

function expectedOutcome(expectation: Expectation, principal: Principal): Outcome {
  if (expectation === 'public') return 'allowed';
  // API publik tidak menerima sesi web sama sekali (tanpa Bearer → 401).
  if (isApiKeyExpectation(expectation)) return 'unauthenticated';
  if (principal.kind === 'anonymous') return 'unauthenticated';
  if (principal.kind === 'enrollment') {
    return expectation === 'enrollment' ? 'allowed' : 'enrollment_required';
  }
  if (expectation === 'session' || expectation === 'enrollment') return 'allowed';
  return hasPermission(principal.role, expectation) ? 'allowed' : 'forbidden';
}

type Response = Awaited<ReturnType<typeof call>>;

/** Apa yang diputuskan lapisan auth untuk respons ini. */
function observedOutcome(response: Response): Observed {
  if (response.statusCode !== 401 && response.statusCode !== 403) return 'allowed';
  // HEAD tidak punya body; status + pemeriksaan GET-nya sudah cukup.
  if (response.body === '') {
    return response.statusCode === 401 ? 'unauthenticated' : 'forbidden_head';
  }
  // Lapisan kompatibel MobiChat menjawab dengan bentuk MobiChat (`{ success: false, code }` /
  // `{ error }`), bukan amplop standar.
  const body: unknown = response.json();
  if (
    typeof body === 'object' &&
    body !== null &&
    !('error' in body && typeof body.error === 'object')
  ) {
    if (response.statusCode === 401) return 'unauthenticated';
    if ('code' in body && body.code === 'CSRF_INVALID') return 'forbidden';
    return 'allowed';
  }
  const { code, message } = errorEnvelopeSchema.parse(body).error;
  if (code === 'UNAUTHENTICATED') return 'unauthenticated';
  if (code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') return 'enrollment_required';
  // 403 dari handler sendiri (mis. Admin mengundang Admin) memakai pesan khusus; penolakan
  // izin di hook selalu memakai pesan bawaan.
  if (code === 'FORBIDDEN' && message === ERROR_MESSAGES.FORBIDDEN) return 'forbidden';
  if (code === 'CSRF_INVALID') return 'forbidden';
  return 'allowed';
}

const SAMPLE_PARAMS: Readonly<Record<string, string>> = {
  invitationId: '00000000-0000-4000-8000-0000000000aa',
  template: 'invitation',
  userId: '00000000-0000-4000-8000-0000000000bb',
  sessionId: '00000000-0000-4000-8000-0000000000cc',
  channelId: '00000000-0000-4000-8000-0000000000dd',
  conversationId: '00000000-0000-4000-8000-0000000000ee',
  contactId: '00000000-0000-4000-8000-0000000000ff',
  messageId: '00000000-0000-4000-8000-0000000000a1',
  tagId: '00000000-0000-4000-8000-0000000000a2',
  noteId: '00000000-0000-4000-8000-0000000000a3',
  quickReplyId: '00000000-0000-4000-8000-0000000000a4',
  apiKeyId: '00000000-0000-4000-8000-0000000000a5',
  webhookId: '00000000-0000-4000-8000-0000000000a6',
  deliveryId: '00000000-0000-4000-8000-0000000000a7',
  messageNumber: '1',
  templateId: '00000000-0000-4000-8000-0000000000a8',
  presetId: 'isp_tagihan_jatuh_tempo',
};

function concreteUrl(pattern: string): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = SAMPLE_PARAMS[name];
    if (value === undefined)
      throw new Error(`Tambahkan contoh parameter "${name}" di SAMPLE_PARAMS`);
    return value;
  });
}

let harness: IntegrationHarness;
let declarations: RouteDeclaration[];
const principals = new Map<string, Principal>();
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-uji-matriks-rbac-01';

beforeAll(async () => {
  harness = await createIntegrationHarness();
  const owner = await completeSetup(harness.app);
  const organizationId = owner.session.organization.id;
  declarations = [...harness.app.routeDeclarations];

  principals.set('tanpa sesi', { kind: 'anonymous' });
  principals.set('owner', {
    kind: 'full',
    role: 'owner',
    userId: owner.session.user.id,
    cookie: owner.cookie,
    csrf: owner.csrf,
  });
  const passwordHash = await hasher.hash(PASSWORD);
  for (const role of USER_ROLES.filter((value) => value !== 'owner')) {
    const user = await insertUser(harness.db, organizationId, {
      role,
      email: `${role}.matriks@majujaya.test`,
      name: `Pengguna ${role}`,
      passwordHash,
    });
    const signed = await login(harness.app, { email: user.email, password: PASSWORD });
    principals.set(role, {
      kind: 'full',
      role,
      userId: user.id,
      cookie: signed.cookie,
      csrf: signed.csrf,
    });
  }
  // Sesi terbatas: Admin yang belum mendaftarkan 2FA.
  const enrolling = await insertUser(harness.db, organizationId, {
    role: 'admin',
    email: 'admin.belum2fa@majujaya.test',
    name: 'Admin Belum 2FA',
    passwordHash,
  });
  const { response, body } = await startLogin(harness.app, {
    email: enrolling.email,
    password: PASSWORD,
  });
  if (body.status !== 'two_factor_enrollment_required') throw new Error('bukan sesi terbatas');
  principals.set('sesi terbatas 2FA', {
    kind: 'enrollment',
    role: 'admin',
    userId: enrolling.id,
    cookie: sessionCookieOf(response),
    csrf: body.csrfToken,
  });
});

afterAll(async () => {
  await harness?.close();
});

const key = (route: { method: string; url: string }) => `${route.method} ${route.url}`;

/** Akses yang diharapkan untuk satu deklarasi (rute modul, HEAD otomatis, atau pelengkap 405). */
function expectationFor(route: RouteDeclaration): Expectation {
  if (route.methodNotAllowed) {
    const real = Object.entries(ROUTES)
      .filter(([entry]) => entry.split(' ')[1] === route.url)
      .map(([, expectation]) => expectation);
    if (real.length === 0) throw new Error(`Pelengkap 405 tanpa rute asli: ${key(route)}`);
    return complementExpectation(real);
  }
  const entry = route.method === 'HEAD' ? `GET ${route.url}` : key(route);
  const expectation = ROUTES[entry];
  if (expectation === undefined) {
    throw new Error(`Rute ${key(route)} belum ada di tabel ROUTES rbac-matrix.integration.test.ts`);
  }
  return expectation;
}

describe('deklarasi rute = tabel tertulis', () => {
  it('setiap rute modul punya entri, setiap entri punya rute, aksesnya sama persis', () => {
    const real = declarations.filter((route) => !route.methodNotAllowed && route.method !== 'HEAD');
    expect(real.map(key).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const route of real) {
      expect(route.access, key(route)).toEqual(accessOf(expectationFor(route)));
    }
  });

  it('HEAD otomatis dan rute pelengkap 405 mengikuti aksesnya', () => {
    const derived = declarations.filter(
      (route) => route.methodNotAllowed || route.method === 'HEAD',
    );
    expect(derived.length).toBeGreaterThan(Object.keys(ROUTES).length);
    for (const route of derived) {
      expect(route.access, key(route)).toEqual(accessOf(expectationFor(route)));
    }
    // HEAD modul hanya ada untuk GET; pelengkap 405 tidak pernah boleh dipakai sesi terbatas.
    for (const route of derived.filter((value) => !value.methodNotAllowed)) {
      expect(route.method, key(route)).toBe('HEAD');
      expect(ROUTES[`GET ${route.url}`], key(route)).toBeDefined();
    }
    for (const route of declarations.filter((value) => value.methodNotAllowed)) {
      expect(
        route.access.kind === 'authenticated' && route.access.allowTwoFactorEnrollment,
        key(route),
      ).toBeFalsy();
    }
  });

  it('daftar rute publik dan rute cukup-sesi eksplisit (bukan izin) tidak bertambah diam-diam', () => {
    const byExpectation = (wanted: Expectation[]) =>
      Object.entries(ROUTES)
        .filter(([, expectation]) => wanted.includes(expectation))
        .map(([entry]) => entry)
        .sort();
    // Rute "cukup sesi" hanya untuk data milik pengguna itu sendiri.
    expect(byExpectation(['session', 'enrollment'])).toEqual([
      'DELETE /api/v1/auth/sessions/:sessionId',
      'GET /api/v1/auth/2fa',
      'GET /api/v1/auth/email/verification',
      'GET /api/v1/auth/me',
      'GET /api/v1/auth/sessions',
      'POST /api/v1/auth/2fa/backup-codes',
      'POST /api/v1/auth/2fa/disable',
      'POST /api/v1/auth/2fa/enroll',
      'POST /api/v1/auth/2fa/enroll/confirm',
      'POST /api/v1/auth/email/verification',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/sessions/revoke-others',
    ]);
  });
});

describe('peran × endpoint: hasil sungguhan cocok dengan matriks', () => {
  const PRINCIPAL_NAMES = [
    'tanpa sesi',
    'sesi terbatas 2FA',
    'owner',
    'admin',
    'supervisor',
    'cs',
    'teknisi',
  ] as const;

  it.each(PRINCIPAL_NAMES)('%s', async (name) => {
    const principal = principals.get(name);
    if (!principal) throw new Error(`pemanggil ${name} belum disiapkan`);
    // Pelengkap 405 dulu, lalu rute modul; logout paling akhir (mengakhiri sesi).
    const ordered = [...declarations].sort((a, b) => {
      const rank = (route: RouteDeclaration) =>
        key(route) === LOGOUT ? 2 : route.methodNotAllowed ? 0 : 1;
      return rank(a) - rank(b);
    });

    const mismatches: string[] = [];
    const deniedPermissions = new Set<Permission>();
    for (const route of ordered) {
      const expectation = expectationFor(route);
      const expected = expectedOutcome(expectation, principal);
      const mutating = !['GET', 'HEAD'].includes(route.method);
      const response = await call(
        harness.app,
        route.method as Parameters<typeof call>[1],
        concreteUrl(route.url),
        mutating ? [] : undefined,
        principal.kind === 'anonymous' ? {} : { cookie: principal.cookie, csrf: principal.csrf },
      );
      const observed = observedOutcome(response);
      if (!matches(expected, observed)) {
        mismatches.push(
          `${key(route)}: harap ${expected}, dapat ${observed} (${response.statusCode})`,
        );
      }
      // Pelengkap yang lolos lapisan auth selalu 405 + Allow.
      if (route.methodNotAllowed && expected === 'allowed') {
        if (response.statusCode !== 405 || !response.headers.allow) {
          mismatches.push(
            `${key(route)}: pelengkap harus 405 + Allow, dapat ${response.statusCode}`,
          );
        }
      }
      if (
        expected === 'forbidden' &&
        expectation !== 'public' &&
        !isApiKeyExpectation(expectation)
      ) {
        deniedPermissions.add(expectation as Permission);
      }
    }
    expect(mismatches).toEqual([]);

    // R8: setiap izin yang ditolak meninggalkan TEPAT satu entri audit (pembatas per izin).
    if (principal.kind === 'full') {
      const rows = await harness.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, 'auth.access.denied'),
            eq(auditLogs.actorUserId, principal.userId),
          ),
        );
      const audited = rows.map((row) => row.metadata.permission as string).sort();
      expect(audited).toEqual([...deniedPermissions].sort());
    }
  });

  it('pemanggil yang diuji mewakili kelima peran', async () => {
    const roles = [...principals.values()]
      .filter((principal) => principal.kind === 'full')
      .map((principal) => principal.role);
    expect(roles.sort()).toEqual([...USER_ROLES].sort());
    const active = await harness.db.select({ role: users.role }).from(users);
    expect(active.length).toBe(USER_ROLES.length + 1);
  });
});
