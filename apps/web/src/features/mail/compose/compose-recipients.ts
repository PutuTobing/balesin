import { mailDomainOf, type MailComposeAddress } from '@balesin/shared';
import { normalizeAddress } from '../../inbox/email-recipients';

/**
 * Kolom Kepada/Cc/Bcc jendela tulis (KONTRAK-API-EMAIL-TULIS §6, §12). Aturan di sini hanya
 * membantu sebelum kirim — server tetap penentu (validator 9.1, batas penerima, jatah alamat baru).
 */

export type RecipientField = 'to' | 'cc' | 'bcc';

export interface Recipients {
  to: MailComposeAddress[];
  cc: MailComposeAddress[];
  bcc: MailComposeAddress[];
}

export interface ParsedInput {
  /** Alamat sah (huruf kecil) + nama bila diketik `Nama <alamat>`. */
  valid: MailComposeAddress[];
  /** Potongan yang bukan alamat sah (tetap di kolom supaya bisa diperbaiki). */
  invalid: string[];
}

/** Nama yang aman untuk header: tanpa kendali, `<>"\`, maks. 80 karakter; kosong → `null`. */
function cleanName(raw: string): string | null {
  const name = raw
    .replace(/[\p{Cc}<>"\\]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return name === '' ? null : name;
}

/**
 * Ketikan/tempelan → alamat: dipisah koma, titik koma, atau baris baru; spasi juga memisah kecuali
 * di dalam bentuk `Nama Lengkap <alamat@contoh.id>` (nama dipertahankan).
 */
export function parseRecipientInput(raw: string): ParsedInput {
  const valid: MailComposeAddress[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[,;\n\r]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const bracket = /^(.*?)<([^<>]+)>\s*$/.exec(trimmed);
    if (bracket) {
      const address = normalizeAddress(bracket[2] ?? '');
      if (address) {
        valid.push({ address, name: cleanName((bracket[1] ?? '').replace(/^["']|["']$/g, '')) });
      } else {
        invalid.push(trimmed);
      }
      continue;
    }
    for (const piece of trimmed.split(/\s+/)) {
      const cleaned = piece.replace(/^["'(]+|["')]+$/g, '');
      if (!cleaned) continue;
      const address = normalizeAddress(cleaned);
      if (address) valid.push({ address, name: null });
      else invalid.push(cleaned);
    }
  }
  return { valid, invalid };
}

/** Semua alamat di tiga kolom (huruf kecil), untuk menolak duplikat (Kepada > Cc > Bcc). */
export function allAddresses(recipients: Recipients): Set<string> {
  return new Set(
    [...recipients.to, ...recipients.cc, ...recipients.bcc].map((item) =>
      item.address.toLowerCase(),
    ),
  );
}

/**
 * Tambahkan alamat ke satu kolom. Duplikat di kolom mana pun dilewati (dilaporkan), sisanya
 * ditambahkan dengan urutan ketikan.
 */
export function addRecipients(
  recipients: Recipients,
  field: RecipientField,
  incoming: readonly MailComposeAddress[],
): { next: Recipients; added: MailComposeAddress[]; duplicates: string[] } {
  const seen = allAddresses(recipients);
  const added: MailComposeAddress[] = [];
  const duplicates: string[] = [];
  for (const item of incoming) {
    const address = item.address.toLowerCase();
    if (seen.has(address)) {
      duplicates.push(address);
      continue;
    }
    seen.add(address);
    added.push({ address, name: item.name });
  }
  return { next: { ...recipients, [field]: [...recipients[field], ...added] }, added, duplicates };
}

export function removeRecipient(
  recipients: Recipients,
  field: RecipientField,
  address: string,
): Recipients {
  const target = address.toLowerCase();
  return {
    ...recipients,
    [field]: recipients[field].filter((item) => item.address.toLowerCase() !== target),
  };
}

/** Jumlah penerima setelah digabung tanpa beda huruf (cara server menghitung batas). */
export function recipientCount(recipients: Recipients): number {
  return allAddresses(recipients).size;
}

/** Label chip: nama bila ada, selain itu alamat. */
export function recipientLabel(item: MailComposeAddress): string {
  return item.name?.trim() || item.address;
}

/** Inisial untuk avatar chip (dua huruf). */
export function recipientInitials(item: MailComposeAddress): string {
  const source = item.name?.trim() || item.address.split('@')[0] || item.address;
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : source.slice(0, 2);
  return letters.toLocaleUpperCase('id-ID');
}

/** Penerima di luar domain identitas (bantuan lokal sebelum hasil cek server tiba). */
export function externalAddresses(
  recipients: Recipients,
  internalDomains: readonly string[],
): string[] {
  const internal = new Set(internalDomains.map((domain) => domain.toLowerCase()));
  return [...allAddresses(recipients)].filter((address) => !internal.has(mailDomainOf(address)));
}
