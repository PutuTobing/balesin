/**
 * Klien Bot API Telegram untuk ALARM sistem (Fase 4, PENGATURAN-UI §4). Host tetap
 * `https://api.telegram.org`; alamat lain hanya untuk tes (server tiruan di loopback, diberikan kode
 * tes — tidak pernah dari `.env`/UI). Bot API mewajibkan token di path URL, jadi URL permintaan TIDAK
 * PERNAH ditulis ke log/pesan galat; hasil hanya berupa kode.
 */

export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

export type TelegramErrorCode =
  'token_invalid' | 'chat_not_found' | 'forbidden' | 'rate_limited' | 'network' | 'unknown';

export type TelegramSendResult =
  { ok: true } | { ok: false; code: TelegramErrorCode; retryAfterSeconds: number | null };

export interface TelegramSendInput {
  token: string;
  chatId: string;
  text: string;
  /** HANYA tes: server tiruan di 127.0.0.1/localhost. */
  baseUrl?: string;
  timeoutMs?: number;
}

function safeBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return TELEGRAM_API_BASE_URL;
  const url = new URL(baseUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!loopback && url.origin !== TELEGRAM_API_BASE_URL) {
    throw new Error(
      'Alamat Bot API Telegram hanya boleh api.telegram.org atau server tiruan lokal',
    );
  }
  return url.origin;
}

/** Pesan teks polos (tanpa parse mode → tidak ada markup dari isi). Tidak pernah melempar. */
export async function sendTelegramMessage(input: TelegramSendInput): Promise<TelegramSendResult> {
  if (!/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(input.token)) {
    return { ok: false, code: 'token_invalid', retryAfterSeconds: null };
  }
  let response: Response;
  try {
    response = await fetch(`${safeBaseUrl(input.baseUrl)}/bot${input.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, code: 'network', retryAfterSeconds: null };
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text.length <= 65_536 ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  const record = (body ?? {}) as {
    ok?: unknown;
    description?: unknown;
    parameters?: { retry_after?: unknown };
  };
  if (response.ok && record.ok === true) return { ok: true };
  const description = typeof record.description === 'string' ? record.description : '';
  const retryAfter =
    typeof record.parameters?.retry_after === 'number' ? record.parameters.retry_after : null;
  const code: TelegramErrorCode =
    response.status === 401 || response.status === 404
      ? 'token_invalid'
      : response.status === 429
        ? 'rate_limited'
        : response.status === 403
          ? 'forbidden'
          : response.status === 400 && /chat not found/i.test(description)
            ? 'chat_not_found'
            : 'unknown';
  return { ok: false, code, retryAfterSeconds: retryAfter };
}
