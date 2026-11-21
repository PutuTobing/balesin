import { z } from 'zod';

/**
 * Pratinjau template email sistem (docs/PENGATURAN-UI.md §1: "Template email … bisa dipratinjau;
 * memakai logo & warna organisasi"). Isinya contoh — tidak ada token sungguhan.
 */
export const EMAIL_TEMPLATE_IDS = [
  'invitation',
  'password_reset',
  'email_verification',
  'password_changed',
  'two_factor_enabled',
  'two_factor_enabled_admin',
  'account_locked',
] as const;
export const emailTemplateIdSchema = z.enum(EMAIL_TEMPLATE_IDS, {
  error: 'Template email tidak dikenal.',
});
export type EmailTemplateId = z.infer<typeof emailTemplateIdSchema>;

export const EMAIL_TEMPLATE_LABELS: Record<EmailTemplateId, string> = {
  invitation: 'Undangan bergabung',
  password_reset: 'Atur ulang password',
  email_verification: 'Verifikasi email',
  password_changed: 'Pemberitahuan password diubah',
  two_factor_enabled: 'Verifikasi dua langkah aktif',
  two_factor_enabled_admin: 'Verifikasi dua langkah aktif (ke Owner/Admin)',
  account_locked: 'Percobaan masuk dihentikan sementara',
};

export const emailTemplateParamsSchema = z.object({ template: emailTemplateIdSchema });

/**
 * `GET /settings/email/templates/:template/preview`. `html` adalah dokumen HTML lengkap
 * (logo sebagai `data:` URI). Tampilkan di `<iframe sandbox srcdoc>` (tanpa `allow-scripts`);
 * `text` adalah versi teks polos yang ikut terkirim.
 */
export const emailTemplatePreviewResponseSchema = z.object({
  template: emailTemplateIdSchema,
  subject: z.string(),
  text: z.string(),
  html: z.string(),
});
export type EmailTemplatePreviewResponse = z.infer<typeof emailTemplatePreviewResponseSchema>;
