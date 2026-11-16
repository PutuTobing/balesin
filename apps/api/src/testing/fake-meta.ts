/**
 * Server Graph API Meta TIRUAN untuk tes integrasi (BUTUH-TOBING #3: kredensial sungguhan belum
 * ada, dan tes tidak boleh memanggil Meta). Mendengarkan di 127.0.0.1 port acak; aplikasi tes
 * diarahkan ke sini lewat `config.metaGraphBaseUrl` (hanya mungkin di luar production).
 *
 * Meniru perilaku yang dipakai Balesin: token Bearer, `appsecret_proof` (HMAC-SHA256 heks),
 * `GET /{phone-number-id}`, `GET /{waba-id}/phone_numbers`, `GET|POST
 * /{phone-number-id}/whatsapp_business_profile`, `POST /{phone-number-id}/messages` (kirim pesan →
 * wamid), `POST /{phone-number-id}/media` (unggah multipart → ID media), `GET /{media-id}` (URL
 * unduhan) dan `GET /download/{media-id}` (berkas, butuh token Bearer — meniru lookaside), dengan
 * amplop error Meta. Setiap permintaan
 * dicatat (`requests`) supaya tes bisa memeriksa header/query yang dikirim. Kesalahan bisa
 * disuntikkan per path lewat `failNext`.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePhoneNumber {
  id: string;
  wabaId: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  status?: string;
  name_status?: string;
  code_verification_status?: string;
  whatsapp_business_manager_messaging_limit?: string;
  throughput?: { level: string };
  profile?: Record<string, unknown>;
}

export interface FakeMetaRequest {
  method: string;
  /** Path tanpa versi, mis. `/111/whatsapp_business_profile`. */
  path: string;
  version: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
}

export interface FakeFailure {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Hanya untuk metode ini (mis. `POST`); permintaan metode lain tidak memakainya. */
  method?: string;
}

/** Berkas media di server tiruan (unggahan Balesin, atau media masuk yang disiapkan tes). */
export interface FakeMedia {
  bytes: Buffer;
  mimeType: string;
}

/** Pesan yang dikirim Balesin lewat `POST /{phone-number-id}/messages`. */
export interface FakeSentMessage {
  phoneNumberId: string;
  wamid: string;
  body: Record<string, unknown>;
}

export interface FakeMeta {
  url: string;
  requests: FakeMetaRequest[];
  /** Pesan yang diterima server tiruan (urut). */
  sentMessages: FakeSentMessage[];
  /** ID media → berkas. Tes boleh mengisi untuk mensimulasikan media masuk. */
  media: Map<string, FakeMedia>;
  /** Token sah → App Secret aplikasinya. */
  tokens: Map<string, { appSecret: string; expired?: boolean; noPermission?: boolean }>;
  phoneNumbers: Map<string, FakePhoneNumber>;
  wabas: Set<string>;
  /** Jawaban gagal berikutnya untuk path (tanpa versi) ini, berurutan; habis = normal lagi. */
  failNext(path: string, ...failures: FakeFailure[]): void;
  reset(): void;
  close(): Promise<void>;
}

export const metaErrorBody = (
  code: number,
  message: string,
  extra: Record<string, unknown> = {},
) => ({
  error: { message, type: 'OAuthException', code, fbtrace_id: 'FakeTrace123', ...extra },
});

function send(response: ServerResponse, status: number, body: unknown, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function readRaw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (contentType?.startsWith('multipart/form-data')) return { multipartBytes: raw.length };
  const text = raw.toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Isi berkas `file` dari multipart (cukup untuk tes; satu berkas, batas sederhana). */
function multipartFile(raw: Buffer, contentType: string): FakeMedia | null {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]?.replace(/^"|"$/g, '');
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  let start = raw.indexOf(marker);
  while (start !== -1) {
    const next = raw.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const part = raw.subarray(start + marker.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, headerEnd).toString('utf8');
    if (/name="file"/.test(headers)) {
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? 'application/octet-stream';
      // Buang CRLF penutup sebelum batas berikutnya.
      return { bytes: Buffer.from(part.subarray(headerEnd + 4, part.length - 2)), mimeType: type };
    }
    start = next;
  }
  return null;
}

