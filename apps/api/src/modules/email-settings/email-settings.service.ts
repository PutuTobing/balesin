import {
  AppError,
  SMTP_PASSWORD_PURPOSE,
  Secret,
  fallbackEmailSettings,
  isPlaintextLoginRejected,
  maskedSecret,
  openStoredEmailSettings,
  renderTestEmail,
  secretTail,
  sendSmtpMail,
  verifySmtpConnection,
  type HostLookup,
  type MailTransportSettings,
  type PlaintextLoginPolicy,
  type SecretBox,
  type SmtpFallbackConfig,
  type SmtpPolicy,
  type SmtpResult,
  type SmtpTimeouts,
} from '@balesin/core';
import {
  lockEmailAddresses,
  organizations,
  type Database,
  type DbExecutor,
  type EmailSettings,
} from '@balesin/db';
import {
  EMAIL_TEST_MESSAGES,
  type DetectEmailHostResponse,
  type EmailSettingsInput,
  type IdentityConfirmation,
  type SaveEmailSettingsRequest,
  type EmailSettingsResponse,
  type EmailSettingsView,
  type EmailTestCode,
  type EmailTestResult,
  type ErrorDetail,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import { addressIsMailIdentity } from '../mail/mail-compose.repo';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import { deliveryPathChanged, queueOwnerChangeNotices } from './change-notice';
import { detectEmailHost, systemMailDns, type MailDns } from './email-host-detection';
import {
  findEmailSettings,
  recordEmailTestResult,
  upsertEmailSettings,
  type EmailSettingsValues,
} from './email-settings.repo';

/**
 * Email pengirim sistem (docs/PENGATURAN-UI.md §1): simpan, tampilkan tersamar, tes koneksi,
 * kirim email tes, deteksi host. Dipakai wizard setup (belum ada organisasi; isi form dikirim
 * lengkap) dan Pengaturan → Email pengirim.
 */

/** Siapa yang bertindak. `null` = wizard setup (belum ada organisasi maupun pengguna). */
export interface EmailSettingsActor {
  organizationId: string;
  userId: string;
}

export interface EmailOperationContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
  /** Cookie "perangkat dikenal" (ember batas laju konfirmasi identitas). */
  presentedDeviceToken?: string;
}

/** Pengaturan dari form yang sudah lolos pemeriksaan dan siap dipakai/disimpan. */
export interface PreparedEmailSettings {
  input: EmailSettingsInput;
  transport: MailTransportSettings;
  /** Asal password: baru diketik, memakai yang tersimpan, atau tanpa login. */
  passwordSource: 'new' | 'stored' | 'none';
}

export interface EmailSettingsService {
  /** `true` bila server bisa mengenkripsi rahasia (`BALESIN_MASTER_KEY` terisi). */
  readonly canStoreSecrets: boolean;
  view(organizationId: string): Promise<EmailSettingsResponse>;
  /**
   * Menyimpan. Bila jalur kirim berubah (server, login, alamat pengirim/balas-ke — termasuk
   * menyimpan pertama kali), pelaku SIAPA PUN (Owner juga) wajib konfirmasi ulang identitas, dan
   * semua Owner aktif — termasuk pelakunya — diberi tahu lewat pengaturan LAMA (`change-notice.ts`;
   * review akhir Fase 1 T2).
   */
  save(
    auth: AuthContext,
    input: SaveEmailSettingsRequest,
    context: EmailOperationContext,
  ): Promise<EmailSettingsResponse>;
  /**
   * Memeriksa isi form (port, pasangan username/password) dan menyusun nilai siap simpan.
   * Melempar `VALIDATION_ERROR` dengan `details` per isian; `fieldPrefix` ditempel di depan
   * nama isian (mis. `email.` untuk wizard setup).
   */
  prepare(
    input: EmailSettingsInput,
    stored: EmailSettings | undefined,
    fieldPrefix: string,
  ): PreparedEmailSettings;
  /** Nilai kolom untuk disimpan (password dienkripsi dengan konteks organisasi). */
  toValues(
    organizationId: string,
    prepared: PreparedEmailSettings,
    stored: EmailSettings | undefined,
  ): EmailSettingsValues;
  /** Pemeriksaan tambahan saat menyimpan (butuh DNS): login tanpa enkripsi ke internet. */
  assertSecureLogin(input: EmailSettingsInput, fieldPrefix: string): Promise<void>;
  testConnection(
    actor: EmailSettingsActor | null,
    draft: EmailSettingsInput | undefined,
    context: EmailOperationContext,
  ): Promise<EmailTestResult>;
  sendTest(
    actor: EmailSettingsActor | null,
    to: string,
    draft: EmailSettingsInput | undefined,
    context: EmailOperationContext,
  ): Promise<EmailTestResult>;
  detectHost(emailAddress: string): Promise<DetectEmailHostResponse>;
}

