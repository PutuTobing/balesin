/**
 * Review keamanan Fase 9 tahap 9A bagian 1 (docs/security-reviews/2026-11-23-fase9a-1.md) —
 * klien IMAP akun Email terhadap server IMAP yang DIKENDALIKAN PENYERANG (akun pribadi: CS bebas
 * mengisi host-nya sendiri). Server jahat di sini hanya di loopback (127.0.0.1), TLS sertifikat tes.
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang). Saat
 * diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 */
import type { AddressInfo } from 'node:net';
import { createServer, type TLSSocket } from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';

import { TEST_IMAP_CERT, TEST_IMAP_KEY } from '../channels/testing/test-cert';
import { strictMailAddressAllowed } from '../mail/host-guard';
import { classifyAddress, parseWebhookUrl } from '../net/outgoing-webhook';
import { Secret } from '../secret';
import { MAIL_LIST_MAX_BYTES, openMailImapSession, testMailIncoming } from './imap-account';

interface HostileServer {
  port: number;
  /** Sambungan yang masih terbuka. */
  open(): number;
  /** Byte yang sudah dikirim ke klien. */
  sent(): number;
  close(): Promise<void>;
}

/**
 * Server IMAP yang menjawab LIST dengan aliran `* LIST` TANPA AKHIR (tidak pernah mengirim tagged
 * OK). Data terus mengalir, jadi `socketTimeout` (tidak aktif) tidak pernah terpicu.
 */
async function startEndlessListServer(linesPerTick = 500): Promise<HostileServer> {
  const sockets = new Set<TLSSocket>();
  let sent = 0;
  const server = createServer({ cert: TEST_IMAP_CERT, key: TEST_IMAP_KEY }, (socket) => {
    sockets.add(socket);
    const timers: ReturnType<typeof setInterval>[] = [];
    socket.on('close', () => {
      sockets.delete(socket);
      for (const timer of timers) clearInterval(timer);
    });
    socket.on('error', () => undefined);
    socket.write('* OK IMAP4rev1 siap\r\n');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [tag = '*', command = ''] = line.split(' ');
        const upper = command.toUpperCase();
        if (upper === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK selesai\r\n`);
        } else if (upper === 'LIST') {
          let n = 0;
          const block = () => {
            let out = '';
            for (let i = 0; i < linesPerTick; i += 1)
              out += `* LIST () "/" "folder-${String((n += 1))}"\r\n`;
            return out;
          };
          timers.push(
            setInterval(() => {
              if (socket.writableLength > 1 << 20) return;
              const data = block();
              sent += data.length;
              socket.write(data);
            }, 5),
          );
        } else if (upper === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK\r\n`);
        } else {
          socket.write(`${tag} OK selesai\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    open: () => sockets.size,
    sent: () => sent,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let hostile: HostileServer | null = null;

afterEach(async () => {
  await hostile?.close();
  hostile = null;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('S2 (Tinggi) — server IMAP jahat: tidak ada tenggat yang MENUTUP sambungan', () => {
  it('tes Masuk ke server yang mengalirkan LIST tanpa akhir: setelah tenggat, sambungan ditutup (tidak terus menumpuk memori di proses api)', async () => {
    hostile = await startEndlessListServer();
    const started = Date.now();
    const outcome = await testMailIncoming(
      {
        host: 'imap.contoh.test',
        port: hostile.port,
        security: 'ssl',
        username: 'cs@penyerang.test',
        password: new Secret('apa-saja'),
      },
      {
        allowedPorts: [hostile.port],
        lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        testCa: TEST_IMAP_CERT,
        strict: { privateCidrs: [], allowLoopback: true },
        timeouts: {
          connectionMs: 2_000,
          greetingMs: 2_000,
          socketMs: 2_000,
          totalMs: 1_500,
        },
      },
      { syncWindowDays: 90, roleOf: () => null },
    );
    // Tenggat jawaban berfungsi (laporan tes gagal dalam ~1,5 dtk)…
    expect(outcome.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    const sentAtTimeout = hostile.sent();
    await wait(1_500);
    // …tetapi yang DIHARAPKAN: sambungan ke server jahat sudah ditutup dan aliran berhenti.
    // Sekarang sesi tetap terbuka dan imapflow terus menimbun entri LIST di memori.
    expect(hostile.open()).toBe(0);
    expect(hostile.sent() - sentAtTimeout).toBeLessThan(1024 * 1024);
  }, 15_000);
});

describe('R1 (Rendah) — penjaga host ketat', () => {
  it('regresi: loopback (termasuk IPv4-mapped bentuk heksa), link-local, metadata, privat tanpa allowlist, NAT64/6to4 ditolak', () => {
    const rule = { privateCidrs: [] as string[] };
    for (const address of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '169.254.169.254',
      '::ffff:a9fe:a9fe',
      'fd00:ec2::254',
      '10.0.0.1',
      '::ffff:10.0.0.1',
      '192.168.1.10',
      'fd00::1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      '2001::1',
      '198.18.0.1',
      '0.0.0.0',
    ]) {
      expect(strictMailAddressAllowed(address, rule), address).toBe(false);
    }
    expect(strictMailAddressAllowed('10.0.0.1', { privateCidrs: ['10.0.0.0/8'] })).toBe(true);
    expect(strictMailAddressAllowed('203.0.113.10', rule)).toBe(true);
  });

  it('SIIT/IPv4-translated ::ffff:0:a.b.c.d (pembungkus IPv4) ditolak seperti ::ffff:a.b.c.d', () => {
    const rule = { privateCidrs: [] as string[] };
    expect(strictMailAddressAllowed('::ffff:0:7f00:1', rule)).toBe(false);
    expect(strictMailAddressAllowed('::ffff:0:a00:1', rule)).toBe(false);
  });
});

describe('R1 (Rendah) — pembungkus IPv4 di IPv6 (webhook keluar & penjaga ketat Email)', () => {
  // Semua bentuk ini membawa alamat IPv4 internal (loopback, privat, metadata) di dalam IPv6:
  // IPv4-mapped (titik & heksa, huruf besar, bentuk panjang), SIIT `::ffff:0:a.b.c.d`, NAT64
  // `64:ff9b::/96` & local-use `64:ff9b:1::/48`, IPv4-compatible `::a.b.c.d`, 6to4, Teredo.
  const wrapped = [
    '::ffff:127.0.0.1',
    '::FFFF:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:0:7f00:1',
    '::ffff:0:127.0.0.1',
    '0:0:0:0:ffff:0:7f00:1',
    '::ffff:0:a00:1',
    '::ffff:0:10.0.0.1',
    '::ffff:0:192.168.1.1',
    '::ffff:0:a9fe:a9fe',
    '::ffff:0:8.8.8.8',
    '64:ff9b::7f00:1',
    '64:ff9b::127.0.0.1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::808:808',
    '64:ff9b:1::a00:1',
    '64:ff9b:1:7f00:1::',
    '::127.0.0.1',
    '::7f00:1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::1',
    '2001::1',
  ];

  it('webhook keluar: semua bentuk terbungkus = terlarang (juga dengan allowlist privat)', () => {
    for (const address of wrapped) {
      expect(classifyAddress(address), address).toBe('forbidden');
      for (const allow of [[], ['10.0.0.0/8', '192.168.0.0/16']]) {
        expect(parseWebhookUrl(`https://[${address}]/kait`, allow), address).toEqual({
          error: 'blocked_address',
        });
      }
    }
  });

  it('penjaga ketat Email: semua bentuk terbungkus ditolak, juga bila IPv4-nya ada di allowlist', () => {
    for (const address of wrapped) {
      expect(strictMailAddressAllowed(address, { privateCidrs: [] }), address).toBe(false);
      expect(
        strictMailAddressAllowed(address, { privateCidrs: ['10.0.0.0/8', '192.168.0.0/16'] }),
        address,
      ).toBe(false);
    }
    // allowLoopback (HANYA tes) tidak membuka bentuk SIIT/NAT64 dari loopback.
    for (const address of ['::ffff:0:7f00:1', '64:ff9b::7f00:1']) {
      expect(strictMailAddressAllowed(address, { privateCidrs: [], allowLoopback: true })).toBe(
        false,
      );
    }
  });

  it('kontrol: IPv4-mapped ke privat = privat (butuh allowlist), alamat publik biasa lolos', () => {
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('private');
    expect(parseWebhookUrl('https://[::ffff:a00:1]/', [])).toEqual({
      error: 'private_not_allowed',
    });
    expect(classifyAddress('2606:4700::1111')).toBe('public');
    expect(strictMailAddressAllowed('2606:4700::1111', { privateCidrs: [] })).toBe(true);
    expect(strictMailAddressAllowed('::ffff:10.0.0.1', { privateCidrs: ['10.0.0.0/8'] })).toBe(
      true,
    );
  });
});

