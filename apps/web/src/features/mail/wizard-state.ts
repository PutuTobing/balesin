import {
  MAIL_IMAP_PORTS,
  MAIL_PRESETS,
  MAIL_SMTP_PORTS,
  MAIL_TEST_MESSAGES,
  type CreateMailAccountInput,
  type ErrorDetail,
  type MailAccessGrantRequest,
  type MailAccessLevel,
  type MailAccountColor,
  type MailAccountKind,
  type MailAvailableProvider,
  type MailImapInput,
  type MailServerSuggestion,
  type MailSmtpInput,
  type MailSyncWindowDays,
  type MailTestCode,
  type MailTlsSecurity,
  type TestMailAccountResponse,
} from '@balesin/shared';
import { emailDomain } from './mail-format';

/**
 * Logika wizard "Hubungkan akun email" tanpa React (dites unit). Password TIDAK pernah ada di sini
 * kecuali sebagai argumen saat menyusun body permintaan — nilainya dibaca dari isian tak
 * terkendali (`SecretField`) tepat sebelum dikirim.
 */

export const WIZARD_STEPS = 4;
export type WizardStep = 1 | 2 | 3 | 4;

/** Isian server & identitas (state). Port disimpan sebagai teks isian. */
export interface ServerValues {
  displayName: string;
  fromName: string;
  username: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: MailTlsSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailTlsSecurity;
  sameCredentials: boolean;
  smtpUsername: string;
}

/** Penerima akses di wizard / kartu Akses (nama & keterangan untuk tampilan saja). */
export interface GrantDraft {
  principalType: 'user' | 'department';
  id: string;
  name: string;
  /** "5 orang" / "Supervisor". */
  meta: string;
  level: MailAccessLevel;
  /** Pengguna nonaktif: server menolak menyimpannya. */
  inactive?: boolean;
}

