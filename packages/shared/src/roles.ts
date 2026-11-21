import { z } from 'zod';

/**
 * Lima peran pengguna (PRD §4). Urutan = dari wewenang tertinggi ke terendah.
 * Sumber tunggal: enum Postgres `user_role` di `@balesin/db` dibuat dari daftar ini.
 */
export const USER_ROLES = ['owner', 'admin', 'supervisor', 'cs', 'teknisi'] as const;

export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Nama peran untuk ditampilkan di UI. */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  supervisor: 'Supervisor',
  cs: 'CS',
  teknisi: 'Teknisi',
};
