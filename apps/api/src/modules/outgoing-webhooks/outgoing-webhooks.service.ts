import { randomBytes } from 'node:crypto';

import {
  AppError,
  WEBHOOK_TARGET_ERROR_MESSAGES,
  normalizePrivateCidr,
  parseWebhookUrl,
  type SecretBox,
} from '@balesin/core';
import {
  apiKeys,
  newId,
  organizations,
  webhookDeliveries,
  webhookEndpoints,
  type Database,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from '@balesin/db';
import {
  OUTGOING_WEBHOOKS_PER_ORGANIZATION_MAX,
  OUTGOING_WEBHOOK_SECRET_OVERLAP_HOURS,
  OUTGOING_WEBHOOK_TEST_EVENT,
  type CreateOutgoingWebhookRequest,
  type IdentityConfirmation,
  type OutgoingWebhook,
  type OutgoingWebhookEvent,
  type OutgoingWebhookFormat,
  type PrivateNetworkSettings,
  type UpdateOutgoingWebhookRequest,
  type WebhookDelivery,
} from '@balesin/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { parseApiKey, secretMatches } from '../api-keys/api-key-token';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { decodeCursor, encodeCursor } from '../inbox/inbox.repo';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';

/**
 * Pengaturan → Webhook keluar (Fase 3, docs/KONTRAK-WEBHOOK-KELUAR.md). Izin `integrations.manage`
 * (Owner/Admin). Konfirmasi identitas untuk: buat, ubah URL, rotasi rahasia, ubah allowlist IP
 * privat (semuanya menentukan ke mana data pelanggan dikirim). Nonaktifkan/hapus = tanpa
 * konfirmasi (arah aman). Rahasia `whsec_…` tampil SEKALI, disimpan terenkripsi.
 */

const NOT_FOUND = 'Webhook tidak ditemukan.';
const DELIVERY_NOT_FOUND = 'Riwayat pengiriman tidak ditemukan.';
const UNAVAILABLE =
  'Webhook keluar belum bisa dibuat: kunci master server belum diatur. Hubungi admin server.';

export interface WebhookContext extends TwoFactorContext {
  client: ClientInfo;
}

export interface OutgoingWebhooksService {
  list(organizationId: string): Promise<OutgoingWebhook[]>;
  create(
    auth: AuthContext,
    input: CreateOutgoingWebhookRequest,
    context: WebhookContext,
  ): Promise<{ webhook: OutgoingWebhook; secret: string }>;
  update(
    auth: AuthContext,
    id: string,
    input: UpdateOutgoingWebhookRequest,
    context: WebhookContext,
  ): Promise<OutgoingWebhook>;
  remove(auth: AuthContext, client: ClientInfo, id: string): Promise<void>;
  rotateSecret(
    auth: AuthContext,
    id: string,
    confirmation: IdentityConfirmation | undefined,
    context: WebhookContext,
    /** `revokePrevious` = rahasia lama langsung tidak berlaku (review Info 6). */
    options?: { revokePrevious?: boolean },
  ): Promise<{ webhook: OutgoingWebhook; secret: string }>;
  test(auth: AuthContext, id: string): Promise<WebhookDelivery>;
  deliveries(
    organizationId: string,
    id: string,
    page: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null }>;
  redeliver(auth: AuthContext, id: string, deliveryId: string): Promise<WebhookDelivery>;
  privateNetwork(organizationId: string): Promise<PrivateNetworkSettings>;
  updatePrivateNetwork(
    auth: AuthContext,
    cidrs: readonly string[],
    confirmation: IdentityConfirmation | undefined,
    context: WebhookContext,
  ): Promise<PrivateNetworkSettings>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'url-tidak-valid';
  }
}

