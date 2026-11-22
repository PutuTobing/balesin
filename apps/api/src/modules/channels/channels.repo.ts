import {
  channelAccessSql,
  userPrincipal,
  channels,
  type Channel,
  type DbExecutor,
  type NewChannel,
} from '@balesin/db';
import type { WhatsAppNumberSummary } from '@balesin/shared';
import { and, asc, count, eq, isNull } from 'drizzle-orm';

/**
 * Akses tabel `channels`. SETIAP query terfilter `organization_id` dan hanya melihat channel yang
 * belum dihapus (`deleted_at is null`) — channel organisasi lain atau yang sudah dihapus = tidak ada.
 */

const live = (organizationId: string) =>
  and(eq(channels.organizationId, organizationId), isNull(channels.deletedAt));

/** `visibleTo` = hanya channel yang boleh dilihat pengguna itu (akses per channel, tahap 9.0). */
export async function listChannels(
  db: DbExecutor,
  organizationId: string,
  options: { visibleTo?: string } = {},
): Promise<Channel[]> {
  return db
    .select()
    .from(channels)
    .where(
      and(
        live(organizationId),
        options.visibleTo === undefined
          ? undefined
          : channelAccessSql(organizationId, userPrincipal(options.visibleTo), channels.id),
      ),
    )
    .orderBy(asc(channels.createdAt), asc(channels.id));
}

export async function countChannels(db: DbExecutor, organizationId: string): Promise<number> {
  const [row] = await db.select({ total: count() }).from(channels).where(live(organizationId));
  return row?.total ?? 0;
}

/** `forUpdate` = kunci baris sampai transaksi selesai (ubah/hapus/tes bersamaan). */
export async function findChannel(
  db: DbExecutor,
  organizationId: string,
  channelId: string,
  options: { forUpdate?: boolean } = {},
): Promise<Channel | undefined> {
  const query = db
    .select()
    .from(channels)
    .where(and(live(organizationId), eq(channels.id, channelId)))
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertChannel(db: DbExecutor, values: NewChannel): Promise<Channel> {
  const [row] = await db.insert(channels).values(values).returning();
  if (!row) throw new Error('Channel tidak tersimpan');
  return row;
}

export type ChannelChanges = Partial<
  Pick<
    NewChannel,
    | 'name'
    | 'enabled'
    | 'disabledAt'
    | 'waPhoneNumberId'
    | 'waBusinessAccountId'
    | 'waAccessTokenEncrypted'
    | 'waAccessTokenTail'
    | 'waAppSecretEncrypted'
    | 'waAppSecretTail'
    | 'waVerifyTokenEncrypted'
    | 'waVerifyTokenRotatedAt'
    | 'waNumberSummary'
    | 'lastTestOk'
    | 'lastTestCode'
    | 'lastTestedAt'
    | 'credentialsUpdatedAt'
    | 'deletedAt'
  >
>;

export async function updateChannel(
  db: DbExecutor,
  organizationId: string,
  channelId: string,
  changes: ChannelChanges & { updatedByUserId: string },
): Promise<Channel | undefined> {
  const [row] = await db
    .update(channels)
    .set(changes)
    .where(and(live(organizationId), eq(channels.id, channelId)))
    .returning();
  return row;
}

/**
 * Mencatat hasil tes HANYA bila kredensial belum diganti sejak tes dimulai (`credentialsUpdatedAt`
 * sama). Data nomor diperbarui hanya bila tesnya berhasil. `undefined` = tidak dicatat.
 */
export async function recordChannelTest(
  db: DbExecutor,
  organizationId: string,
  channelId: string,
  credentialsUpdatedAt: Date,
  result: { ok: boolean; code: string; testedAt: Date; number: WhatsAppNumberSummary | null },
): Promise<Channel | undefined> {
  const [row] = await db
    .update(channels)
    .set({
      lastTestOk: result.ok,
      lastTestCode: result.code,
      lastTestedAt: result.testedAt,
      ...(result.ok && result.number ? { waNumberSummary: result.number } : {}),
    })
    .where(
      and(
        live(organizationId),
        eq(channels.id, channelId),
        eq(channels.credentialsUpdatedAt, credentialsUpdatedAt),
      ),
    )
    .returning();
  return row;
}
