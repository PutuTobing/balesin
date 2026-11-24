import { z } from 'zod';

import { DEPARTMENTS_PER_ORGANIZATION_MAX } from './departments';
import { identityConfirmationSchema } from './identity';
import { userRoleSchema, type UserRole } from './roles';

/**
 * Akses per channel (tahap 9.0, PRD-EMAIL §4.10; docs/KONTRAK-API-CHANNEL.md "Akses per channel").
 *
 * - Per channel (semua jenis: WhatsApp, Telegram, Email, Messenger, Instagram): mode `all` ("Semua
 *   tim", bawaan = perilaku sebelum tahap 9.0) atau `restricted` ("Hanya departemen/pengguna
 *   tertentu") + daftar departemen & pengguna.
 * - Owner/Admin (`CHANNEL_ACCESS_EXEMPT_ROLES`) SELALU melihat semua channel.
 * - Pengguna lain di luar daftar channel terbatas tidak melihat percakapan, hitungan, notifikasi,
 *   hasil cari, event real-time, dan laporan channel itu. Penegakan = IRISAN dengan cakupan peran
 *   (Teknisi `assigned`) dan "akses hanya departemen sendiri".
 * - Hanya untuk pengguna bersesi. API key / bot (n8n) tidak terpengaruh (DECISIONS 2026-11-22).
 * Kelola = `channels.manage` (Pengaturan → Channel → [channel] → Akses).
 */

export const CHANNEL_ACCESS_MODES = ['all', 'restricted'] as const;
export const channelAccessModeSchema = z.enum(CHANNEL_ACCESS_MODES);
export type ChannelAccessMode = z.infer<typeof channelAccessModeSchema>;

/** Peran yang tidak pernah dibatasi akses per channel. */
export const CHANNEL_ACCESS_EXEMPT_ROLES = [
  'owner',
  'admin',
] as const satisfies readonly UserRole[];

export function isChannelAccessExempt(role: UserRole): boolean {
  return (CHANNEL_ACCESS_EXEMPT_ROLES as readonly string[]).includes(role);
}

/** Batas pengguna yang bisa didaftarkan langsung ke satu channel. */
export const CHANNEL_ACCESS_USERS_MAX = 500;

export const CHANNEL_ACCESS_MODE_LABELS: Readonly<Record<ChannelAccessMode, string>> = {
  all: 'Semua tim',
  restricted: 'Hanya departemen/pengguna tertentu',
};

const idListSchema = (max: number, label: string) =>
  z
    .array(z.uuid({ error: `ID ${label} tidak valid.` }), { error: `Daftar ${label} tidak valid.` })
    .max(max, `Paling banyak ${String(max)} ${label}.`)
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]);

/**
 * `PUT /settings/channels/:channelId/access`. Mode `all` → daftar dikosongkan server (kirim `[]`);
 * daftar yang tidak kosong dengan mode `all` ditolak supaya UI tidak mengira daftarnya tersimpan.
 * Mode `restricted` dengan kedua daftar kosong sah: hanya Owner/Admin yang melihat channel itu.
 * `confirmation` (password + kode 2FA) WAJIB bila perubahan MELONGGARKAN akses (review 9.0 R3):
 * `restricted → all`, atau menambah departemen/pengguna ke channel yang sudah terbatas. Mempersempit
 * (`all → restricted`, mencabut) tidak perlu.
 */
export const updateChannelAccessRequestSchema = z
  .object({
    mode: channelAccessModeSchema,
    departmentIds: idListSchema(DEPARTMENTS_PER_ORGANIZATION_MAX, 'departemen').default([]),
    userIds: idListSchema(CHANNEL_ACCESS_USERS_MAX, 'pengguna').default([]),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'all' && (value.departmentIds.length > 0 || value.userIds.length > 0)) {
      context.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Mode "Semua tim" tidak memakai daftar departemen/pengguna — kosongkan daftarnya.',
      });
    }
  });
export type UpdateChannelAccessRequest = z.infer<typeof updateChannelAccessRequestSchema>;
export type UpdateChannelAccessInput = z.input<typeof updateChannelAccessRequestSchema>;

export const channelAccessDepartmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
});
export type ChannelAccessDepartment = z.infer<typeof channelAccessDepartmentSchema>;

export const channelAccessUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: userRoleSchema,
  active: z.boolean(),
});
export type ChannelAccessUser = z.infer<typeof channelAccessUserSchema>;

export const channelAccessSchema = z.object({
  channelId: z.uuid(),
  mode: channelAccessModeSchema,
  departments: z.array(channelAccessDepartmentSchema),
  users: z.array(channelAccessUserSchema),
  /** Peran yang selalu melihat channel ini (untuk keterangan di UI). */
  exemptRoles: z.array(userRoleSchema),
});
export type ChannelAccess = z.infer<typeof channelAccessSchema>;

export const channelAccessResponseSchema = z.object({ access: channelAccessSchema });
export type ChannelAccessResponse = z.infer<typeof channelAccessResponseSchema>;

/**
 * Jawaban `PUT`: keadaan baru + jumlah percakapan `served` yang dikembalikan ke antrian karena
 * pemegangnya kini tanpa akses (review 9.0 R4).
 */
export const updateChannelAccessResponseSchema = channelAccessResponseSchema.extend({
  releasedConversations: z.number().int().nonnegative(),
});
export type UpdateChannelAccessResponse = z.infer<typeof updateChannelAccessResponseSchema>;

/** `true` bila perubahan `before → after` memperluas akses (butuh konfirmasi identitas). */
export function channelAccessLoosens(
  before: { mode: ChannelAccessMode; departmentIds: readonly string[]; userIds: readonly string[] },
  after: { mode: ChannelAccessMode; departmentIds: readonly string[]; userIds: readonly string[] },
): boolean {
  if (before.mode !== 'restricted') return false;
  if (after.mode === 'all') return true;
  return (
    after.departmentIds.some((id) => !before.departmentIds.includes(id)) ||
    after.userIds.some((id) => !before.userIds.includes(id))
  );
}

/**
 * `GET /inbox/agents?channelId=` — tahap 9.0: hanya agen yang berhak atas channel itu (dialog
 * tugaskan/alihkan memakai channel percakapan). Channel yang tidak boleh dilihat pemanggil = 404.
 */
export const inboxAgentListQuerySchema = z
  .object({ channelId: z.uuid({ error: 'ID channel tidak valid.' }).optional() })
  .strict();
export type InboxAgentListQuery = z.infer<typeof inboxAgentListQuerySchema>;