describe('S2 (Tinggi) — anggaran byte sambungan & per perintah', () => {
  const config = (port: number) => ({
    host: 'imap.contoh.test',
    port,
    security: 'ssl' as const,
    username: 'cs@penyerang.test',
    password: new Secret('apa-saja'),
  });
  const policy = (port: number) => ({
    allowedPorts: [port],
    lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    testCa: TEST_IMAP_CERT,
    strict: { privateCidrs: [] as string[], allowLoopback: true },
    timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 30_000, totalMs: 30_000 },
  });

  it('anggaran byte sambungan terlewati (juga selama fase sambung/login) → gagal SEGERA dan sambungan diputus, bukan menunggu tenggat', async () => {
    hostile = await startEndlessListServer(2_000);
    const port = hostile.port;
    const started = Date.now();
    // imapflow sudah mengirim `LIST "" ""` saat menyambung: banjir bisa terjadi sebelum sesi jadi.
    const attempt = (async () => {
      const session = await openMailImapSession(config(port), policy(port), {
        maxBytes: 256 * 1024,
        commandMs: 30_000,
      });
      await session.listFolders();
    })();
    await expect(attempt).rejects.toMatchObject({ diagnostic: 'BYTE_BUDGET' });
    expect(Date.now() - started).toBeLessThan(5_000);
    await wait(300);
    expect(hostile.open()).toBe(0);
    expect(hostile.sent()).toBeLessThan(4 * 1024 * 1024);
  }, 15_000);

  it('LIST raksasa diputus pada batas per perintah walau anggaran sambungan (96 MB) masih jauh', async () => {
    hostile = await startEndlessListServer(4_000);
    const port = hostile.port;
    const attempt = (async () => {
      const session = await openMailImapSession(config(port), policy(port), { commandMs: 30_000 });
      await session.listFolders();
    })();
    await expect(attempt).rejects.toMatchObject({ diagnostic: 'BYTE_BUDGET' });
    await wait(300);
    expect(hostile.open()).toBe(0);
    // Batas LIST 4 MB (+ sisa penyangga soket), jauh di bawah anggaran sambungan.
    expect(hostile.sent()).toBeLessThan(MAIL_LIST_MAX_BYTES + 4 * 1024 * 1024);
  }, 30_000);
});
