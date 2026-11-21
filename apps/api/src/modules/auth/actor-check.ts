import { AppError } from '@balesin/core';
import { userSessions, users, type DbExecutor } from '@balesin/db';
import { hasPermission, type Permission, type UserRole } from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { AuthContext } from './session.service';

/**
 * Pemeriksaan ulang pelaku DI TRANSAKSI TULIS TERAKHIR (review akhir Fase 1 R3; pola wajib Fase 2
 * untuk kirim pesan). Hook auth memeriksa sesi + peran di AWAL permintaan; aksi yang panjang
 * (konfirmasi identitas, panggilan Meta, tes SMTP) bisa selesai SETELAH pelakunya dinonaktifkan,
 * diturunkan perannya, atau sesinya dicabut. Helper ini mengunci baris pengguna (`FOR SHARE`, jadi
 * penonaktifan/ubah peran yang bersamaan menunggu transaksi ini) lalu memastikan:
 *  - akun masih aktif dan sesinya belum dicabut/kedaluwarsa → selain itu 401;
 *  - peran SEKARANG masih memegang `permission` → selain itu 403.
 *
 * Mengembalikan peran terbaru (untuk aturan turunan, mis. peran yang boleh diundang).
 */
export async function assertActorStillAuthorized(
  tx: DbExecutor,
  auth: AuthContext,
  permission: Permission,
  /** Penolakan dicatat `warn` (hanya ID + alasan, tanpa data pribadi). */
  log?: { warn(object: Record<string, unknown>, message: string): void },
): Promise<{ role: UserRole }> {
  const [row] = await tx
    .select({
      role: users.role,
      disabledAt: users.disabledAt,
      sessionLive: sql<boolean>`${userSessions.revokedAt} is null and ${userSessions.idleExpiresAt} > now() and ${userSessions.absoluteExpiresAt} > now()`,
    })
    .from(users)
    .leftJoin(
      userSessions,
      and(
        eq(userSessions.organizationId, users.organizationId),
        eq(userSessions.userId, users.id),
        eq(userSessions.id, auth.sessionRef),
      ),
    )
    .where(
      and(
        eq(users.organizationId, auth.organizationId),
        eq(users.id, auth.user.id),
        isNull(users.disabledAt),
      ),
    )
    .for('share', { of: users })
    .limit(1);
  if (!row || row.sessionLive !== true) {
    log?.warn(
      {
        userId: auth.user.id,
        sessionRef: auth.sessionRef,
        permission,
        reason: row ? 'session' : 'user',
      },
      'Pelaku tidak lagi aktif/bersesi saat transaksi tulis: perubahan dibatalkan',
    );
    throw new AppError('UNAUTHENTICATED');
  }
  if (!hasPermission(row.role, permission)) {
    log?.warn(
      { userId: auth.user.id, sessionRef: auth.sessionRef, permission, role: row.role },
      'Wewenang pelaku berubah saat transaksi tulis: perubahan dibatalkan',
    );
    throw authorityChanged();
  }
  return { role: row.role };
}

/**
 * 403 "wewenangmu baru saja berubah" — peran/izin pelaku berubah DI TENGAH permintaan. Tidak lewat
 * `forbidByRule`: penolakan terjadi di dalam transaksi yang dibatalkan, dan perubahan wewenangnya
 * sendiri (ubah peran / nonaktifkan) sudah diaudit oleh yang melakukannya.
 */
export function authorityChanged(message?: string): AppError {
  return new AppError('FORBIDDEN', {
    message:
      message ??
      'Wewenangmu baru saja berubah, jadi perubahan ini tidak disimpan. Muat ulang halaman untuk melihat aksesmu sekarang.',
  });
}
