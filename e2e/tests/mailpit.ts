import { expect } from '@playwright/test';
import { MAILPIT_API_URL } from '../stack/env';

/** Pesan di Mailpit (hanya bagian yang dipakai tes). */
export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  /** Waktu email diterima Mailpit (ISO). */
  Created: string;
}

/** Cari email di Mailpit lokal berdasarkan alamat tujuan (API Mailpit, bukan SMTP). Terbaru dulu. */
export async function findMail(to: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  if (!response.ok) throw new Error(`Mailpit menjawab ${response.status}`);
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

/** Isi teks polos + HTML satu email. */
export async function readMail(id: string): Promise<{ Text: string; HTML: string }> {
  const response = await fetch(`${MAILPIT_API_URL}/api/v1/message/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Mailpit menjawab ${response.status}`);
  return (await response.json()) as { Text: string; HTML: string };
}

/**
 * Tunggu email bertautan token untuk `to` yang tiba SETELAH `since` (Mailpit dipakai bersama
 * antar-run; alamat tetap seperti email Owner bisa punya email lama), lalu ambil tautannya dari
 * teks polos: `…/undangan#token=…`, `…/atur-ulang-password#token=…`, `…/verifikasi-email#token=…`.
 */
export async function waitForTokenLink(
  to: string,
  path: '/undangan' | '/atur-ulang-password' | '/verifikasi-email',
  since: Date,
): Promise<string> {
  let link = '';
  await expect
    .poll(
      async () => {
        for (const message of await findMail(to)) {
          if (new Date(message.Created).getTime() < since.getTime() - 1000) continue;
          const { Text } = await readMail(message.ID);
          const pattern = new RegExp(`https?://[^\\s]+${path}#token=[A-Za-z0-9_-]+`);
          const found = pattern.exec(Text)?.[0];
          if (found) {
            link = found;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000, message: `email ${path} untuk ${to}` },
    )
    .toBe(true);
  return link;
}
