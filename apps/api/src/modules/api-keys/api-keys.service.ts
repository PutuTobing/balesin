import { AppError } from '@balesin/core';
import { apiKeys, organizations, users, type Database } from '@balesin/db';
import {
  API_KEYS_PER_ORGANIZATION_MAX,
  API_KEY_DAILY_SEND_DEFAULT,
  type ApiKey,
  type ApiKeyScope,
  type ApiSettings,
  type CreateApiKeyRequest,
} from '@balesin/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
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
      const generated = generateApiKey(pepper);
      const id = await db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'api_keys.manage');
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
            expiresAt,
            createdByUserId: auth.user.id,
          })
          .returning({ id: apiKeys.id });
        if (!row) throw new Error('API key tidak tersimpan');
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
