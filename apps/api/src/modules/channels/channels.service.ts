import {
  AppError,
  constantTimeEqual,
  isMetaApiError,
  newWebhookVerifyToken,
  openChannelSecret,
  openWhatsAppCredentials,
  readBusinessProfile,
  readPhoneNumber,
  sealChannelSecret,
  secretTail,
  updateBusinessProfile,
  wabaHasPhoneNumber,
  type MetaApiError,
  type MetaCredentials,
  type MetaGraphClient,
  type PhoneNumberDetails,
  type SecretBox,
} from '@balesin/core';
import {
  isPgError,
  newId,
  PG_ERROR_CODES,
  type Channel,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  BUSINESS_PROFILE_CONFIRMED_FIELDS,
  BUSINESS_PROFILE_FIELDS,
  CHANNEL_TEST_MESSAGES,
  MAX_CHANNELS_PER_ORGANIZATION,
  numberWarnings,
  type BusinessProfile,
  type BusinessProfileField,
  type BusinessProfileResponse,
  type ChannelCredentialField,
  type ChannelSettingsListResponse,
  type ChannelSummaryListResponse,
  type ChannelTestCode,
  type ChannelTestResult,
  type ChannelWebhookResponse,
  type CreateChannelRequest,
  type CreateChannelResponse,
  type ErrorDetail,
  type IdentityConfirmation,
  type MetaErrorKind,
  type UpdateBusinessProfileRequest,
  type UpdateBusinessProfileResponse,
  type UpdateChannelRequest,
  type WhatsAppChannel,
  type WhatsAppNumberSummary,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import {
  noticeMetadata,
  queueChannelChangeNotices,
  type ChannelChangeActor,
} from './channel-change-notice';
import {
  SUBSCRIBE_FIELDS,
  toChannelSummary,
  toWhatsAppChannel,
  webhookUrlFor,
  webhookUrlWarning,
} from './channel-view';
import {
  countChannels,
  findChannel,
  insertChannel,
  listChannels,
  recordChannelTest,
  updateChannel,
  type ChannelChanges,
} from './channels.repo';

/**
 * Channel WhatsApp Cloud API (ROADMAP Fase 2 butir 1–2; docs/KONTRAK-API-CHANNEL.md): wizard
 * koneksi, ganti kredensial, nonaktifkan/hapus, tes koneksi, URL webhook + verify token, profil
 * bisnis. Semua query terfilter organisasi pelaku; channel organisasi lain = 404.
 *
 * Rahasia: token System User, App Secret, dan verify token dienkripsi `SecretBox` dengan konteks
 * organisasi + kolom + ID channel; respons/log/audit hanya pernah melihat ekornya (••••abcd).
 */

export interface ChannelContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
  presentedDeviceToken?: string;
}

export interface ChannelsService {
  readonly canStoreSecrets: boolean;
  listSummaries(auth: AuthContext): Promise<ChannelSummaryListResponse>;
  listSettings(auth: AuthContext): Promise<ChannelSettingsListResponse>;
  get(auth: AuthContext, channelId: string): Promise<WhatsAppChannel>;
  create(
    auth: AuthContext,
    input: CreateChannelRequest,
    context: ChannelContext,
  ): Promise<CreateChannelResponse>;
  update(
    auth: AuthContext,
    channelId: string,
    input: UpdateChannelRequest,
    context: ChannelContext,
  ): Promise<WhatsAppChannel>;
  setEnabled(
    auth: AuthContext,
    channelId: string,
    enabled: boolean,
    context: ChannelContext,
  ): Promise<WhatsAppChannel>;
  remove(
    auth: AuthContext,
    channelId: string,
    confirmation: IdentityConfirmation,
    context: ChannelContext,
  ): Promise<void>;
  test(auth: AuthContext, channelId: string, context: ChannelContext): Promise<ChannelTestResult>;
  webhook(auth: AuthContext, channelId: string): Promise<ChannelWebhookResponse>;
  rotateVerifyToken(
    auth: AuthContext,
    channelId: string,
    context: ChannelContext,
  ): Promise<ChannelWebhookResponse>;
  readBusinessProfile(auth: AuthContext, channelId: string): Promise<BusinessProfileResponse>;
  updateBusinessProfile(
    auth: AuthContext,
    channelId: string,
    input: UpdateBusinessProfileRequest,
    context: ChannelContext,
  ): Promise<UpdateBusinessProfileResponse>;
}

