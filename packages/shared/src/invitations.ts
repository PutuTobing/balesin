import { z } from 'zod';

import { meResponseSchema, type MeResponse } from './auth';
import { emailAddressSchema, isoDateTimeSchema, personNameSchema } from './fields';
import { newPasswordSchema } from './password';
import type { UserRole } from './roles';

/**
 * Undangan pengguna (CLAUDE.md: tidak ada pendaftaran bebas — Owner lewat wizard setup, pengguna
 * lain HANYA lewat undangan email; SECURITY.md §1). Alur lengkap: docs/KONTRAK-API-AUTH.md bagian
 * "Undangan".
 */

/** Undangan berlaku sekian jam sejak tautannya terakhir dibuat (dibuat atau dikirim ulang). */
export const INVITATION_VALID_HOURS = 72;

/** Peran yang bisa diundang. Owner hanya dibuat oleh wizard setup — tidak pernah lewat undangan. */
export const INVITABLE_ROLES = ['admin', 'supervisor', 'cs', 'teknisi'] as const;
export const invitableRoleSchema = z.enum(INVITABLE_ROLES, {
  error: 'Pilih peran: Admin, Supervisor, CS, atau Teknisi.',
});
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

/**
 * Siapa boleh mengundang (dan mengirim ulang/membatalkan undangan) peran apa:
 *  - Owner: Admin, Supervisor, CS, Teknisi.
 *  - Admin: Supervisor, CS, Teknisi — TIDAK Admin (hanya Owner yang menentukan siapa memegang
 *    wewenang Admin) dan tidak Owner.
 *  - Supervisor, CS, Teknisi: tidak bisa mengundang (PRD §4).
 * Ditegakkan server; web memakainya untuk pilihan peran di form.
 */
export const INVITE_PERMISSIONS: Record<UserRole, readonly InvitableRole[]> = {
  owner: ['admin', 'supervisor', 'cs', 'teknisi'],
  admin: ['supervisor', 'cs', 'teknisi'],
  supervisor: [],
  cs: [],
  teknisi: [],
};

export function canInviteRole(actor: UserRole, role: UserRole): boolean {
  return (INVITE_PERMISSIONS[actor] as readonly UserRole[]).includes(role);
}

/**
 * Token sekali pakai dari tautan email (fragment `#token=…`, lihat `links.ts`). Bentuknya hanya
 * diperiksa kasar; token yang salah/kedaluwarsa dijawab 410 `TOKEN_INVALID`.
 */
export const linkTokenSchema = z
  .string({ error: 'Tautan tidak lengkap. Buka lagi tautan dari email-mu.' })
  .min(1, 'Tautan tidak lengkap. Buka lagi tautan dari email-mu.')
  .max(128, 'Tautan tidak valid. Buka lagi tautan dari email-mu.')
  .regex(/^[A-Za-z0-9_-]+$/, 'Tautan tidak valid. Buka lagi tautan dari email-mu.');

/**
 * Status pengiriman email (undangan, atur ulang password, verifikasi):
 *  - `queued`  — diantrekan, belum dikirim worker;
 *  - `sent`    — server SMTP menerimanya;
 *  - `failed`  — gagal setelah semua percobaan (periksa Pengaturan → Email pengirim);
 *  - `skipped` — tidak dikirim karena email pengirim belum diatur saat worker memprosesnya;
 *  - `link`    — tanpa email: tautan ditampilkan SEKALI ke pembuat undangan untuk disalin.
 */
export const EMAIL_DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'skipped', 'link'] as const;
export const emailDeliveryStatusSchema = z.enum(EMAIL_DELIVERY_STATUSES);
export type EmailDeliveryStatus = z.infer<typeof emailDeliveryStatusSchema>;

export const EMAIL_DELIVERY_LABELS: Record<EmailDeliveryStatus, string> = {
  queued: 'Sedang dikirim',
  sent: 'Email terkirim',
  failed: 'Email gagal terkirim',
  skipped: 'Email tidak dikirim',
  link: 'Tautan disalin manual',
};

