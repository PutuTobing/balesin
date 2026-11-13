import { MAILPIT_API_URL } from '../stack/env';

/** Pesan di Mailpit (hanya bagian yang dipakai tes). */
export interface MailpitMessage {
  Subject: string;
  To: { Address: string }[];
}

/** Cari email di Mailpit lokal berdasarkan alamat tujuan (API Mailpit, bukan SMTP). */
export async function findMail(to: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  if (!response.ok) throw new Error(`Mailpit menjawab ${response.status}`);
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}
