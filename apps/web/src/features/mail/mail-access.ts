import {
  MAIL_ACCESS_LEVELS,
  USER_ROLE_LABELS,
  isMailImplicitManager,
  mailLevelAtLeast,
  type DepartmentSummary,
  type MailAccessLevel,
  type MailAccountAccessResponse,
  type TeamUser,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import type { GrantDraft } from './wizard-state';

/** Logika daftar akses akun email (wizard langkah 4, kartu Akses) tanpa React — dites unit. */

const a = t.mail.access;
const m = t.mail;

export const LEVEL_OPTIONS = MAIL_ACCESS_LEVELS.map((level) => ({
  value: level,
  label: m.levels[level] ?? level,
}));

/** Pengguna yang bisa diberi akses: aktif dan bukan Owner/Admin (otomatis Kelola). */
export function grantableUsers(users: readonly TeamUser[]): TeamUser[] {
  return users
    .filter((user) => user.status !== 'disabled' && !isMailImplicitManager(user.role))
    .sort((x, y) => x.name.localeCompare(y.name, 'id'));
}

export function departmentDraft(department: DepartmentSummary, level: MailAccessLevel): GrantDraft {
  return {
    principalType: 'department',
    id: department.id,
    name: department.name,
    meta: a.members(department.memberCount),
    level,
  };
}

export function userDraft(user: Pick<TeamUser, 'id' | 'name' | 'role'>, level: MailAccessLevel) {
  return {
    principalType: 'user',
    id: user.id,
    name: user.name,
    meta: USER_ROLE_LABELS[user.role],
    level,
  } satisfies GrantDraft;
}

/** Penerima akses dari server → isian editor. */
export function draftsFromAccess(access: MailAccountAccessResponse): GrantDraft[] {
  return access.grants.map(({ principal, level }) =>
    principal.type === 'user'
      ? {
          principalType: 'user',
          id: principal.id,
          name: principal.name,
          meta: USER_ROLE_LABELS[principal.role],
          level,
          inactive: !principal.active,
        }
      : {
          principalType: 'department',
          id: principal.id,
          name: principal.name,
          meta: a.members(principal.memberCount),
          level,
        },
  );
}

/**
 * Menambah penerima atau menaikkan tingkat = melonggarkan akses → wajib konfirmasi identitas
 * (kontrak §5). Hanya mengurangi/menurunkan tidak.
 */
export function accessLoosens(saved: readonly GrantDraft[], next: readonly GrantDraft[]): boolean {
  return next.some((grant) => {
    const before = saved.find((item) => item.id === grant.id);
    return !before || !mailLevelAtLeast(before.level, grant.level);
  });
}

/** Grant langsung yang berubah (Tim → Akses email): `null` = cabut. */
export function directChanges(
  initial: Readonly<Record<string, MailAccessLevel | null>>,
  next: Readonly<Record<string, MailAccessLevel | null>>,
): { accountId: string; level: MailAccessLevel | null }[] {
  return Object.keys(next)
    .filter((accountId) => (next[accountId] ?? null) !== (initial[accountId] ?? null))
    .map((accountId) => ({ accountId, level: next[accountId] ?? null }));
}

/** Memberi akses baru atau menaikkan hak langsung = konfirmasi identitas (kontrak §5). */
export function teamAccessLoosens(
  initial: Readonly<Record<string, MailAccessLevel | null>>,
  next: Readonly<Record<string, MailAccessLevel | null>>,
): boolean {
  return directChanges(initial, next).some(
    ({ accountId, level }) => level !== null && !mailLevelAtLeast(initial[accountId], level),
  );
}
