import type { DbExecutor } from '@balesin/db';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { revokeOpenInvitationsOfIssuer } from './invitations.repo';

/**
 * Pemulihan akun → undangan terbuka yang token berlakunya diterbitkan pengguna itu ikut dibatalkan,
 * di transaksi yang sama (review akhir Fase 1 T1 butir 3, putaran 2 N2). Cookie/password curian
 * yang sempat mengundang akun penyerang tidak meninggalkan akses menetap — juga bila penyerang
 * sudah KELUAR atau sesinya kedaluwarsa sebelum korban memulihkan akun.
 *
 * Cakupan per jalur:
 *  - "keluarkan sesi ini" (Keamanan akun / tim) → `{ sessionIds: [sesi itu] }`;
 *  - "keluarkan sesi lain" (Keamanan akun) → `{ exceptSessionId: sesi pelaku }`: semua undangan
 *    terbitannya selain yang diterbitkan dari sesi yang sedang dipakai;
 *  - atur ulang password, "keluarkan semua sesi" / atur ulang 2FA oleh Owner/Admin → `{}`: semua.
 * TIDAK dipakai untuk keluar biasa, rotasi sesi saat masuk, mendaftar 2FA, dan ubah peran
 * (undangan yang tak boleh diterbitkan lagi sudah ditolak `invitationIssuerAuthorized`;
 * nonaktifkan akun membatalkan semua lewat `revokeInvitationsIssuedBy`).
 *
 * Satu baris audit `invitation.revoked` (`reason: issuer_session_revoked`) per undangan.
 */
export async function revokeInvitationsOnRecovery(
  tx: DbExecutor,
  input: {
    organizationId: string;
    issuerUserId: string;
    scope: { sessionIds: readonly string[] } | { exceptSessionId?: string };
    /** Pelaku pemulihan (bawaan: penerbitnya sendiri). */
    actorUserId?: string;
    client?: ClientInfo;
  },
): Promise<number> {
  const actorUserId = input.actorUserId ?? input.issuerUserId;
  const revoked = await revokeOpenInvitationsOfIssuer(tx, {
    organizationId: input.organizationId,
    issuerUserId: input.issuerUserId,
    revokedByUserId: actorUserId,
    ...input.scope,
  });
  for (const invitation of revoked) {
    await recordAudit(tx, {
      organizationId: input.organizationId,
      actorUserId,
      action: AUDIT_ACTIONS.invitationRevoked,
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: {
        reason: 'issuer_session_revoked',
        role: invitation.role,
        issuerRef: input.issuerUserId,
      },
      client: input.client ?? { ip: null, userAgent: null },
    });
  }
  return revoked.length;
}