/** "cs" → "CS", "billing" → "Billing", "noc.pusat" → "Noc.pusat". */
export function displayNameFromAddress(address: string): string {
  const local = address.split('@')[0]?.trim() ?? '';
  if (local.length === 0) return '';
  if (local.length <= 3) return local.toUpperCase();
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** Saran server pertama yang bisa dipakai 9A (IMAP + SMTP lengkap, penyedia cPanel/IMAP). */
export function usableSuggestion(
  suggestions: readonly MailServerSuggestion[],
): MailServerSuggestion | null {
  return (
    suggestions.find(
      (item) =>
        item.imap !== null &&
        item.smtp !== null &&
        (item.provider === 'cpanel' || item.provider === 'imap'),
    ) ?? null
  );
}

/** Saran untuk penyedia yang belum didukung (Gmail/Microsoft): hanya catatan. */
export function unsupportedSuggestion(
  suggestions: readonly MailServerSuggestion[],
): MailServerSuggestion | null {
  return suggestions.find((item) => item.imap === null || item.smtp === null) ?? null;
}

/** Isian awal langkah Detail akun: dari saran deteksi, atau preset penyedia yang dipilih. */
export function initialServerValues(
  emailAddress: string,
  provider: MailAvailableProvider,
  suggestion: MailServerSuggestion | null,
  organizationName: string,
): ServerValues {
  const domain = emailDomain(emailAddress);
  const local = emailAddress.split('@')[0] ?? '';
  const preset = MAIL_PRESETS[provider];
  const guessedHost = provider === 'cpanel' && domain ? `mail.${domain}` : '';
  const imap = suggestion?.imap ?? {
    host: guessedHost,
    port: preset.imap.port,
    security: preset.imap.security,
  };
  const smtp = suggestion?.smtp ?? {
    host: guessedHost,
    port: preset.smtp.port,
    security: preset.smtp.security,
  };
  const usernameKind = suggestion?.username ?? preset.username;
  return {
    displayName: displayNameFromAddress(emailAddress),
    fromName: organizationName,
    username: usernameKind === 'localpart' ? local : emailAddress.trim().toLowerCase(),
    imapHost: imap.host,
    imapPort: String(imap.port),
    imapSecurity: imap.security,
    smtpHost: smtp.host,
    smtpPort: String(smtp.port),
    smtpSecurity: smtp.security,
    sameCredentials: true,
    smtpUsername: '',
  };
}

/**
 * Ganti keamanan → port ikut berganti bila port lama masih port bawaan keamanan lama (port yang
 * diketik sendiri tidak ditimpa).
 */
export function portForSecurity(
  kind: 'imap' | 'smtp',
  currentPort: string,
  previous: MailTlsSecurity,
  next: MailTlsSecurity,
): string {
  const ports = kind === 'imap' ? MAIL_IMAP_PORTS : MAIL_SMTP_PORTS;
  return currentPort.trim() === String(ports[previous]) || currentPort.trim() === ''
    ? String(ports[next])
    : currentPort;
}

const toPort = (value: string) => (/^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : NaN);

/**
 * Bagian `imap` + `smtp` body (tes, buat, ubah). `password` kosong = tidak dikirim (akun tersimpan:
 * pakai password lama).
 */
export function serverBody(
  values: ServerValues,
  passwords: { imap?: string; smtp?: string },
): { imap: MailImapInput; smtp: MailSmtpInput } {
  return {
    imap: {
      host: values.imapHost,
      port: toPort(values.imapPort),
      security: values.imapSecurity,
      username: values.username,
      ...(passwords.imap ? { password: passwords.imap } : {}),
    },
    smtp: values.sameCredentials
      ? {
          host: values.smtpHost,
          port: toPort(values.smtpPort),
          security: values.smtpSecurity,
          sameCredentials: true,
        }
      : {
          host: values.smtpHost,
          port: toPort(values.smtpPort),
          security: values.smtpSecurity,
          sameCredentials: false,
          username: values.smtpUsername,
          ...(passwords.smtp ? { password: passwords.smtp } : {}),
        },
  };
}

/** Sidik isian yang memengaruhi hasil tes: berubah = hasil tes lama tidak berlaku. */
export function testSignature(emailAddress: string, values: ServerValues): string {
  return JSON.stringify([
    emailAddress.trim().toLowerCase(),
    values.username,
    values.imapHost,
    values.imapPort,
    values.imapSecurity,
    values.smtpHost,
    values.smtpPort,
    values.smtpSecurity,
    values.sameCredentials,
    values.sameCredentials ? '' : values.smtpUsername,
  ]);
}

export function testPassed(result: TestMailAccountResponse | null): boolean {
  return result?.incoming?.ok === true && result.outgoing?.ok === true;
}

export interface CreateDraft {
  kind: MailAccountKind;
  provider: MailAvailableProvider;
  emailAddress: string;
  values: ServerValues;
  color: MailAccountColor;
  syncWindowDays: MailSyncWindowDays;
  grants: readonly GrantDraft[];
}

export function grantRequests(grants: readonly GrantDraft[]): MailAccessGrantRequest[] {
  return grants.map((grant) =>
    grant.principalType === 'user'
      ? { principalType: 'user', userId: grant.id, level: grant.level }
      : { principalType: 'department', departmentId: grant.id, level: grant.level },
  );
}

/** Body `POST /mail/accounts` (tanpa `confirmation`). */
export function createBody(
  draft: CreateDraft,
  passwords: { imap: string; smtp?: string },
): CreateMailAccountInput {
  const { imap, smtp } = serverBody(draft.values, passwords);
  return {
    kind: draft.kind,
    provider: draft.provider,
    displayName: draft.values.displayName,
    emailAddress: draft.emailAddress,
    fromName: draft.values.fromName,
    color: draft.color,
    imap: { ...imap, password: passwords.imap },
    smtp,
    syncWindowDays: draft.syncWindowDays,
    access: draft.kind === 'shared' ? grantRequests(draft.grants) : [],
  };
}

/** Langkah tempat isian berada (galat dari server dibawa ke langkahnya). */
export function stepOfField(field: string): WizardStep {
  if (field === 'emailAddress' || field === 'provider') return 1;
  if (
    field === 'displayName' ||
    field === 'fromName' ||
    field.startsWith('imap') ||
    field.startsWith('smtp')
  ) {
    return 2;
  }
  return 4;
}

/**
 * Tes gagal saat menyimpan (502 `CHANNEL_REQUEST_FAILED`, `details[].field` = `imap`/`smtp`,
 * `reason` = kode tes): hasil tes terakhir ditimpa sisi yang gagal supaya langkah Tes koneksi
 * menampilkan sebab yang sama.
 */
export function resultFromSaveFailure(
  previous: TestMailAccountResponse | null,
  details: readonly ErrorDetail[],
): TestMailAccountResponse {
  const pick = (field: 'imap' | 'smtp') => details.find((detail) => detail.field === field);
  const failure = (detail: ErrorDetail) => {
    const reason = detail.reason;
    const code = (reason && reason in MAIL_TEST_MESSAGES ? reason : 'unknown') as MailTestCode;
    return { code, message: detail.message || MAIL_TEST_MESSAGES[code] };
  };
  const imap = pick('imap');
  const smtp = pick('smtp');
  return {
    testedAt: new Date().toISOString(),
    incoming: imap
      ? {
          ok: false,
          code: failure(imap).code as never,
          message: failure(imap).message,
          durationMs: 0,
          details: null,
        }
      : (previous?.incoming ?? null),
    outgoing: smtp
      ? {
          ok: false,
          code: failure(smtp).code as never,
          message: failure(smtp).message,
          durationMs: 0,
        }
      : (previous?.outgoing ?? null),
  };
}
