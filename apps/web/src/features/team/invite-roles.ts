import {
  INVITABLE_ROLES,
  INVITE_PERMISSIONS,
  type InvitableRole,
  type UserRole,
} from '@balesin/shared';

/**
 * Pilihan peran di form undangan (docs/KONTRAK-API-AUTH.md, "Siapa boleh mengundang"): peran yang
 * ditawarkan server (`invitableRoles`) DAN diizinkan matriks untuk peran pengundang. Owner:
 * Admin/Supervisor/CS/Teknisi. Admin: Supervisor/CS/Teknisi (bukan Admin). Owner tidak pernah ada
 * di pilihan (tidak bisa diundang). Server tetap penentu akhir.
 */
export function inviteRoleOptions(
  actor: UserRole,
  offered: readonly InvitableRole[],
): InvitableRole[] {
  const allowed = INVITE_PERMISSIONS[actor];
  return INVITABLE_ROLES.filter((role) => offered.includes(role) && allowed.includes(role));
}

/** Pilihan awal: CS (peran yang paling sering diundang) bila tersedia. */
export function defaultInviteRole(options: readonly InvitableRole[]): InvitableRole | '' {
  if (options.includes('cs')) return 'cs';
  return options[0] ?? '';
}
