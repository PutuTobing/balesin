import {
  PG_ERROR_CODES,
  channels,
  getPgError,
  webhookEvents,
  type Channel,
  type Database,
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

/**
 * Channel WhatsApp hidup di organisasi ini yang memegang nomor-nomor tersebut — SATU query untuk
 * semua nomor di satu notifikasi (review webhook R2). Pemanggil membatasi jumlah nomornya
 * (`WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION`). Nomor hidup unik per organisasi (indeks unik).
 */
export async function findLiveChannelsByPhoneNumberIds(
  db: DbExecutor,
  organizationId: string,
  phoneNumberIds: readonly string[],
): Promise<Map<string, Channel>> {
  const found = new Map<string, Channel>();
  if (phoneNumberIds.length === 0) return found;
  const rows = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.type, 'whatsapp'),
        inArray(channels.waPhoneNumberId, [...phoneNumberIds]),
        isNull(channels.deletedAt),
      ),
    );
  for (const row of rows) {
    if (row.waPhoneNumberId !== null && !found.has(row.waPhoneNumberId)) {
      found.set(row.waPhoneNumberId, row);
    }
  }
  return found;
}

export interface StoredWebhookEvent {
  id: string;
  organizationId: string;
  status: NewWebhookEvent['status'];
}

/** Baris per pernyataan INSERT (batas parameter Postgres 65.535; tiap baris ±11 parameter). */
const INSERT_CHUNK = 500;

/**
 * Kode error yang melekat pada DATA satu baris — mengulang byte yang sama tidak akan pernah berhasil:
 * kelas 22 (data exception: `\u0000`/surrogate di jsonb, angka/tanggal di luar rentang, …) dan
 * `23514` (CHECK). Juga kesalahan serialisasi Drizzle sebelum query dikirim (mis. `RangeError` dari
 * Invalid Date). Error lain (koneksi, kapasitas, kunci) = sementara → pemanggil menjawab 503.
 */
export function rowDataErrorCode(error: unknown): string | null {
  const pg = getPgError(error);
  if (pg) {
    return pg.code.startsWith('22') || pg.code === PG_ERROR_CODES.checkViolation ? pg.code : null;
  }
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof RangeError) return 'RangeError';
    current = current.cause;
  }
  return null;
}

type InsertedRow = StoredWebhookEvent & { channelId: string; dedupKey: string };

function insertChunk(db: DbExecutor, chunk: readonly NewWebhookEvent[]): Promise<InsertedRow[]> {
  return db
    .insert(webhookEvents)
    .values([...chunk])
    .onConflictDoNothing({ target: [webhookEvents.channelId, webhookEvents.dedupKey] })
    .returning({
      id: webhookEvents.id,
      organizationId: webhookEvents.organizationId,
      status: webhookEvents.status,
      channelId: webhookEvents.channelId,
      dedupKey: webhookEvents.dedupKey,
    });
}

/**
 * INSERT satu bagian; bila gagal karena data satu baris (`rowDataErrorCode`), diulang PER BARIS dan
 * baris yang tetap gagal dilewati (review webhook S2). `db` BUKAN transaksi: setiap pernyataan berdiri
 * sendiri, jadi kegagalan satu baris tidak membatalkan yang lain.
 */
async function insertChunkTolerant(
  db: Database,
  chunk: readonly NewWebhookEvent[],
  rejectedCodes: string[],
): Promise<{ created: InsertedRow[]; attempted: NewWebhookEvent[] }> {
  try {
    return { created: await insertChunk(db, chunk), attempted: [...chunk] };
  } catch (error) {
    if (rowDataErrorCode(error) === null) throw error;
  }
  const created: InsertedRow[] = [];
  const attempted: NewWebhookEvent[] = [];
  for (const row of chunk) {
    try {
      created.push(...(await insertChunk(db, [row])));
      attempted.push(row);
    } catch (error) {
      const code = rowDataErrorCode(error);
      if (code === null) throw error;
      rejectedCodes.push(code);
    }
  }
  return { created, attempted };
}

/**
 * Menyimpan kejadian dengan `ON CONFLICT (channel_id, dedup_key) DO NOTHING`.
 *  - `inserted`: baris baru;
 *  - `pendingDuplicates`: kejadian yang SUDAH ada dan masih `pending` (mis. penyimpanan sebelumnya
 *    berhasil tetapi mengantre job gagal → Meta mengirim ulang) — diantre ulang pemanggil;
 *  - `duplicates`: jumlah semua kiriman ulang (termasuk yang sudah selesai: diabaikan);
 *  - `rejectedCodes`: kode error per baris yang dilewati karena datanya ditolak database (tanpa isi).
 * Error lain (koneksi, kapasitas) dilempar apa adanya.
 */
export async function insertWebhookEvents(
  db: Database,
  rows: readonly NewWebhookEvent[],
): Promise<{
  inserted: StoredWebhookEvent[];
  pendingDuplicates: StoredWebhookEvent[];
  duplicates: number;
  rejectedCodes: string[];
}> {
  const inserted: StoredWebhookEvent[] = [];
  const pendingDuplicates: StoredWebhookEvent[] = [];
  const rejectedCodes: string[] = [];
  let duplicates = 0;

  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const { created, attempted } = await insertChunkTolerant(
      db,
      rows.slice(start, start + INSERT_CHUNK),
      rejectedCodes,
    );
    inserted.push(
      ...created.map(({ id, organizationId, status }) => ({ id, organizationId, status })),
    );

    const createdKeys = new Set(created.map((row) => `${row.channelId}|${row.dedupKey}`));
    const conflicted = attempted.filter(
      (row) => !createdKeys.has(`${row.channelId}|${row.dedupKey}`),
    );
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

  return { inserted, pendingDuplicates, duplicates, rejectedCodes };
}
