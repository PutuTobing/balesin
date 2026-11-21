import { TELEGRAM_BOT_TOKEN_PATTERN } from '@balesin/shared';
import { z } from 'zod';

import type { Secret } from '../secret';
import { telegramSafeBaseUrl } from '../net/telegram';

/**
 * Klien Bot API Telegram untuk CHANNEL inbox (Fase 6). Terpisah dari pengirim alarm
 * (`net/telegram.ts`) — token bot channel disimpan & dibuka sendiri (`channels.tg_bot_token`).
 *
 * Aturan:
 *  - Host tetap `https://api.telegram.org`; alamat lain HANYA server tiruan di loopback untuk tes
 *    (diberikan kode tes, tidak pernah dari `.env`/UI).
 *  - Token ada di PATH URL (aturan Bot API) → URL tidak pernah ditulis ke log/pesan galat; galat
 *    dilempar sebagai `TelegramApiError` berkode (tanpa URL, tanpa `description` mentah).
 *  - Tanpa redirect, batas waktu per permintaan, ukuran jawaban dibatasi.
 *  - Teks dikirim TANPA `parse_mode` (isi tidak pernah ditafsirkan sebagai markup).
 */

export type TelegramErrorKind =
  | 'token_invalid'
  /** Bot diblokir pengguna / pengguna dihapus / bot tidak boleh mengirim ke chat itu. */
  | 'forbidden'
  | 'chat_not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'too_large'
  | 'unexpected_response';

export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';
  constructor(
    readonly kind: TelegramErrorKind,
    readonly method: string,
    readonly retryAfterSeconds: number | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(`Bot API Telegram ${method} gagal (${kind})`);
  }

  /** Telegram jelas BELUM memproses (aman diulang). */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'server_error';
  }
}

export const isTelegramApiError = (error: unknown): error is TelegramApiError =>
  error instanceof TelegramApiError;