/** Ringkasan key yang dipakai mode MobiChat (nama + status), tanpa rahasia. */
interface KeyInfo {
  name: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

function keyStatus(key: KeyInfo | undefined, at: Date): 'active' | 'expired' | 'revoked' {
  if (!key || key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt.getTime() <= at.getTime()) return 'expired';
  return 'active';
}

function toWebhook(
  row: WebhookEndpointRow,
  keys: ReadonlyMap<string, KeyInfo> = new Map(),
  at: Date = new Date(),
): OutgoingWebhook {
  const key = row.mobichatApiKeyId ? keys.get(row.mobichatApiKeyId) : undefined;
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events as OutgoingWebhookEvent[],
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    secretRotatedAt: row.secretRotatedAt.toISOString(),
    previousSecretExpiresAt: row.previousSecretExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    format: row.format as OutgoingWebhookFormat,
    botOnly: row.botOnly,
    mobichat:
      row.format === 'mobichat' && row.mobichatApiKeyId && row.mobichatApiKeyLast4
        ? {
            baseUrl: row.mobichatBaseUrl,
            apiKeyLast4: row.mobichatApiKeyLast4,
            apiKeyId: row.mobichatApiKeyId,
            apiKeyName: key?.name ?? null,
            apiKeyStatus: keyStatus(key, at),
          }
        : null,
  };
}

function toDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    httpStatus: row.httpStatus,
    durationMs: row.durationMs,
    error: row.errorCode,
    responseSnippet: row.responseSnippet,
    payloadPurged: row.payloadPurgedAt !== null || row.payload === null,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    nextAttemptAt: row.status === 'pending' ? (row.nextAttemptAt?.toISOString() ?? null) : null,
  };
}

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
const secretContext = (organizationId: string, id: string) => ({
  organizationId,
  purpose: 'webhook_endpoints.secret',
  subjectId: id,
});
/** AAD API key mode MobiChat (dibaca worker dengan konteks yang SAMA). */
export const mobichatKeyContext = (organizationId: string, id: string) => ({
  organizationId,
  purpose: 'webhook_endpoints.mobichat_api_key',
  subjectId: id,
});

/**
 * Alamat Balesin untuk `mobichat_base_url`: http/https, tanpa kredensial/query/fragmen, tanpa `/`
 * di akhir (workflow menambah `/api/public/...` sendiri).
 */
export function normalizeMobichatBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field, message }],
  });
}

