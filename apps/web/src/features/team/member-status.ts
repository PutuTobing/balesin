import type { TeamUser, UserRole } from '@balesin/shared';
import type { StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';

const badges = t.team.badges;

export interface MemberBadge {
  tone: StatusTone;
  label: string;
}

/**
 * Lencana keadaan anggota, urut dari yang paling perlu perhatian: status akun (nonaktif /
 * terkunci), keadaan 2FA, lalu email belum diverifikasi. "Aktif" tidak diberi lencana (keadaan
 * biasa); 2FA selalu ditampilkan karena itu yang paling sering dicari Owner.
 */
export function memberBadges(user: TeamUser): MemberBadge[] {
  const list: MemberBadge[] = [];
  if (user.status === 'disabled') list.push({ tone: 'neutral', label: badges.disabled });
  if (user.status === 'locked') list.push({ tone: 'warning', label: badges.locked });
  list.push(twoFactorBadge(user));
  if (!user.emailVerified) list.push({ tone: 'warning', label: badges.emailUnverified });
  return list;
}

export function twoFactorBadge(user: TeamUser): MemberBadge {
  const { twoFactor } = user;
  if (twoFactor.enabled) return { tone: 'success', label: badges.twoFactorOn };
  if (twoFactor.required) {
    return twoFactor.enrollmentExpired
      ? { tone: 'danger', label: badges.twoFactorExpired }
      : { tone: 'warning', label: badges.twoFactorPending };
  }
  return { tone: 'neutral', label: badges.twoFactorOff };
}

/** Saring anggota berdasarkan nama atau email (tanpa membedakan huruf besar-kecil). */
export function filterMembers(users: readonly TeamUser[], query: string): TeamUser[] {
  const needle = query.trim().toLocaleLowerCase('id-ID');
  if (!needle) return [...users];
  return users.filter(
    (user) =>
      user.name.toLocaleLowerCase('id-ID').includes(needle) ||
      user.email.toLocaleLowerCase('id-ID').includes(needle),
  );
}

/** Kolom pencarian baru tampil bila anggotanya cukup banyak untuk perlu dicari. */
export const MEMBER_SEARCH_THRESHOLD = 8;

/**
 * Kenapa anggota ini tidak bisa dikelola pemanggil (`canManage: false`), untuk teks penjelasan —
 * bukan tombol mati. Server tetap penentu; ini hanya memilih kalimat.
 */
export function viewOnlyReason(
  user: Pick<TeamUser, 'isSelf' | 'canManage' | 'role'>,
  actorRole: UserRole | undefined,
): 'self' | 'adminLimit' | 'other' | null {
  if (user.canManage) return null;
  if (user.isSelf) return 'self';
  if (actorRole === 'admin' && (user.role === 'owner' || user.role === 'admin')) {
    return 'adminLimit';
  }
  return 'other';
}
