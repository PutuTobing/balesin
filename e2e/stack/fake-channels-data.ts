/**
 * Data server channel TIRUAN untuk E2E (`fake-channels-server.ts`, Fase 6): Bot API Telegram tiruan
 * dan server IMAP tiruan ber-TLS (sertifikat KHUSUS TES). SMTP keluar channel Email memakai Mailpit
 * lokal (`MAILPIT_SMTP` di `env.ts`). Semua nilai KHUSUS TES — tidak pernah menyentuh Telegram atau
 * server email sungguhan: API & worker E2E diarahkan ke sini lewat `BALESIN_TEST_TELEGRAM_BASE_URL`,
 * `BALESIN_TEST_IMAP_PORTS`, `BALESIN_TEST_IMAP_CA_FILE` (hanya diterima non-produksi).
 *
 * Port IMAP & Telegram acak; tes membacanya dari server kendali (`fakeChannelsInfo()`), yang
 * portnya TETAP per stack (`E2E_API_PORT` + 40000, mis. 43100 untuk stack 3100).
 */
import { E2E_API_PORT } from './env';

export const FAKE_CHANNELS_READY_PREFIX = 'FAKE_CHANNELS=';

/** Port server kendali (info + suntik email/update) per stack E2E. */
export const FAKE_CHANNELS_CONTROL_PORT = Number(
  process.env.E2E_FAKE_CHANNELS_PORT ?? E2E_API_PORT + 40_000,
);
export const FAKE_CHANNELS_CONTROL_URL = `http://127.0.0.1:${String(FAKE_CHANNELS_CONTROL_PORT)}`;

export const FAKE_TELEGRAM = {
  /** Token bot sah (format BotFather) yang dikenal server tiruan. */
  token: '7000000001:AAE2eTokenBotTiruan_0123456789abcdefgh',
  /** Token sah kedua (proyek HP / "ganti token"). */
  secondToken: '7000000002:AAE2eTokenBotTiruanKedua_98765432zyxw',
  /** Format sah tetapi tidak dikenal → 401 → "token tidak valid". */
  wrongToken: '7000000999:AAE2eTokenBotSalahTidakDikenal_0000000',
  bots: {
    '7000000001': { id: 7000000001, username: 'majujaya_cs_bot' },
    '7000000002': { id: 7000000002, username: 'majujaya_hp_bot' },
  },
} as const;

export const FAKE_IMAP = {
  /** Host yang cocok dengan sertifikat tes (SAN `localhost`). */
  host: 'localhost',
  security: 'ssl',
  username: 'cs@majujaya.test',
  password: 'rahasia-imap-e2e',
  wrongPassword: 'password-salah-imap',
  folder: 'INBOX',
} as const;

/**
 * Modul Email (Fase 9A/9B): kotak surat IMAP multi-folder tiruan (`fake-mail-imap.ts` core, TLS
 * sertifikat tes) + SMTP tiruan ber-TLS (`fake-mail-smtp.ts`) — satu akun saja. Alamat sengaja BUKAN
 * alamat Channel Email (`FAKE_IMAP`) maupun Email pengirim sistem (alamat harus unik di organisasi).
 * Portnya acak (dibaca dari `fakeChannelsInfo()`); api & worker mengizinkannya lewat
 * `BALESIN_TEST_IMAP_PORTS` / `BALESIN_TEST_MAIL_SMTP_PORTS` (hanya non-produksi).
 */
export const FAKE_MAIL = {
  host: 'localhost',
  address: 'kotak.bersama@majujaya.test',
  username: 'kotak.bersama@majujaya.test',
  password: 'rahasia-kotak-e2e',
} as const;

export interface FakeSmtpMessage {
  from: string;
  to: string[];
  raw: string;
  receivedAt: string;
}

export interface FakeChannelsInfo {
  telegramUrl: string;
  imapPort: number;
  mailImapPort: number;
  mailSmtpPort: number;
}

/** Alamat server tiruan yang sedang berjalan (dari server kendali). */
export async function fakeChannelsInfo(): Promise<FakeChannelsInfo> {
  const response = await fetch(`${FAKE_CHANNELS_CONTROL_URL}/info`);
  if (!response.ok) throw new Error(`Server channel tiruan tidak menjawab (${response.status})`);
  return (await response.json()) as FakeChannelsInfo;
}

/** Masukkan email (RFC 822) ke kotak masuk IMAP tiruan; diambil worker pada putaran berikutnya. */
export async function deliverFakeEmail(raw: string): Promise<number> {
  const response = await fetch(`${FAKE_CHANNELS_CONTROL_URL}/imap/messages`, {
    method: 'POST',
    headers: { 'content-type': 'message/rfc822' },
    body: raw,
  });
  if (!response.ok) throw new Error(`Email tiruan ditolak (${response.status})`);
  return ((await response.json()) as { uid: number }).uid;
}

/** Panggilan Bot API yang diterima server tiruan (mis. memastikan balasan terkirim). */
export async function fakeTelegramCalls(): Promise<
  { token: string; method: string; body: unknown }[]
> {
  const response = await fetch(`${FAKE_CHANNELS_CONTROL_URL}/telegram/calls`);
  if (!response.ok) throw new Error(`Server Telegram tiruan tidak menjawab (${response.status})`);
  return (await response.json()) as { token: string; method: string; body: unknown }[];
}

/** Masukkan email (RFC 822) ke folder kotak surat modul Email tiruan (bawaan `INBOX`; IDLE memberi tahu). */
export async function deliverFakeMail(raw: string, folder = 'INBOX'): Promise<number> {
  const response = await fetch(
    `${FAKE_CHANNELS_CONTROL_URL}/mail/imap/messages?folder=${encodeURIComponent(folder)}`,
    { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: raw },
  );
  if (!response.ok) throw new Error(`Email tiruan modul Email ditolak (${response.status})`);
  return ((await response.json()) as { uid: number }).uid;
}

/** Email yang diterima SMTP tiruan modul Email (urutan tiba). */
export async function fakeSmtpMessages(): Promise<FakeSmtpMessage[]> {
  const response = await fetch(`${FAKE_CHANNELS_CONTROL_URL}/mail/smtp/messages`);
  if (!response.ok) throw new Error(`SMTP tiruan tidak menjawab (${response.status})`);
  return (await response.json()) as FakeSmtpMessage[];
}

/** Ringkasan isi folder kotak surat tiruan (mis. salinan di Terkirim/Draf). */
export async function fakeMailFolder(
  folder: string,
): Promise<{ uid: number; flags: string[]; raw: string }[]> {
  const response = await fetch(
    `${FAKE_CHANNELS_CONTROL_URL}/mail/imap/messages?folder=${encodeURIComponent(folder)}`,
  );
  if (!response.ok) throw new Error(`IMAP tiruan tidak menjawab (${response.status})`);
  return (await response.json()) as { uid: number; flags: string[]; raw: string }[];
}
