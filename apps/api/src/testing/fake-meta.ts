/**
 * Server Graph API Meta TIRUAN untuk tes integrasi (BUTUH-TOBING #3: kredensial sungguhan belum
 * ada, dan tes tidak boleh memanggil Meta). Mendengarkan di 127.0.0.1 port acak; aplikasi tes
 * diarahkan ke sini lewat `config.metaGraphBaseUrl` (hanya mungkin di luar production).
 *
 * Meniru perilaku yang dipakai Balesin: token Bearer, `appsecret_proof` (HMAC-SHA256 heks),
 * `GET /{phone-number-id}`, `GET /{waba-id}/phone_numbers`, `GET|POST
 * /{phone-number-id}/whatsapp_business_profile`, dengan amplop error Meta. Setiap permintaan
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
}

export interface FakeMeta {
  url: string;
  requests: FakeMetaRequest[];
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

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const [, version = '', ...segments] = url.pathname.split('/');
      const path = `/${segments.join('/')}`;
      const body = await readBody(request);
      const authorization = request.headers.authorization ?? null;
      requests.push({
        method: request.method ?? 'GET',
        path,
        version,
        query: Object.fromEntries(url.searchParams),
        authorization,
        body,
      });

      const queued = failures.get(path);
      const failure = queued?.shift();
      if (failure) return send(response, failure.status, failure.body, failure.headers);

      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
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
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Koneksi keep-alive dari fetch (undici) tidak boleh menahan penutupan.
        server.closeAllConnections();
      }),
  };
}
