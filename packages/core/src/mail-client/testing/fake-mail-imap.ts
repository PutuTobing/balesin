import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';

import { TEST_IMAP_CERT, TEST_IMAP_KEY } from '../../channels/testing/test-cert';

/**
 * Server IMAP TIRUAN multi-folder untuk tes modul Email (Fase 9) — perintah yang dipakai
 * `mail-client` lewat imapflow: CAPABILITY, LOGIN, LIST, STATUS, SELECT/EXAMINE, UID SEARCH
 * (ALL/SINCE), UID FETCH (UID, FLAGS, INTERNALDATE, RFC822.SIZE, BODYSTRUCTURE dari MIME sungguhan,
 * header terpilih, `BODY.PEEK[]`/`BODY.PEEK[<bagian>]` dengan potongan `<awal.panjang>`), UID STORE,
 * UID COPY/MOVE (COPYUID), UID EXPUNGE, EXPUNGE, CREATE, IDLE/DONE, NOOP, LOGOUT. TLS dengan
 * sertifikat tes. Bukan server IMAP sungguhan: hanya cukup untuk menguji adaptor & alur sinkron/aksi.
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
  /** Kemampuan `MOVE` (RFC 6851). Bawaan `false` (jalur COPY + \Deleted + UID EXPUNGE). */
  move?: boolean;
  /** Kemampuan `UIDPLUS`. Bawaan `true`. */
  uidplus?: boolean;
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
  /** Perintah berikutnya dengan awalan ini dijawab `NO` (sekali per pemanggilan). */
  failNext(commandPrefix: string): void;
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

// ── MIME minimal (BODYSTRUCTURE & bagian) ───────────────────────────────────

interface MimeNode {
  header: Buffer;
  body: Buffer;
  type: string;
  subtype: string;
  params: Record<string, string>;
  encoding: string;
  id: string | null;
  disposition: string | null;
  dispositionParams: Record<string, string>;
  children: MimeNode[];
}

function splitMessage(raw: Buffer): { headers: Buffer; body: Buffer } {
  const text = raw.toString('latin1');
  const index = text.indexOf('\r\n\r\n');
  if (index < 0) return { headers: raw, body: Buffer.alloc(0) };
  return { headers: raw.subarray(0, index + 4), body: raw.subarray(index + 4) };
}

function headerMap(block: Buffer): Map<string, string> {
  const unfolded = block.toString('latin1').replace(/\r\n[ \t]+/g, ' ');
  const map = new Map<string, string>();
  for (const line of unfolded.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!map.has(key)) map.set(key, line.slice(colon + 1).trim());
  }
  return map;
}

function paramsOf(value: string): { main: string; params: Record<string, string> } {
  const [main = '', ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const item of rest) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    params[item.slice(0, eq).trim().toLowerCase()] = unquote(item.slice(eq + 1).trim());
  }
  return { main: main.trim().toLowerCase(), params };
}

function parseMime(raw: Buffer, depth = 0): MimeNode {
  const { headers, body } = splitMessage(raw);
  const map = headerMap(headers);
  const contentType = paramsOf(map.get('content-type') ?? 'text/plain; charset=us-ascii');
  const [type = 'text', subtype = 'plain'] = contentType.main.split('/');
  const disposition = map.get('content-disposition');
  const parsedDisposition = disposition ? paramsOf(disposition) : null;
  const node: MimeNode = {
    header: headers,
    body,
    type,
    subtype,
    params: contentType.params,
    encoding: (map.get('content-transfer-encoding') ?? '7bit').toLowerCase(),
    id: map.get('content-id') ?? null,
    disposition: parsedDisposition?.main ?? null,
    dispositionParams: parsedDisposition?.params ?? {},
    children: [],
  };
  const boundary = contentType.params.boundary;
  if (type === 'multipart' && boundary && depth < 10) {
    const text = body.toString('latin1');
    const marker = `--${boundary}`;
    const pieces = text.split(marker).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      const content = piece.replace(/^\r\n/, '').replace(/\r\n$/, '');
      node.children.push(parseMime(Buffer.from(content, 'latin1'), depth + 1));
    }
  }
  return node;
}

const q = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const paramList = (params: Record<string, string>) => {
  const entries = Object.entries(params);
  return entries.length === 0
    ? 'NIL'
    : `(${entries.map(([key, value]) => `${q(key.toUpperCase())} ${q(value)}`).join(' ')})`;
};

function bodyStructureOf(node: MimeNode): string {
  if (node.children.length > 0) {
    return `(${node.children.map(bodyStructureOf).join('')} ${q(node.subtype.toUpperCase())} ${paramList(
      node.params.boundary ? { boundary: node.params.boundary } : {},
    )} NIL NIL)`;
  }
  const disposition = node.disposition
    ? `(${q(node.disposition.toUpperCase())} ${paramList(node.dispositionParams)})`
    : 'NIL';
  const lines =
    node.type === 'text' ? ` ${String(node.body.toString('latin1').split('\r\n').length)}` : '';
  return `(${q(node.type.toUpperCase())} ${q(node.subtype.toUpperCase())} ${paramList(node.params)} ${
    node.id ? q(node.id) : 'NIL'
  } NIL ${q(node.encoding.toUpperCase())} ${String(node.body.length)}${lines} NIL ${disposition} NIL)`;
}

