import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sendTelegramMessage } from './telegram';

const TOKEN = '123456789:AAFakeTokenUntukTesSaja_abcdefghijklmn';
let server: Server;
let baseUrl: string;
const received: { path: string; body: unknown }[] = [];
let next: { status: number; body: unknown } | null = null;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      });
      const answer = next ?? { status: 200, body: { ok: true, result: {} } };
      next = null;
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('sendTelegramMessage', () => {
  it('mengirim teks polos (tanpa parse mode) ke /bot<token>/sendMessage', async () => {
    expect(
      await sendTelegramMessage({ token: TOKEN, chatId: '-1001234', text: 'halo', baseUrl }),
    ).toEqual({ ok: true });
    expect(received.at(-1)).toEqual({
      path: `/bot${TOKEN}/sendMessage`,
      body: { chat_id: '-1001234', text: 'halo', disable_web_page_preview: true },
    });
  });

  it.each([
    [401, { ok: false, error_code: 401 }, 'token_invalid'],
    [400, { ok: false, description: 'Bad Request: chat not found' }, 'chat_not_found'],
    [403, { ok: false, description: 'Forbidden: bot was kicked' }, 'forbidden'],
    [429, { ok: false, parameters: { retry_after: 7 } }, 'rate_limited'],
    [500, 'bukan json', 'unknown'],
  ])('jawaban %i → kode %s', async (status, body, code) => {
    next = { status, body };
    const result = await sendTelegramMessage({ token: TOKEN, chatId: '1', text: 'x', baseUrl });
    expect(result).toMatchObject({ ok: false, code });
    if (code === 'rate_limited') expect(result).toMatchObject({ retryAfterSeconds: 7 });
  });

  it('token berformat salah tidak dikirim; host selain Telegram/loopback ditolak; jaringan putus', async () => {
    const before = received.length;
    expect(await sendTelegramMessage({ token: 'salah', chatId: '1', text: 'x', baseUrl })).toEqual({
      ok: false,
      code: 'token_invalid',
      retryAfterSeconds: null,
    });
    expect(received.length).toBe(before);
    expect(
      await sendTelegramMessage({
        token: TOKEN,
        chatId: '1',
        text: 'x',
        baseUrl: 'https://penyerang.contoh',
      }),
    ).toMatchObject({ ok: false, code: 'network' });
    expect(
      await sendTelegramMessage({
        token: TOKEN,
        chatId: '1',
        text: 'x',
        baseUrl: 'http://127.0.0.1:1',
      }),
    ).toMatchObject({ ok: false, code: 'network' });
  });
});
