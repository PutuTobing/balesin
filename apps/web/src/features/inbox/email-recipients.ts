import { EMAIL_MAX_EXTRA_RECIPIENTS, emailAddressSchema, type Message } from '@balesin/shared';

/**
 * Tahap 9.0 — Cc/Bcc & "Balas semua" composer channel Email (docs/KONTRAK-API-INBOX.md "Channel
 * Email — Kepada/Cc …"). Semua aturan di sini hanya membantu sebelum kirim; server tetap penentu
 * (format, batas 10, alamat channel sendiri, izin alamat baru).
 */

export type CopyField = 'cc' | 'bcc';

export interface EmailCopies {
  cc: string[];
  bcc: string[];
}

export type RejectReason = 'invalid' | 'customer' | 'self' | 'otherChannel' | 'limit';

export interface AddResult extends EmailCopies {
  /** Alamat yang benar-benar ditambahkan (huruf kecil). */
  added: string[];
  /** Ditolak, urut sesuai ketikan. Duplikat dibuang diam-diam (tidak masuk sini). */
  rejected: { address: string; reason: RejectReason }[];
}

export interface CopyContext {
  /** Alamat pelanggan (penerima utama), huruf kecil; `null` bila tidak diketahui. */
  customer: string | null;
  /** Alamat utama + alias channel (huruf kecil). */
  own: readonly string[];
  /** Alamat/alias channel Email LAIN organisasi yang terlihat pengguna (server tetap memeriksa). */
  others?: readonly string[];
}

/**
 * Ketikan/tempelan → calon alamat: dipisah koma, titik koma, spasi, atau baris baru; bentuk
 * `Nama <alamat@contoh.id>` diambil alamatnya.
 */
export function splitAddressInput(raw: string): string[] {
  const tokens: string[] = [];
  for (const part of raw.split(/[,;\n\r]+/)) {
    const bracketed = [...part.matchAll(/<([^<>]*)>/g)].map((match) => match[1] ?? '');
    // `Nama <alamat>`: nama (tanpa @) dibuang; alamat lain di luar kurung tetap diambil.
    const pieces =
      bracketed.length > 0
        ? [
            ...bracketed,
            ...part
              .replace(/<[^<>]*>/g, ' ')
              .split(/\s+/)
              .filter((piece) => piece.includes('@')),
          ]
        : part.split(/\s+/);
    for (const piece of pieces) {
      const cleaned = piece.trim().replace(/^["'(]+|["')]+$/g, '');
      if (cleaned) tokens.push(cleaned);
    }
  }
  return tokens;
}

/** Alamat sah → bentuk huruf kecil (aturan yang sama dengan server), selain itu `null`. */
export function normalizeAddress(raw: string): string | null {
  const parsed = emailAddressSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Tambahkan calon alamat ke `field`, dengan aturan server (lihat atas). */
export function addCopies(
  current: EmailCopies,
  field: CopyField,
  tokens: readonly string[],
  context: CopyContext,
  max = EMAIL_MAX_EXTRA_RECIPIENTS,
): AddResult {
  const next: EmailCopies = { cc: [...current.cc], bcc: [...current.bcc] };
  const added: string[] = [];
  const rejected: AddResult['rejected'] = [];
  const own = new Set(context.own.map((value) => value.toLowerCase()));
  const others = new Set((context.others ?? []).map((value) => value.toLowerCase()));
  for (const token of tokens) {
    const address = normalizeAddress(token);
    if (!address) {
      rejected.push({ address: token, reason: 'invalid' });
      continue;
    }
    if (next.cc.includes(address) || next.bcc.includes(address)) continue;
    if (address === context.customer) {
      rejected.push({ address, reason: 'customer' });
      continue;
    }
    if (own.has(address)) {
      rejected.push({ address, reason: 'self' });
      continue;
    }
    if (others.has(address)) {
      rejected.push({ address, reason: 'otherChannel' });
      continue;
    }
    if (next.cc.length + next.bcc.length >= max) {
      rejected.push({ address, reason: 'limit' });
      continue;
    }
    next[field].push(address);
    added.push(address);
  }
  return { ...next, added, rejected };
}

const DELIVERED = new Set(['sent', 'delivered', 'read']);

/**
 * Alamat yang SUDAH ada di utas (cukup `inbox.reply`): pelanggan, `To`/`Cc` email masuk, dan
 * `To`/`Cc` email keluar yang benar-benar terkirim. Bcc tidak dihitung. Hanya dari pesan yang sudah
 * dimuat — server memeriksa seluruh utas.
 */
export function threadAddresses(messages: readonly Message[], customer: string | null) {
  const known = new Set<string>();
  if (customer) known.add(customer);
  for (const message of messages) {
    const email = message.email;
    if (!email) continue;
    if (message.direction === 'outbound' && !DELIVERED.has(message.status ?? '')) continue;
    for (const address of [...(email.to ?? []), ...(email.cc ?? [])]) {
      known.add(address.toLowerCase());
    }
  }
  return known;
}

/** Isi Cc "Balas semua" = `replyAll` email MASUK terakhir (pesan urut lama → baru). */
export function lastReplyAll(messages: readonly Message[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.direction === 'inbound' && message.email) return message.email.replyAll ?? [];
  }
  return [];
}

/** Alamat Cc/Bcc yang belum ada di utas (urut seperti di composer). */
export function newCopies(copies: EmailCopies, known: ReadonlySet<string>): string[] {
  return [...copies.cc, ...copies.bcc].filter((address) => !known.has(address));
}

/** Sisa ketikan setelah ditambahkan: hanya alamat yang tidak sah (supaya bisa diperbaiki). */
export function leftoverInput(result: AddResult): string {
  return result.rejected
    .filter((item) => item.reason === 'invalid')
    .map((item) => item.address)
    .join(', ');
}
