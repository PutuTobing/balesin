import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '../secret';
import {
  createTelegramBotClient,
  isTelegramApiError,
  telegramWebhookUrlUsable,
  type TelegramBotClient,
} from './telegram-bot';
import { normalizeTelegramUpdate } from './telegram-update';

const TOKEN = new Secret('123456789:AAFakeTokenUntukTesSaja_abcdefghijklmn');
const from = {
  id: 777001,
  is_bot: false,
  first_name: 'Budi',
  last_name: 'S‮antoso',
  username: 'budi_s',
};
const chat = { id: 777001, type: 'private' };

describe('normalizeTelegramUpdate', () => {
  it('teks pribadi → pesan netral (ID eksternal chat:message, nama dibersihkan, balas-kutip)', () => {
    const result = normalizeTelegramUpdate({
      update_id: 10,
      message: {
        message_id: 5,
        date: 1_794_900_000,
        from,
        chat,
        text: 'Halo kak',
        reply_to_message: { message_id: 3 },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      callbackQueryId: null,
      message: {
        externalId: '777001:5',
        type: 'text',
        rawType: 'text',
        text: 'Halo kak',
        replyToExternalId: '777001:3',
        sender: { externalUserId: '777001', handle: '@budi_s', displayName: 'Budi S antoso' },
      },
    });
  });

  it('foto (ukuran terbesar), dokumen, suara, lokasi, kontak', () => {
    const base = { update_id: 11, message: { message_id: 6, date: 1, from, chat } };
    const photo = normalizeTelegramUpdate({
      ...base,
      message: {
        ...base.message,
        caption: 'bukti',
        photo: [
          { file_id: 'kecil', file_size: 10 },
          { file_id: 'besar', file_size: 1000 },
        ],
      },
    });
    expect(photo).toMatchObject({
      ok: true,
      message: { type: 'image', text: 'bukti', media: { ref: 'besar' } },
    });
    const doc = normalizeTelegramUpdate({
      ...base,
      message: {
        ...base.message,
        document: { file_id: 'd1', file_name: '../../KTP.pdf', mime_type: 'application/pdf' },
      },
    });
    expect(doc).toMatchObject({
      ok: true,
      message: { type: 'document', media: { filename: 'KTP.pdf' } },
    });
    const voice = normalizeTelegramUpdate({
      ...base,
      message: { ...base.message, voice: { file_id: 'v1' } },
    });
    expect(voice).toMatchObject({
      ok: true,
      message: { type: 'audio', rawType: 'voice', media: { voice: true } },
    });
    const location = normalizeTelegramUpdate({
      ...base,
      message: { ...base.message, location: { latitude: -5.4, longitude: 105.2 } },
    });
    expect(location).toMatchObject({
      ok: true,
      message: { type: 'location', location: { latitude: -5.4 } },
    });
    const contact = normalizeTelegramUpdate({
      ...base,
      message: { ...base.message, contact: { phone_number: '+628123', first_name: 'Ani' } },
    });
    expect(contact).toMatchObject({
      ok: true,
      message: { type: 'contacts', text: 'Ani — +628123' },
    });
  });

  it('tombol inline → interaktif + ID callback untuk dijawab', () => {
    const result = normalizeTelegramUpdate({
      update_id: 12,
      callback_query: { id: 'cb-1', from, data: 'paket_20mb', message: { message_id: 9, chat } },
    });
    expect(result).toMatchObject({
      ok: true,
      callbackQueryId: 'cb-1',
      message: {
        externalId: 'cb:cb-1',
        type: 'interactive',
        reply: { kind: 'button_reply', id: 'paket_20mb' },
        replyToExternalId: '777001:9',
      },
    });
  });

  it('tombol inline tanpa pesan (inline mode) / dari grup → diabaikan (review Info 4)', () => {
    expect(
      normalizeTelegramUpdate({ update_id: 13, callback_query: { id: 'cb-2', from, data: 'x' } }),
    ).toEqual({ ok: false, reason: 'ignored', updateId: 13 });
    expect(
      normalizeTelegramUpdate({
        update_id: 14,
        callback_query: {
          id: 'cb-3',
          from,
          data: 'x',
          message: { message_id: 1, chat: { id: -100, type: 'supergroup' } },
        },
      }),
    ).toEqual({ ok: false, reason: 'ignored', updateId: 14 });
  });

  it('grup, bot, update tak dikenal → diabaikan; bentuk rusak → invalid', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 1,
        message: { message_id: 1, date: 1, from, chat: { id: -100, type: 'group' }, text: 'x' },
      }),
    ).toEqual({ ok: false, reason: 'ignored', updateId: 1 });
    expect(
      normalizeTelegramUpdate({
        update_id: 2,
        message: { message_id: 1, date: 1, from: { ...from, is_bot: true }, chat, text: 'x' },
      }),
    ).toEqual({ ok: false, reason: 'ignored', updateId: 2 });
    expect(normalizeTelegramUpdate({ update_id: 3, edited_message: {} })).toEqual({
      ok: false,
      reason: 'ignored',
      updateId: 3,
    });
    expect(normalizeTelegramUpdate({ update_id: 'x' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('createTelegramBotClient (server tiruan)', () => {
  let server: Server;
  let client: TelegramBotClient;
  const calls: { path: string; contentType: string; body: string }[] = [];
  let next: { status: number; body: unknown } | null = null;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        calls.push({
          path,
          contentType: request.headers['content-type'] ?? '',
          body: Buffer.concat(chunks).toString('latin1'),
        });
        if (path.startsWith('/file/')) {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          response.end(Buffer.from('ISI-BERKAS'));
          return;
        }
        const answer =
          next ??
          (path.endsWith('/getMe')
            ? {
                status: 200,
                body: { ok: true, result: { id: 123456789, is_bot: true, username: 'cs_bot' } },
              }
            : path.endsWith('/getFile')
              ? {
                  status: 200,
                  body: {
                    ok: true,
                    result: { file_id: 'f1', file_size: 10, file_path: 'photos/f1.jpg' },
                  },
                }
              : path.endsWith('/setWebhook')
                ? { status: 200, body: { ok: true, result: true } }
                : {
                    status: 200,
                    body: { ok: true, result: { message_id: 42, chat: { id: 777001 } } },
                  });
        next = null;
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    client = createTelegramBotClient({
      baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    });
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('getMe, setWebhook (secret_token + allowed_updates), sendText tanpa parse_mode + tombol inline', async () => {
    expect(await client.getMe(TOKEN)).toEqual({ id: '123456789', username: 'cs_bot' });
    await client.setWebhook(TOKEN, {
      url: 'https://balesin.test/webhooks/telegram/x',
      secretToken: 'rahasia_123',
    });
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toMatchObject({
      url: 'https://balesin.test/webhooks/telegram/x',
      secret_token: 'rahasia_123',
      allowed_updates: ['message', 'callback_query'],
    });
    const sent = await client.sendText(TOKEN, {
      chatId: '777001',
      text: '<b>bukan markup</b>',
      replyToMessageId: 5,
      buttons: [[{ text: 'Ya', callbackData: 'ya' }]],
    });
    expect(sent).toEqual({ chatId: '777001', messageId: 42 });
    const body = JSON.parse(calls.at(-1)?.body ?? '{}') as Record<string, unknown>;
    expect(body).not.toHaveProperty('parse_mode');
    expect(body).toMatchObject({
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: 'Ya', callback_data: 'ya' }]] },
    });
  });

  it('sendMedia multipart; downloadFile lewat getFile + batas ukuran', async () => {
    await client.sendMedia(TOKEN, {
      method: 'sendDocument',
      chatId: '777001',
      file: new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }),
      filename: 'tagihan.pdf',
      caption: 'Tagihan',
      replyToMessageId: null,
    });
    expect(calls.at(-1)?.contentType).toMatch(/^multipart\/form-data/);
    expect(calls.at(-1)?.body).toContain('filename="tagihan.pdf"');
    const chunks: Uint8Array[] = [];
    const result = await client.downloadFile(TOKEN, {
      fileId: 'f1',
      maxBytes: 1024,
      sink: (chunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      },
    });
    expect(result.sizeBytes).toBe(10);
    expect(calls.at(-1)?.path).toBe(`/file/bot${TOKEN.reveal()}/photos/f1.jpg`);
    await expect(
      client.downloadFile(TOKEN, { fileId: 'f1', maxBytes: 5, sink: () => Promise.resolve() }),
    ).rejects.toMatchObject({ kind: 'too_large' });
  });

  it.each([
    [401, { ok: false }, 'token_invalid', false],
    [403, { ok: false, description: 'Forbidden: bot was blocked by the user' }, 'forbidden', false],
    [400, { ok: false, description: 'Bad Request: chat not found' }, 'chat_not_found', false],
    [429, { ok: false, parameters: { retry_after: 3 } }, 'rate_limited', true],
    [502, 'bukan json', 'server_error', true],
  ])('HTTP %i → %s', async (status, body, kind, retryable) => {
    next = { status, body };
    const error = await client
      .sendText(TOKEN, { chatId: '1', text: 'x', replyToMessageId: null, buttons: null })
      .catch((caught: unknown) => caught);
    expect(isTelegramApiError(error)).toBe(true);
    expect(error).toMatchObject({ kind, retryable });
    // Pesan galat tidak pernah memuat URL/token.
    expect(String((error as Error).message)).not.toContain(TOKEN.reveal());
  });

  it('host selain api.telegram.org/loopback ditolak saat klien dibuat; token salah format tidak dikirim', async () => {
    expect(() => createTelegramBotClient({ baseUrl: 'https://penyerang.test' })).toThrow();
    const before = calls.length;
    await expect(client.getMe(new Secret('bukan-token'))).rejects.toMatchObject({
      kind: 'token_invalid',
    });
    expect(calls.length).toBe(before);
  });

  it('URL webhook yang bisa dipakai Telegram', () => {
    expect(telegramWebhookUrlUsable('https://balesin.contoh.id/webhooks/telegram/x')).toBe(true);
    expect(telegramWebhookUrlUsable('https://balesin.contoh.id:8443/x')).toBe(true);
    expect(telegramWebhookUrlUsable('https://balesin.contoh.id:3000/x')).toBe(false);
    expect(telegramWebhookUrlUsable('http://balesin.contoh.id/x')).toBe(false);
    expect(telegramWebhookUrlUsable('https://localhost/x')).toBe(false);
  });
});