export interface TelegramBotClientOptions {
  /** HANYA tes: server tiruan di loopback. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Batas jawaban JSON (getWebhookInfo/getMe/sendMessage kecil). */
const MAX_JSON_BYTES = 256 * 1024;
/** Bot API: berkas yang bisa diunduh lewat `getFile` maks. 20 MB. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  username: z.string().max(64).optional(),
  first_name: z.string().max(256).optional(),
});

const webhookInfoSchema = z.object({
  url: z.string().max(4096),
  pending_update_count: z.number().int().nonnegative().optional(),
  last_error_date: z.number().int().optional(),
  last_error_message: z.string().max(4096).optional(),
});
export type TelegramWebhookInfo = z.infer<typeof webhookInfoSchema>;

const sentMessageSchema = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int() }),
});

const fileSchema = z.object({
  file_id: z.string(),
  file_size: z.number().int().nonnegative().optional(),
  file_path: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_./-]+$/)
    .refine((value) => !value.includes('..'), 'path berkas tidak sah')
    .optional(),
});

/** Tombol inline (dibangun dari pesan interaktif Balesin). */
export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

export type TelegramMediaMethod =
  'sendPhoto' | 'sendDocument' | 'sendAudio' | 'sendVideo' | 'sendVoice';

export interface TelegramBotClient {
  getMe(
    token: Secret<string>,
    signal?: AbortSignal,
  ): Promise<{ id: string; username: string | null }>;
  setWebhook(
    token: Secret<string>,
    input: { url: string; secretToken: string },
    signal?: AbortSignal,
  ): Promise<void>;
  deleteWebhook(token: Secret<string>, signal?: AbortSignal): Promise<void>;
  getWebhookInfo(token: Secret<string>, signal?: AbortSignal): Promise<TelegramWebhookInfo>;
  sendText(
    token: Secret<string>,
    input: {
      chatId: string;
      text: string;
      replyToMessageId: number | null;
      buttons: TelegramInlineButton[][] | null;
    },
  ): Promise<{ chatId: string; messageId: number }>;
  sendLocation(
    token: Secret<string>,
    input: { chatId: string; latitude: number; longitude: number; replyToMessageId: number | null },
  ): Promise<{ chatId: string; messageId: number }>;
  sendMedia(
    token: Secret<string>,
    input: {
      method: TelegramMediaMethod;
      chatId: string;
      file: Blob;
      filename: string;
      caption: string | null;
      replyToMessageId: number | null;
    },
  ): Promise<{ chatId: string; messageId: number }>;
  /** `getFile` → unduh `file/bot<token>/<path>` ke `sink` (maks. `maxBytes`). */
  downloadFile(
    token: Secret<string>,
    input: {
      fileId: string;
      maxBytes: number;
      sink: (chunk: Uint8Array) => Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<{ sizeBytes: number }>;
}

function assertToken(token: Secret<string>, method: string): string {
  const value = token.reveal();
  if (!TELEGRAM_BOT_TOKEN_PATTERN.test(value)) throw new TelegramApiError('token_invalid', method);
  return value;
}

/** Kode HTTP + `description` Telegram → jenis galat (deskripsi hanya dipindai, tidak diteruskan). */
export function classifyTelegramFailure(status: number, description: string): TelegramErrorKind {
  if (status === 401 || status === 404) return 'token_invalid';
  if (status === 429) return 'rate_limited';
  if (status === 403) return 'forbidden';
  if (status === 413) return 'too_large';
  if (status >= 500) return 'server_error';
  if (status === 400 && /chat not found|user not found/i.test(description)) return 'chat_not_found';
  if (status === 400 && /bot was blocked|user is deactivated/i.test(description))
    return 'forbidden';
  if (status === 400) return 'bad_request';
  return 'unexpected_response';
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createTelegramBotClient(options: TelegramBotClientOptions = {}): TelegramBotClient {
  const base = telegramSafeBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(
    token: Secret<string>,
    method: string,
    body: Record<string, unknown> | FormData,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const value = assertToken(token, method);
    const timeout = AbortSignal.timeout(body instanceof FormData ? 120_000 : timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}/bot${value}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData
          ? { body }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new TelegramApiError('network', method);
    }
    let parsed: unknown;
    try {
      const text = await readLimited(response, MAX_JSON_BYTES);
      parsed = text === null ? null : (JSON.parse(text) as unknown);
    } catch {
      parsed = null;
    }
    const record = (parsed ?? {}) as {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
      parameters?: { retry_after?: unknown };
    };
    if (response.ok && record.ok === true) {
      const result = schema.safeParse(record.result);
      if (!result.success) throw new TelegramApiError('unexpected_response', method);
      return result.data;
    }
    const retryAfter =
      typeof record.parameters?.retry_after === 'number' ? record.parameters.retry_after : null;
    const description = typeof record.description === 'string' ? record.description : '';
    throw new TelegramApiError(
      classifyTelegramFailure(response.status, description),
      method,
      retryAfter,
      response.status,
    );
  }

  const replyParameters = (replyTo: number | null) =>
    replyTo === null
      ? {}
      : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };

  const sentOf = (sent: z.infer<typeof sentMessageSchema>) => ({
    chatId: String(sent.chat.id),
    messageId: sent.message_id,
  });

  return {
    async getMe(token, signal) {
      const me = await call(token, 'getMe', {}, userSchema, signal);
      if (!me.is_bot) throw new TelegramApiError('unexpected_response', 'getMe');
      return { id: String(me.id), username: me.username ?? null };
    },

    async setWebhook(token, input, signal) {
      await call(
        token,
        'setWebhook',
        {
          url: input.url,
          secret_token: input.secretToken,
          // Hanya yang diproses Balesin: pesan + tekan tombol inline.
          allowed_updates: ['message', 'callback_query'],
          max_connections: 40,
        },
        z.literal(true),
        signal,
      );
    },

    async deleteWebhook(token, signal) {
      await call(token, 'deleteWebhook', { drop_pending_updates: false }, z.literal(true), signal);
    },

    getWebhookInfo: (token, signal) => call(token, 'getWebhookInfo', {}, webhookInfoSchema, signal),

    async sendText(token, input) {
      const sent = await call(
        token,
        'sendMessage',
        {
          chat_id: input.chatId,
          text: input.text,
          link_preview_options: { is_disabled: true },
          ...replyParameters(input.replyToMessageId),
          ...(input.buttons
            ? {
                reply_markup: {
                  inline_keyboard: input.buttons.map((row) =>
                    row.map((button) => ({
                      text: button.text,
                      callback_data: button.callbackData,
                    })),
                  ),
                },
              }
            : {}),
        },
        sentMessageSchema,
      );
      return sentOf(sent);
    },

    async sendLocation(token, input) {
      const sent = await call(
        token,
        'sendLocation',
        {
          chat_id: input.chatId,
          latitude: input.latitude,
          longitude: input.longitude,
          ...replyParameters(input.replyToMessageId),
        },
        sentMessageSchema,
      );
      return sentOf(sent);
    },

    async sendMedia(token, input) {
      const field = {
        sendPhoto: 'photo',
        sendDocument: 'document',
        sendAudio: 'audio',
        sendVideo: 'video',
        sendVoice: 'voice',
      }[input.method];
      const form = new FormData();
      form.set('chat_id', input.chatId);
      form.set(field, input.file, input.filename);
      if (input.caption) form.set('caption', input.caption.slice(0, 1024));
      if (input.replyToMessageId !== null) {
        form.set(
          'reply_parameters',
          JSON.stringify({ message_id: input.replyToMessageId, allow_sending_without_reply: true }),
        );
      }
      return sentOf(await call(token, input.method, form, sentMessageSchema));
    },

    async downloadFile(token, input) {
      const file = await call(
        token,
        'getFile',
        { file_id: input.fileId },
        fileSchema,
        input.signal,
      );
      if (!file.file_path) throw new TelegramApiError('too_large', 'getFile');
      if (file.file_size !== undefined && file.file_size > input.maxBytes) {
        throw new TelegramApiError('too_large', 'getFile');
      }
      const value = assertToken(token, 'file');
      const timeout = AbortSignal.timeout(90_000);
      let response: Response;
      try {
        response = await doFetch(`${base}/file/bot${value}/${file.file_path}`, {
          redirect: 'error',
          signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
        });
      } catch {
        throw new TelegramApiError('network', 'file');
      }
      if (!response.ok || !response.body) {
        throw new TelegramApiError(
          classifyTelegramFailure(response.status, ''),
          'file',
          null,
          response.status,
        );
      }
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let size = 0;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > input.maxBytes) throw new TelegramApiError('too_large', 'file');
          await input.sink(chunk);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        if (isTelegramApiError(error)) throw error;
        throw new TelegramApiError('network', 'file');
      }
      return { sizeBytes: size };
    },
  };
}

/**
 * Alamat webhook Telegram yang bisa dipakai: Telegram hanya mengirim ke https di port 443/80/88/8443
 * (dokumentasi `setWebhook`). `null` = aman; selain itu alasan untuk ditampilkan.
 */
export function telegramWebhookUrlUsable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return false;
  return ['', '443', '80', '88', '8443'].includes(parsed.port);
}