export interface ChannelsServiceDeps {
  db: Database;
  /** `null` = `BALESIN_MASTER_KEY` kosong (hanya development/test): channel tidak bisa disimpan. */
  secretBox: SecretBox | null;
  meta: MetaGraphClient;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  /** Pemberitahuan ke Owner saat channel diubah selain Owner (`channel-change-notice.ts`). */
  notifier: Pick<EmailNotifier, 'channelChanged'>;
  /** Alamat publik API (untuk URL webhook). */
  apiUrl: string;
  now?: () => Date;
}

const NOT_FOUND_MESSAGE = 'Channel tidak ditemukan. Mungkin sudah dihapus.';
const NO_MASTER_KEY_MESSAGE =
  'Kredensial channel belum bisa disimpan karena BALESIN_MASTER_KEY belum diisi di berkas .env server. ' +
  'Isi dulu (lihat .env.example), jalankan ulang aplikasi, lalu coba lagi.';
const SECRET_UNAVAILABLE_MESSAGE =
  'Kredensial tersimpan channel ini tidak bisa dibuka (BALESIN_MASTER_KEY server berubah). ' +
  'Masukkan ulang token System User dan App Secret di pengaturan channel.';
const PHONE_CONFLICT_MESSAGE =
  'Nomor dengan Phone Number ID ini sudah terhubung sebagai channel lain. Ubah atau hapus channel itu dulu.';
const LIVE_PHONE_INDEX = 'channels_organization_id_wa_phone_number_id_live_unique';
/**
 * Tenggat total satu operasi yang memanggil Meta (tes koneksi = sampai 7 panggilan; profil bisnis =
 * baca + ubah + baca ulang): permintaan HTTP tidak tertahan menit-menit saat Meta lambat (review R5).
 */
export const META_OPERATION_DEADLINE_MS = 25_000;
/**
 * Pemberitahuan perubahan profil bisnis baru boleh diambil worker setelah jeda ini (> tenggat Meta):
 * saat itu sudah diketahui apakah Meta menerima perubahannya (baris audit `…_update_failed`).
 */
export const BUSINESS_PROFILE_NOTICE_DELAY_MS = META_OPERATION_DEADLINE_MS + 5_000;

const CONFIRMATION_REQUIRED = {
  create: 'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menambahkan channel.',
  credentials:
    'Masukkan password-mu (dan kode verifikasi dua langkah) untuk mengganti kredensial channel.',
  businessProfile:
    'Masukkan password-mu (dan kode verifikasi dua langkah) untuk mengubah profil bisnis.',
} as const;

function confirmationRequired(message: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [bodyDetail('confirmation.password', message)],
  });
}

/** Nilai profil bisnis satu isian sebagai teks audit/email (website dipisah koma). */
function profileValue(
  profile: BusinessProfile | UpdateBusinessProfileRequest,
  field: BusinessProfileField,
): string {
  const value = profile[field];
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
}

function bodyDetail(field: string, message: string): ErrorDetail {
  return { location: 'body', field, message };
}

/** Kesalahan konfirmasi identitas (field `password`/`code`) dipindah ke bawah `prefix`. */
function prefixFields(error: unknown, prefix: string): unknown {
  if (!(error instanceof AppError) || !error.details) return error;
  return new AppError(error.code, {
    message: error.message,
    statusCode: error.statusCode,
    details: error.details.map((detail) => ({ ...detail, field: `${prefix}${detail.field}` })),
    retryAfterSeconds: error.retryAfterSeconds,
    cause: error.cause,
  });
}

/** Jenis kesalahan Meta → kode hasil tes, sesuai langkah yang sedang dites. */
function testCodeFor(kind: MetaErrorKind, step: 'phone' | 'waba'): ChannelTestCode {
  switch (kind) {
    case 'token_invalid':
    case 'token_expired':
    case 'app_secret_invalid':
    case 'permission_denied':
    case 'phone_not_registered':
    case 'account_restricted':
    case 'rate_limited':
    case 'network_error':
    case 'unexpected_response':
      return kind;
    case 'not_found':
      return step === 'phone' ? 'phone_number_not_found' : 'waba_not_found';
    case 'temporarily_unavailable':
      return 'meta_unavailable';
    case 'invalid_parameter':
    case 'payment_required':
    case 'unknown':
      return 'unknown';
  }
}

