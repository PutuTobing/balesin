import { AppError } from '@balesin/core';
import type { DbExecutor } from '@balesin/db';
import { EMAIL_MAX_EXTRA_RECIPIENTS, storedEmailSenderVerification } from '@balesin/shared';
import { sql } from 'drizzle-orm';

import { maskEmail } from '../audit/audit';

/**
 * Tahap 9.0 — Cc/Bcc balasan channel Email (docs/KONTRAK-API-INBOX.md "Cc/Bcc channel Email").
 *
 * - Alamat yang SUDAH ada di utas (pengirim/Kepada/Cc email di percakapan ini) cukup `inbox.reply`.
 * - Alamat BARU = memulai percakapan → `inbox.initiate` + jatah harian `mulai-percakapan` (satu unit
 *   per alamat baru); API key → scope `messages:initiate`. Penolakan lewat `forbidByRule`
 *   (`ACCESS_RULES.inboxInitiateEmailRecipient`).
 * - Maks. `EMAIL_MAX_EXTRA_RECIPIENTS` alamat (Cc + Bcc, setelah duplikat dibuang).
 * - Bcc hanya masuk amplop SMTP (tidak pernah header) dan tersimpan di catatan pesan keluar.
 */

export interface EmailCopies {
  cc: string[];
  bcc: string[];
}

export interface EmailCopyInput {
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
}

const invalid = (message: string, field = 'cc') =>
  new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field, message }],
  });

/** Ada Cc/Bcc yang diminta (setelah dibuang yang kosong)? */
export function hasEmailCopies(input: EmailCopyInput): boolean {
  return (input.cc?.length ?? 0) > 0 || (input.bcc?.length ?? 0) > 0;
}

/**
 * Bentuk baku Cc/Bcc: huruf kecil, tanpa duplikat (alamat di Cc tidak diulang di Bcc), penerima
 * utama (pelanggan) dibuang diam-diam. Alamat/alias channel sendiri → 400. Lebih dari batas → 400.
 * Format alamat sudah divalidasi skema Zod (`emailAddressSchema`).
 */
export function normalizeEmailCopies(
  input: EmailCopyInput,
  primary: string,
  channelAddresses: readonly string[],
  /** Review 9.0 R8: alamat/alias channel Email LAIN milik organisasi yang sama → 400. */
  otherChannelAddresses: readonly string[] = [],
): EmailCopies {
  const main = primary.trim().toLowerCase();
  const own = new Set(channelAddresses.map((address) => address.trim().toLowerCase()));
  const others = new Set(otherChannelAddresses.map((address) => address.trim().toLowerCase()));
  const clean = (list: readonly string[] | undefined) =>
    [...new Set((list ?? []).map((address) => address.trim().toLowerCase()))].filter(
      (address) => address !== main,
    );
  const cc = clean(input.cc);
  const bcc = clean(input.bcc).filter((address) => !cc.includes(address));
  const ownHit = [...cc, ...bcc].find((address) => own.has(address));
  if (ownHit) {
    throw invalid(
      'Alamat channel ini sendiri tidak perlu dimasukkan ke Cc/Bcc.',
      cc.includes(ownHit) ? 'cc' : 'bcc',
    );
  }
  const otherHit = [...cc, ...bcc].find((address) => others.has(address));
  if (otherHit) {
    throw invalid(
      'Alamat itu milik channel Email lain di Balesin. Teruskan lewat percakapan di channel itu, bukan lewat Cc/Bcc.',
      cc.includes(otherHit) ? 'cc' : 'bcc',
    );
  }
  if (cc.length + bcc.length > EMAIL_MAX_EXTRA_RECIPIENTS) {
    throw invalid(
      `Paling banyak ${String(EMAIL_MAX_EXTRA_RECIPIENTS)} alamat tambahan (Cc + Bcc) per balasan.`,
    );
  }
  return { cc, bcc };
}

/** Cc/Bcc ditolak di channel selain Email. */
export function emailCopiesNotSupported(): AppError {
  return invalid('Cc dan Bcc hanya bisa dipakai di channel Email.');
}

/**
 * Alamat yang sudah ada di utas: pelanggan (pengirim) + `To`/`Cc` email masuk yang pengirimnya
 * TERVERIFIKASI (`senderVerification` = `pass`, penafsiran bersama `storedEmailSenderVerification`;
 * review 9.0 S1 — header email `fail`/`unverified` dikendalikan pengirim luar, jadi tidak boleh
 * menjadi daftar izin Cc) + `To`/`Cc` email keluar yang BENAR-BENAR terkirim (`sent`/`delivered`/
 * `read` — pesan gagal/tertunda tidak dihitung, jadi kirim ulang tidak bisa "menghalalkan" alamatnya
 * sendiri). Bcc tidak dihitung.
 */
export async function threadEmailAddresses(
  db: DbExecutor,
  organizationId: string,
  conversationId: string,
  contactAddress: string | null,
): Promise<Set<string>> {
  const result = await db.execute<{ direction: string; email: unknown }>(sql`
    select m.direction, m.extras -> 'email' as email
    from messages m
    where m.organization_id = ${organizationId}
      and m.conversation_id = ${conversationId}
      and m.extras ? 'email'
      and (m.direction = 'inbound' or m.status in ('sent', 'delivered', 'read'))`);
  const addresses = new Set<string>();
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) if (typeof item === 'string') addresses.add(item.toLowerCase());
  };
  for (const row of result.rows) {
    if (typeof row.email !== 'object' || row.email === null) continue;
    const email = row.email as { to?: unknown; cc?: unknown };
    if (row.direction === 'inbound' && storedEmailSenderVerification(row.email) !== 'pass') {
      continue;
    }
    add(email.to);
    add(email.cc);
  }
  if (contactAddress) addresses.add(contactAddress.trim().toLowerCase());
  return addresses;
}

/** Alamat Cc/Bcc yang BELUM pernah ada di utas (urut seperti diminta). */
export function newEmailAddresses(copies: EmailCopies, thread: ReadonlySet<string>): string[] {
  return [...copies.cc, ...copies.bcc].filter((address) => !thread.has(address));
}

/** Metadata audit `message.email_copies_sent` — alamat tersamar sebagian (`maskEmail`). */
export function emailCopiesAuditMetadata(
  copies: EmailCopies,
  newCount: number,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    cc: copies.cc.map(maskEmail),
    bcc: copies.bcc.map(maskEmail),
    newCount,
    ...extra,
  };
}
