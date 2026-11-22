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
import { Secret } from '../secret';
import { testMailIncoming } from './imap-account';

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
async function startEndlessListServer(): Promise<HostileServer> {
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
            for (let i = 0; i < 500; i += 1)
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
  it.fails(
    'tes Masuk ke server yang mengalirkan LIST tanpa akhir: setelah tenggat, sambungan ditutup (tidak terus menumpuk memori di proses api)',
    async () => {
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
    },
    15_000,
  );
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

  it.fails(
    'SIIT/IPv4-translated ::ffff:0:a.b.c.d (pembungkus IPv4) ditolak seperti ::ffff:a.b.c.d',
    () => {
      const rule = { privateCidrs: [] as string[] };
      expect(strictMailAddressAllowed('::ffff:0:7f00:1', rule)).toBe(false);
      expect(strictMailAddressAllowed('::ffff:0:a00:1', rule)).toBe(false);
    },
  );
});
