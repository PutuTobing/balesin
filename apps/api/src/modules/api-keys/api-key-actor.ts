import { AppError } from '@balesin/core';
import { apiKeys, type DbExecutor } from '@balesin/db';
import { apiKeyHasScope, type ApiKeyScope } from '@balesin/shared';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';

/**
 * Pelaku API key untuk aksi tulis di luar kirim pesan (lapisan kompatibel MobiChat: handoff, assign,
 * selesai, catatan). Bukan pengguna: `conversation_events.api_key_id`/`conversation_notes.api_key_id`
 * diisi, `actor_user_id` kosong.
 */
export interface ApiKeyActor {
  organizationId: string;
  apiKeyId: string;
  client: ClientInfo;
}

/**
 * Pola wajib "cek ulang pelaku di transaksi akhir" versi API key: key dikunci `FOR SHARE` (pencabutan
 * yang bersamaan menunggu) lalu dipastikan belum dicabut/kedaluwarsa (401) dan masih memegang scope
 * (403). Mengembalikan nama key (untuk tampilan pelaku).
 */
export async function assertApiKeyStillAuthorized(
  tx: DbExecutor,
  actor: Pick<ApiKeyActor, 'organizationId' | 'apiKeyId'>,
  scope: ApiKeyScope,
  now: Date,
): Promise<{ name: string }> {
  const [row] = await tx
    .select({ name: apiKeys.name, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, actor.organizationId),
        eq(apiKeys.id, actor.apiKeyId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
      ),
    )
    .for('share')
    .limit(1);
  if (!row) throw new AppError('UNAUTHENTICATED');
  if (!apiKeyHasScope(row.scopes, scope)) {
    throw new AppError('FORBIDDEN', {
      message: `API key ini tidak punya izin "${scope}".`,
    });
  }
  return { name: row.name };
}
