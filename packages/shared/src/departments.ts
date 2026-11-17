import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';
import { userRoleSchema } from './roles';

/**
 * Departemen (Fase 5, PRD §3.6/§3.8; docs/KONTRAK-API-CRM-TIKET.md "Departemen").
 *
 * - Departemen = kelompok pengguna (mis. CS, Teknisi). Percakapan punya SATU departemen (atau
 *   tidak ada); board tiket boleh punya satu departemen (tiketnya ikut departemen board).
 * - "Akses hanya departemen sendiri" = tanda PER PENGGUNA (`restricted`) yang menyempitkan cakupan
 *   `all` izin percakapan & tiket menjadi `department` (`DEPARTMENT_SCOPED_PERMISSIONS`). Hanya untuk
 *   Supervisor dan CS: Owner/Admin selalu penuh, Teknisi sudah dibatasi `assigned`/`own`.
 * - Channel boleh punya departemen bawaan: percakapan BARU dari pelanggan di channel itu langsung
 *   masuk departemen tersebut.
 * Kelola = `settings.workspace.manage`; daftar nama = `inbox.view`; pindahkan percakapan =
 * `inbox.assign`.
 */

export const DEPARTMENTS_PER_ORGANIZATION_MAX = 50;
export const DEPARTMENT_NAME_MAX = 60;
export const DEPARTMENT_DESCRIPTION_MAX = 300;
/** Peran yang boleh diberi tanda "akses hanya departemen sendiri" (sumber: `permissions.ts`). */
export { DEPARTMENT_RESTRICTABLE_ROLE_LIST as DEPARTMENT_RESTRICTABLE_ROLES } from './permissions';

const departmentNameSchema = z
  .string({ error: 'Nama departemen wajib diisi.' })
  .trim()
  .min(1, 'Nama departemen wajib diisi.')
  .max(DEPARTMENT_NAME_MAX, `Nama departemen maksimal ${String(DEPARTMENT_NAME_MAX)} karakter.`)
  .refine((value) => !hasControlCharacters(value), 'Nama departemen memuat karakter khusus.');

const departmentDescriptionSchema = z
  .string()
  .trim()
  .min(1, 'Deskripsi kosong — kirim null untuk menghapusnya.')
  .max(
    DEPARTMENT_DESCRIPTION_MAX,
    `Deskripsi maksimal ${String(DEPARTMENT_DESCRIPTION_MAX)} karakter.`,
  )
  .refine((value) => !hasControlCharacters(value), 'Deskripsi memuat karakter khusus.');

export const departmentRefSchema = z.object({ id: z.uuid(), name: z.string() });
export type DepartmentRef = z.infer<typeof departmentRefSchema>;

/** `GET /departments` (`inbox.view`) — nama saja, untuk saringan & dialog pindah departemen. */
export const departmentSummarySchema = departmentRefSchema.extend({
  description: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
});
export type DepartmentSummary = z.infer<typeof departmentSummarySchema>;
export const departmentListResponseSchema = z.object({
  departments: z.array(departmentSummarySchema),
});
export type DepartmentListResponse = z.infer<typeof departmentListResponseSchema>;

/** `GET /settings/departments` (`settings.workspace.manage`) — lengkap dengan anggota & channel. */
export const departmentDetailSchema = departmentSummarySchema.extend({
  members: z.array(
    z.object({ id: z.uuid(), name: z.string(), role: userRoleSchema, restricted: z.boolean() }),
  ),
  /** Channel yang percakapan barunya otomatis masuk departemen ini. */
  defaultChannelIds: z.array(z.uuid()),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DepartmentDetail = z.infer<typeof departmentDetailSchema>;
export const departmentSettingsResponseSchema = z.object({
  departments: z.array(departmentDetailSchema),
});
export type DepartmentSettingsResponse = z.infer<typeof departmentSettingsResponseSchema>;
export const departmentResponseSchema = z.object({ department: departmentDetailSchema });
export type DepartmentResponse = z.infer<typeof departmentResponseSchema>;

export const departmentIdParamsSchema = z.object({ departmentId: z.string() });

export const createDepartmentRequestSchema = z.object({
  name: departmentNameSchema,
  description: departmentDescriptionSchema.nullable().default(null),
  defaultChannelIds: z.array(z.uuid()).max(50).default([]),
});
export type CreateDepartmentRequest = z.input<typeof createDepartmentRequestSchema>;

export const updateDepartmentRequestSchema = z
  .object({
    name: departmentNameSchema.optional(),
    description: departmentDescriptionSchema.nullable().optional(),
    /** MENGGANTI daftar channel bawaan departemen ini. */
    defaultChannelIds: z.array(z.uuid()).max(50).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    error: 'Tidak ada yang diubah.',
  });
export type UpdateDepartmentRequest = z.infer<typeof updateDepartmentRequestSchema>;

/**
 * `GET`/`PUT /settings/department-access/:userId` — departemen seorang pengguna + tanda "akses hanya
 * departemen sendiri". MELONGGARKAN akses (mencabut tanda, atau menambah departemen pada pengguna
 * bertanda) wajib konfirmasi identitas; menyempitkan tidak.
 */
export const departmentAccessSchema = z.object({
  userId: z.uuid(),
  departmentIds: z.array(z.uuid()),
  restricted: z.boolean(),
});
export type DepartmentAccess = z.infer<typeof departmentAccessSchema>;
export const departmentAccessResponseSchema = z.object({ access: departmentAccessSchema });
export type DepartmentAccessResponse = z.infer<typeof departmentAccessResponseSchema>;
export const departmentAccessParamsSchema = z.object({ userId: z.string() });

export const updateDepartmentAccessRequestSchema = z.object({
  departmentIds: z
    .array(z.uuid({ error: 'Departemen tidak valid.' }))
    .max(DEPARTMENTS_PER_ORGANIZATION_MAX)
    .refine((items) => new Set(items).size === items.length, 'Departemen tidak boleh kembar.'),
  restricted: z.boolean(),
  confirmation: identityConfirmationSchema.optional(),
});
export type UpdateDepartmentAccessRequest = z.input<typeof updateDepartmentAccessRequestSchema>;

/** `POST /conversations/:id/department` (`inbox.assign`) — `null` = lepas dari departemen. */
export const setConversationDepartmentRequestSchema = z.object({
  departmentId: z.uuid({ error: 'Departemen tidak valid.' }).nullable(),
});
export type SetConversationDepartmentRequest = z.infer<
  typeof setConversationDepartmentRequestSchema
>;
