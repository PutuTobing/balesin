import { simpleParser, type AddressObject } from 'mailparser';

import {
  authenticationResultsOf,
  authServIdOf,
  emailSenderVerification,
  normalizeEmailAddress,
  normalizeMessageId,
  type EmailSenderVerification,
} from '../channels/email-message';
import { cleanCustomerText } from '../meta/contact-identity';

/**
 * Header email akun Email (Fase 9, KONTRAK-API-EMAIL §11 langkah 2): hanya header yang diminta lewat
 * `BODY.PEEK[HEADER.FIELDS (…)]` (bukan isi) → ringkasan aman untuk `mail_messages`.
 *
 *  - Teks (nama, subjek) dibersihkan dari karakter kendali & pengubah arah (`cleanCustomerText`).
 *  - Alamat huruf kecil, ≤ 100 per header (sisanya hanya dihitung).
 *  - Verifikasi pengirim: `Authentication-Results` TERATAS dari server tepercaya akun.
 *  - Alamat tujuan (`delivered_to`): `Delivered-To` teratas → `X-Original-To` → `To`/`Cc` yang cocok
 *    identitas/domain akun → `null` (header amplop bisa dipalsukan bila tidak cocok domain akun).
 */

/** Header yang diambil saat sinkron (urutan bebas; huruf besar seperti dikirim ke server). */
export const MAIL_SYNC_HEADER_FIELDS = [
  'FROM',
  'SENDER',
  'REPLY-TO',
  'TO',
  'CC',
  'BCC',
  'SUBJECT',
  'DATE',
  'MESSAGE-ID',
  'IN-REPLY-TO',
  'REFERENCES',
  'DELIVERED-TO',
  'X-ORIGINAL-TO',
  'AUTHENTICATION-RESULTS',
  'LIST-UNSUBSCRIBE',
  'AUTO-SUBMITTED',
  'PRECEDENCE',
] as const;

export const MAIL_MAX_ADDRESSES_PER_HEADER = 100;

export interface MailAddress {
  address: string;
  name: string | null;
}

export interface MailAuthResult {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  authServId: string | null;
}

export interface MailHeaderSummary {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  from: MailAddress | null;
  senderAddress: string | null;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  toCount: number;
  ccCount: number;
  deliveredTo: string | null;
  subject: string | null;
  sentAt: Date | null;
  senderVerification: EmailSenderVerification;
  authDetails: MailAuthResult | null;
}

export interface MailHeaderContext {
  /** `authserv-id` tepercaya akun (bawaan dari host IMAP). */
  trustedAuthServIds: readonly string[];
  /** Alamat identitas akun (utama + alias 9B), huruf kecil. */
  identities: readonly string[];
}

function addressEntries(
  value: AddressObject | AddressObject[] | undefined,
): AddressObject['value'] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item) => item.value);
}

function addressList(value: AddressObject | AddressObject[] | undefined): {
  list: MailAddress[];
  count: number;
} {
  const seen = new Set<string>();
  const list: MailAddress[] = [];
  let count = 0;
  const visit = (entries: AddressObject['value']) => {
    for (const entry of entries) {
      if (entry.group) visit(entry.group);
      const address = normalizeEmailAddress(entry.address);
      if (!address || seen.has(address)) continue;
      seen.add(address);
      count += 1;
      if (list.length < MAIL_MAX_ADDRESSES_PER_HEADER) {
        list.push({ address, name: cleanCustomerText(entry.name || null, 200) });
      }
    }
  };
  visit(addressEntries(value));
  return { list, count };
}

function messageIds(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value ? value.split(/\s+/) : [];
  return raw
    .map((item) => normalizeMessageId(item))
    .filter((id): id is string => id !== null && id.length <= 998)
    .slice(-20);
}

function headerValues(lines: readonly { key: string; line: string }[], key: string): string[] {
  return lines
    .filter((entry) => entry.key === key)
    .map((entry) =>
      entry.line
        .slice(entry.line.indexOf(':') + 1)
        .replace(/\s+/g, ' ')
        .trim(),
    );
}

