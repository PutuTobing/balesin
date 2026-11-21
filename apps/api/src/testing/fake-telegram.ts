import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Server Bot API Telegram TIRUAN (Fase 6) di loopback: `getMe`, `setWebhook`, `deleteWebhook`,
 * `getWebhookInfo`, `sendMessage`, `sendLocation`, `send{Photo,Document,Audio,Video,Voice}`,
 * `getFile` + unduh berkas. Tidak pernah memanggil Telegram sungguhan.
 */

export interface FakeTelegramCall {
  token: string;
  method: string;
  /** JSON (untuk multipart: teks mentah). */
  body: Record<string, unknown> | string;
}

export interface FakeTelegram {
  url: string;
  calls: FakeTelegramCall[];
  /** Token sah → bot. */
  bots: Map<string, { id: number; username: string }>;
  /** URL webhook terpasang per token (`getWebhookInfo`). */
  webhooks: Map<string, { url: string; secretToken: string }>;
  /** Berkas yang bisa diunduh: file_id → isi. */
  files: Map<string, Buffer>;
  /** Jawaban berikutnya untuk metode kirim (sekali pakai). */
  failNext: { status: number; body: unknown } | null;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const state = {
    calls: [] as FakeTelegramCall[],
    bots: new Map<string, { id: number; username: string }>(),
    webhooks: new Map<string, { url: string; secretToken: string }>(),
    files: new Map<string, Buffer>(),
    failNext: null as { status: number; body: unknown } | null,
  };
  let nextMessageId = 100;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const url = request.url ?? '';
      const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(url);
      if (file) {
        const content = state.files.get(file[2] ?? '');
        if (!state.bots.has(file[1] ?? '') || !content) {
          reply(404, { ok: false });
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(content);
        return;
      }
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
      const token = match?.[1] ?? '';
      const method = match?.[2] ?? '';
      const raw = Buffer.concat(chunks);
      const isJson = (request.headers['content-type'] ?? '').startsWith('application/json');
      let body: Record<string, unknown> | string = raw.toString('latin1');
      if (isJson) {
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      state.calls.push({ token, method, body });
      const bot = state.bots.get(token);
      if (!bot) {
        reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      const json = typeof body === 'string' ? {} : body;
      if (method.startsWith('send') && state.failNext) {
        const failure = state.failNext;
        state.failNext = null;
        reply(failure.status, failure.body);
        return;
      }
      switch (method) {
        case 'getMe':
          reply(200, {
            ok: true,
            result: { id: bot.id, is_bot: true, username: bot.username, first_name: 'Bot' },
          });
          return;
        case 'setWebhook':
          state.webhooks.set(token, {
            url: String(json.url),
            secretToken: String(json.secret_token),
          });
          reply(200, { ok: true, result: true });
          return;
        case 'deleteWebhook':
          state.webhooks.delete(token);
          reply(200, { ok: true, result: true });
          return;
        case 'getWebhookInfo':
          reply(200, {
            ok: true,
            result: { url: state.webhooks.get(token)?.url ?? '', pending_update_count: 0 },
          });
          return;
        case 'getFile': {
          const fileId = String(json.file_id);
          if (!state.files.has(fileId)) {
            reply(400, { ok: false, description: 'Bad Request: invalid file_id' });
            return;
          }
          reply(200, {
            ok: true,
            result: {
              file_id: fileId,
              file_size: state.files.get(fileId)?.length,
              file_path: fileId,
            },
          });
          return;
        }
        default: {
          if (!method.startsWith('send')) {
            reply(404, { ok: false });
            return;
          }
          const chatId =
            typeof body === 'string'
              ? Number(/name="chat_id"\r\n\r\n(-?\d+)/.exec(body)?.[1])
              : Number(json.chat_id);
          nextMessageId += 1;
          reply(200, { ok: true, result: { message_id: nextMessageId, chat: { id: chatId } } });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    get calls() {
      return state.calls;
    },
    bots: state.bots,
    webhooks: state.webhooks,
    files: state.files,
    get failNext() {
      return state.failNext;
    },
    set failNext(value) {
      state.failNext = value;
    },
    reset() {
      state.calls.length = 0;
      state.bots.clear();
      state.webhooks.clear();
      state.files.clear();
      state.failNext = null;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
