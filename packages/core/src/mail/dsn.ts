import { normalizeMessageId } from '../channels/email-message';

/**
 * Laporan status pengiriman (bounce, RFC 3464) untuk email API (Fase 9.1,
 * docs/KONTRAK-API-EMAIL-KIRIM.md §5). Pemolling channel Email memanggil ini untuk email yang
 * DILEWATI sebagai bounce, lalu mencocokkan `originalMessageIds` dengan `email_outbound`.
 *
 * Pengurai MIME kecil sendiri (bukan `mailparser`): `mailparser` menggabungkan bagian
 * `message/delivery-status` ke teks isi, sehingga blok per penerima tidak bisa dibaca andal.
 * Hanya struktur yang dibutuhkan yang diurai (header, multipart, base64/quoted-printable).
 * DSN palsu hanya bisa menyentuh email yang `Message-ID`-nya diketahui pengirim DSN.
 */

export interface DeliveryStatusRecipient {
  /** Alamat penerima (huruf kecil). */
  recipient: string;
  /** `failed` · `delayed` · `delivered` · `relayed` · `expanded` (huruf kecil). */
  action: string;
  /** Kode status bertingkat, mis. `5.1.1`; `null` bila tidak ada/tidak sah. */
  status: string | null;
}

export interface DeliveryStatusReport {
  /** `Message-ID` email asli (tanpa `<>`). */
  originalMessageIds: string[];
  recipients: DeliveryStatusRecipient[];
  /** `true` = laporan baku `multipart/report; report-type=delivery-status`. */
  standard: boolean;
}

const MAX_MESSAGE_IDS = 20;
const MAX_RECIPIENTS = 50;
const MAX_DEPTH = 5;
/** Bounce lebih besar dari ini tidak diurai (email asli terlampir bisa besar; header cukup). */
const MAX_RAW_BYTES = 2 * 1024 * 1024;

interface MimePart {
  headers: Map<string, string[]>;
  contentType: string;
  params: Record<string, string>;
  body: string;
}

function splitHeaderBody(text: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { head: text, body: '' };
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

/** Header (dilipat RFC 5322 diluruskan) → peta nama huruf kecil → nilai. */
function parseHeaders(head: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = headers.get(name) ?? [];
    list.push(value);
    headers.set(name, list);
  }
  return headers;
}

function first(headers: Map<string, string[]>, name: string): string {
  return headers.get(name)?.[0] ?? '';
}

function parseContentType(value: string): { type: string; params: Record<string, string> } {
  const [typePart, ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const item of rest) {
    const equals = item.indexOf('=');
    if (equals <= 0) continue;
    const key = item.slice(0, equals).trim().toLowerCase();
    const raw = item.slice(equals + 1).trim();
    params[key] = raw.startsWith('"') ? raw.slice(1, raw.lastIndexOf('"')) : raw;
  }
  return { type: (typePart ?? '').trim().toLowerCase() || 'text/plain', params };
}

function decodeBody(body: string, encoding: string): string {
  const kind = encoding.trim().toLowerCase();
  if (kind === 'base64') {
    return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('latin1');
  }
  if (kind === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  }
  return body;
}

function parsePart(text: string): MimePart {
  const { head, body } = splitHeaderBody(text);
  const headers = parseHeaders(head);
  const { type, params } = parseContentType(first(headers, 'content-type'));
  const isMultipart = type.startsWith('multipart/');
  return {
    headers,
    contentType: type,
    params,
    body: isMultipart ? body : decodeBody(body, first(headers, 'content-transfer-encoding')),
  };
}

function childrenOf(part: MimePart): MimePart[] {
  const boundary = part.params.boundary;
  if (!part.contentType.startsWith('multipart/') || !boundary) return [];
  const delimiter = `--${boundary}`;
  const pieces = part.body.split(delimiter);
  const children: MimePart[] = [];
  // pieces[0] = pembuka (diabaikan); bagian terakhir dimulai `--` = penutup.
  for (const piece of pieces.slice(1)) {
    if (piece.startsWith('--')) break;
    children.push(parsePart(piece.replace(/^[ \t]*\r?\n/, '')));
  }
  return children;
}

function walk(part: MimePart, depth: number, visit: (part: MimePart) => void): void {
  visit(part);
  if (depth >= MAX_DEPTH) return;
  for (const child of childrenOf(part)) walk(child, depth + 1, visit);
}

const STATUS_PATTERN = /^[245]\.\d{1,3}\.\d{1,3}$/;
const ADDRESS_PATTERN = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}$/;

