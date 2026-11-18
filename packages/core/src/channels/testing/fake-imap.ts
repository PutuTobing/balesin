import {
  createServer as createPlainServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';

import { TEST_IMAP_CERT, TEST_IMAP_KEY } from './test-cert';

/**
 * Server IMAP TIRUAN untuk tes (Fase 6) — hanya perintah yang dipakai `email-imap.ts` (lewat
 * imapflow): CAPABILITY, LOGIN, SELECT/EXAMINE, UID FETCH (UID, RFC822.SIZE, BODY.PEEK[]),
 * UID STORE, NOOP, LOGOUT. TLS langsung memakai sertifikat tes (`TEST_IMAP_CERT`); `plain: true` =
 * tanpa TLS (untuk menguji bahwa klien MENOLAK sambungan tanpa enkripsi).
 */

export interface FakeImapMessage {
  uid: number;
  raw: Buffer;
  seen: boolean;
}

export interface FakeImapOptions {
  username?: string;
  password?: string;
  folder?: string;
  uidValidity?: number;
  plain?: boolean;
}

export interface FakeImapServer {
  port: number;
  /** Tambah email ke folder; UID berikutnya otomatis. */
  add(raw: string | Buffer): number;
  messages: FakeImapMessage[];
  commands: string[];
  setUidValidity(value: number): void;
  close(): Promise<void>;
}

function quotedArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    args.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : (match[2] ?? ''));
  }
  return args;
}

function inSet(uid: number, set: string, maxUid: number): boolean {
  return set.split(',').some((part) => {
    const [startText, endText] = part.split(':');
    const start = startText === '*' ? maxUid : Number(startText);
    if (endText === undefined) return uid === start;
    const end = endText === '*' ? Math.max(maxUid, start) : Number(endText);
    return uid >= Math.min(start, end) && uid <= Math.max(start, end);
  });
}

export async function startFakeImap(options: FakeImapOptions = {}): Promise<FakeImapServer> {
  const username = options.username ?? 'cs@contoh.test';
  const password = options.password ?? 'rahasia-imap';
  const folder = options.folder ?? 'INBOX';
  let uidValidity = options.uidValidity ?? 1;
  const messages: FakeImapMessage[] = [];
  const commands: string[] = [];
  let nextUid = 1;

  const handle = (socket: Socket | TLSSocket) => {
    let buffer = '';
    let authed = false;
    const write = (line: string | Buffer) => socket.write(line);
    write('* OK [CAPABILITY IMAP4rev1] Fake IMAP siap\r\n');
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [tag = '*', ...rest] = line.split(' ');
        const command = (rest[0] ?? '').toUpperCase();
        const argsText = rest.slice(1).join(' ');
        commands.push(command === 'LOGIN' ? 'LOGIN ***' : `${command} ${argsText}`.trim());
        const maxUid = messages.at(-1)?.uid ?? 0;
        switch (command) {
          case 'CAPABILITY':
            write('* CAPABILITY IMAP4rev1\r\n');
            write(`${tag} OK CAPABILITY selesai\r\n`);
            break;
          case 'LOGIN': {
            const [user, pass] = quotedArgs(argsText);
            if (user === username && pass === password) {
              authed = true;
              write(`${tag} OK [CAPABILITY IMAP4rev1] Masuk\r\n`);
            } else {
              write(`${tag} NO [AUTHENTICATIONFAILED] Login gagal\r\n`);
            }
            break;
          }
          case 'SELECT':
          case 'EXAMINE': {
            const [name] = quotedArgs(argsText);
            if (!authed || name !== folder) {
              write(`${tag} NO [NONEXISTENT] Folder tidak ada\r\n`);
              break;
            }
            write('* FLAGS (\\Seen \\Answered)\r\n');
            write(`* ${String(messages.length)} EXISTS\r\n`);
            write('* 0 RECENT\r\n');
            write(`* OK [UIDVALIDITY ${String(uidValidity)}] UID sah\r\n`);
            write(`* OK [UIDNEXT ${String(nextUid)}] UID berikutnya\r\n`);
            write(`${tag} OK [${command === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] Selesai\r\n`);
            break;
          }
          case 'UID': {
            const sub = (rest[1] ?? '').toUpperCase();
            const set = rest[2] ?? '';
            const items = rest.slice(3).join(' ').toUpperCase();
            if (sub === 'FETCH') {
              messages.forEach((message, position) => {
                if (!inSet(message.uid, set, maxUid)) return;
                const seq = String(position + 1);
                if (items.includes('BODY')) {
                  write(
                    `* ${seq} FETCH (UID ${String(message.uid)} BODY[] {${String(message.raw.length)}}\r\n`,
                  );
                  write(message.raw);
                  write(')\r\n');
                } else {
                  write(
                    `* ${seq} FETCH (UID ${String(message.uid)} RFC822.SIZE ${String(message.raw.length)})\r\n`,
                  );
                }
              });
              write(`${tag} OK UID FETCH selesai\r\n`);
            } else if (sub === 'STORE') {
              messages.forEach((message, position) => {
                if (!inSet(message.uid, set, maxUid)) return;
                message.seen = true;
                if (!items.includes('SILENT')) {
                  write(
                    `* ${String(position + 1)} FETCH (UID ${String(message.uid)} FLAGS (\\Seen))\r\n`,
                  );
                }
              });
              write(`${tag} OK UID STORE selesai\r\n`);
            } else {
              write(`${tag} OK\r\n`);
            }
            break;
          }
          case 'LOGOUT':
            write('* BYE Sampai jumpa\r\n');
            write(`${tag} OK LOGOUT selesai\r\n`);
            socket.end();
            break;
          default:
            write(`${tag} OK\r\n`);
        }
      }
    });
  };

  const server: Server = options.plain
    ? createPlainServer(handle)
    : createTlsServer({ cert: TEST_IMAP_CERT, key: TEST_IMAP_KEY }, handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    messages,
    commands,
    add(raw) {
      const uid = nextUid;
      nextUid += 1;
      messages.push({
        uid,
        raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'),
        seen: false,
      });
      return uid;
    },
    setUidValidity(value) {
      uidValidity = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Email RFC 822 sederhana untuk tes. */
export function testEmail(input: {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  messageId?: string;
  inReplyTo?: string;
  headers?: Record<string, string>;
}): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to ?? 'cs@contoh.test'}`,
    `Subject: ${input.subject ?? 'Pertanyaan'}`,
    `Message-ID: <${input.messageId ?? `${String(Date.now())}.${String(Math.random()).slice(2)}@pelanggan.test`}>`,
    ...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
    'Date: Tue, 17 Nov 2026 10:00:00 +0700',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    ...Object.entries(input.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
    '',
    input.text ?? 'Halo, internet saya mati sejak pagi.',
    '',
  ];
  return lines.join('\r\n');
}
