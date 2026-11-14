import { AppError } from '@balesin/core';
import {
  emailSettingsChangeNotices,
  users,
  type DbExecutor,
  type EmailSettings,
} from '@balesin/db';
import type { UserRole } from '@balesin/shared';
import { and, eq, isNull } from 'drizzle-orm';

import type { EmailNotifier } from '../../queues/email-queue';
import type { EmailSettingsValues } from './email-settings.repo';

/**
 * Pemberitahuan ke semua Owner saat email pengirim diubah pengguna SELAIN Owner (review keamanan
 * RBAC S1). Admin memegang `settings.email.manage`; sesi Admin yang dibobol bisa mengganti server
 * SMTP ke milik penyerang lalu membaca tautan atur ulang password CS/Teknisi, undangan Admin buatan
 * Owner, dan menelan pemberitahuan keamanan ke Owner.
 *
 * - Pemicu: sambungan (host, port, keamanan, username, password) ATAU alamat pengirim/balas-ke
 *   berubah, oleh peran selain Owner. Perubahan nama pengirim saja tidak.
 * - Dikirim lewat pengaturan SEBELUM perubahan: salinannya (termasuk teks sandi password apa adanya)
 *   disimpan di `email_settings_change_notices`, worker mengirim lewat salinan itu.
 * - Dijalankan DI DALAM transaksi penyimpanan dan diantrekan sebelum commit: bila pemberitahuan tidak
 *   bisa diantrekan, perubahannya ikut batal (503). Worker yang mengambil job sebelum commit akan
 *   mengulang (baris belum terlihat).
 * - Owner tidak memberi tahu dirinya sendiri; perubahan Owner tetap tercatat di audit seperti biasa.
 */

/** Perubahan yang mengubah KE MANA dan LEWAT MANA email keamanan dikirim. */
export function deliveryPathChanged(
  stored: EmailSettings | undefined,
  values: EmailSettingsValues,
  passwordChanged: boolean,
): boolean {
  if (!stored) return true;
  return (
    passwordChanged ||
    stored.host !== values.host ||
    stored.port !== values.port ||
    stored.security !== values.security ||
    stored.username !== values.username ||
    stored.fromAddress !== values.fromAddress ||
    stored.replyTo !== values.replyTo
  );
}

/** Owner aktif organisasi ini (penerima pemberitahuan). */
async function findActiveOwnerIds(tx: DbExecutor, organizationId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    );
  return rows.map((row) => row.id);
}

export interface ChangeNoticeInput {
  organizationId: string;
  actor: { userId: string; role: UserRole };
  stored: EmailSettings | undefined;
  values: EmailSettingsValues;
  auditLogId: string;
}

/**
 * Mencatat salinan pengaturan lama dan mengantre satu job per Owner. Mengembalikan jumlah Owner
 * yang diberi tahu (0 bila pelakunya Owner, atau tidak ada Owner aktif).
 */
export async function queueOwnerChangeNotices(
  tx: DbExecutor,
  notifier: EmailNotifier,
  input: ChangeNoticeInput,
): Promise<number> {
  if (input.actor.role === 'owner') return 0;
  const owners = await findActiveOwnerIds(tx, input.organizationId);
  if (owners.length === 0) return 0;

  const { stored, values } = input;
  const [notice] = await tx
    .insert(emailSettingsChangeNotices)
    .values({
      organizationId: input.organizationId,
      actorUserId: input.actor.userId,
      auditLogId: input.auditLogId,
      previousFromName: stored?.fromName ?? null,
      previousFromAddress: stored?.fromAddress ?? null,
      previousReplyTo: stored?.replyTo ?? null,
      previousHost: stored?.host ?? null,
      previousPort: stored?.port ?? null,
      previousSecurity: stored?.security ?? null,
      previousUsername: stored?.username ?? null,
      previousPasswordEncrypted: stored?.passwordEncrypted ?? null,
      newHost: values.host,
      newPort: values.port,
      newFromAddress: values.fromAddress,
      pendingDeliveries: owners.length,
    })
    .returning({ id: emailSettingsChangeNotices.id });
  if (!notice) throw new Error('Pemberitahuan perubahan email pengirim tidak tersimpan');

  try {
    for (const recipientUserId of owners) {
      await notifier.emailSettingsChanged({
        organizationId: input.organizationId,
        recipientUserId,
        noticeId: notice.id,
      });
    }
  } catch (cause) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      message:
        'Perubahan email pengirim belum disimpan karena pemberitahuan ke Owner tidak bisa dikirim sekarang. Coba lagi beberapa saat lagi.',
      cause,
    });
  }
  return owners.length;
}