export function createOutgoingWebhooksService(deps: {
  db: Database;
  secretBox: SecretBox | null;
  /** Pepper API key (verifikasi key yang ditempel di mode MobiChat). `null` = tanpa master key. */
  apiKeyPepper?: Buffer | null;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  /** HANYA tes: izinkan URL ke 127.0.0.1 (server penerima tiruan). */
  allowLoopback?: boolean;
  now?: () => Date;
}): OutgoingWebhooksService {
  const { db, secretBox, twoFactor } = deps;
  const now = deps.now ?? (() => new Date());

  function box(): SecretBox {
    if (!secretBox) throw new AppError('SERVICE_UNAVAILABLE', { message: UNAVAILABLE });
    return secretBox;
  }

  async function cidrsOf(organizationId: string): Promise<string[]> {
    const [row] = await db
      .select({ cidrs: organizations.webhookPrivateCidrs })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return row?.cidrs ?? [];
  }

  async function checkUrl(organizationId: string, url: string): Promise<string> {
    const parsed = parseWebhookUrl(url, await cidrsOf(organizationId), {
      allowLoopback: deps.allowLoopback ?? false,
    });
    if ('error' in parsed) throw invalid('url', WEBHOOK_TARGET_ERROR_MESSAGES[parsed.error]);
    return parsed.url.href;
  }

  async function keysOf(organizationId: string, rows: readonly WebhookEndpointRow[]) {
    const ids = [
      ...new Set(rows.map((row) => row.mobichatApiKeyId).filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return new Map<string, KeyInfo>();
    const found = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, organizationId), inArray(apiKeys.id, ids)));
    return new Map(found.map(({ id, ...info }) => [id, info] as const));
  }

  async function view(row: WebhookEndpointRow): Promise<OutgoingWebhook> {
    return toWebhook(row, await keysOf(row.organizationId, [row]), now());
  }

  /**
   * API key yang ditempel untuk mode MobiChat: harus key SAH milik organisasi ini (bentuk, rahasia,
   * belum dicabut/kedaluwarsa) — salah ketik atau key organisasi lain ditolak sebelum disimpan.
   */
  async function verifyMobichatKey(organizationId: string, token: string) {
    const parsed = parseApiKey(token.trim());
    const pepper = deps.apiKeyPepper ?? null;
    if (!pepper) throw new AppError('SERVICE_UNAVAILABLE', { message: UNAVAILABLE });
    const [key] = parsed
      ? await db
          .select()
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.organizationId, organizationId),
              eq(apiKeys.lookupKey, parsed.lookupKey),
            ),
          )
          .limit(1)
      : [];
    if (
      !parsed ||
      !key ||
      !secretMatches(pepper, parsed, key.secretHash) ||
      key.revokedAt !== null ||
      (key.expiresAt !== null && key.expiresAt.getTime() <= now().getTime())
    ) {
      throw invalid(
        'mobichat.apiKey',
        'API key tidak valid, sudah dicabut, atau kedaluwarsa. Tempel API key utuh dari Pengaturan → API key.',
      );
    }
    return { id: key.id, token: token.trim(), last4: token.trim().slice(-4) };
  }

  function checkBaseUrl(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value.trim() === '') return null;
    const normalized = normalizeMobichatBaseUrl(value);
    if (!normalized) {
      throw invalid(
        'mobichat.baseUrl',
        'Alamat Balesin harus diawali https:// (atau http://), tanpa nama pengguna, query, atau #.',
      );
    }
    return normalized;
  }

  async function one(organizationId: string, id: string): Promise<WebhookEndpointRow> {
    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)));
    if (!row) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
    return row;
  }

  const confirm = (
    auth: AuthContext,
    confirmation: IdentityConfirmation | undefined,
    action: string,
    context: WebhookContext,
    message: string,
  ) => requireIdentityConfirmation(twoFactor, auth, confirmation, action, context, message);

  return {
    async list(organizationId) {
      const rows = await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.organizationId, organizationId))
        .orderBy(desc(webhookEndpoints.createdAt));
      const keys = await keysOf(organizationId, rows);
      const at = now();
      return rows.map((row) => toWebhook(row, keys, at));
    },

    async create(auth, input, context) {
      const sealer = box();
      await confirm(
        auth,
        input.confirmation,
        'webhook.create',
        context,
        'Masukkan password (dan kode verifikasi) untuk membuat webhook.',
      );
      const url = await checkUrl(auth.organizationId, input.url);
      const format = input.format ?? 'native';
      const mobichatKey =
        format === 'mobichat' && input.mobichat
          ? await verifyMobichatKey(auth.organizationId, input.mobichat.apiKey)
          : null;
      const mobichatBaseUrl = format === 'mobichat' ? checkBaseUrl(input.mobichat?.baseUrl) : null;
      const id = newId();
      const secret = newSecret();
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.organizationId, auth.organizationId));
        if (Number(count?.total ?? 0) >= OUTGOING_WEBHOOKS_PER_ORGANIZATION_MAX) {
          throw new AppError('CONFLICT', {
            message: `Sudah ada ${String(OUTGOING_WEBHOOKS_PER_ORGANIZATION_MAX)} webhook (batas). Hapus yang tidak dipakai dulu.`,
          });
        }
        await tx.insert(webhookEndpoints).values({
          id,
          organizationId: auth.organizationId,
          url,
          description: input.description ?? null,
          events: [...input.events],
          format,
          botOnly: input.botOnly ?? false,
          secretEncrypted: sealer.encrypt(secret, secretContext(auth.organizationId, id)),
          ...(mobichatKey
            ? {
                mobichatBaseUrl,
                mobichatApiKeyId: mobichatKey.id,
                mobichatApiKeyLast4: mobichatKey.last4,
                mobichatApiKeyEncrypted: sealer.encrypt(
                  mobichatKey.token,
                  mobichatKeyContext(auth.organizationId, id),
                ),
              }
            : {}),
          createdByUserId: auth.user.id,
        });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.outgoingWebhookCreated,
          targetType: 'webhook',
          targetId: id,
          // Host saja: path/query URL bisa memuat token milik penerima.
          metadata: {
            change: 'created',
            host: hostOf(url),
            events: input.events.join(','),
            format,
            botOnly: input.botOnly ?? false,
            ...(mobichatKey
              ? {
                  mobichatApiKeyId: mobichatKey.id,
                  ...(mobichatBaseUrl ? { mobichatBaseHost: hostOf(mobichatBaseUrl) } : {}),
                }
              : {}),
            actorRole: role,
          },
          client: context.client,
        });
      });
      return { webhook: await view(await one(auth.organizationId, id)), secret };
    },

    async update(auth, id, input, context) {
      const current = await one(auth.organizationId, id);
      if (input.mobichat !== undefined && current.format !== 'mobichat') {
        throw invalid('mobichat', 'Pengaturan MobiChat hanya untuk webhook format MobiChat.');
      }
      if (
        input.events !== undefined &&
        current.format === 'mobichat' &&
        input.events.some((event) => event !== 'message.received')
      ) {
        throw invalid(
          'events',
          'Mode MobiChat hanya mengirim event "message.received" (pesan masuk).',
        );
      }
      // Kunci & alamat balik menentukan ke mana n8n mengirim API key → wajib konfirmasi identitas.
      const mobichatKey =
        input.mobichat?.apiKey !== undefined
          ? await verifyMobichatKey(auth.organizationId, input.mobichat.apiKey)
          : null;
      const baseUrlChange =
        input.mobichat?.baseUrl !== undefined ? checkBaseUrl(input.mobichat.baseUrl) : undefined;
      const baseUrlChanged =
        baseUrlChange !== undefined && baseUrlChange !== current.mobichatBaseUrl;
      if (mobichatKey || baseUrlChanged) {
        await confirm(
          auth,
          input.confirmation,
          'webhook.update_mobichat',
          context,
          'Masukkan password (dan kode verifikasi) untuk mengubah API key / alamat Balesin di webhook MobiChat.',
        );
      }
      let url: string | undefined;
      if (input.url !== undefined) {
        url = await checkUrl(auth.organizationId, input.url);
        if (url !== current.url) {
          await confirm(
            auth,
            input.confirmation,
            'webhook.update_url',
            context,
            'Masukkan password (dan kode verifikasi) untuk mengubah alamat webhook.',
          );
        } else {
          url = undefined;
        }
      }
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const patch: Partial<typeof webhookEndpoints.$inferInsert> = {};
        const changedFields: string[] = [];
        if (url !== undefined) {
          patch.url = url;
          changedFields.push('url');
        }
        if (input.events !== undefined) {
          patch.events = [...input.events];
          changedFields.push('events');
        }
        if (input.description !== undefined) {
          patch.description = input.description;
          changedFields.push('description');
        }
        if (input.botOnly !== undefined && input.botOnly !== current.botOnly) {
          patch.botOnly = input.botOnly;
          changedFields.push('botOnly');
        }
        if (mobichatKey) {
          const sealer = box();
          patch.mobichatApiKeyId = mobichatKey.id;
          patch.mobichatApiKeyLast4 = mobichatKey.last4;
          patch.mobichatApiKeyEncrypted = sealer.encrypt(
            mobichatKey.token,
            mobichatKeyContext(auth.organizationId, id),
          );
          changedFields.push('mobichatApiKey');
        }
        if (baseUrlChanged) {
          patch.mobichatBaseUrl = baseUrlChange;
          changedFields.push('mobichatBaseUrl');
        }
        if (input.enabled !== undefined && input.enabled !== current.enabled) {
          patch.enabled = input.enabled;
          patch.disabledReason = input.enabled ? null : 'manual';
          if (input.enabled) patch.consecutiveFailures = 0;
          changedFields.push('enabled');
        }
        if (changedFields.length === 0) return;
        await tx
          .update(webhookEndpoints)
          .set(patch)
          .where(
            and(
              eq(webhookEndpoints.organizationId, auth.organizationId),
              eq(webhookEndpoints.id, id),
            ),
          );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.outgoingWebhookUpdated,
          targetType: 'webhook',
          targetId: id,
          metadata: {
            change: 'updated',
            changedFields: changedFields.join(','),
            ...(url !== undefined ? { host: hostOf(url), previousHost: hostOf(current.url) } : {}),
            ...(input.events !== undefined ? { events: input.events.join(',') } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.botOnly !== undefined ? { botOnly: patch.botOnly } : {}),
            ...(mobichatKey ? { mobichatApiKeyId: mobichatKey.id } : {}),
            ...(baseUrlChanged
              ? { mobichatBaseHost: baseUrlChange ? hostOf(baseUrlChange) : 'APP_URL' }
              : {}),
            actorRole: role,
          },
          client: context.client,
        });
      });
      return view(await one(auth.organizationId, id));
    },

    async remove(auth, client, id) {
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [deleted] = await tx
          .delete(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.organizationId, auth.organizationId),
              eq(webhookEndpoints.id, id),
            ),
          )
          .returning({ url: webhookEndpoints.url });
        if (!deleted) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.outgoingWebhookDeleted,
          targetType: 'webhook',
          targetId: id,
          metadata: { host: hostOf(deleted.url), actorRole: role },
          client,
        });
      });
    },

    async rotateSecret(auth, id, confirmation, context, options = {}) {
      const sealer = box();
      await confirm(
        auth,
        confirmation,
        'webhook.rotate_secret',
        context,
        'Masukkan password (dan kode verifikasi) untuk membuat rahasia webhook baru.',
      );
      const secret = newSecret();
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [current] = await tx
          .select()
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.organizationId, auth.organizationId),
              eq(webhookEndpoints.id, id),
            ),
          )
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
        const at = now();
        await tx
          .update(webhookEndpoints)
          .set({
            secretEncrypted: sealer.encrypt(secret, secretContext(auth.organizationId, id)),
            secretRotatedAt: at,
            // Rahasia lama tetap ikut ditandatangani selama masa tumpang tindih — kecuali dicabut
            // seketika (rahasia bocor).
            previousSecretEncrypted: options.revokePrevious ? null : current.secretEncrypted,
            previousSecretExpiresAt: options.revokePrevious
              ? null
              : new Date(at.getTime() + OUTGOING_WEBHOOK_SECRET_OVERLAP_HOURS * 3600_000),
          })
          .where(eq(webhookEndpoints.id, id));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.outgoingWebhookSecretRotated,
          targetType: 'webhook',
          targetId: id,
          metadata: {
            change: 'secret_rotated',
            host: hostOf(current.url),
            revokePrevious: options.revokePrevious === true,
            actorRole: role,
          },
          client: context.client,
        });
      });
      return { webhook: await view(await one(auth.organizationId, id)), secret };
    },

    async test(auth, id) {
      const endpoint = await one(auth.organizationId, id);
      if (!endpoint.enabled) {
        throw new AppError('CONFLICT', { message: 'Aktifkan webhook dulu sebelum mengirim tes.' });
      }
      const eventId = newId();
      const at = now();
      const [row] = await db
        .insert(webhookDeliveries)
        .values({
          organizationId: auth.organizationId,
          endpointId: id,
          eventId,
          event: OUTGOING_WEBHOOK_TEST_EVENT,
          payload:
            endpoint.format === 'mobichat'
              ? {
                  event: OUTGOING_WEBHOOK_TEST_EVENT,
                  event_id: eventId,
                  created_at: at.toISOString(),
                  message_text: 'Event tes dari Pengaturan → Webhook.',
                  message_type: 'text',
                  sender: 'system',
                  message: {
                    type: 'system',
                    sender: 'system',
                    text: 'Event tes dari Pengaturan → Webhook.',
                    attachments: [],
                  },
                }
              : {
                  id: eventId,
                  event: OUTGOING_WEBHOOK_TEST_EVENT,
                  created_at: at.toISOString(),
                  data: { message: 'Event tes dari Pengaturan → Webhook.' },
                },
          nextAttemptAt: at,
        })
        .returning();
      if (!row) throw new Error('Pengiriman tes tidak tersimpan');
      return toDelivery(row);
    },

    async deliveries(organizationId, id, page) {
      await one(organizationId, id);
      const limit = page.limit ?? 30;
      const cursor = page.cursor ? decodeCursor(page.cursor) : undefined;
      if (page.cursor && !cursor) {
        throw new AppError('VALIDATION_ERROR', { message: 'Kursor halaman tidak valid.' });
      }
      const rows = await db
        .select({
          row: webhookDeliveries,
          exact: sql<string>`to_char(${webhookDeliveries.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.organizationId, organizationId),
            eq(webhookDeliveries.endpointId, id),
            cursor
              ? sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${cursor.atExact}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(limit + 1);
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        deliveries: visible.map(({ row }) => toDelivery(row)),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ atExact: last.exact, id: last.row.id })
            : null,
      };
    },

    async redeliver(auth, id, deliveryId) {
      const endpoint = await one(auth.organizationId, id);
      if (!endpoint.enabled) {
        throw new AppError('CONFLICT', {
          message: 'Aktifkan webhook dulu sebelum mengirim ulang.',
        });
      }
      const [original] = await db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.organizationId, auth.organizationId),
            eq(webhookDeliveries.endpointId, id),
            eq(webhookDeliveries.id, deliveryId),
          ),
        );
      if (!original) throw new AppError('NOT_FOUND', { message: DELIVERY_NOT_FOUND });
      if (!original.payload || original.payloadPurgedAt) {
        throw new AppError('CONFLICT', {
          message:
            'Isi pengiriman ini sudah dihapus (lewat masa simpan), jadi tidak bisa dikirim ulang.',
        });
      }
      const [row] = await db
        .insert(webhookDeliveries)
        .values({
          organizationId: auth.organizationId,
          endpointId: id,
          eventId: original.eventId,
          event: original.event,
          payload: original.payload,
          nextAttemptAt: now(),
          redeliveryOfId: original.id,
        })
        .returning();
      if (!row) throw new Error('Kirim ulang tidak tersimpan');
      return toDelivery(row);
    },

    async privateNetwork(organizationId) {
      return { cidrs: await cidrsOf(organizationId) };
    },

    async updatePrivateNetwork(auth, cidrs, confirmation, context) {
      const normalized: string[] = [];
      for (const cidr of cidrs) {
        const value = normalizePrivateCidr(cidr);
        if (!value) {
          throw invalid(
            'cidrs',
            `"${cidr.slice(0, 64)}" bukan jaringan privat yang sah (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7).`,
          );
        }
        normalized.push(value);
      }
      const unique = [...new Set(normalized)];
      await confirm(
        auth,
        confirmation,
        'webhook.private_network',
        context,
        'Masukkan password (dan kode verifikasi) untuk mengubah allowlist IP privat.',
      );
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [current] = await tx
          .select({ cidrs: organizations.webhookPrivateCidrs })
          .from(organizations)
          .where(eq(organizations.id, auth.organizationId))
          .for('update');
        await tx
          .update(organizations)
          .set({ webhookPrivateCidrs: unique })
          .where(eq(organizations.id, auth.organizationId));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.privateNetworkUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          metadata: {
            change: 'private_network',
            previous: (current?.cidrs ?? []).join(','),
            cidrs: unique.join(','),
            actorRole: role,
          },
          client: context.client,
        });
      });
      return { cidrs: unique };
    },
  };
}