/** `spf=pass`, `dkim=…`, `dmarc=…` dari satu nilai `Authentication-Results`. */
export function authResultOf(value: string): MailAuthResult {
  const text = value.toLowerCase();
  const pick = (method: string) => {
    const match = new RegExp(`\\b${method}=([a-z]{2,16})\\b`).exec(text);
    return match?.[1] ?? null;
  };
  return {
    spf: pick('spf'),
    dkim: pick('dkim'),
    dmarc: pick('dmarc'),
    authServId: authServIdOf(value),
  };
}

function trustedFirst(results: readonly string[], trusted: readonly string[]): string | null {
  for (const value of results) {
    const id = authServIdOf(value);
    if (
      id !== null &&
      trusted.some((entry) =>
        entry.startsWith('.') ? id.endsWith(entry) || id === entry.slice(1) : id === entry,
      )
    ) {
      return value;
    }
  }
  return null;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/** Alamat tujuan sebenarnya (kontrak §3 `delivered_to`). */
export function mailDeliveredTo(input: {
  envelope: readonly string[];
  to: readonly MailAddress[];
  cc: readonly MailAddress[];
  identities: readonly string[];
}): string | null {
  const own = new Set(input.identities.map((address) => address.toLowerCase()));
  const domains = new Set([...own].map(domainOf));
  const matches = (address: string) => own.has(address) || domains.has(domainOf(address));
  const envelope = input.envelope.find(matches);
  if (envelope) return envelope;
  const header = [...input.to, ...input.cc].map((entry) => entry.address).find(matches);
  return header ?? null;
}

/** Urai blok header (tanpa isi). Tidak pernah melempar untuk header rusak — kolom kosong saja. */
export async function parseMailHeaderBlock(
  block: Buffer,
  context: MailHeaderContext,
): Promise<MailHeaderSummary> {
  const source = Buffer.concat([block.subarray(0, 256 * 1024), Buffer.from('\r\n\r\n')]);
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  const from = addressList(parsed.from).list[0] ?? null;
  const to = addressList(parsed.to);
  const cc = addressList(parsed.cc);
  const bcc = addressList(parsed.bcc);
  const replyTo = addressList(parsed.replyTo);
  const senderHeader = parsed.headers.get('sender');
  const sender =
    senderHeader && typeof senderHeader === 'object' && 'value' in senderHeader
      ? (addressList(senderHeader as AddressObject).list[0]?.address ?? null)
      : null;
  const lines = parsed.headerLines;
  const envelope = [...headerValues(lines, 'delivered-to'), ...headerValues(lines, 'x-original-to')]
    .map((value) => normalizeEmailAddress(/<([^<>]+)>/.exec(value)?.[1] ?? value))
    .filter((value): value is string => value !== null)
    .slice(0, 10);
  const results = authenticationResultsOf(lines);
  const trusted = trustedFirst(results, context.trustedAuthServIds);
  const date = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;
  return {
    messageIdHeader: normalizeMessageId(parsed.messageId)?.slice(0, 998) ?? null,
    inReplyTo: messageIds(parsed.inReplyTo)[0] ?? null,
    references: messageIds(parsed.references),
    from,
    senderAddress: sender,
    replyTo: replyTo.list.slice(0, 10),
    to: to.list,
    cc: cc.list,
    bcc: bcc.list,
    toCount: to.count,
    ccCount: cc.count,
    deliveredTo: mailDeliveredTo({
      envelope,
      to: to.list,
      cc: cc.list,
      identities: context.identities,
    }),
    subject: cleanCustomerText(parsed.subject ?? null, 998),
    sentAt: date,
    senderVerification: emailSenderVerification(
      results,
      context.trustedAuthServIds,
      from ? domainOf(from.address) : null,
    ),
    authDetails: trusted ? authResultOf(trusted) : null,
  };
}

/** Cuplikan ≤ 200 karakter dari awal bagian teks (sudah didekode transfer-encoding-nya). */
export function mailSnippetOf(text: string | null | undefined): string | null {
  if (!text) return null;
  return cleanCustomerText(text.replace(/<[^>]{0,500}>/g, ' '), 200);
}
