import {
  EMAIL_POLL_INTERVAL_MINUTES,
  IMAP_DEFAULT_PORTS,
  createConnectionChannelRequestSchema,
  updateConnectionChannelRequestSchema,
  type ConnectionChannel,
  type ConnectionChannelType,
  type CreateConnectionChannelRequest,
  type ImapSecurity,
  type UpdateConnectionChannelRequest,
} from '@balesin/shared';
import { useRef, useState } from 'react';
import { zodFieldErrors, type FieldErrors } from '../../../lib/form';

export type SmtpSecurity = 'ssl' | 'starttls' | 'none';
export const SMTP_DEFAULT_PORTS: Record<SmtpSecurity, number> = {
  ssl: 465,
  starttls: 587,
  none: 25,
};

/** Isian non-rahasia (state). Rahasia hanya di elemen input tak terkendali (`refs`). */
export interface ConnectionValues {
  name: string;
  emailAddress: string;
  fromName: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: ImapSecurity;
  imapUsername: string;
  folder: string;
  pollInterval: string;
  markAsRead: boolean;
  smtpMode: 'system' | 'custom';
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string;
  trusted: string;
  pageId: string;
  instagramAccountId: string;
}

type SecretName = 'botToken' | 'imapPassword' | 'smtpPassword' | 'pageAccessToken' | 'appSecret';

/** Isian yang mengubah kredensial/tujuan koneksi → wajib konfirmasi identitas (kontrak PATCH). */
const SENSITIVE_KEYS = [
  'botToken',
  'emailAddress',
  'imap',
  'smtp',
  'trustedAuthServIds',
  'pageId',
  'instagramAccountId',
  'pageAccessToken',
  'appSecret',
] as const;

function initialValues(channel: ConnectionChannel | null): ConnectionValues {
  const email = channel?.type === 'email' ? channel : null;
  const meta =
    channel && (channel.type === 'messenger' || channel.type === 'instagram') ? channel : null;
  const smtp = email?.smtp.mode === 'custom' ? email.smtp : null;
  return {
    name: channel?.name ?? '',
    emailAddress: email?.emailAddress ?? '',
    fromName: email?.fromName ?? '',
    imapHost: email?.imap.host ?? '',
    imapPort: String(email?.imap.port ?? IMAP_DEFAULT_PORTS.ssl),
    imapSecurity: email?.imap.security ?? 'ssl',
    imapUsername: email?.imap.username ?? '',
    folder: email?.imap.folder ?? 'INBOX',
    pollInterval: String(email?.pollIntervalMinutes ?? EMAIL_POLL_INTERVAL_MINUTES.default),
    markAsRead: email?.markAsRead ?? true,
    smtpMode: email?.smtp.mode ?? 'system',
    smtpHost: smtp?.host ?? '',
    smtpPort: String(smtp?.port ?? SMTP_DEFAULT_PORTS.starttls),
    smtpSecurity: smtp?.security ?? 'starttls',
    smtpUsername: smtp?.username ?? '',
    trusted:
      email && !email.senderVerification.isDefault
        ? email.senderVerification.trustedAuthServIds.join('\n')
        : '',
    pageId: meta?.pageId ?? '',
    instagramAccountId: meta?.instagramAccountId ?? '',
  };
}

const toNumber = (value: string) =>
  /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;

/**
 * State form channel (buat & ubah). `build()` menyusun body sesuai jenis dan memvalidasinya dengan
 * skema bersama (galat per isian, mis. `imap.host`). Saat mengubah, hanya isian yang berubah yang
 * dikirim; `sensitive` = perlu konfirmasi identitas.
 */
