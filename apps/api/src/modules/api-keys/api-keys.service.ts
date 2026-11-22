import { AppError } from '@balesin/core';
import {
  apiKeyEmailSenders,
  apiKeys,
  channels,
  organizations,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  API_KEYS_PER_ORGANIZATION_MAX,
  API_KEY_DAILY_SEND_DEFAULT,
  apiKeyHasEmailScope,
  emailSenderId,
  parseEmailSenderId,
  type ApiKey,
  type ApiKeyScope,
  type ApiSettings,
  type CreateApiKeyRequest,
  type UpdateApiKeyRequest,
} from '@balesin/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { normalizeAttachmentHost } from '../email-send/attachment-hosts';
import { displayPrefix, generateApiKey, normalizeIpRule } from './api-key-token';

/**
 * Pengaturan → API key (Fase 3, docs/KONTRAK-API-PUBLIK.md "Mengelola API key"). Izin
 * `api_keys.manage` (Owner/Admin, PRD §4). Membuat key = konfirmasi identitas (membuka akses
 * mesin ke data pelanggan & pengiriman); mencabut = TANPA konfirmasi (arah aman, harus cepat).
 * Keduanya diaudit dan muncul sebagai kejadian keamanan `api_key_changed` (banner Owner/Admin).
 */

const NOT_FOUND = 'API key tidak ditemukan.';
const UNAVAILABLE =
  'API key belum bisa dibuat: kunci master server belum diatur. Hubungi admin server.';
const MAX_EXPIRY_MS = 2 * 366 * 24 * 60 * 60 * 1000;

export interface ApiKeysService {
  list(organizationId: string): Promise<ApiKey[]>;
  create(
    auth: AuthContext,
    input: CreateApiKeyRequest,
    context: TwoFactorContext,
  ): Promise<{ apiKey: ApiKey; secret: string }>;
  revoke(auth: AuthContext, client: ClientInfo, id: string): Promise<ApiKey>;
  /** Tahap 9.1: ubah pengirim email & host lampiran (SELALU konfirmasi identitas). */
  update(
    auth: AuthContext,
    id: string,
    input: UpdateApiKeyRequest,
    context: TwoFactorContext,
  ): Promise<ApiKey>;
  settings(organizationId: string): Promise<ApiSettings>;
  updateSettings(auth: AuthContext, client: ClientInfo, input: ApiSettings): Promise<ApiSettings>;
}

