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
export function memberBadges(
  user: TeamUser,
  /** Baris di kelompok "Nonaktif": judul kelompok sudah menyatakannya, tanpa lencana ganda. */
  { inDisabledGroup = false }: { inDisabledGroup?: boolean } = {},
): MemberBadge[] {
  const list: MemberBadge[] = [];
  if (user.status === 'disabled' && !inDisabledGroup) {
    list.push({ tone: 'neutral', label: badges.disabled });
  }
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
      ? // Setara "Terkunci sementara": tidak bisa masuk sampai ditangani (sama dengan kotak di detail).
        { tone: 'warning', label: badges.twoFactorExpired }
      : { tone: 'warning', label: badges.twoFactorPending };
  }
  return { tone: 'neutral', label: badges.twoFactorOff };
}

/**
 * Saring anggota berdasarkan nama atau email (tanpa membedakan huruf besar-kecil). Tanpa "@", yang
 * dicocokkan hanya bagian email sebelum "@": domain organisasi sama untuk semua orang, jadi "ma"
 * tidak boleh cocok dengan semua anggota hanya karena "majujaya.co.id".
 */
export function filterMembers(users: readonly TeamUser[], query: string): TeamUser[] {
  const needle = query.trim().toLocaleLowerCase('id-ID');
  if (!needle) return [...users];
  return users.filter((user) => {
    const email = user.email.toLocaleLowerCase('id-ID');
    const searchable = needle.includes('@') ? email : (email.split('@')[0] ?? email);
    return user.name.toLocaleLowerCase('id-ID').includes(needle) || searchable.includes(needle);
  });
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
