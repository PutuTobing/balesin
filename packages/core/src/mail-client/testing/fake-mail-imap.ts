import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';

import { TEST_IMAP_CERT, TEST_IMAP_KEY } from '../../channels/testing/test-cert';

/**
 * Server IMAP TIRUAN multi-folder untuk tes modul Email (Fase 9) — perintah yang dipakai
 * `mail-client` lewat imapflow: CAPABILITY, LOGIN, LIST, STATUS, SELECT/EXAMINE, UID SEARCH
 * (ALL/SINCE), UID FETCH (UID, FLAGS, INTERNALDATE, RFC822.SIZE, BODYSTRUCTURE, header terpilih,
 * awal bagian teks), IDLE/DONE, NOOP, LOGOUT. TLS dengan sertifikat tes. Bukan server IMAP sungguhan:
 * hanya cukup untuk menguji adaptor & alur sinkron.
 */

export interface FakeMailMessage {
  uid: number;
  raw: Buffer;
  flags: string[];
  internalDate: Date;
}

export interface FakeMailFolder {
  path: string;
  flags: string[];
  uidValidity: number;
  nextUid: number;
  messages: FakeMailMessage[];
}

export interface FakeMailImapOptions {
  username?: string;
  password?: string;
  /** Selain INBOX. Bawaan: Sent, Drafts, Junk, Trash (gaya cPanel `INBOX.`). */
  folders?: string[];
  idle?: boolean;
  /** Teks balasan LOGIN gagal (mis. untuk menguji pengenalan "sandi aplikasi"). */
  loginFailureText?: string;
}

