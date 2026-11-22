import {
  isChannelAccessExempt,
  type ChannelAccess,
  type ChannelAccessMode,
  type DepartmentSummary,
  type TeamUser,
  type UpdateChannelAccessInput,
} from '@balesin/shared';

/** Kunci cache aturan akses satu channel. */
export const channelAccessKey = (channelId: string) =>
  ['settings', 'channel-access', channelId] as const;

/** Isian form "Akses tim" (tahap 9.0, docs/KONTRAK-API-CHANNEL.md "Akses per channel"). */
export interface AccessDraft {
  mode: ChannelAccessMode;
  departmentIds: string[];
  userIds: string[];
}

/**
 * Keadaan awal dari server. Pengguna nonaktif di daftar dilepas (server menolak menyimpan pengguna
 * nonaktif); jumlahnya dikembalikan supaya bisa dijelaskan.
 */
export function initialDraft(access: ChannelAccess): {
  draft: AccessDraft;
  droppedInactive: number;
} {
  const active = access.users.filter((user) => user.active);
  return {
    draft: {
      mode: access.mode,
      departmentIds: access.departments.map((department) => department.id),
      userIds: active.map((user) => user.id),
    },
    droppedInactive: access.users.length - active.length,
  };
}

/** Isi `PUT …/access`: mode `all` tanpa daftar (daftar + `all` ditolak server). */
export function accessBody(draft: AccessDraft): UpdateChannelAccessInput {
  if (draft.mode === 'all') return { mode: 'all' };
  return { mode: 'restricted', departmentIds: draft.departmentIds, userIds: draft.userIds };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

export function sameDraft(a: AccessDraft, b: AccessDraft): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'all') return true;
  return sameSet(a.departmentIds, b.departmentIds) && sameSet(a.userIds, b.userIds);
}

export function toggleId(list: readonly string[], id: string, on: boolean): string[] {
  const without = list.filter((item) => item !== id);
  return on ? [...without, id] : without;
}

/** Pengguna yang bisa dipilih: aktif & bukan Owner/Admin (selalu melihat semua channel). */
export function selectableUsers(users: readonly TeamUser[]): TeamUser[] {
  return users
    .filter((user) => user.status !== 'disabled' && !isChannelAccessExempt(user.role))
    .sort((a, b) => a.name.localeCompare(b.name, 'id'));
}

export interface AccessSummary {
  /** `true` = hanya Owner/Admin (mode terbatas tanpa departemen & pengguna). */
  ownersOnly: boolean;
  departments: number;
  /** Jumlah anggota departemen terpilih (bisa tumpang tindih dengan pengguna langsung). */
  members: number;
  users: number;
}

export function accessSummary(
  draft: AccessDraft,
  departments: readonly Pick<DepartmentSummary, 'id' | 'memberCount'>[],
): AccessSummary {
  const picked = departments.filter((department) => draft.departmentIds.includes(department.id));
  return {
    ownersOnly:
      draft.mode === 'restricted' && draft.departmentIds.length === 0 && draft.userIds.length === 0,
    departments: draft.departmentIds.length,
    members: picked.reduce((total, department) => total + department.memberCount, 0),
    users: draft.userIds.length,
  };
}
