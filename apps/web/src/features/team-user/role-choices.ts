import { USER_ROLE_LABELS, type TeamUser, type UserRole } from '@balesin/shared';

/** Pilihan peran: yang boleh diberikan pemanggil, ditambah peran sekarang bila tidak termasuk. */
export function roleChoices(user: Pick<TeamUser, 'role' | 'assignableRoles'>) {
  const options: { value: UserRole; label: string }[] = user.assignableRoles.map((role) => ({
    value: role,
    label: role === user.role ? `${USER_ROLE_LABELS[role]} (sekarang)` : USER_ROLE_LABELS[role],
  }));
  if (!user.assignableRoles.some((role) => role === user.role)) {
    options.unshift({ value: user.role, label: `${USER_ROLE_LABELS[user.role]} (sekarang)` });
  }
  return options;
}