/** Bagian bernomor IMAP (`1`, `2.1`, …). Email satu bagian: `1` = isi. */
function partOf(root: MimeNode, section: string): MimeNode | null {
  const numbers = section.split('.').map(Number);
  let node: MimeNode | undefined = root;
  for (const number of numbers) {
    if (!node) return null;
    if (node.children.length === 0) {
      if (number !== 1) return null;
      continue;
    }
    node = node.children[number - 1];
  }
  return node ?? null;
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
  const failures: string[] = [];
  const idleClients = new Set<{ socket: Socket | TLSSocket; selected: string | null }>();
  let open = 0;
  const sockets = new Set<Socket | TLSSocket>();
  const capability = `IMAP4rev1${options.uidplus === false ? '' : ' UIDPLUS'}${
    options.move ? ' MOVE' : ''
  }${options.idle === false ? '' : ' IDLE'}`;

  const notifyIdle = (path: string, line: string, except?: Socket | TLSSocket) => {
    for (const client of idleClients) {
      if (client.selected === path && client.socket !== except) client.socket.write(line);
    }
  };

  const copyInto = (source: FakeMailFolder, target: FakeMailFolder, uids: number[]) => {
    const map: [number, number][] = [];
    for (const uid of uids) {
      const message = source.messages.find((item) => item.uid === uid);
      if (!message) continue;
      const next = target.nextUid;
      target.nextUid += 1;
      target.messages.push({
        uid: next,
        raw: message.raw,
        flags: message.flags.filter((flag) => flag !== '\\Deleted'),
        internalDate: message.internalDate,
      });
      map.push([uid, next]);
    }
    return map;
  };

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
    const expungeUids = (folder: FakeMailFolder, uids: Set<number>) => {
      for (let index = folder.messages.length - 1; index >= 0; index -= 1) {
        const message = folder.messages[index];
        if (message && uids.has(message.uid)) {
          folder.messages.splice(index, 1);
          write(`* ${String(index + 1)} EXPUNGE\r\n`);
          notifyIdle(folder.path, `* ${String(index + 1)} EXPUNGE\r\n`, socket);
        }
      }
    };
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
        const text = command === 'LOGIN' ? 'LOGIN ***' : `${command} ${args}`.trim();
        commands.push(text);
        const failureIndex = failures.findIndex((prefix) => text.toUpperCase().startsWith(prefix));
        if (failureIndex >= 0) {
          failures.splice(failureIndex, 1);
          write(`${tag} NO [SERVERBUG] gagal (tiruan)\r\n`);
          continue;
        }
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
          case 'CREATE': {
            const path = unquote(args.trim());
            if (!authed || path.length === 0 || folders.has(path)) {
              write(`${tag} NO [ALREADYEXISTS] sudah ada\r\n`);
              break;
            }
            folders.set(path, {
              path,
              flags: ['\\HasNoChildren'],
              uidValidity: 1,
              nextUid: 1,
              messages: [],
            });
            write(`${tag} OK CREATE selesai\r\n`);
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
          case 'EXPUNGE': {
            if (!folder) {
              write(`${tag} NO belum memilih folder\r\n`);
              break;
            }
            expungeUids(
              folder,
              new Set(
                folder.messages
                  .filter((message) => message.flags.includes('\\Deleted'))
                  .map((message) => message.uid),
              ),
            );
            write(`${tag} OK EXPUNGE selesai\r\n`);
            break;
          }
          case 'UID': {
            const sub = (rest[0] ?? '').toUpperCase();
            if (!folder) {
              write(`${tag} NO belum memilih folder\r\n`);
              break;
            }
            const maxUid = folder.messages.at(-1)?.uid ?? 0;
            const set = rest[1] ?? '';
            const selectedUids = () =>
              folder.messages
                .filter((message) => inSet(message.uid, set, maxUid))
                .map((m) => m.uid);
            if (sub === 'SEARCH') {
              const criteria = rest.slice(1).join(' ').toUpperCase();
              const since = criteria.includes('SINCE') ? parseSearchDate(criteria) : null;
              const uids = folder.messages
                .filter((message) => !since || message.internalDate.getTime() >= since.getTime())
                .map((message) => message.uid);
              write(
                `* SEARCH${uids.map((uid) => ` ${String(uid)}`).join('')}\r\n${tag} OK SEARCH selesai\r\n`,
              );
            } else if (sub === 'STORE') {
              const mode = (rest[2] ?? '').toUpperCase();
              const flagText = /\(([^)]*)\)/.exec(rest.slice(3).join(' '))?.[1] ?? '';
              const flags = flagText.split(/\s+/).filter((flag) => flag.length > 0);
              folder.messages.forEach((message, position) => {
                if (!inSet(message.uid, set, maxUid)) return;
                if (mode.startsWith('+')) {
                  message.flags = [...new Set([...message.flags, ...flags])];
                } else if (mode.startsWith('-')) {
                  const lower = new Set(flags.map((flag) => flag.toLowerCase()));
                  message.flags = message.flags.filter((flag) => !lower.has(flag.toLowerCase()));
                } else {
                  message.flags = flags;
                }
                if (!mode.includes('.SILENT')) {
                  write(
                    `* ${String(position + 1)} FETCH (UID ${String(message.uid)} FLAGS (${message.flags.join(' ')}))\r\n`,
                  );
                }
              });
              write(`${tag} OK STORE selesai\r\n`);
            } else if (sub === 'COPY' || sub === 'MOVE') {
              if (sub === 'MOVE' && !options.move) {
                write(`${tag} BAD MOVE tidak didukung\r\n`);
                break;
              }
              const target = folders.get(unquote(rest.slice(2).join(' ').trim()));
              if (!target) {
                write(`${tag} NO [TRYCREATE] folder tujuan tidak ada\r\n`);
                break;
              }
              const uids = selectedUids();
              const map = copyInto(folder, target, uids);
              const code =
                options.uidplus === false || map.length === 0
                  ? ''
                  : `[COPYUID ${String(target.uidValidity)} ${map.map(([from]) => String(from)).join(',')} ${map
                      .map(([, to]) => String(to))
                      .join(',')}] `;
              if (sub === 'MOVE') {
                if (code) write(`* OK ${code}dipindah\r\n`);
                expungeUids(folder, new Set(uids));
                write(`${tag} OK MOVE selesai\r\n`);
              } else {
                write(`${tag} OK ${code}COPY selesai\r\n`);
              }
              if (map.length > 0) {
                notifyIdle(target.path, `* ${String(target.messages.length)} EXISTS\r\n`, socket);
              }
            } else if (sub === 'EXPUNGE') {
              if (options.uidplus === false) {
                write(`${tag} BAD UID EXPUNGE tidak didukung\r\n`);
                break;
              }
              expungeUids(
                folder,
                new Set(
                  folder.messages
                    .filter(
                      (message) =>
                        inSet(message.uid, set, maxUid) && message.flags.includes('\\Deleted'),
                    )
                    .map((message) => message.uid),
                ),
              );
              write(`${tag} OK UID EXPUNGE selesai\r\n`);
            } else if (sub === 'FETCH') {
              const items = rest.slice(2).join(' ');
              const upper = items.toUpperCase();
              const sections = [
                ...items.matchAll(/BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi),
              ].map((match) => ({
                section: match[1] ?? '',
                start: match[2] === undefined ? null : Number(match[2]),
                length: match[3] === undefined ? null : Number(match[3]),
              }));
              folder.messages.forEach((message, position) => {
                if (!inSet(message.uid, set, maxUid)) return;
                const parts: (string | Buffer)[] = [
                  `* ${String(position + 1)} FETCH (UID ${String(message.uid)}`,
                ];
                const { headers } = splitMessage(message.raw);
                const mime = parseMime(message.raw);
                if (/\bFLAGS\b/.test(upper)) parts.push(` FLAGS (${message.flags.join(' ')})`);
                if (upper.includes('INTERNALDATE'))
                  parts.push(` INTERNALDATE "${imapDate(message.internalDate)}"`);
                if (upper.includes('RFC822.SIZE'))
                  parts.push(` RFC822.SIZE ${String(message.raw.length)}`);
                if (upper.includes('BODYSTRUCTURE'))
                  parts.push(` BODYSTRUCTURE ${bodyStructureOf(mime)}`);
                for (const { section, start, length } of sections) {
                  const key = section.toUpperCase();
                  let content: Buffer;
                  let label = section;
                  if (key.startsWith('HEADER.FIELDS')) {
                    content = headers;
                    label = 'HEADER.FIELDS (FROM)';
                  } else if (key === '') {
                    content = message.raw;
                  } else if (key === 'TEXT') {
                    content = mime.body;
                  } else if (/^[\d.]+\.MIME$/.test(key)) {
                    content = partOf(mime, key.replace(/\.MIME$/, ''))?.header ?? Buffer.alloc(0);
                  } else {
                    content = partOf(mime, key)?.body ?? Buffer.alloc(0);
                  }
                  const origin = start ?? 0;
                  const slice =
                    start === null
                      ? content
                      : content.subarray(origin, origin + (length ?? content.length));
                  parts.push(
                    ` BODY[${label}]${start === null ? '' : `<${String(origin)}>`} {${String(slice.length)}}\r\n`,
                    slice,
                  );
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
    failNext(commandPrefix) {
      failures.push(commandPrefix.toUpperCase());
    },
    connections: () => open,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