function summaryOf(details: PhoneNumberDetails, fetchedAt: Date): WhatsAppNumberSummary {
  return {
    displayPhoneNumber: details.displayPhoneNumber,
    verifiedName: details.verifiedName,
    qualityRating: details.qualityRating,
    status: details.status,
    nameStatus: details.nameStatus,
    codeVerificationStatus: details.codeVerificationStatus,
    messagingLimit: details.messagingLimit,
    throughputLevel: details.throughputLevel,
    fetchedAt: fetchedAt.toISOString(),
  };
}

/** Kesalahan Meta saat meneruskan permintaan (profil bisnis) → 502 dengan pesan Indonesia. */
function metaRequestFailed(error: MetaApiError): AppError {
  const message =
    error.kind === 'not_found' ? CHANNEL_TEST_MESSAGES.phone_number_not_found : error.message;
  return new AppError('META_REQUEST_FAILED', {
    message,
    cause: error,
    ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  });
}

export function createChannelsService(deps: ChannelsServiceDeps): ChannelsService {
  const { db, secretBox, meta, twoFactor, notifier, apiUrl } = deps;
  const now = deps.now ?? (() => new Date());

  const actorOf = (auth: AuthContext): ChannelChangeActor => ({
    userId: auth.user.id,
    role: auth.user.role,
  });

  /** Owner aktif diberi tahu (bila pelakunya bukan Owner) — di dalam transaksi `tx`. */
  const notifyOwners = (tx: DbExecutor, auth: AuthContext, auditLogId: string) =>
    queueChannelChangeNotices(tx, notifier, {
      organizationId: auth.organizationId,
      actor: actorOf(auth),
      auditLogId,
    });

  function requireBox(): SecretBox {
    if (!secretBox) throw new AppError('SERVICE_UNAVAILABLE', { message: NO_MASTER_KEY_MESSAGE });
    return secretBox;
  }

  async function load(auth: AuthContext, channelId: string): Promise<Channel> {
    const row = await findChannel(db, auth.organizationId, channelId);
    if (!row || row.type !== 'whatsapp') throw notFound();
    return row;
  }

  function credentialsOf(row: Channel): MetaCredentials | null {
    if (!secretBox) return null;
    try {
      return openWhatsAppCredentials(secretBox, row);
    } catch {
      return null;
    }
  }

  function requireCredentials(row: Channel): MetaCredentials {
    const credentials = credentialsOf(row);
    if (!credentials) {
      throw new AppError('SERVICE_UNAVAILABLE', { message: SECRET_UNAVAILABLE_MESSAGE });
    }
    return credentials;
  }

  function webhookView(row: Channel, box: SecretBox): ChannelWebhookResponse {
    if (row.waVerifyTokenEncrypted === null || row.waVerifyTokenRotatedAt === null)
      throw notFound();
    let verifyToken: string;
    try {
      verifyToken = openChannelSecret(box, row, 'verifyToken', row.waVerifyTokenEncrypted).reveal();
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message:
          'Verify token tersimpan tidak bisa dibuka (BALESIN_MASTER_KEY server berubah). Buat ulang verify token, lalu pasang lagi di Meta.',
      });
    }
    return {
      channelId: row.id,
      callbackUrl: webhookUrlFor(apiUrl, row.id),
      verifyToken,
      verifyTokenRotatedAt: row.waVerifyTokenRotatedAt.toISOString(),
      subscribeFields: SUBSCRIBE_FIELDS,
      warning: webhookUrlWarning(apiUrl),
    };
  }

  function rethrowConflict(error: unknown): never {
    if (isPgError(error, PG_ERROR_CODES.uniqueViolation, LIVE_PHONE_INDEX)) {
      throw new AppError('CONFLICT', {
        message: PHONE_CONFLICT_MESSAGE,
        details: [bodyDetail('phoneNumberId', PHONE_CONFLICT_MESSAGE)],
      });
    }
    throw error;
  }

  async function confirm(
    auth: AuthContext,
    input: IdentityConfirmation,
    action: string,
    context: ChannelContext,
    fieldPrefix = '',
  ) {
    try {
      await twoFactor.confirmIdentity(
        auth,
        { password: input.password, code: input.code },
        action,
        context,
      );
    } catch (error) {
      throw fieldPrefix === '' ? error : prefixFields(error, fieldPrefix);
    }
  }

  /** Isian kredensial yang BENAR-BENAR berubah (token/App Secret dibandingkan waktu-konstan). */
  function changedCredentialFields(
    row: Channel,
    input: UpdateChannelRequest,
    stored: MetaCredentials | null,
  ): ChannelCredentialField[] {
    const changed: ChannelCredentialField[] = [];
    if (input.phoneNumberId !== undefined && input.phoneNumberId !== row.waPhoneNumberId) {
      changed.push('phoneNumberId');
    }
    if (input.wabaId !== undefined && input.wabaId !== row.waBusinessAccountId) {
      changed.push('wabaId');
    }
    if (
      input.accessToken !== undefined &&
      (!stored || !constantTimeEqual(input.accessToken, stored.accessToken.reveal()))
    ) {
      changed.push('accessToken');
    }
    if (
      input.appSecret !== undefined &&
      (!stored || !constantTimeEqual(input.appSecret, stored.appSecret?.reveal() ?? ''))
    ) {
      changed.push('appSecret');
    }
    return changed;
  }

  async function runTest(
    row: Channel,
    credentials: MetaCredentials,
  ): Promise<{
    code: ChannelTestCode;
    number: WhatsAppNumberSummary | null;
    metaCode: number | null;
  }> {
    const phoneNumberId = row.waPhoneNumberId ?? '';
    const wabaId = row.waBusinessAccountId ?? '';
    // Satu tenggat untuk SEMUA panggilan tes ini (review R5).
    const options = { signal: AbortSignal.timeout(META_OPERATION_DEADLINE_MS) };
    let number: WhatsAppNumberSummary;
    try {
      number = summaryOf(await readPhoneNumber(meta, credentials, phoneNumberId, options), now());
    } catch (error) {
      if (!isMetaApiError(error)) throw error;
      return { code: testCodeFor(error.kind, 'phone'), number: null, metaCode: error.metaCode };
    }
    try {
      const belongs = await wabaHasPhoneNumber(meta, credentials, wabaId, phoneNumberId, options);
      return { code: belongs ? 'ok' : 'phone_number_waba_mismatch', number, metaCode: null };
    } catch (error) {
      if (!isMetaApiError(error)) throw error;
      return { code: testCodeFor(error.kind, 'waba'), number, metaCode: error.metaCode };
    }
  }

  return {
    canStoreSecrets: secretBox !== null,

    async listSummaries(auth) {
      const rows = await listChannels(db, auth.organizationId);
      return { channels: rows.map(toChannelSummary) };
    },

    async listSettings(auth) {
      const rows = await listChannels(db, auth.organizationId);
      return {
        channels: rows
          .filter((row) => row.type === 'whatsapp')
          .map((row) => toWhatsAppChannel(row, apiUrl)),
        canStoreSecrets: secretBox !== null,
        maxChannels: MAX_CHANNELS_PER_ORGANIZATION,
      };
    },

    async get(auth, channelId) {
      return toWhatsAppChannel(await load(auth, channelId), apiUrl);
    },

    async create(auth, input, context) {
      const box = requireBox();
      // Channel baru dengan App Secret milik orang lain = pesan masuk bisa dipalsukan (review
      // channel R2). Semua peran, Owner juga: cookie Owner curian tidak cukup (review akhir S1).
      if (!input.confirmation) throw confirmationRequired(CONFIRMATION_REQUIRED.create);
      await confirm(auth, input.confirmation, 'channel.create', context, 'confirmation.');
      const id = newId();
      const owner = { id, organizationId: auth.organizationId };
      const createdAt = now();
      const verifyToken = newWebhookVerifyToken();

      const row = await db
        .transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
          // Pembuatan bersamaan berurutan per organisasi: batas jumlah channel tidak terlewati.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`channels-create|${auth.organizationId}`}, 0))`,
          );
          if ((await countChannels(tx, auth.organizationId)) >= MAX_CHANNELS_PER_ORGANIZATION) {
            throw new AppError('CONFLICT', {
              message: `Batas ${MAX_CHANNELS_PER_ORGANIZATION} channel per organisasi sudah tercapai. Hapus channel yang tidak dipakai dulu.`,
            });
          }
          const inserted = await insertChannel(tx, {
            id,
            organizationId: auth.organizationId,
            type: 'whatsapp',
            name: input.name,
            waPhoneNumberId: input.phoneNumberId,
            waBusinessAccountId: input.wabaId,
            waAccessTokenEncrypted: sealChannelSecret(box, owner, 'accessToken', input.accessToken),
            waAccessTokenTail: secretTail(input.accessToken),
            waAppSecretEncrypted: sealChannelSecret(box, owner, 'appSecret', input.appSecret),
            waAppSecretTail: secretTail(input.appSecret),
            waVerifyTokenEncrypted: sealChannelSecret(box, owner, 'verifyToken', verifyToken),
            waVerifyTokenRotatedAt: createdAt,
            credentialsUpdatedAt: createdAt,
            createdByUserId: auth.user.id,
            updatedByUserId: auth.user.id,
          });
          const auditLogId = await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.channelCreated,
            targetType: 'channel',
            targetId: id,
            metadata: {
              type: 'whatsapp',
              name: input.name,
              phoneNumberId: input.phoneNumberId,
              wabaId: input.wabaId,
              ...noticeMetadata(actorOf(auth), 'created'),
            },
            client: context.client,
          });
          await notifyOwners(tx, auth, auditLogId);
          return inserted;
        })
        .catch(rethrowConflict);

      return { channel: toWhatsAppChannel(row, apiUrl), webhook: webhookView(row, box) };
    },

    async update(auth, channelId, input, context) {
      const row = await load(auth, channelId);
      const stored = credentialsOf(row);
      const changed = changedCredentialFields(row, input, stored);
      const nameChanged = input.name !== undefined && input.name !== row.name;

      if (changed.length === 0 && !nameChanged) return toWhatsAppChannel(row, apiUrl);

      const changes: ChannelChanges = {};
      if (nameChanged) changes.name = input.name;
      if (changed.length > 0) {
        const box = requireBox();
        if (!input.confirmation) throw confirmationRequired(CONFIRMATION_REQUIRED.credentials);
        await confirm(auth, input.confirmation, 'channel.credentials', context, 'confirmation.');

        const owner = { id: row.id, organizationId: auth.organizationId };
        if (changed.includes('phoneNumberId')) changes.waPhoneNumberId = input.phoneNumberId;
        if (changed.includes('wabaId')) changes.waBusinessAccountId = input.wabaId;
        if (changed.includes('accessToken') && input.accessToken !== undefined) {
          changes.waAccessTokenEncrypted = sealChannelSecret(
            box,
            owner,
            'accessToken',
            input.accessToken,
          );
          changes.waAccessTokenTail = secretTail(input.accessToken);
        }
        if (changed.includes('appSecret') && input.appSecret !== undefined) {
          changes.waAppSecretEncrypted = sealChannelSecret(
            box,
            owner,
            'appSecret',
            input.appSecret,
          );
          changes.waAppSecretTail = secretTail(input.appSecret);
        }
        // Kredensial baru = status kembali "belum dites"; data nomor lama tidak berlaku lagi.
        Object.assign(changes, {
          credentialsUpdatedAt: now(),
          lastTestOk: null,
          lastTestCode: null,
          lastTestedAt: null,
          waNumberSummary: null,
        } satisfies ChannelChanges);
      }

      const updated = await db
        .transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
          const next = await updateChannel(tx, auth.organizationId, row.id, {
            ...changes,
            updatedByUserId: auth.user.id,
          });
          if (!next) throw notFound();
          const credentialsChanged = changed.length > 0;
          const auditLogId = await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.channelUpdated,
            targetType: 'channel',
            targetId: row.id,
            // Hanya NAMA isian yang diganti — nilai token/App Secret tidak pernah dicatat.
            metadata: {
              changedFields: [...(nameChanged ? ['name'] : []), ...changed],
              name: next.name,
              previousName: nameChanged ? row.name : null,
              phoneNumberId: next.waPhoneNumberId,
              previousPhoneNumberId: changed.includes('phoneNumberId') ? row.waPhoneNumberId : null,
              wabaId: next.waBusinessAccountId,
              // Ganti nama saja tidak diberitahukan ke Owner.
              ...(credentialsChanged
                ? noticeMetadata(actorOf(auth), 'credentials_changed')
                : { actorRole: auth.user.role }),
            },
            client: context.client,
          });
          if (credentialsChanged) await notifyOwners(tx, auth, auditLogId);
          return next;
        })
        .catch(rethrowConflict);
      return toWhatsAppChannel(updated, apiUrl);
    },

    async setEnabled(auth, channelId, enabled, context) {
      const row = await load(auth, channelId);
      if (row.enabled === enabled) return toWhatsAppChannel(row, apiUrl);
      const updated = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        const next = await updateChannel(tx, auth.organizationId, row.id, {
          enabled,
          updatedByUserId: auth.user.id,
        });
        if (!next) throw notFound();
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: enabled ? AUDIT_ACTIONS.channelEnabled : AUDIT_ACTIONS.channelDisabled,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            name: row.name,
            phoneNumberId: row.waPhoneNumberId,
            // Mengaktifkan kembali juga diberitahukan (review R3): channel yang sengaja
            // dinonaktifkan Owner tidak boleh bisa dihidupkan lagi diam-diam.
            ...noticeMetadata(actorOf(auth), enabled ? 'enabled' : 'disabled'),
          },
          client: context.client,
        });
        await notifyOwners(tx, auth, auditLogId);
        return next;
      });
      return toWhatsAppChannel(updated, apiUrl);
    },

    async remove(auth, channelId, confirmation, context) {
      const row = await load(auth, channelId);
      await confirm(auth, confirmation, 'channel.delete', context);
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        // Rahasia dimusnahkan; baris tetap untuk rujukan riwayat percakapan (fase berikutnya).
        const deleted = await updateChannel(tx, auth.organizationId, row.id, {
          deletedAt: now(),
          enabled: false,
          waAccessTokenEncrypted: null,
          waAccessTokenTail: null,
          waAppSecretEncrypted: null,
          waAppSecretTail: null,
          waVerifyTokenEncrypted: null,
          updatedByUserId: auth.user.id,
        });
        if (!deleted) throw notFound();
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelDeleted,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            name: row.name,
            phoneNumberId: row.waPhoneNumberId,
            wabaId: row.waBusinessAccountId,
            ...noticeMetadata(actorOf(auth), 'deleted'),
          },
          client: context.client,
        });
        await notifyOwners(tx, auth, auditLogId);
      });
    },

    async test(auth, channelId, context) {
      const row = await load(auth, channelId);
      const credentials = credentialsOf(row);
      const outcome = credentials
        ? await runTest(row, credentials)
        : { code: 'secret_unavailable' as const, number: null, metaCode: null };
      const ok = outcome.code === 'ok';
      const testedAt = now();

      await db.transaction(async (tx) => {
        const recorded = await recordChannelTest(
          tx,
          auth.organizationId,
          row.id,
          row.credentialsUpdatedAt,
          { ok, code: outcome.code, testedAt, number: outcome.number },
        );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelTested,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            code: outcome.code,
            metaCode: outcome.metaCode,
            qualityRating: outcome.number?.qualityRating ?? null,
            numberStatus: outcome.number?.status ?? null,
            // `false` = kredensial diganti selagi tes berjalan; hasil tidak dicatat sebagai status.
            recorded: recorded !== undefined,
          },
          client: context.client,
        });
      });
      context.log.info(
        { channelRef: row.id, code: outcome.code, metaCode: outcome.metaCode },
        'Tes koneksi channel WhatsApp selesai',
      );

      return {
        ok,
        code: outcome.code,
        message: CHANNEL_TEST_MESSAGES[outcome.code],
        testedAt: testedAt.toISOString(),
        number: outcome.number,
        warnings: ok ? numberWarnings(outcome.number) : [],
      };
    },

    async webhook(auth, channelId) {
      const box = requireBox();
      return webhookView(await load(auth, channelId), box);
    },

    async rotateVerifyToken(auth, channelId, context) {
      const box = requireBox();
      const row = await load(auth, channelId);
      const rotatedAt = now();
      const updated = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        const next = await updateChannel(tx, auth.organizationId, row.id, {
          waVerifyTokenEncrypted: sealChannelSecret(
            box,
            { id: row.id, organizationId: auth.organizationId },
            'verifyToken',
            newWebhookVerifyToken(),
          ),
          waVerifyTokenRotatedAt: rotatedAt,
          updatedByUserId: auth.user.id,
        });
        if (!next) throw notFound();
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelVerifyTokenRotated,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            name: row.name,
            phoneNumberId: row.waPhoneNumberId,
            ...noticeMetadata(actorOf(auth), 'verify_token_rotated'),
          },
          client: context.client,
        });
        await notifyOwners(tx, auth, auditLogId);
        return next;
      });
      return webhookView(updated, box);
    },

    async readBusinessProfile(auth, channelId) {
      const row = await load(auth, channelId);
      const credentials = requireCredentials(row);
      try {
        const profile = await readBusinessProfile(meta, credentials, row.waPhoneNumberId ?? '', {
          signal: AbortSignal.timeout(META_OPERATION_DEADLINE_MS),
        });
        return { profile, fetchedAt: now().toISOString() };
      } catch (error) {
        if (isMetaApiError(error)) throw metaRequestFailed(error);
        throw error;
      }
    },

    async updateBusinessProfile(auth, channelId, input, context) {
      const row = await load(auth, channelId);
      const credentials = requireCredentials(row);
      const phoneNumberId = row.waPhoneNumberId ?? '';
      const changedFields = BUSINESS_PROFILE_FIELDS.filter((field) => input[field] !== undefined);

      // Teks/tautan yang tampil ke pelanggan: wajib konfirmasi untuk semua peran, Owner juga
      // (review channel S1; review akhir Fase 1 S1 + putaran 2 N1). Kategori saja tidak.
      if (BUSINESS_PROFILE_CONFIRMED_FIELDS.some((field) => input[field] !== undefined)) {
        if (!input.confirmation) throw confirmationRequired(CONFIRMATION_REQUIRED.businessProfile);
        await confirm(
          auth,
          input.confirmation,
          'channel.business_profile',
          context,
          'confirmation.',
        );
      }

      // Satu tenggat untuk baca nilai lama + ubah + baca ulang (review R5).
      const options = { signal: AbortSignal.timeout(META_OPERATION_DEADLINE_MS) };
      // Nilai lama (data publik) dicatat di audit supaya bisa dibandingkan/dipulihkan. Bila tidak
      // terbaca, perubahan juga tidak dikirim (Meta yang sama hampir pasti menolaknya).
      let previous: BusinessProfile;
      try {
        previous = await readBusinessProfile(meta, credentials, phoneNumberId, options);
      } catch (error) {
        if (isMetaApiError(error)) throw metaRequestFailed(error);
        throw error;
      }

      // Audit + pemberitahuan Owner tercatat SEBELUM perubahan dikirim ke Meta (yang tidak bisa
      // ditarik kembali): bila antrean mati, tidak ada yang berubah (503). Job baru diambil worker
      // setelah tenggat Meta lewat, jadi penolakan Meta (baris `…_update_failed`) sudah tercatat.
      const auditLogId = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        const id = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelBusinessProfileUpdated,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            changedFields,
            previous: Object.fromEntries(
              changedFields.map((field) => [field, profileValue(previous, field)]),
            ),
            next: Object.fromEntries(
              changedFields.map((field) => [field, profileValue(input, field)]),
            ),
            name: row.name,
            phoneNumberId: row.waPhoneNumberId,
            ...noticeMetadata(actorOf(auth), 'business_profile_changed'),
          },
          client: context.client,
        });
        await queueChannelChangeNotices(tx, notifier, {
          organizationId: auth.organizationId,
          actor: actorOf(auth),
          auditLogId: id,
          delayMs: BUSINESS_PROFILE_NOTICE_DELAY_MS,
        });
        return id;
      });

      try {
        await updateBusinessProfile(meta, credentials, phoneNumberId, input, options);
      } catch (error) {
        await recordAudit(db, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelBusinessProfileUpdateFailed,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            auditLogId,
            kind: isMetaApiError(error) ? error.kind : 'internal',
            metaCode: isMetaApiError(error) ? error.metaCode : null,
          },
          client: context.client,
        });
        if (isMetaApiError(error)) throw metaRequestFailed(error);
        throw error;
      }
      try {
        const profile = await readBusinessProfile(meta, credentials, phoneNumberId, options);
        return { status: 'updated', profile, fetchedAt: now().toISOString() };
      } catch (error) {
        if (!isMetaApiError(error)) throw error;
        context.log.warn(
          { channelRef: row.id, kind: error.kind },
          'Profil bisnis tersimpan di Meta, tetapi gagal dibaca ulang',
        );
        return { status: 'updated', profile: null, fetchedAt: null };
      }
    },
  };
}