export function createApiKeysService(deps: {
  db: Database;
  pepper: Buffer | null;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  now?: () => Date;
}): ApiKeysService {
  const { db, pepper, twoFactor } = deps;
  const now = deps.now ?? (() => new Date());

  async function select(organizationId: string, id?: string): Promise<ApiKey[]> {
    const rows = await db
      .select({ key: apiKeys, creatorName: users.name })
      .from(apiKeys)
      .leftJoin(
        users,
        and(
          eq(users.organizationId, apiKeys.organizationId),
          eq(users.id, apiKeys.createdByUserId),
        ),
      )
      .where(
        and(
          eq(apiKeys.organizationId, organizationId),
          id === undefined ? undefined : eq(apiKeys.id, id),
        ),
      )
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
    const at = now().getTime();
    const senders = await emailSendersOf(
      db,
      organizationId,
      rows.map((row) => row.key.id),
    );
    return rows.map(({ key, creatorName }) => ({
      id: key.id,
      name: key.name,
      displayPrefix: displayPrefix(key.lookupKey),
      scopes: key.scopes as ApiKeyScope[],
      allowedIps: key.allowedIps,
      dailySendLimit: key.dailySendLimit,
      expiresAt: key.expiresAt?.toISOString() ?? null,
      revokedAt: key.revokedAt?.toISOString() ?? null,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      createdBy:
        key.createdByUserId && creatorName ? { id: key.createdByUserId, name: creatorName } : null,
      createdAt: key.createdAt.toISOString(),
      status: key.revokedAt
        ? 'revoked'
        : key.expiresAt && key.expiresAt.getTime() <= at
          ? 'expired'
          : 'active',
      emailSenders: senders.get(key.id) ?? [],
      emailAttachmentHosts: key.emailAttachmentHosts,
    }));
  }

  async function one(organizationId: string, id: string): Promise<ApiKey> {
    const [found] = await select(organizationId, id);
    if (!found) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
    return found;
  }

  function invalid(field: string, message: string): AppError {
    return new AppError('VALIDATION_ERROR', {
      message,
      details: [{ location: 'body', field, message }],
    });
  }

  /**
   * Pengirim email untuk key (§2): wajib ≥ 1 bila key memegang `email:*`, selain itu harus kosong.
   * Hanya Channel Email yang hidup di organisasi ini (akun Email `acc_…` baru dibuka di 9B; akun
   * pribadi tidak pernah). Mengembalikan ID channel.
   */
  async function resolveSenders(
    executor: DbExecutor,
    organizationId: string,
    scopes: readonly string[],
    senderIds: readonly string[] | undefined,
  ): Promise<string[]> {
    const ids = senderIds ?? [];
    if (!apiKeyHasEmailScope(scopes)) {
      if (ids.length > 0) {
        throw invalid(
          'emailSenderIds',
          'Pengirim email hanya bisa dipilih untuk key dengan scope email:read atau email:send.',
        );
      }
      return [];
    }
    if (ids.length === 0) {
      throw invalid(
        'emailSenderIds',
        'Pilih minimal satu pengirim email untuk key dengan scope email.',
      );
    }
    const channelIds: string[] = [];
    for (const id of ids) {
      const parsed = parseEmailSenderId(id);
      if (!parsed) throw invalid('emailSenderIds', `Pengirim "${id.slice(0, 80)}" tidak dikenal.`);
      if (parsed.kind !== 'channel') {
        throw invalid(
          'emailSenderIds',
          'Akun Email belum bisa dipakai sebagai pengirim API. Pilih Channel Email.',
        );
      }
      channelIds.push(parsed.id);
    }
    const unique = [...new Set(channelIds)];
    const found = await executor
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, organizationId),
          eq(channels.type, 'email'),
          isNull(channels.deletedAt),
          inArray(channels.id, unique),
        ),
      );
    if (found.length !== unique.length) {
      throw invalid(
        'emailSenderIds',
        'Ada pengirim email yang tidak ditemukan atau sudah dihapus.',
      );
    }
    return unique;
  }

  function resolveHosts(scopes: readonly string[], hosts: readonly string[] | undefined): string[] {
    const values = hosts ?? [];
    if (values.length > 0 && !apiKeyHasEmailScope(scopes)) {
      throw invalid(
        'emailAttachmentHosts',
        'Host lampiran hanya untuk key dengan scope email:send.',
      );
    }
    const normalized: string[] = [];
    for (const value of values) {
      const host = normalizeAttachmentHost(value);
      if (!host) {
        throw invalid('emailAttachmentHosts', `Host "${value.slice(0, 80)}" tidak valid.`);
      }
      normalized.push(host);
    }
    return [...new Set(normalized)];
  }

  async function replaceSenders(
    tx: DbExecutor,
    organizationId: string,
    apiKeyId: string,
    channelIds: readonly string[],
  ) {
    await tx
      .delete(apiKeyEmailSenders)
      .where(
        and(
          eq(apiKeyEmailSenders.organizationId, organizationId),
          eq(apiKeyEmailSenders.apiKeyId, apiKeyId),
        ),
      );
    if (channelIds.length === 0) return;
    await tx.insert(apiKeyEmailSenders).values(
      channelIds.map((channelId) => ({
        organizationId,
        apiKeyId,
        senderKind: 'channel',
        channelId,
      })),
    );
  }

  return {
    list: (organizationId) => select(organizationId),

    async create(auth, input, context) {
      if (!pepper) throw new AppError('SERVICE_UNAVAILABLE', { message: UNAVAILABLE });
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        input.confirmation,
        'api_key.create',
        context,
        'Masukkan password (dan kode verifikasi) untuk membuat API key.',
      );
      const at = now();
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= at.getTime()) {
        throw invalid('expiresAt', 'Tanggal kedaluwarsa harus di masa depan.');
      }
      if (expiresAt && expiresAt.getTime() - at.getTime() > MAX_EXPIRY_MS) {
        throw invalid('expiresAt', 'Kedaluwarsa maksimal 2 tahun dari sekarang.');
      }
      let allowedIps: string[] | null = null;
      if (input.allowedIps && input.allowedIps.length > 0) {
        allowedIps = [];
        for (const rule of input.allowedIps) {
          const normalized = normalizeIpRule(rule);
          if (!normalized) {
            throw invalid('allowedIps', `Alamat IP/CIDR "${rule.slice(0, 64)}" tidak valid.`);
          }
          allowedIps.push(normalized);
        }
        allowedIps = [...new Set(allowedIps)];
      }
      const emailAttachmentHosts = resolveHosts(input.scopes, input.emailAttachmentHosts);
      const generated = generateApiKey(pepper);
      const id = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'api_keys.manage');
        const senderChannelIds = await resolveSenders(
          tx,
          auth.organizationId,
          input.scopes,
          input.emailSenderIds,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`api-keys:${auth.organizationId}`}, 0))`,
        );
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(and(eq(apiKeys.organizationId, auth.organizationId), isNull(apiKeys.revokedAt)));
        if (Number(count?.total ?? 0) >= API_KEYS_PER_ORGANIZATION_MAX) {
          throw new AppError('CONFLICT', {
            message: `Sudah ada ${String(API_KEYS_PER_ORGANIZATION_MAX)} API key aktif (batas). Cabut yang tidak dipakai dulu.`,
          });
        }
        const [row] = await tx
          .insert(apiKeys)
          .values({
            organizationId: auth.organizationId,
            name: input.name,
            lookupKey: generated.lookupKey,
            secretHash: generated.secretHash,
            scopes: [...input.scopes],
            allowedIps,
            dailySendLimit: input.dailySendLimit ?? API_KEY_DAILY_SEND_DEFAULT,
            emailAttachmentHosts,
            expiresAt,
            createdByUserId: auth.user.id,
          })
          .returning({ id: apiKeys.id });
        if (!row) throw new Error('API key tidak tersimpan');
        await replaceSenders(tx, auth.organizationId, row.id, senderChannelIds);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.apiKeyCreated,
          targetType: 'api_key',
          targetId: row.id,
          // Rahasia TIDAK PERNAH diaudit — hanya awalan yang aman ditampilkan.
          metadata: {
            change: 'created',
            name: input.name,
            displayPrefix: displayPrefix(generated.lookupKey),
            scopes: input.scopes.join(','),
            expiresAt: expiresAt?.toISOString() ?? null,
            allowedIps: allowedIps?.join(',') ?? null,
            dailySendLimit: input.dailySendLimit ?? API_KEY_DAILY_SEND_DEFAULT,
            ...(senderChannelIds.length > 0
              ? {
                  emailSenders: senderChannelIds
                    .map((channelId) => emailSenderId('channel', channelId))
                    .join(','),
                  emailAttachmentHosts: emailAttachmentHosts.join(','),
                }
              : {}),
            actorRole: role,
          },
          client: context.client,
        });
        return row.id;
      });
      return { apiKey: await one(auth.organizationId, id), secret: generated.token };
    },

    async revoke(auth, client, id) {
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'api_keys.manage');
        const [current] = await tx
          .select({
            name: apiKeys.name,
            lookupKey: apiKeys.lookupKey,
            revokedAt: apiKeys.revokedAt,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.organizationId, auth.organizationId), eq(apiKeys.id, id)))
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
        if (current.revokedAt) return;
        await tx
          .update(apiKeys)
          .set({ revokedAt: now(), revokedByUserId: auth.user.id })
          .where(and(eq(apiKeys.organizationId, auth.organizationId), eq(apiKeys.id, id)));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.apiKeyRevoked,
          targetType: 'api_key',
          targetId: id,
          metadata: {
            change: 'revoked',
            name: current.name,
            displayPrefix: displayPrefix(current.lookupKey),
            actorRole: role,
          },
          client,
        });
      });
      return one(auth.organizationId, id);
    },

    async update(auth, id, input, context) {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        input.confirmation,
        'api_key.update',
        context,
        'Masukkan password (dan kode verifikasi) untuk mengubah API key.',
      );
      await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'api_keys.manage');
        const [current] = await tx
          .select({
            name: apiKeys.name,
            lookupKey: apiKeys.lookupKey,
            scopes: apiKeys.scopes,
            revokedAt: apiKeys.revokedAt,
            hosts: apiKeys.emailAttachmentHosts,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.organizationId, auth.organizationId), eq(apiKeys.id, id)))
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
        if (current.revokedAt) {
          throw new AppError('CONFLICT', { message: 'API key ini sudah dicabut.' });
        }
        const changedFields: string[] = [];
        const metadata: Record<string, string> = {};
        if (input.emailSenderIds !== undefined) {
          const channelIds = await resolveSenders(
            tx,
            auth.organizationId,
            current.scopes,
            input.emailSenderIds,
          );
          await replaceSenders(tx, auth.organizationId, id, channelIds);
          changedFields.push('emailSenders');
          metadata.emailSenders = channelIds
            .map((channelId) => emailSenderId('channel', channelId))
            .join(',');
        }
        if (input.emailAttachmentHosts !== undefined) {
          const hosts = resolveHosts(current.scopes, input.emailAttachmentHosts);
          await tx
            .update(apiKeys)
            .set({ emailAttachmentHosts: hosts })
            .where(and(eq(apiKeys.organizationId, auth.organizationId), eq(apiKeys.id, id)));
          changedFields.push('emailAttachmentHosts');
          metadata.previousEmailAttachmentHosts = current.hosts.join(',');
          metadata.emailAttachmentHosts = hosts.join(',');
        }
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.apiKeyUpdated,
          targetType: 'api_key',
          targetId: id,
          metadata: {
            change: 'updated',
            name: current.name,
            displayPrefix: displayPrefix(current.lookupKey),
            changedFields: changedFields.join(','),
            ...metadata,
            actorRole: role,
          },
          client: context.client,
        });
      });
      return one(auth.organizationId, id);
    },

    async settings(organizationId) {
      const [row] = await db
        .select({ docsEnabled: organizations.apiDocsEnabled })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      return { docsEnabled: row?.docsEnabled ?? true };
    },

    async updateSettings(auth, client, input) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'api_keys.manage');
        const [current] = await tx
          .select({ docsEnabled: organizations.apiDocsEnabled })
          .from(organizations)
          .where(eq(organizations.id, auth.organizationId))
          .for('update');
        if (!current || current.docsEnabled === input.docsEnabled) return;
        await tx
          .update(organizations)
          .set({ apiDocsEnabled: input.docsEnabled })
          .where(eq(organizations.id, auth.organizationId));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.apiSettingsUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          metadata: {
            previous: { docsEnabled: current.docsEnabled },
            docsEnabled: input.docsEnabled,
          },
          client,
        });
      });
      return { docsEnabled: input.docsEnabled };
    },
  };
}

/** Pengirim email per key (channel yang dihapus otomatis tidak ikut). */
async function emailSendersOf(
  db: DbExecutor,
  organizationId: string,
  apiKeyIds: readonly string[],
): Promise<Map<string, ApiKey['emailSenders']>> {
  const result = new Map<string, ApiKey['emailSenders']>();
  if (apiKeyIds.length === 0) return result;
  const rows = await db
    .select({
      apiKeyId: apiKeyEmailSenders.apiKeyId,
      channelId: channels.id,
      name: channels.name,
      address: channels.emailAddress,
    })
    .from(apiKeyEmailSenders)
    .innerJoin(
      channels,
      and(
        eq(channels.organizationId, apiKeyEmailSenders.organizationId),
        eq(channels.id, apiKeyEmailSenders.channelId),
        isNull(channels.deletedAt),
      ),
    )
    .where(
      and(
        eq(apiKeyEmailSenders.organizationId, organizationId),
        inArray(apiKeyEmailSenders.apiKeyId, [...apiKeyIds]),
      ),
    )
    .orderBy(channels.name);
  for (const row of rows) {
    const list = result.get(row.apiKeyId) ?? [];
    list.push({
      id: emailSenderId('channel', row.channelId),
      kind: 'channel',
      name: row.name,
      address: row.address ?? '',
    });
    result.set(row.apiKeyId, list);
  }
  return result;
}