export const INVITATION_STATUSES = ['pending', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Satu undangan yang masih terbuka (belum diterima, belum dibatalkan). */
export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: invitableRoleSchema,
  /** `expired` = lewat `expiresAt`; bisa dikirim ulang (tautan baru, 72 jam lagi). */
  status: z.enum(INVITATION_STATUSES),
  invitedBy: z.object({ id: z.uuid(), name: z.string() }),
  createdAt: isoDateTimeSchema,
  /** Waktu tautan yang berlaku sekarang dibuat (dibuat atau dikirim ulang terakhir). */
  lastSentAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  /** Berapa kali tautan dibuat (1 = belum pernah dikirim ulang). */
  sendCount: z.number().int().positive(),
  deliveryStatus: emailDeliveryStatusSchema,
  /** Pemanggil boleh mengirim ulang/membatalkan undangan ini (Admin tidak untuk undangan Admin). */
  canManage: z.boolean(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/** `GET /invitations` — undangan tertunda dan kedaluwarsa, terbaru dulu. */
export const invitationListResponseSchema = z.object({
  invitations: z.array(invitationSchema),
  /** Peran yang boleh diundang pemanggil (untuk pilihan di form). */
  invitableRoles: z.array(invitableRoleSchema),
  /**
   * `true` = email pengirim sudah diatur: undangan dikirim lewat email. `false` = tautan undangan
   * ditampilkan sekali ke pembuatnya untuk disalin manual.
   */
  emailDelivery: z.boolean(),
});
export type InvitationListResponse = z.infer<typeof invitationListResponseSchema>;

/** `POST /invitations` */
export const createInvitationRequestSchema = z.object({
  email: emailAddressSchema,
  role: invitableRoleSchema,
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

/**
 * Respons buat / kirim ulang undangan. `link` HANYA terisi bila email pengirim belum diatur
 * (`deliveryStatus: "link"`): tampilkan sekali dengan tombol "Salin", jangan simpan di cache/
 * storage, dan jangan tampilkan lagi (server tidak bisa menampilkannya ulang — kirim ulang
 * undangan untuk mendapat tautan baru). Bila email terkirim, `link` selalu `null`.
 */
export const invitationIssuedResponseSchema = z.object({
  invitation: invitationSchema,
  link: z.string().nullable(),
});
export type InvitationIssuedResponse = z.infer<typeof invitationIssuedResponseSchema>;

export const invitationIdParamsSchema = z.object({
  invitationId: z.uuid({ error: 'Undangan tidak ditemukan.' }),
});

export const revokeInvitationResponseSchema = z.object({ status: z.literal('revoked') });
export type RevokeInvitationResponse = z.infer<typeof revokeInvitationResponseSchema>;

// ── Publik: membuka & menerima undangan ─────────────────────────────────────

export const inspectInvitationRequestSchema = z.object({ token: linkTokenSchema });
export type InspectInvitationRequest = z.infer<typeof inspectInvitationRequestSchema>;

/** Isi undangan — hanya untuk token yang sah. */
export const inspectInvitationResponseSchema = z.object({
  email: z.string(),
  role: invitableRoleSchema,
  organizationName: z.string(),
  /** Nama produk dari branding (bawaan "Balesin"). */
  productName: z.string(),
  invitedByName: z.string(),
  expiresAt: isoDateTimeSchema,
  /** Peran ini wajib verifikasi dua langkah: setelah membuat password, langsung daftar 2FA. */
  twoFactorRequired: z.boolean(),
});
export type InspectInvitationResponse = z.infer<typeof inspectInvitationResponseSchema>;

/** Peran diambil dari undangan, bukan dari isian ini. */
export const acceptInvitationRequestSchema = z.object({
  token: linkTokenSchema,
  name: personNameSchema,
  password: newPasswordSchema,
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

/**
 * 201: akun dibuat dan langsung masuk.
 *  - CS/Teknisi: `authenticated` (sesi penuh + cookie perangkat dikenal).
 *  - Admin/Supervisor: `two_factor_enrollment_required` — sesi TERBATAS 30 menit yang hanya
 *    bisa dipakai mendaftarkan 2FA (bentuk & aturan sama dengan akhir wizard setup).
 */
export const acceptInvitationResponseSchema = meResponseSchema;
export type AcceptInvitationResponse = MeResponse;