export interface EmailSettingsServiceDeps {
  db: Database;
  /** `null` = `BALESIN_MASTER_KEY` belum diisi (hanya mungkin di development/test). */
  secretBox: SecretBox | null;
  /** Cadangan `SMTP_*` dari .env. */
  fallback: SmtpFallbackConfig | null;
  /** Port SMTP yang boleh dituju. */
  allowedPorts: readonly number[];
  /** Login "Tanpa enkripsi": `private-only` di production. */
  plaintextLogin: PlaintextLoginPolicy;
  /** Bisa diganti di tes. */
  lookup?: HostLookup;
  timeouts?: Partial<SmtpTimeouts>;
  dns?: MailDns;
  /** Pengantre pemberitahuan ke Owner (perubahan jalur kirim email pengirim). */
  notifier: EmailNotifier;
  /** Konfirmasi ulang identitas sebelum jalur kirim berubah (review akhir Fase 1 T2). */
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
}

const NO_MASTER_KEY_MESSAGE =
  'Password belum bisa disimpan karena BALESIN_MASTER_KEY belum diisi di berkas .env server. ' +
  'Isi dulu (lihat .env.example), jalankan ulang aplikasi, lalu simpan lagi.';

function validationError(details: ErrorDetail[]): AppError {
  return new AppError('VALIDATION_ERROR', { details });
}

function bodyDetail(field: string, message: string): ErrorDetail {
  return { location: 'body', field, message };
}

function toView(row: EmailSettings): EmailSettingsView {
  return {
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    host: row.host,
    port: row.port,
    security: row.security,
    username: row.username,
    hasPassword: row.passwordEncrypted !== null,
    passwordHint: row.passwordEncrypted !== null ? maskedSecret(row.passwordTail) : null,
  };
}

function isTestCode(value: string | null): value is EmailTestCode {
  return value !== null && value in EMAIL_TEST_MESSAGES;
}