export async function startFakeMeta(): Promise<FakeMeta> {
  const requests: FakeMetaRequest[] = [];
  const tokens = new Map<
    string,
    { appSecret: string; expired?: boolean; noPermission?: boolean }
  >();
  const phoneNumbers = new Map<string, FakePhoneNumber>();
  const wabas = new Set<string>();
  const failures = new Map<string, FakeFailure[]>();
  const sentMessages: FakeSentMessage[] = [];
  const media = new Map<string, FakeMedia>();
  let sequence = 0;

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const [, version = '', ...segments] = url.pathname.split('/');
      const path = `/${segments.join('/')}`;
      const raw = await readRaw(request);
      const body = parseBody(raw, request.headers['content-type']);
      const authorization = request.headers.authorization ?? null;
      requests.push({
        method: request.method ?? 'GET',
        path,
        version,
        query: Object.fromEntries(url.searchParams),
        authorization,
        body,
      });

      const queued = failures.get(path) ?? [];
      const index = queued.findIndex(
        (entry) => entry.method === undefined || entry.method === request.method,
      );
      const failure = index === -1 ? undefined : queued.splice(index, 1)[0];
      if (failure) return send(response, failure.status, failure.body, failure.headers);

      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      // Unduhan berkas (meniru lookaside.fbsbx.com): tanpa versi, hanya token Bearer.
      if (version === 'download') {
        const file = media.get(segments[0] ?? '');
        if (!tokens.has(token)) return send(response, 401, { error: 'unauthorized' });
        if (!file) return send(response, 404, { error: 'not found' });
        response.writeHead(200, {
          'content-type': file.mimeType,
          'content-length': String(file.bytes.length),
        });
        response.end(file.bytes);
        return;
      }
      const app = tokens.get(token);
      if (!app) {
        return send(
          response,
          401,
          metaErrorBody(190, 'Invalid OAuth access token - Cannot parse access token'),
        );
      }
      if (app.expired) {
        return send(
          response,
          401,
          metaErrorBody(190, 'Error validating access token: Session has expired', {
            error_subcode: 463,
          }),
        );
      }
      const proof = url.searchParams.get('appsecret_proof');
      const expected = createHmac('sha256', app.appSecret).update(token).digest('hex');
      if (proof !== expected) {
        return send(
          response,
          400,
          metaErrorBody(100, 'Invalid appsecret_proof provided in the API argument', {
            type: 'GraphMethodException',
          }),
        );
      }
      if (app.noPermission) {
        return send(response, 403, metaErrorBody(10, 'Application does not have permission'));
      }

      const missing = (id: string) =>
        send(
          response,
          400,
          metaErrorBody(
            100,
            `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
            { error_subcode: 33 },
          ),
        );

      const [first = '', second] = segments;
      if (segments.length === 1 && request.method === 'GET' && media.has(first)) {
        const file = media.get(first);
        return send(response, 200, {
          messaging_product: 'whatsapp',
          id: first,
          url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/download/${first}?sig=uji`,
          mime_type: file?.mimeType,
          file_size: file?.bytes.length,
        });
      }
      if (second === 'messages' && request.method === 'POST') {
        if (!phoneNumbers.has(first)) return missing(first);
        const payload = (body ?? {}) as Record<string, unknown>;
        if (payload.status === 'read') return send(response, 200, { success: true });
        sequence += 1;
        const wamid = `wamid.FAKE${String(Date.now())}${String(sequence)}`;
        sentMessages.push({ phoneNumberId: first, wamid, body: payload });
        return send(response, 200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: payload.to, wa_id: payload.to }],
          messages: [{ id: wamid }],
        });
      }
      if (second === 'media' && request.method === 'POST') {
        if (!phoneNumbers.has(first)) return missing(first);
        const file = multipartFile(raw, request.headers['content-type'] ?? '');
        if (!file) return send(response, 400, metaErrorBody(100, 'Param file must be a file'));
        sequence += 1;
        const id = `${String(9_000_000_000 + sequence)}`;
        media.set(id, file);
        return send(response, 200, { id });
      }
      if (segments.length === 1 && request.method === 'GET') {
        const number = phoneNumbers.get(first);
        if (!number) return missing(first);
        const fields = (url.searchParams.get('fields') ?? '').split(',').filter(Boolean);
        const all: Record<string, unknown> = { ...number };
        delete all.wabaId;
        delete all.profile;
        const picked: Record<string, unknown> = { id: number.id };
        for (const field of fields) if (field in all) picked[field] = all[field];
        return send(response, 200, picked);
      }
      if (second === 'phone_numbers' && request.method === 'GET') {
        if (!wabas.has(first)) return missing(first);
        const data = [...phoneNumbers.values()]
          .filter((number) => number.wabaId === first)
          .map((number) => ({ id: number.id }));
        return send(response, 200, { data });
      }
      if (second === 'whatsapp_business_profile') {
        const number = phoneNumbers.get(first);
        if (!number) return missing(first);
        if (request.method === 'GET') {
          return send(response, 200, {
            data: [{ messaging_product: 'whatsapp', ...(number.profile ?? {}) }],
          });
        }
        if (request.method === 'POST') {
          const changes = { ...(body as Record<string, unknown>) };
          delete changes.messaging_product;
          number.profile = { ...(number.profile ?? {}), ...changes };
          return send(response, 200, { success: true });
        }
      }
      return send(response, 400, metaErrorBody(100, 'Unknown path components'));
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    sentMessages,
    media,
    tokens,
    phoneNumbers,
    wabas,
    failNext(path, ...next) {
      failures.set(path, [...(failures.get(path) ?? []), ...next]);
    },
    reset() {
      requests.length = 0;
      tokens.clear();
      phoneNumbers.clear();
      wabas.clear();
      failures.clear();
      sentMessages.length = 0;
      media.clear();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Koneksi keep-alive dari fetch (undici) tidak boleh menahan penutupan.
        server.closeAllConnections();
      }),
  };
}

// Notifikasi webhook tiruan bertanda tangan (pesan masuk, status, error) — untuk tes & E2E.
export * from './fake-meta-webhooks';
