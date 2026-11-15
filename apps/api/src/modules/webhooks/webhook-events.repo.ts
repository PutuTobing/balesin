import {
  channels,
  webhookEvents,
  type Channel,
  type DbExecutor,
  type NewWebhookEvent,
} from '@balesin/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/**
 * Akses data penerima webhook.
 *
 * PENGECUALIAN yang disengaja dari "setiap query difilter organization_id dari sesi": permintaan
 * webhook datang dari Meta tanpa sesi, jadi `findChannelForWebhook` mencari channel HANYA dari ID di
 * URL. Organisasi kemudian diambil dari baris channel itu dan SEMUA query berikutnya memakainya
 * (channel saudara, penyimpanan kejadian). ID channel bukan autentikasi — keasliannya dari tanda
 * tangan App Secret channel tersebut.
 */

/** Channel WhatsApp untuk ID ini, termasuk yang sudah dihapus (dibedakan pemanggil). */
export async function findChannelForWebhook(
  db: DbExecutor,
  channelId: string,
): Promise<Channel | undefined> {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.type, 'whatsapp')))
    .limit(1);
  return row;
}

/** Channel WhatsApp hidup lain di organisasi yang sama yang memegang nomor ini. */
export async function findLiveChannelByPhoneNumberId(
  db: DbExecutor,
  organizationId: string,
  phoneNumberId: string,
): Promise<Channel | undefined> {
  const [row] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.type, 'whatsapp'),
        eq(channels.waPhoneNumberId, phoneNumberId),
        isNull(channels.deletedAt),
      ),
    )
    .limit(1);
  return row;
}

export interface StoredWebhookEvent {
  id: string;
  organizationId: string;
  status: NewWebhookEvent['status'];
}

/** Baris per pernyataan INSERT (batas parameter Postgres 65.535; tiap baris ±11 parameter). */
const INSERT_CHUNK = 500;

/**
 * Menyimpan kejadian dengan `ON CONFLICT (channel_id, dedup_key) DO NOTHING`.
 *  - `inserted`: baris baru;
 *  - `pendingDuplicates`: kejadian yang SUDAH ada dan masih `pending` (mis. penyimpanan sebelumnya
 *    berhasil tetapi mengantre job gagal → Meta mengirim ulang) — diantre ulang pemanggil;
 *  - `duplicates`: jumlah semua kiriman ulang (termasuk yang sudah selesai: diabaikan).
 */
export async function insertWebhookEvents(
  db: DbExecutor,
  rows: readonly NewWebhookEvent[],
): Promise<{
  inserted: StoredWebhookEvent[];
  pendingDuplicates: StoredWebhookEvent[];
  duplicates: number;
}> {
  const inserted: StoredWebhookEvent[] = [];
  const pendingDuplicates: StoredWebhookEvent[] = [];
  let duplicates = 0;

  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK);
    const created = await db
      .insert(webhookEvents)
      .values(chunk)
      .onConflictDoNothing({ target: [webhookEvents.channelId, webhookEvents.dedupKey] })
      .returning({
        id: webhookEvents.id,
        organizationId: webhookEvents.organizationId,
        status: webhookEvents.status,
        channelId: webhookEvents.channelId,
        dedupKey: webhookEvents.dedupKey,
      });
    inserted.push(
      ...created.map(({ id, organizationId, status }) => ({ id, organizationId, status })),
    );

    const createdKeys = new Set(created.map((row) => `${row.channelId}|${row.dedupKey}`));
    const conflicted = chunk.filter((row) => !createdKeys.has(`${row.channelId}|${row.dedupKey}`));
    duplicates += conflicted.length;
    if (conflicted.length === 0) continue;

    // Dikelompokkan per channel (satu notifikasi bisa dialihkan ke beberapa channel saudara).
    const byChannel = new Map<string, { organizationId: string; keys: string[] }>();
    for (const row of conflicted) {
      const group = byChannel.get(row.channelId) ?? {
        organizationId: row.organizationId,
        keys: [],
      };
      group.keys.push(row.dedupKey);
      byChannel.set(row.channelId, group);
    }
    for (const [channelId, group] of byChannel) {
      const pending = await db
        .select({
          id: webhookEvents.id,
          organizationId: webhookEvents.organizationId,
          status: webhookEvents.status,
        })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.organizationId, group.organizationId),
            eq(webhookEvents.channelId, channelId),
            inArray(webhookEvents.dedupKey, group.keys),
            eq(webhookEvents.status, 'pending'),
          ),
        );
      pendingDuplicates.push(...pending);
    }
  }

  return { inserted, pendingDuplicates, duplicates };
}
