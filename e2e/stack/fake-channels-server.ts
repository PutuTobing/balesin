/**
 * Server channel TIRUAN untuk stack E2E (Fase 6), dijalankan `start-backend.mjs` (lewat tsx) sebelum
 * API dan worker — pola sama dengan `fake-meta-server.ts`:
 *  - Bot API Telegram tiruan (`apps/api/src/testing/fake-telegram.ts`) berisi bot dari
 *    `fake-channels-data.ts`;
 *  - IMAP tiruan ber-TLS sertifikat tes (`packages/core/src/channels/testing/fake-imap.ts`); CA-nya
 *    ditulis ke berkas sementara untuk `BALESIN_TEST_IMAP_CA_FILE`;
 *  - server kendali di port TETAP (`FAKE_CHANNELS_CONTROL_PORT`): `GET /info`, `POST /imap/messages`
 *    (email RFC 822 mentah), `GET /telegram/calls`.
 * Semuanya hanya mendengarkan 127.0.0.1. Mencetak `FAKE_CHANNELS={json}` saat siap.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeTelegram } from '../../apps/api/src/testing/fake-telegram';
import { startFakeImap } from '../../packages/core/src/channels/testing/fake-imap';
import { TEST_IMAP_CERT } from '../../packages/core/src/channels/testing/test-cert';
import {
  FAKE_CHANNELS_CONTROL_PORT,
  FAKE_CHANNELS_READY_PREFIX,
  FAKE_IMAP,
  FAKE_TELEGRAM,
} from './fake-channels-data';

const telegram = await startFakeTelegram();
for (const token of [FAKE_TELEGRAM.token, FAKE_TELEGRAM.secondToken]) {
  const bot = FAKE_TELEGRAM.bots[token.split(':')[0] as keyof typeof FAKE_TELEGRAM.bots];
  telegram.bots.set(token, { id: bot.id, username: bot.username });
}

const imap = await startFakeImap({
  username: FAKE_IMAP.username,
  password: FAKE_IMAP.password,
  folder: FAKE_IMAP.folder,
});

const caDir = mkdtempSync(join(tmpdir(), 'balesin-e2e-imap-ca-'));
const caFile = join(caDir, 'ca.pem');
writeFileSync(caFile, TEST_IMAP_CERT, 'utf8');

const MAX_EMAIL_BYTES = 5 * 1024 * 1024;

const control = createServer((request, response) => {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_EMAIL_BYTES) chunks.push(chunk);
  });
  request.on('end', () => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url === '/info') {
      reply(200, { telegramUrl: telegram.url, imapPort: imap.port });
    } else if (request.method === 'POST' && url === '/imap/messages') {
      if (size === 0 || size > MAX_EMAIL_BYTES) {
        reply(400, { error: 'Isi email kosong atau terlalu besar.' });
        return;
      }
      reply(201, { uid: imap.add(Buffer.concat(chunks)) });
    } else if (request.method === 'GET' && url === '/telegram/calls') {
      reply(200, telegram.calls);
    } else {
      reply(404, { error: 'Tidak dikenal.' });
    }
  });
});
await new Promise<void>((resolve, reject) => {
  control.once('error', reject);
  control.listen(FAKE_CHANNELS_CONTROL_PORT, '127.0.0.1', resolve);
});

process.stdout.write(
  `${FAKE_CHANNELS_READY_PREFIX}${JSON.stringify({
    telegramUrl: telegram.url,
    imapPort: imap.port,
    caFile,
  })}\n`,
);

const stop = () => {
  control.close();
  void Promise.allSettled([telegram.close(), imap.close()]).finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