export function createEmailSettingsService(deps: EmailSettingsServiceDeps): EmailSettingsService {
  const { db, secretBox, fallback, allowedPorts } = deps;
  const dns = deps.dns ?? systemMailDns;

  const policyFor = (extraPort?: number): SmtpPolicy => ({
    allowedPorts: extraPort === undefined ? allowedPorts : [...allowedPorts, extraPort],
    plaintextLogin: deps.plaintextLogin,
    lookup: deps.lookup,
    timeouts: deps.timeouts,
  });

  /**
   * Menolak penyimpanan "Tanpa enkripsi" + login ke server di internet (password akan
   * terkirim polos) — hanya bila kebijakannya `private-only` (production).
   */
  async function assertSecureLogin(input: EmailSettingsInput, fieldPrefix: string) {
    const rejected = await isPlaintextLoginRejected(
      { host: input.host, security: input.security, username: input.username ?? null },
      policyFor(),
    );
    if (rejected) {
      throw validationError([
        bodyDetail(`${fieldPrefix}security`, EMAIL_TEST_MESSAGES.insecure_login),
      ]);
    }
  }

  function prepare(
    input: EmailSettingsInput,
    stored: EmailSettings | undefined,
    fieldPrefix: string,
  ): PreparedEmailSettings {
    const field = (name: string) => `${fieldPrefix}${name}`;
    const details: ErrorDetail[] = [];
    const username = input.username ?? null;

    if (!allowedPorts.includes(input.port)) {
      details.push(bodyDetail(field('port'), EMAIL_TEST_MESSAGES.port_not_allowed));
    }

    let password: Secret<string> | null = null;
    let passwordSource: PreparedEmailSettings['passwordSource'] = 'none';
    if (username === null) {
      if (input.password !== undefined) {
        details.push(
          bodyDetail(
            field('password'),
            'Kosongkan password bila username dikosongkan, atau isi username-nya.',
          ),
        );
      }
    } else if (input.password !== undefined) {
      password = new Secret(input.password);
      passwordSource = 'new';
    } else if (!stored || stored.passwordEncrypted === null) {
      details.push(bodyDetail(field('password'), 'Password wajib diisi.'));
    } else if (
      // Password tersimpan hanya dipakai lagi untuk TUJUAN YANG SAMA PERSIS. Kalau tidak,
      // mengganti host (atau menurunkan keamanan sambungan) akan mengirim password lama ke
      // server lain — cara membocorkan rahasia yang tidak bisa dibaca dari UI.
      stored.host !== input.host ||
      stored.port !== input.port ||
      stored.security !== input.security ||
      stored.username !== username
    ) {
      details.push(
        bodyDetail(
          field('password'),
          'Masukkan ulang password. Host, port, keamanan, atau username berubah, jadi password yang tersimpan tidak dipakai lagi.',
        ),
      );
    } else {
      const opened = openStoredEmailSettings(stored, secretBox);
      if (opened.ok) {
        password = opened.settings.connection.password;
        passwordSource = 'stored';
      } else {
        details.push(bodyDetail(field('password'), EMAIL_TEST_MESSAGES.secret_unavailable));
      }
    }

    if (details.length > 0) throw validationError(details);

    return {
      input,
      passwordSource,
      transport: {
        connection: {
          host: input.host,
          port: input.port,
          security: input.security,
          username,
          password,
        },
        sender: {
          fromName: input.fromName,
          fromAddress: input.fromAddress,
          replyTo: input.replyTo ?? null,
        },
      },
    };
  }

  function toValues(
    organizationId: string,
    prepared: PreparedEmailSettings,
    stored: EmailSettings | undefined,
  ): EmailSettingsValues {
    const { input } = prepared;
    const base = {
      fromName: input.fromName,
      fromAddress: input.fromAddress,
      replyTo: input.replyTo ?? null,
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username ?? null,
    };

    if (prepared.passwordSource === 'none') {
      return { ...base, passwordEncrypted: null, passwordTail: null };
    }
    if (prepared.passwordSource === 'stored' && stored) {
      return {
        ...base,
        passwordEncrypted: stored.passwordEncrypted,
        passwordTail: stored.passwordTail,
      };
    }

    const password = prepared.transport.connection.password;
    // Tanpa master key, rahasia TIDAK disimpan — tidak pernah jatuh ke penyimpanan polos.
    if (!secretBox || !password) {
      throw new AppError('SERVICE_UNAVAILABLE', { message: NO_MASTER_KEY_MESSAGE });
    }
    return {
      ...base,
      passwordEncrypted: secretBox.encrypt(password.reveal(), {
        organizationId,
        purpose: SMTP_PASSWORD_PURPOSE,
      }),
      passwordTail: secretTail(password.reveal()),
    };
  }

  async function view(organizationId: string, executor: DbExecutor = db) {
    const row = await findEmailSettings(executor, organizationId);
    const canStoreSecrets = secretBox !== null;

    if (row) {
      const lastTest: EmailTestResult | null =
        row.lastTestOk !== null && row.lastTestedAt !== null && isTestCode(row.lastTestCode)
          ? {
              ok: row.lastTestOk,
              code: row.lastTestCode,
              message: EMAIL_TEST_MESSAGES[row.lastTestCode],
              testedAt: row.lastTestedAt.toISOString(),
            }
          : null;
      return {
        source: 'database',
        settings: toView(row),
        status: lastTest === null ? 'untested' : lastTest.ok ? 'connected' : 'failed',
        lastTest,
        updatedAt: row.updatedAt.toISOString(),
        canStoreSecrets,
      } satisfies EmailSettingsResponse;
    }

    if (fallback) {
      return {
        source: 'env',
        settings: {
          fromName: fallback.fromName,
          fromAddress: fallback.fromAddress,
          replyTo: null,
          host: fallback.host,
          port: fallback.port,
          security: fallback.security,
          username: fallback.username,
          hasPassword: fallback.username !== null && fallback.password !== null,
          // Rahasia dari .env tidak pernah ditampilkan, tersamar sekalipun.
          passwordHint: null,
        },
        status: 'untested',
        lastTest: null,
        updatedAt: null,
        canStoreSecrets,
      } satisfies EmailSettingsResponse;
    }

    return {
      source: 'none',
      settings: null,
      status: 'not_configured',
      lastTest: null,
      updatedAt: null,
      canStoreSecrets,
    } satisfies EmailSettingsResponse;
  }

  /**
   * Menentukan pengaturan yang diuji: isi form (draft) bila ada, selain itu yang tersimpan,
   * selain itu cadangan .env. `persist` = hasilnya dicatat sebagai status pengaturan tersimpan.
   */
  async function resolveTarget(
    actor: EmailSettingsActor | null,
    draft: EmailSettingsInput | undefined,
  ): Promise<
    | { kind: 'ready'; transport: MailTransportSettings; policy: SmtpPolicy; persist: boolean }
    | { kind: 'failed'; code: EmailTestCode; persist: boolean }
  > {
    const stored = actor ? await findEmailSettings(db, actor.organizationId) : undefined;

    if (draft) {
      const prepared = prepare(draft, stored, 'settings.');
      return { kind: 'ready', transport: prepared.transport, policy: policyFor(), persist: false };
    }
    if (stored) {
      const opened = openStoredEmailSettings(stored, secretBox);
      return opened.ok
        ? { kind: 'ready', transport: opened.settings, policy: policyFor(), persist: true }
        : { kind: 'failed', code: opened.code, persist: true };
    }
    if (fallback) {
      return {
        kind: 'ready',
        transport: fallbackEmailSettings(fallback),
        // Port cadangan ditentukan pengelola server lewat .env, jadi dipercaya.
        policy: policyFor(fallback.port),
        persist: false,
      };
    }
    return { kind: 'failed', code: 'not_configured', persist: false };
  }

  async function runTest(
    mode: 'connection' | 'send',
    actor: EmailSettingsActor | null,
    draft: EmailSettingsInput | undefined,
    context: EmailOperationContext,
    run: (transport: MailTransportSettings, policy: SmtpPolicy) => Promise<SmtpResult>,
    successMessage: string,
  ): Promise<EmailTestResult> {
    const target = await resolveTarget(actor, draft);

    let code: EmailTestCode;
    let host: string | null = null;
    let port: number | null = null;
    if (target.kind === 'failed') {
      code = target.code;
    } else {
      ({ host, port } = target.transport.connection);
      const result = await run(target.transport, target.policy);
      code = result.ok ? 'ok' : result.code;
      // Hanya kode dan angka — balasan mentah server email tidak pernah dicatat maupun dikirim.
      context.log.info(
        { mode, host, port, code, diagnostic: result.ok ? undefined : result.diagnostic },
        'Tes email pengirim selesai',
      );
    }

    const ok = code === 'ok';
    let testedAt = new Date();
    if (actor) {
      await db.transaction(async (tx) => {
        // Alamat tujuan email tes yang salah bukan kesalahan pengaturan, jadi tidak mengubah status.
        if (target.persist && code !== 'recipient_rejected') {
          testedAt =
            (await recordEmailTestResult(tx, actor.organizationId, { ok, code })) ?? testedAt;
        }
        await recordAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.emailSettingsTested,
          targetType: 'email_settings',
          metadata: { mode, host, port, code, draft: draft !== undefined },
          client: context.client,
        });
      });
    }

    return {
      ok,
      code,
      message: ok ? successMessage : EMAIL_TEST_MESSAGES[code],
      testedAt: testedAt.toISOString(),
    };
  }

  /**
   * Konfirmasi ulang identitas sebelum jalur kirim berubah — untuk semua peran, Owner juga (review
   * akhir Fase 1 T2). Kesalahan per isian diletakkan di bawah `confirmation.`.
   */
  async function confirmChange(
    auth: AuthContext,
    confirmation: IdentityConfirmation | undefined,
    context: EmailOperationContext,
  ): Promise<void> {
    await requireIdentityConfirmation(
      deps.twoFactor,
      auth,
      confirmation,
      'email_settings.update',
      context,
      'Masukkan password-mu (dan kode verifikasi dua langkah) untuk mengubah server atau alamat email pengirim.',
    );
  }

  return {
    canStoreSecrets: secretBox !== null,
    view: (organizationId) => view(organizationId),
    prepare,
    toValues,
    assertSecureLogin,

    async save(auth, request, context) {
      const { confirmation, ...input } = request;
      const actor = { organizationId: auth.organizationId, userId: auth.user.id };
      await assertSecureLogin(input, '');

      // Jalur kirim berubah → konfirmasi identitas DULU (di luar transaksi: memeriksa password
      // mahal dan memakai ember batas lajunya sendiri). Diperiksa ulang di transaksi di bawah.
      const before = await findEmailSettings(db, actor.organizationId);
      const preview = prepare(input, before, '');
      const confirmed = deliveryPathChanged(
        before,
        toValues(actor.organizationId, preview, before),
        preview.passwordSource === 'new',
      );
      if (confirmed) await confirmChange(auth, confirmation, context);

      return db.transaction(async (tx) => {
        // Pelaku diperiksa ulang di transaksi tulis (review akhir Fase 1 R3).
        await assertActorStillAuthorized(tx, auth, 'settings.email.manage', context.log);
        const stored = await findEmailSettings(tx, actor.organizationId);
        const prepared = prepare(input, stored, '');
        const values = toValues(actor.organizationId, prepared, stored);
        // 9B (KONTRAK-API-EMAIL-TULIS §3.3, arah sebaliknya): alamat pengirim sistem BARU tidak boleh
        // sudah menjadi identitas (alamat/alias) akun di menu Email.
        const nextAddress = values.fromAddress.trim().toLowerCase();
        if (!stored || stored.fromAddress.trim().toLowerCase() !== nextAddress) {
          await lockEmailAddresses(tx, actor.organizationId, [nextAddress]);
          if (await addressIsMailIdentity(tx, actor.organizationId, nextAddress)) {
            const message =
              'Alamat ini sudah dipakai sebagai alamat pengirim di menu Email. Pakai alamat lain (mis. noreply@) untuk Email pengirim sistem.';
            throw new AppError('CONFLICT', {
              message,
              details: [
                { location: 'body', field: 'fromAddress', message, reason: 'address_in_use' },
              ],
            });
          }
        }
        const connectionChanged =
          !stored ||
          prepared.passwordSource === 'new' ||
          stored.host !== values.host ||
          stored.port !== values.port ||
          stored.security !== values.security ||
          stored.username !== values.username;

        await upsertEmailSettings(tx, actor.organizationId, values, {
          updatedByUserId: actor.userId,
          resetTestResult: connectionChanged,
        });
        // Semua pelaku (Owner juga): pemberitahuan lewat pengaturan LAMA ke semua Owner aktif.
        const notifyOwners = deliveryPathChanged(stored, values, prepared.passwordSource === 'new');
        // Pengaturan berubah di sela konfirmasi: perubahan ini ternyata membelokkan jalur kirim.
        if (notifyOwners && !confirmed) await confirmChange(auth, confirmation, context);
        const auditLogId = await recordAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.emailSettingsUpdated,
          targetType: 'email_settings',
          // Tanpa password dalam bentuk apa pun; hanya fakta "login diganti atau tidak".
          metadata: {
            host: values.host,
            port: values.port,
            security: values.security,
            username: values.username,
            fromAddress: values.fromAddress,
            replyTo: values.replyTo,
            loginChanged: prepared.passwordSource === 'new',
            created: !stored,
            previousHost: stored?.host ?? null,
            ownersNotified: notifyOwners,
            actorRole: auth.user.role,
          },
          client: context.client,
        });
        if (notifyOwners) {
          await queueOwnerChangeNotices(tx, deps.notifier, {
            organizationId: actor.organizationId,
            actor: { userId: actor.userId, role: auth.user.role },
            stored,
            values,
            auditLogId,
          });
        }
        return view(actor.organizationId, tx);
      });
    },

    testConnection: (actor, draft, context) =>
      runTest(
        'connection',
        actor,
        draft,
        context,
        (transport, policy) => verifySmtpConnection(transport.connection, policy),
        EMAIL_TEST_MESSAGES.ok,
      ),

    sendTest: async (actor, to, draft, context) => {
      // Warna utama organisasi ikut dipakai (email tes saat wizard setup: organisasi belum ada).
      const [brand] = actor
        ? await db
            .select({ brandColor: organizations.brandColor })
            .from(organizations)
            .where(eq(organizations.id, actor.organizationId))
            .limit(1)
        : [];
      return runTest(
        'send',
        actor,
        draft,
        context,
        (transport, policy) =>
          sendSmtpMail(
            transport.connection,
            transport.sender,
            {
              to,
              ...renderTestEmail({
                brand: {
                  productName: transport.sender.fromName,
                  organizationName: null,
                  logoSrc: null,
                  primaryColor: brand?.brandColor ?? null,
                },
              }),
            },
            policy,
          ),
        `Email tes terkirim ke ${to}. Cek kotak masuk alamat itu, termasuk folder spam.`,
      );
    },

    detectHost: (emailAddress) => detectEmailHost(emailAddress, dns),
  };
}
