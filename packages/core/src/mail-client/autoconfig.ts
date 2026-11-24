/**
 * Pembaca MINIMAL berkas autoconfig Thunderbird (`config-v1.1.xml`, juga ISPDB) untuk deteksi
 * otomatis akun Email (KONTRAK-API-EMAIL §4.1 butir 4).
 *
 * Sengaja bukan parser XML umum: tanpa DTD, tanpa entitas (selain 5 entitas baku), tanpa CDATA,
 * tanpa namespace. Dokumen ber-`<!DOCTYPE`/`<!ENTITY` ditolak utuh (cegah XXE/billion laughs). Hanya
 * `incomingServer type="imap"` dan `outgoingServer type="smtp"` yang dibaca (`hostname`, `port`,
 * `socketType`, `username`), dan hanya pasangan port + keamanan yang didukung yang diterima. Semua
 * regex linear (tanpa pengulangan bersarang), masukan dibatasi 64 KB.
 */

export interface AutoconfigServer {
  host: string;
  port: number;
  security: 'ssl' | 'starttls';
  username: 'address' | 'localpart';
}

export interface AutoconfigResult {
  imap: AutoconfigServer | null;
  smtp: AutoconfigServer | null;
}

export const AUTOCONFIG_MAX_BYTES = 64 * 1024;

const HOST_PATTERN =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(block: string, tag: string): string | null {
  const open = `<${tag}>`;
  const start = block.indexOf(open);
  if (start < 0) return null;
  const end = block.indexOf(`</${tag}>`, start + open.length);
  if (end < 0) return null;
  const value = decodeEntities(block.slice(start + open.length, end)).trim();
  return value.length > 0 && value.length <= 300 ? value : null;
}

/** Blok `<name type="…">…</name>` berurutan (tanpa regex bersarang). */
function blocksOf(xml: string, name: string): { type: string; body: string }[] {
  const out: { type: string; body: string }[] = [];
  let index = 0;
  while (out.length < 20) {
    const start = xml.indexOf(`<${name}`, index);
    if (start < 0) break;
    const headEnd = xml.indexOf('>', start);
    if (headEnd < 0) break;
    const head = xml.slice(start, headEnd + 1);
    const close = xml.indexOf(`</${name}>`, headEnd);
    if (close < 0) break;
    const type = /\btype\s*=\s*"([a-z0-9]{1,16})"/i.exec(head)?.[1]?.toLowerCase() ?? '';
    out.push({ type, body: xml.slice(headEnd + 1, close) });
    index = close + name.length + 3;
  }
  return out;
}

function serverOf(body: string, kind: 'imap' | 'smtp', domain: string): AutoconfigServer | null {
  const rawHost = tagText(body, 'hostname')
    ?.toLowerCase()
    .replace(/%emaildomain%/g, domain);
  const port = Number(tagText(body, 'port'));
  const socket = tagText(body, 'socketType')?.toUpperCase();
  const username = tagText(body, 'username') ?? '%EMAILADDRESS%';
  if (!rawHost || !HOST_PATTERN.test(rawHost)) return null;
  const security = socket === 'SSL' ? 'ssl' : socket === 'STARTTLS' ? 'starttls' : null;
  if (!security) return null;
  const allowed =
    kind === 'imap'
      ? (security === 'ssl' && port === 993) || (security === 'starttls' && port === 143)
      : (security === 'ssl' && port === 465) || (security === 'starttls' && port === 587);
  if (!allowed) return null;
  return {
    host: rawHost,
    port,
    security,
    username: username.toUpperCase() === '%EMAILLOCALPART%' ? 'localpart' : 'address',
  };
}

/** `null` = bukan dokumen autoconfig yang aman/dikenali. */
export function parseAutoconfigXml(xml: string, domain: string): AutoconfigResult | null {
  if (xml.length > AUTOCONFIG_MAX_BYTES) return null;
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) return null;
  if (!xml.includes('<clientConfig')) return null;
  const imapBlock = blocksOf(xml, 'incomingServer').find((block) => block.type === 'imap');
  const smtpBlock = blocksOf(xml, 'outgoingServer').find((block) => block.type === 'smtp');
  const imap = imapBlock ? serverOf(imapBlock.body, 'imap', domain) : null;
  const smtp = smtpBlock ? serverOf(smtpBlock.body, 'smtp', domain) : null;
  if (!imap && !smtp) return null;
  return { imap, smtp };
}

// ── Cuplikan ───────────────────────────────────────────────────────────────

export function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw.toString('latin1').replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charCodeAt(i);
    if (
      text[i] === '=' &&
      i + 2 < text.length + 0 &&
      /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))
    ) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(char & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Awal bagian teks (masih ber-transfer-encoding, bisa terpotong) → teks. Charset tak dikenal →
 * UTF-8 longgar. HTML dibuang tag-nya (hanya untuk cuplikan polos, tidak pernah ditampilkan sebagai HTML).
 */
export function decodeTextPreview(input: {
  raw: Buffer;
  encoding: string | null;
  charset: string | null;
  html: boolean;
}): string {
  let bytes = input.raw;
  if (input.encoding === 'base64') {
    const clean = bytes.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
  } else if (input.encoding === 'quoted-printable') {
    bytes = decodeQuotedPrintable(bytes);
  }
  let text: string;
  try {
    text = new TextDecoder(input.charset ?? 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  if (input.html) {
    text = text
      .replace(/<(style|script)[^>]{0,200}>[\s\S]{0,20000}?<\/\1>/gi, ' ')
      .replace(/<[^>]{0,2000}>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }
  // Baris kutipan balasan ("> …") dan pemisah tidak berguna untuk cuplikan.
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join(' ');
}
