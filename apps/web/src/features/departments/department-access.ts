import type { DepartmentAccess } from '@balesin/shared';

/** Melonggarkan = mencabut tanda, atau menambah departemen pada pengguna bertanda. */
export function isLoosening(
  before: Pick<DepartmentAccess, 'departmentIds' | 'restricted'>,
  after: Pick<DepartmentAccess, 'departmentIds' | 'restricted'>,
): boolean {
  // Sama dengan server: hanya pengguna yang SEBELUMNYA bertanda yang bisa dilonggarkan.
  if (!before.restricted) return false;
  return !after.restricted || after.departmentIds.some((id) => !before.departmentIds.includes(id));
}
