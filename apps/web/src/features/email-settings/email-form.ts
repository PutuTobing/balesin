import {
  SMTP_DEFAULT_PORTS,
  SMTP_PRESETS,
  applySmtpPreset,
  emailSettingsInputSchema,
  type EmailSettingsInput,
  type EmailSettingsView,
  type SmtpPresetId,
  type SmtpSecurity,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import { zodFieldErrors, type FieldErrors } from '../../lib/form';

/**
 * Isian form email pengirim (docs/PENGATURAN-UI.md §1), dipakai bersama oleh wizard setup
 * langkah "Email" dan Pengaturan → Email pengirim. Semua nilai berupa teks seperti di form;
 * diubah ke `EmailSettingsInput` (skema `@balesin/shared`) saat dites atau disimpan.
 */
export interface EmailFormValues {
  preset: SmtpPresetId;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  /** `false` = username masih mengikuti alamat pengirim (bawaan). */
  usernameEdited: boolean;
  password: string;
}

export const emptyEmailForm: EmailFormValues = {
  preset: 'other',
  fromName: '',
  fromAddress: '',
  replyTo: '',
  host: '',
  port: String(SMTP_DEFAULT_PORTS.ssl),
  security: 'ssl',
  username: '',
  usernameEdited: false,
  password: '',
};

/** Form terisi dari pengaturan tersimpan (password tidak pernah dikirim balik server). */
export function emailFormFromView(view: EmailSettingsView): EmailFormValues {
  return {
    preset: presetForHost(view.host),
    fromName: view.fromName,
    fromAddress: view.fromAddress,
    replyTo: view.replyTo ?? '',
    host: view.host,
    port: String(view.port),
    security: view.security,
    username: view.username ?? '',
    usernameEdited: (view.username ?? '') !== view.fromAddress,
    password: '',
  };
}

/** Preset yang host-nya cocok, untuk menandai pilihan saat form dibuka lagi. */
export function presetForHost(host: string): SmtpPresetId {
  const lower = host.trim().toLowerCase();
  const fixed = SMTP_PRESETS.find((preset) => preset.host === lower);
  if (fixed) return fixed.id;
  if (lower.startsWith('mail.')) return 'cpanel';
  return 'other';
}

/** Gabungkan perubahan isian dengan aturan turunannya (username bawaan, port bawaan). */
export function updateEmailForm(
  values: EmailFormValues,
  patch: Partial<EmailFormValues>,
): EmailFormValues {
  const next = { ...values, ...patch };
  if (patch.username !== undefined) next.usernameEdited = patch.username !== next.fromAddress;
  if (patch.fromAddress !== undefined && !values.usernameEdited) {
    next.username = patch.fromAddress.trim();
  }
  // Ganti keamanan: port ikut berganti bila port lama memang port bawaan keamanan sebelumnya.
  if (patch.security !== undefined && patch.port === undefined) {
    const previousDefault = String(SMTP_DEFAULT_PORTS[values.security]);
    if (values.port.trim() === '' || values.port.trim() === previousDefault) {
      next.port = String(SMTP_DEFAULT_PORTS[patch.security]);
    }
  }
  return next;
}

/** Pilih preset: isi host/port/keamanan yang ditentukan preset itu. */
export function applyPreset(values: EmailFormValues, presetId: SmtpPresetId): EmailFormValues {
  const applied = applySmtpPreset(presetId, values.fromAddress);
  return {
    ...values,
    preset: presetId,
    host: applied.host ?? values.host,
    port: applied.port === null ? values.port : String(applied.port),
    security: applied.security ?? values.security,
  };
}

/** Nilai yang menentukan apakah password tersimpan masih boleh dipakai (aturan server). */
function credentialKey(input: {
  host: string;
  port: number | string;
  security: string;
  username: string | null;
}) {
  return [
    input.host.trim().toLowerCase(),
    String(input.port).trim(),
    input.security,
    (input.username ?? '').trim(),
  ].join('|');
}

/**
 * `true` bila password tersimpan masih bisa dipakai: ada password tersimpan, dan host, port,
 * keamanan, serta username tidak berubah (docs/KONTRAK-API-AUTH.md, PUT /settings/email).
 */
export function canKeepStoredPassword(
  values: EmailFormValues,
  saved: EmailSettingsView | null | undefined,
): boolean {
  if (!saved?.hasPassword) return false;
  return (
    credentialKey(saved) === credentialKey({ ...values, username: values.username.trim() || null })
  );
}

export type EmailFormResult =
  { ok: true; input: EmailSettingsInput } | { ok: false; errors: FieldErrors };

/**
 * Ubah isian form ke `EmailSettingsInput` dan validasi dengan skema bersama.
 * `saved`: pengaturan tersimpan (halaman Pengaturan) — password kosong boleh bila password
 * tersimpan masih berlaku; selain itu password wajib bila server butuh login.
 */
export function toEmailInput(
  values: EmailFormValues,
  saved?: EmailSettingsView | null,
): EmailFormResult {
  const port = values.port.trim();
  const candidate = {
    fromName: values.fromName,
    fromAddress: values.fromAddress,
    replyTo: values.replyTo.trim() === '' ? null : values.replyTo,
    host: values.host,
    port: /^\d+$/.test(port) ? Number(port) : port === '' ? undefined : Number.NaN,
    security: values.security,
    username: values.username.trim() === '' ? null : values.username,
    password: values.password === '' ? undefined : values.password,
  };
  const parsed = emailSettingsInputSchema.safeParse(candidate);
  const errors: FieldErrors = parsed.success ? {} : zodFieldErrors(parsed.error);

  const needsLogin = values.username.trim() !== '';
  if (needsLogin && values.password === '' && !canKeepStoredPassword(values, saved)) {
    errors.password ??= saved?.hasPassword
      ? t.emailSettings.passwordReenter
      : t.emailSettings.passwordRequired;
  }

  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: parsed.data };
}

/** Sidik isian (tanpa password) untuk mengetahui apakah hasil tes masih sesuai isian sekarang. */
export function emailFormFingerprint(values: EmailFormValues): string {
  return JSON.stringify([
    values.fromName.trim(),
    values.fromAddress.trim().toLowerCase(),
    values.replyTo.trim().toLowerCase(),
    credentialKey({ ...values, username: values.username.trim() || null }),
    values.password.length,
  ]);
}

/** Isian form berbeda dari yang tersimpan (password terisi = berbeda). */
export function isEmailFormDirty(
  values: EmailFormValues,
  saved: EmailSettingsView | null,
): boolean {
  if (!saved) return true;
  return (
    values.password !== '' ||
    emailFormFingerprint({ ...values, password: '' }) !==
      emailFormFingerprint({ ...emailFormFromView(saved), password: '' })
  );
}

/**
 * Menyimpan butuh konfirmasi identitas (review akhir Fase 1 T2): simpan pertama kali, atau jalur
 * kirim berubah (server, port, keamanan, username, password, alamat pengirim, balas-ke). Mengubah
 * nama pengirim saja tidak.
 */
export function needsIdentityToSave(
  values: EmailFormValues,
  saved: EmailSettingsView | null,
): boolean {
  if (!saved) return true;
  return isEmailFormDirty({ ...values, fromName: saved.fromName }, saved);
}