function addressOf(value: string): string | null {
  // `rfc822; alamat` (tipe alamat RFC 3464) atau alamat polos.
  const semicolon = value.indexOf(';');
  const raw = (semicolon >= 0 ? value.slice(semicolon + 1) : value)
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
  return ADDRESS_PATTERN.test(raw) ? raw : null;
}

/** Bagian `message/delivery-status`: blok pertama = per pesan, berikutnya per penerima. */
function recipientsOf(statusBody: string): DeliveryStatusRecipient[] {
  const recipients: DeliveryStatusRecipient[] = [];
  const blocks = statusBody.split(/\r?\n[ \t]*\r?\n/);
  for (const block of blocks) {
    const headers = parseHeaders(block);
    const target =
      addressOf(first(headers, 'final-recipient')) ??
      addressOf(first(headers, 'original-recipient'));
    if (!target) continue;
    const action = first(headers, 'action').toLowerCase().split(/\s/)[0] ?? '';
    const status = first(headers, 'status').split(/\s/)[0] ?? '';
    recipients.push({
      recipient: target,
      action: action || 'failed',
      status: STATUS_PATTERN.test(status) ? status : null,
    });
    if (recipients.length >= MAX_RECIPIENTS) break;
  }
  return recipients;
}

function findReport(part: MimePart, depth: number): MimePart | null {
  if (
    part.contentType === 'multipart/report' &&
    (part.params['report-type'] ?? '').toLowerCase() === 'delivery-status'
  ) {
    return part;
  }
  if (depth >= MAX_DEPTH) return null;
  for (const child of childrenOf(part)) {
    const found = findReport(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function pushId(ids: string[], value: string | null, exclude: string | null): void {
  if (!value || value === exclude || ids.includes(value) || ids.length >= MAX_MESSAGE_IDS) return;
  ids.push(value);
}

const MESSAGE_ID_IN_TEXT = /^[ \t>]*message-id:[ \t]*(<[^<>\s]{1,998}>)/gim;

function senderLooksAutomated(headers: Map<string, string[]>): boolean {
  const returnPath = first(headers, 'return-path');
  if (returnPath && /^<\s*>$/.test(returnPath.trim())) return true;
  const from = first(headers, 'from').toLowerCase();
  const address = /<([^<>]+)>/.exec(from)?.[1] ?? from.trim();
  const local = address.split('@')[0] ?? '';
  return local === 'mailer-daemon' || local === 'postmaster';
}

/**
 * Urai bounce. Laporan baku (`multipart/report; report-type=delivery-status`) → penerima dari bagian
 * `message/delivery-status`, `Message-ID` asli dari `text/rfc822-headers`/`message/rfc822`.
 * Cadangan untuk MAILER-DAEMON/postmaster/`Return-Path: <>` tanpa laporan baku: `Message-ID` dicari
 * di isi. Bukan bounce → `null`.
 */
export function parseDeliveryStatusReport(raw: Buffer): Promise<DeliveryStatusReport | null> {
  return Promise.resolve(parseReport(raw));
}

function parseReport(raw: Buffer): DeliveryStatusReport | null {
  const text = raw.subarray(0, MAX_RAW_BYTES).toString('latin1');
  const root = parsePart(text);
  const ownId = normalizeMessageId(first(root.headers, 'message-id'));

  const report = findReport(root, 0);

  if (report) {
    const originalMessageIds: string[] = [];
    let recipients: DeliveryStatusRecipient[] = [];
    for (const child of childrenOf(report)) {
      if (child.contentType === 'message/delivery-status' && recipients.length === 0) {
        recipients = recipientsOf(child.body);
      } else if (
        child.contentType === 'text/rfc822-headers' ||
        child.contentType === 'message/rfc822'
      ) {
        const { head } = splitHeaderBody(child.body);
        const headers = parseHeaders(
          child.contentType === 'text/rfc822-headers' ? child.body : head,
        );
        pushId(originalMessageIds, normalizeMessageId(first(headers, 'message-id')), ownId);
      }
    }
    return { originalMessageIds, recipients, standard: true };
  }

  const reportLike =
    root.contentType === 'message/delivery-status' || root.contentType === 'multipart/report';
  if (!reportLike && !senderLooksAutomated(root.headers)) return null;

  const originalMessageIds: string[] = [];
  const recipients: DeliveryStatusRecipient[] = [];
  walk(root, 0, (part) => {
    if (part.contentType.startsWith('multipart/')) return;
    for (const match of part.body.matchAll(MESSAGE_ID_IN_TEXT)) {
      pushId(originalMessageIds, normalizeMessageId(match[1]), ownId);
    }
    if (recipients.length === 0) recipients.push(...recipientsOf(part.body));
  });
  return {
    originalMessageIds,
    recipients: recipients.slice(0, MAX_RECIPIENTS),
    standard: false,
  };
}