export interface FakeMailImapServer {
  port: number;
  folders: Map<string, FakeMailFolder>;
  commands: string[];
  add(
    path: string,
    raw: string | Buffer,
    options?: { flags?: string[]; internalDate?: Date },
  ): number;
  remove(path: string, uid: number): void;
  setFlags(path: string, uid: number, flags: string[]): void;
  setUidValidity(path: string, value: number): void;
  /** Jumlah sambungan yang sedang terbuka. */
  connections(): number;
  close(): Promise<void>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function imapDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${MONTHS[date.getUTCMonth()] ?? 'Jan'}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

function parseSearchDate(text: string): Date | null {
  const match = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(text);
  if (!match) return null;
  const month = MONTHS.findIndex((name) => name.toLowerCase() === (match[2] ?? '').toLowerCase());
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;
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

function splitMessage(raw: Buffer): { headers: Buffer; body: Buffer } {
  const text = raw.toString('latin1');
  const index = text.indexOf('\r\n\r\n');
  if (index < 0) return { headers: raw, body: Buffer.alloc(0) };
  return { headers: raw.subarray(0, index + 4), body: raw.subarray(index + 4) };
}

export async function startFakeMailImap(
  options: FakeMailImapOptions = {},
): Promise<FakeMailImapServer> {
  const username = options.username ?? 'cs@contoh.test';
  const password = options.password ?? 'rahasia-imap';
  const folders = new Map<string, FakeMailFolder>();
  for (const path of [
    'INBOX',
    ...(options.folders ?? ['INBOX.Sent', 'INBOX.Drafts', 'INBOX.Junk', 'INBOX.Trash']),
  ]) {
    folders.set(path, {
      path,
      flags: ['\\HasNoChildren'],
      uidValidity: 1,
      nextUid: 1,
      messages: [],
    });
  }
  const commands: string[] = [];
  const idleClients = new Set<{ socket: Socket | TLSSocket; selected: string | null }>();
  let open = 0;
  const sockets = new Set<Socket | TLSSocket>();
  const capability = `IMAP4rev1 UIDPLUS${options.idle === false ? '' : ' IDLE'}`;

  const handle = (socket: Socket | TLSSocket) => {
    open += 1;
    sockets.add(socket);
    let buffer = '';
    let authed = false;
    const state: { socket: Socket | TLSSocket; selected: string | null } = {
      socket,
      selected: null,
    };
    let idleTag: string | null = null;
    const write = (line: string | Buffer) => socket.write(line);
    write(`* OK [CAPABILITY ${capability}] Fake Mail IMAP siap\r\n`);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      open -= 1;
      sockets.delete(socket);
      idleClients.delete(state);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (idleTag !== null) {
          if (line.trim().toUpperCase() === 'DONE') {
            idleClients.delete(state);
            write(`${idleTag} OK IDLE selesai\r\n`);
            idleTag = null;
          }
          continue;
        }
        const [tag = '*', rawCommand = '', ...rest] = line.split(' ');
        const command = rawCommand.toUpperCase();
        const args = rest.join(' ');
        commands.push(command === 'LOGIN' ? 'LOGIN ***' : `${command} ${args}`.trim());
        const folder = state.selected ? folders.get(state.selected) : undefined;
        switch (command) {
          case 'CAPABILITY':
            write(`* CAPABILITY ${capability}\r\n${tag} OK selesai\r\n`);
            break;
          case 'LOGIN': {
            const parts = args.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
            if (unquote(parts[0] ?? '') === username && unquote(parts[1] ?? '') === password) {
              authed = true;
              write(`${tag} OK [CAPABILITY ${capability}] Masuk\r\n`);
            } else {
              write(
                `${tag} NO [AUTHENTICATIONFAILED] ${options.loginFailureText ?? 'Login gagal'}\r\n`,
              );
            }
            break;
          }
          case 'LIST': {
            if (!authed) {
              write(`${tag} NO belum masuk\r\n`);
              break;
            }
            // `LIST "" ""` = pertanyaan pemisah hierarki (RFC 3501), bukan daftar folder.
            if (/^\S+\s+""\s*$/.test(args.trim())) {
              write(`* LIST (\\Noselect) "." ""\r\n${tag} OK LIST selesai\r\n`);
              break;
            }
            for (const item of folders.values()) {
              write(`* LIST (${item.flags.join(' ')}) "." "${item.path}"\r\n`);
            }
            write(`${tag} OK LIST selesai\r\n`);
            break;
          }
          case 'STATUS': {
            const match = /^("(?:[^"\\]|\\.)*"|\S+)/.exec(args);
            const target = folders.get(unquote(match?.[1] ?? ''));
            if (!target) {
              write(`${tag} NO [NONEXISTENT] tidak ada\r\n`);
              break;
            }
            const unseen = target.messages.filter(
              (message) => !message.flags.includes('\\Seen'),
            ).length;
            write(
              `* STATUS "${target.path}" (MESSAGES ${String(target.messages.length)} UNSEEN ${String(unseen)} UIDNEXT ${String(target.nextUid)} UIDVALIDITY ${String(target.uidValidity)})\r\n${tag} OK STATUS selesai\r\n`,
            );
            break;
          }
          case 'SELECT':
          case 'EXAMINE': {
            const target = folders.get(unquote(args.trim()));
            if (!authed || !target) {
              write(`${tag} NO [NONEXISTENT] tidak ada\r\n`);
              break;
            }
            state.selected = target.path;
            write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
            write(`* ${String(target.messages.length)} EXISTS\r\n* 0 RECENT\r\n`);
            write(`* OK [UIDVALIDITY ${String(target.uidValidity)}] sah\r\n`);
            write(`* OK [UIDNEXT ${String(target.nextUid)}] berikutnya\r\n`);
            write(`${tag} OK [${command === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] selesai\r\n`);
            break;
          }
          case 'UID': {
            const sub = (rest[0] ?? '').toUpperCase();
            if (!folder) {
              write(`${tag} NO belum memilih folder\r\n`);
              break;
            }
            const maxUid = folder.messages.at(-1)?.uid ?? 0;
            if (sub === 'SEARCH') {
              const criteria = rest.slice(1).join(' ').toUpperCase();
              const since = criteria.includes('SINCE') ? parseSearchDate(criteria) : null;
              const uids = folder.messages
                .filter((message) => !since || message.internalDate.getTime() >= since.getTime())
                .map((message) => message.uid);
              write(
                `* SEARCH${uids.map((uid) => ` ${String(uid)}`).join('')}\r\n${tag} OK SEARCH selesai\r\n`,
              );
            } else if (sub === 'FETCH') {
              const set = rest[1] ?? '';
              const items = rest.slice(2).join(' ').toUpperCase();
              folder.messages.forEach((message, position) => {
                if (!inSet(message.uid, set, maxUid)) return;
                const parts: (string | Buffer)[] = [
                  `* ${String(position + 1)} FETCH (UID ${String(message.uid)}`,
                ];
                const { headers, body } = splitMessage(message.raw);
                if (items.includes('FLAGS')) parts.push(` FLAGS (${message.flags.join(' ')})`);
                if (items.includes('INTERNALDATE'))
                  parts.push(` INTERNALDATE "${imapDate(message.internalDate)}"`);
                if (items.includes('RFC822.SIZE'))
                  parts.push(` RFC822.SIZE ${String(message.raw.length)}`);
                if (items.includes('BODYSTRUCTURE')) {
                  parts.push(
                    ` BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${String(body.length)} 1)`,
                  );
                }
                if (items.includes('HEADER.FIELDS')) {
                  parts.push(
                    ` BODY[HEADER.FIELDS (FROM)] {${String(headers.length)}}\r\n`,
                    headers,
                  );
                }
                if (/BODY\.PEEK\[1\]/.test(items)) {
                  const preview = body.subarray(0, 4096);
                  parts.push(` BODY[1] {${String(preview.length)}}\r\n`, preview);
                }
                parts.push(')\r\n');
                for (const part of parts) write(part);
              });
              write(`${tag} OK FETCH selesai\r\n`);
            } else {
              write(`${tag} OK\r\n`);
            }
            break;
          }
          case 'IDLE':
            idleTag = tag;
            idleClients.add(state);
            write('+ idling\r\n');
            break;
          case 'NOOP':
            write(`${tag} OK NOOP\r\n`);
            break;
          case 'LOGOUT':
            write(`* BYE sampai jumpa\r\n${tag} OK LOGOUT\r\n`);
            socket.end();
            break;
          default:
            write(`${tag} OK\r\n`);
        }
      }
    });
  };

  const server: Server = createTlsServer({ cert: TEST_IMAP_CERT, key: TEST_IMAP_KEY }, handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const notifyIdle = (path: string, line: string) => {
    for (const client of idleClients) {
      if (client.selected === path) client.socket.write(line);
    }
  };

  return {
    port,
    folders,
    commands,
    add(path, raw, addOptions = {}) {
      const folder = folders.get(path);
      if (!folder) throw new Error(`Folder ${path} tidak ada`);
      const uid = folder.nextUid;
      folder.nextUid += 1;
      folder.messages.push({
        uid,
        raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'),
        flags: addOptions.flags ?? [],
        internalDate: addOptions.internalDate ?? new Date(),
      });
      notifyIdle(path, `* ${String(folder.messages.length)} EXISTS\r\n`);
      return uid;
    },
    remove(path, uid) {
      const folder = folders.get(path);
      if (!folder) return;
      const index = folder.messages.findIndex((message) => message.uid === uid);
      if (index >= 0) {
        folder.messages.splice(index, 1);
        notifyIdle(path, `* ${String(index + 1)} EXPUNGE\r\n`);
      }
    },
    setFlags(path, uid, flags) {
      const message = folders.get(path)?.messages.find((item) => item.uid === uid);
      if (message) message.flags = flags;
    },
    setUidValidity(path, value) {
      const folder = folders.get(path);
      if (folder) folder.uidValidity = value;
    },
    connections: () => open,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
