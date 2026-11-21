import { AppError } from '@balesin/core';
import type { DbExecutor } from '@balesin/db';
import type { ChannelChangeKind, UserRole } from '@balesin/shared';

import type { EmailNotifier } from '../../queues/email-queue';
import { findActiveOwners } from '../team/team.repo';

/**
 * Pemberitahuan ke semua Owner aktif saat channel diubah oleh pengguna SELAIN Owner (Admin): dibuat,
 * kredensial/ID Meta diganti, verify token dibuat ulang, dinonaktifkan, atau dihapus. Admin yang
 * dibobol tidak boleh bisa diam-diam membelokkan pesan ke nomor/aplikasi lain atau menghentikan
 * layanan pelanggan (pola review RBAC S1, sama dengan email pengirim).
 *
 * - Metadata audit kejadiannya memuat `change`, `actorRole`, dan `ownersNotified` (lihat
 *   `noticeMetadata`); ringkasan keamanan memunculkannya sebagai `channel_changed` (`warning`).
 * - Payload job hanya ID: worker membaca pelaku, channel, perubahan, waktu, dan IP/perangkat dari
 *   baris audit itu. Tidak ada nilai rahasia di mana pun.
 * - Diantrekan DI DALAM transaksi penyimpanan, sebelum commit: bila tidak bisa diantrekan,
 *   perubahannya ikut batal (503). Worker yang mengambil job sebelum commit mengulang.
 * - Owner tidak memberi tahu dirinya sendiri; perubahan Owner tetap tercatat di audit seperti biasa.
 */

export interface ChannelChangeActor {
  userId: string;
  role: UserRole;
}

/** Owner diberi tahu bila pelakunya bukan Owner. */
export function shouldNotifyOwners(actor: ChannelChangeActor): boolean {
  return actor.role !== 'owner';
}

/** Isian metadata audit untuk perubahan yang (mungkin) diberitahukan ke Owner. */
export function noticeMetadata(
  actor: ChannelChangeActor,
  change: ChannelChangeKind,
): { change: ChannelChangeKind; actorRole: UserRole; ownersNotified: boolean } {
  return { change, actorRole: actor.role, ownersNotified: shouldNotifyOwners(actor) };
}

/**
 * Mengantre satu job per Owner aktif untuk baris audit `auditLogId`. Tidak melakukan apa pun bila
 * pelakunya Owner. Mengembalikan jumlah Owner yang diberi tahu.
 */
export async function queueChannelChangeNotices(
  tx: DbExecutor,
  notifier: Pick<EmailNotifier, 'channelChanged'>,
  input: {
    organizationId: string;
    actor: ChannelChangeActor;
    auditLogId: string;
    /** Jeda sebelum job boleh diambil worker (perubahan yang hasilnya baru diketahui kemudian). */
    delayMs?: number;
  },
): Promise<number> {
  if (!shouldNotifyOwners(input.actor)) return 0;
  const owners = await findActiveOwners(tx, input.organizationId, [input.actor.userId]);
  try {
    for (const recipientUserId of owners) {
      await notifier.channelChanged(
        {
          organizationId: input.organizationId,
          recipientUserId,
          auditLogId: input.auditLogId,
        },
        input.delayMs === undefined ? undefined : { delayMs: input.delayMs },
      );
    }
  } catch (cause) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      message:
        'Perubahan channel belum disimpan karena pemberitahuan ke Owner tidak bisa dikirim sekarang. Coba lagi beberapa saat lagi.',
      cause,
    });
  }
  return owners.length;
}
