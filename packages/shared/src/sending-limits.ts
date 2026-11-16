import { z } from 'zod';

import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';

/**
 * Rem pengiriman pesan keluar (SECURITY.md §5, review ruang chat S2). Nilai disimpan di DB
 * (`organizations`) dan diatur lewat Pengaturan → Batas kirim (PENGATURAN-UI), bukan `.env`.
 *
 *  - batas harian (24 jam bergulir) per pengguna dan per organisasi;
 *  - batas per percakapan per menit (spam ke satu pelanggan);
 *  - rem darurat: Owner/Admin menghentikan SEMUA pengiriman keluar seketika (antrean ikut berhenti);
 *    hanya `sending.resume` (+ konfirmasi identitas) yang bisa melanjutkan.
 *
 * Mengubah batas / melanjutkan = `sending.limits.manage` / `sending.resume` + konfirmasi identitas;
 * menarik rem = `sending.limits.manage` TANPA konfirmasi (arah aman, harus cepat). Semua diaudit +
 * banner keamanan; rem ditarik dan batas harian tercapai juga diemail ke semua Owner.
 */
export const SENDING_LIMIT_BOUNDS = {
  dailyPerUser: { default: 500, min: 1, max: 100_000 },
  dailyPerOrganization: { default: 5_000, min: 1, max: 1_000_000 },
  perConversationPerMinute: { default: 20, min: 1, max: 120 },
} as const;

const bounded = (key: keyof typeof SENDING_LIMIT_BOUNDS, label: string) =>
  z
    .number({ error: `${label} harus angka.` })
    .int(`${label} harus bilangan bulat.`)
    .min(
      SENDING_LIMIT_BOUNDS[key].min,
      `${label} paling sedikit ${String(SENDING_LIMIT_BOUNDS[key].min)}.`,
    )
    .max(
      SENDING_LIMIT_BOUNDS[key].max,
      `${label} paling banyak ${SENDING_LIMIT_BOUNDS[key].max.toLocaleString('id-ID')}.`,
    );

export const sendingLimitsSchema = z.object({
  dailyPerUser: z.number().int(),
  dailyPerOrganization: z.number().int(),
  perConversationPerMinute: z.number().int(),
  /** Rem darurat sedang ditarik (`null` = pengiriman berjalan). */
  paused: z
    .object({
      at: isoDateTimeSchema,
      by: z.object({ id: z.uuid(), name: z.string() }).nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  /** Pesan keluar 24 jam terakhir (seluruh organisasi). */
  sentLast24Hours: z.number().int().nonnegative(),
});
export type SendingLimits = z.infer<typeof sendingLimitsSchema>;
export const sendingLimitsResponseSchema = z.object({ limits: sendingLimitsSchema });
export type SendingLimitsResponse = z.infer<typeof sendingLimitsResponseSchema>;

export const updateSendingLimitsRequestSchema = z.object({
  dailyPerUser: bounded('dailyPerUser', 'Batas harian per pengguna'),
  dailyPerOrganization: bounded('dailyPerOrganization', 'Batas harian organisasi'),
  perConversationPerMinute: bounded('perConversationPerMinute', 'Batas per percakapan per menit'),
  confirmation: identityConfirmationSchema.optional(),
});
export type UpdateSendingLimitsRequest = z.infer<typeof updateSendingLimitsRequestSchema>;

export const pauseSendingRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(200, 'Alasan terlalu panjang (maks. 200 karakter).')
    .refine((value) => !hasControlCharacters(value), 'Alasan memuat karakter khusus.')
    .optional(),
});
export type PauseSendingRequest = z.infer<typeof pauseSendingRequestSchema>;

/**
 * `GET /inbox/sending-status` (`inbox.view`) — status rem darurat untuk banner inbox semua agen,
 * tanpa rincian batas/pelaku. Berubah → event WebSocket `sending.changed`.
 */
export const sendingStatusResponseSchema = z.object({ paused: z.boolean() });
export type SendingStatusResponse = z.infer<typeof sendingStatusResponseSchema>;

export const resumeSendingRequestSchema = z.object({
  confirmation: identityConfirmationSchema.optional(),
});
export type ResumeSendingRequest = z.infer<typeof resumeSendingRequestSchema>;
