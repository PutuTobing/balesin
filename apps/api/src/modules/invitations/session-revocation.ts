import type { DbExecutor } from '@balesin/db';

import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { revokeInvitationsIssuedFromSessions } from './invitations.repo';

/**
 * Sesi dicabut untuk MEMULIHKAN akun — "keluarkan sesi ini" / "keluarkan sesi lain" di halaman
 * Keamanan akun, dan atur ulang password — → undangan terbuka yang tokennya diterbitkan dari
 * sesi-sesi itu ikut dibatalkan, di transaksi yang sama (review akhir Fase 1 T1 butir 3). Cookie
 * curian yang sempat mengundang akun penyerang tidak meninggalkan akses menetap setelah korban
 * memulihkan akunnya. TIDAK dipakai untuk: keluar biasa, rotasi sesi saat masuk, mendaftar 2FA, dan
 * ubah peran (undangan yang masih boleh diterbitkan tetap berlaku; nonaktifkan akun membatalkan
 * semua undangan terbitannya lewat `revokeInvitationsIssuedBy`).
 *
 * Satu baris audit `invitation.revoked` (`reason: issuer_session_revoked`) per undangan. Pelaku
 * audit = pemilik sesi (penerbit undangan); asal permintaan tidak tersedia di lapisan ini.
 */
export async function revokeInvitationsFromRevokedSessions(
  tx: DbExecutor,
  organizationId: string,
  issuerUserId: string,
  sessionIds: readonly string[],
): Promise<number> {
  const revoked = await revokeInvitationsIssuedFromSessions(
    tx,
    organizationId,
    issuerUserId,
    sessionIds,
  );
  for (const invitation of revoked) {
    await recordAudit(tx, {
      organizationId,
      actorUserId: issuerUserId,
      action: AUDIT_ACTIONS.invitationRevoked,
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: { reason: 'issuer_session_revoked', role: invitation.role },
      client: { ip: null, userAgent: null },
    });
  }
  return revoked.length;
}