export function useConnectionForm(type: ConnectionChannelType, channel: ConnectionChannel | null) {
  const [values, setValues] = useState(() => initialValues(channel));
  const [errors, setErrors] = useState<FieldErrors>({});
  // Rahasia hanya di elemen input (callback ref), tidak pernah di state React.
  const secrets = useRef<Partial<Record<SecretName, HTMLInputElement | null>>>({});
  const secretRef = (name: SecretName) => (element: HTMLInputElement | null) => {
    secrets.current[name] = element;
  };
  const editing = channel !== null;
  const initial = initialValues(channel);

  const set = <K extends keyof ConnectionValues>(key: K, value: ConnectionValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors({});
  };
  const secret = (name: SecretName) => {
    const value = secrets.current[name]?.value ?? '';
    return value.trim() === '' ? undefined : value;
  };
  const clearSecrets = () => {
    for (const element of Object.values(secrets.current)) if (element) element.value = '';
  };

  function emailBody() {
    const imapChanged =
      !editing ||
      values.imapHost !== initial.imapHost ||
      values.imapPort !== initial.imapPort ||
      values.imapSecurity !== initial.imapSecurity ||
      values.imapUsername !== initial.imapUsername ||
      values.folder !== initial.folder ||
      secret('imapPassword') !== undefined;
    const smtpChanged =
      !editing ||
      values.smtpMode !== initial.smtpMode ||
      (values.smtpMode === 'custom' &&
        (values.smtpHost !== initial.smtpHost ||
          values.smtpPort !== initial.smtpPort ||
          values.smtpSecurity !== initial.smtpSecurity ||
          values.smtpUsername !== initial.smtpUsername ||
          secret('smtpPassword') !== undefined));
    const trustedList = values.trusted
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const trusted = trustedList.length > 0 ? trustedList : null;
    const body: Record<string, unknown> = {
      type: 'email',
      name: values.name,
      emailAddress: values.emailAddress,
      fromName: values.fromName,
      pollIntervalMinutes: toNumber(values.pollInterval),
      markAsRead: values.markAsRead,
    };
    if (imapChanged) {
      body.imap = {
        host: values.imapHost,
        port: toNumber(values.imapPort),
        security: values.imapSecurity,
        username: values.imapUsername,
        folder: values.folder || 'INBOX',
        ...(secret('imapPassword') !== undefined || !editing
          ? { password: secret('imapPassword') ?? '' }
          : {}),
      };
    }
    if (smtpChanged) {
      body.smtp =
        values.smtpMode === 'system'
          ? { mode: 'system' }
          : {
              mode: 'custom',
              host: values.smtpHost,
              port: toNumber(values.smtpPort),
              security: values.smtpSecurity,
              username: values.smtpUsername,
              ...(secret('smtpPassword') !== undefined || !editing || initial.smtpMode !== 'custom'
                ? { password: secret('smtpPassword') ?? '' }
                : {}),
            };
    }
    if (!editing || values.trusted !== initial.trusted) body.trustedAuthServIds = trusted;
    return body;
  }

  function rawBody(): Record<string, unknown> {
    switch (type) {
      case 'telegram':
        return {
          type,
          name: values.name,
          botToken: editing ? secret('botToken') : (secret('botToken') ?? ''),
        };
      case 'email':
        return emailBody();
      case 'messenger':
      case 'instagram':
        return {
          type,
          name: values.name,
          pageId: values.pageId,
          ...(type === 'instagram' ? { instagramAccountId: values.instagramAccountId } : {}),
          pageAccessToken: editing ? secret('pageAccessToken') : (secret('pageAccessToken') ?? ''),
          appSecret: editing ? secret('appSecret') : (secret('appSecret') ?? ''),
        };
    }
  }

  /** Buang isian yang tidak berubah saat mengubah (rahasia kosong = tidak diganti). */
  function diff(body: Record<string, unknown>): Record<string, unknown> {
    if (!editing) return body;
    const out: Record<string, unknown> = { type };
    const same: Record<string, unknown> = {
      name: initial.name,
      emailAddress: initial.emailAddress,
      fromName: initial.fromName,
      pollIntervalMinutes: toNumber(initial.pollInterval),
      markAsRead: initial.markAsRead,
      pageId: initial.pageId,
      instagramAccountId: initial.instagramAccountId,
    };
    for (const [key, value] of Object.entries(body)) {
      if (key === 'type' || value === undefined) continue;
      if (key in same && same[key] === value) continue;
      out[key] = value;
    }
    return out;
  }

  function build():
    | {
        ok: true;
        create: CreateConnectionChannelRequest;
        update: UpdateConnectionChannelRequest;
        sensitive: boolean;
        empty: boolean;
      }
    | { ok: false } {
    const body = diff(rawBody());
    const schema = editing
      ? updateConnectionChannelRequestSchema
      : createConnectionChannelRequestSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return { ok: false };
    }
    setErrors({});
    const keys = Object.keys(body).filter((key) => key !== 'type');
    return {
      ok: true,
      create: body as CreateConnectionChannelRequest,
      update: body as UpdateConnectionChannelRequest,
      sensitive:
        !editing || keys.some((key) => (SENSITIVE_KEYS as readonly string[]).includes(key)),
      empty: keys.length === 0,
    };
  }

  return { type, editing, values, set, errors, setErrors, secretRef, build, clearSecrets };
}

export type ConnectionForm = ReturnType<typeof useConnectionForm>;
