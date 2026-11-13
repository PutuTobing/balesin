/**
 * Tes keamanan dari review Fase 0 (docs/security-reviews/2026-11-13-fase0-fondasi.md).
 *
 * Cara membaca berkas ini:
 *  - `it(...)` biasa = penjaga regresi: perilaku ini SUDAH aman dan harus tetap begitu.
 *  - `it(...)` = CELAH YANG MASIH TERBUKA. Isi tesnya menyatakan perilaku yang BENAR dan
 *    saat ini memang gagal. Setelah celahnya diperbaiki, Vitest melaporkan tes itu "diharapkan
 *    gagal tetapi lulus" — saat itu hapus `.fails`-nya supaya menjadi penjaga regresi biasa.
 *    Kode temuan (T1, S1, S2, R1, R2, R3) merujuk ke laporan review.
 *
 * Tes T1 memakai server Redis PALSU di 127.0.0.1 (port acak), jadi tidak bergantung pada
 * Redis pengembangan dan tidak pernah menyentuh sistem lain.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { redactSecrets, scrubSecretsInJsonLine, scrubSecretsInText } from './redact';
import { closeRedis, createRedis, type Redis } from './redis';
import { REDACTED, Secret } from './secret';
import { createLogCapture } from './testing';

/** Bentuk error balasan ioredis: `command.args` memuat SEMUA argumen perintah yang gagal. */
function redisReplyError(message: string, command: { name: string; args: string[] }): Error {
  return Object.assign(new Error(message), { name: 'ReplyError', command });
}

describe('T1 — error balasan Redis membawa argumen perintah (password, kunci, isi)', () => {
  const PASSWORD = 'sandi-redis-PRODUKSI-9f2c';

  /**
   * Redis PALSU di 127.0.0.1: menjawab setiap perintah dengan error, seperti Redis sungguhan
   * saat password di server tidak cocok dengan `REDIS_URL` (rotasi password, salah ketik).
   */
  let server: Server | undefined;
  let redis: Redis | undefined;
  const sockets = new Set<Socket>();

  async function startRejectingRedis(reply: string): Promise<number> {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        const commands = chunk.toString('latin1').match(/^\*\d+\r\n/gm)?.length ?? 1;
        socket.write(reply.repeat(commands));
      });
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    return (listening.address() as AddressInfo).port;
  }

  afterEach(async () => {
    if (redis) await closeRedis(redis);
    redis = undefined;
    for (const socket of sockets) socket.destroy();
    const listening = server;
    server = undefined;
    if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
  });

  async function connectAndCollect() {
    const port = await startRejectingRedis(
      '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
    );
    const capture = createLogCapture();
    const emitted: Array<Error & { command?: { name?: string; args?: unknown[] } }> = [];
    redis = createRedis(`redis://:${PASSWORD}@127.0.0.1:${port}`, {
      role: 'client',
      name: 'tes-auth',
      logger: capture.logger,
    });
    redis.on('error', (error: Error) => emitted.push(error));
    await expect.poll(() => capture.lines.length, { timeout: 5_000 }).toBeGreaterThan(0);
    return { capture, emitted };
  }

  it('fakta pustaka: ioredis menempelkan password ke error saat AUTH ditolak', async () => {
    const { emitted } = await connectAndCollect();

    // Inilah sebabnya error Redis tidak boleh di-log apa adanya. (Nama perintahnya sengaja
    // tidak diperiksa: AUTH atau HELLO, tergantung versi ioredis.)
    expect(emitted[0]?.command?.args).toContain(PASSWORD);
  });

  it('password REDIS_URL tidak ikut ter-log saat Redis menolak AUTH', async () => {
    const { capture } = await connectAndCollect();

    expect(capture.text()).not.toContain(PASSWORD);
  });

  it('logger tidak menulis argumen perintah Redis yang gagal', () => {
    const capture = createLogCapture();

    capture.logger.warn(
      {
        err: redisReplyError('WRONGPASS invalid username-password pair or user is disabled.', {
          name: 'hello',
          args: ['3', 'AUTH', 'default', PASSWORD],
        }),
      },
      'Koneksi Redis bermasalah, mencoba sambung ulang',
    );
    capture.logger.error(
      {
        err: redisReplyError('OOM command not allowed when used memory > maxmemory', {
          name: 'set',
          args: ['sesi:token-sesi-rahasia-123', 'isi-sesi-rahasia-456', 'EX', '43200'],
        }),
      },
      'Permintaan gagal karena kesalahan di server',
    );

    const text = capture.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('token-sesi-rahasia-123');
    expect(text).not.toContain('isi-sesi-rahasia-456');
  });

  it('redactSecrets tidak meneruskan argumen perintah Redis (mis. untuk audit log)', () => {
    const output = redactSecrets(
      redisReplyError('ERR value is not an integer or out of range', {
        name: 'evalsha',
        args: ['sha1', '1', 'balesin:pesan', '{"to":"628123456789","text":"isi-pesan-pelanggan"}'],
      }),
    );

    expect(JSON.stringify(output)).not.toContain('isi-pesan-pelanggan');
  });
});

describe('S1 — objek di argumen format dan JSON di dalam string', () => {
  it('objek yang diselipkan lewat %j / %o tetap disensor berdasarkan nama kunci', () => {
    const capture = createLogCapture();

    capture.logger.info('payload %j', {
      password: 'sandi-di-format-j',
      token: 'token-di-format-j',
    });
    capture.logger.info('konfigurasi %o', { apiKey: 'kunci-di-format-o' });

    const text = capture.text();
    expect(text).not.toContain('sandi-di-format-j');
    expect(text).not.toContain('token-di-format-j');
    expect(text).not.toContain('kunci-di-format-o');
  });

  it('JSON yang sudah berupa string (mis. body mentah) tetap disensor', () => {
    const raw = JSON.stringify({
      password: 'sandi-dalam-string',
      access_token: 'token-dalam-string',
    });
    const capture = createLogCapture();

    capture.logger.info({ raw }, 'body mentah');
    capture.logger.info(`balasan upstream: ${raw}`);

    const text = capture.text();
    expect(text).not.toContain('sandi-dalam-string');
    expect(text).not.toContain('token-dalam-string');
  });

  it('Secret tetap tertutup lewat argumen format maupun sebagai objek log', () => {
    const secret = new Secret('nilai-secret-asli');
    const capture = createLogCapture();

    capture.logger.info('nilai %s dan %j dan %o', secret, { secret }, secret);
    capture.logger.info(secret as unknown as Record<string, unknown>, 'objek log');
    capture.logger.info({ config: { masterKey: secret, list: [secret] } }, 'bersarang');

    expect(capture.text()).not.toContain('nilai-secret-asli');
    expect(capture.entries()).toHaveLength(3);
  });
});

describe('S2 — lama sensor tidak boleh kuadratik terhadap panjang teks', () => {
  // 12.000 × "Failed query: " ≈ 168 KB — jauh di bawah batas body 1 MiB.
  const hostile = 'Failed query: '.repeat(12_000);

  it('scrubSecretsInJsonLine selesai cepat untuk teks berulang "Failed query: "', () => {
    const line = JSON.stringify({ level: 'error', msg: hostile });

    const startedAt = performance.now();
    scrubSecretsInJsonLine(line);
    const elapsedMs = performance.now() - startedAt;

    // Implementasi linear selesai dalam beberapa milidetik; yang sekarang butuh > 1 detik.
    expect(elapsedMs).toBeLessThan(250);
  });

  it('teks panjang tanpa pola pemicu tetap cepat', () => {
    const benign = 'pelanggan bertanya soal tagihan bulan ini. '.repeat(12_000);

    const startedAt = performance.now();
    scrubSecretsInText(benign);
    scrubSecretsInJsonLine(JSON.stringify({ msg: benign }));

    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});

describe('R1 — pola rahasia di teks bebas', () => {
  const leaking: Array<[label: string, text: string, secret: string]> = [
    [
      'reset_token di query',
      'GET https://app.contoh.id/reset?reset_token=tokenReset123456',
      'tokenReset123456',
    ],
    [
      'invite_token di query',
      '/undangan?email=a@b.c&invite_token=tokenUndangan123',
      'tokenUndangan123',
    ],
    [
      'page_access_token di query',
      'page_access_token=tokenHalaman123456&x=1',
      'tokenHalaman123456',
    ],
    ['new_password di form', 'old_password=lama123456&new_password=baru123456', 'baru123456'],
    [
      'password ber-@ di URL koneksi',
      'gagal ke postgres://balesin:p@ss-ekor-rahasia@db:5432/balesin',
      'ss-ekor-rahasia',
    ],
    [
      'token bot Telegram di path URL',
      'fetch https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage gagal',
      'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    ],
  ];

  for (const [label, text, secret] of leaking) {
    it(`menyensor ${label}`, () => {
      expect(scrubSecretsInText(text)).not.toContain(secret);
    });
  }

  it('pola yang sudah tertangani tetap tertangani', () => {
    const cases: Array<[text: string, secret: string]> = [
      ['x?token=tokenBiasa123456', 'tokenBiasa123456'],
      ['x?a=1&access_token=tokenAkses123456', 'tokenAkses123456'],
      ['host=db user=balesin password=sandiKv123456 dbname=x', 'sandiKv123456'],
      ['otpauth://totp/Balesin:a@b.c?secret=JBSWY3DPEHPK3PXP&issuer=Balesin', 'JBSWY3DPEHPK3PXP'],
      ['postgres://balesin:p%40ss-ter-encode@db:5432/balesin', 'ss-ter-encode'],
      [`token ${'EAAG'}${'a1B2c3D4'.repeat(6)}`, 'a1B2c3D4a1B2'],
    ];
    for (const [text, secret] of cases) {
      expect(scrubSecretsInText(text), text).not.toContain(secret);
    }
  });
});

describe('R3 — nama kunci rahasia yang belum dikenali', () => {
  const missed = ['accessKey', 'licenseKey', 'sessionId', 'sid', 'passcode', 'jwt'];

  for (const key of missed) {
    it(`nilai kunci "${key}" disensor`, () => {
      const output = redactSecrets({ [key]: 'nilai-rahasia-kunci' });

      expect(JSON.stringify(output)).not.toContain('nilai-rahasia-kunci');
    });
  }

  it('kunci umum bukan rahasia tetap tampil (sensor tidak boleh membabi buta)', () => {
    const output = redactSecrets({ code: '23505', key: 'balesin:system:1', id: 'abc', name: 'x' });

    expect(output).toEqual({ code: '23505', key: 'balesin:system:1', id: 'abc', name: 'x' });
  });
});

describe('R2 — pesan error Postgres yang mengulang nilai parameter', () => {
  it('nilai yang gagal di-cast (SQLSTATE 22P02) tidak ikut ter-log', () => {
    // Bentuk asli dari Postgres 16 lewat pg + Drizzle (diverifikasi saat review).
    const query = 'select "id" from "user_sessions" where "user_sessions"."id" = $1';
    const pgError = Object.assign(
      new Error('invalid input syntax for type uuid: "token-sesi-nyasar-ke-kolom-uuid"'),
      { severity: 'ERROR', code: '22P02', routine: 'string_to_uuid' },
    );
    const drizzleError = Object.assign(
      new Error(`Failed query: ${query}\nparams: token-sesi-nyasar-ke-kolom-uuid`),
      { query, params: ['token-sesi-nyasar-ke-kolom-uuid'], cause: pgError },
    );
    const capture = createLogCapture();

    capture.logger.error({ err: drizzleError }, 'Permintaan gagal karena kesalahan di server');

    expect(capture.text()).not.toContain('token-sesi-nyasar-ke-kolom-uuid');
  });

  it('rincian baris dan parameter error Postgres tetap disensor di kedalaman berapa pun', () => {
    const pgError = Object.assign(new Error('new row violates check constraint "x"'), {
      severity: 'ERROR',
      code: '23514',
      detail: 'Failing row contains (1, budi@contoh.com, hash-di-detail).',
      where: 'nilai-di-where',
      internalQuery: 'select 1',
    });
    const wrapped = new Error('gagal menyimpan', {
      cause: new Error('lapisan tengah', { cause: pgError }),
    });
    const capture = createLogCapture();

    capture.logger.error({ err: wrapped }, 'gagal');
    capture.logger.warn({ job: { failure: wrapped } }, 'error di bawah kunci lain');

    const text = capture.text();
    expect(text).not.toContain('hash-di-detail');
    expect(text).not.toContain('nilai-di-where');
    expect(text).toContain('23514');
  });
});

describe('baris log tetap JSON yang sah walau isinya dirancang untuk merusak sensor', () => {
  it.each([
    'postgres://u:p"x@h/db',
    'postgres://u:p\\x@h/db',
    'token=abc"def&x=1',
    'token=abc\\ndef',
    'Bearer abcdefgh"ijkl',
    'Failed query: select "a"\nparams: nilai "berkutip" \\ garis miring',
    'Failed query: tanpa params " kutip',
    '  pemisah baris unicode token=abcdefgh',
    '{"password":"x"}',
  ])('%j', (hostile) => {
    const capture = createLogCapture();

    capture.logger.info({ value: hostile, list: [hostile] }, hostile);
    capture.logger.error(new Error(hostile));

    expect(capture.lines).toHaveLength(2);
    for (const line of capture.lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(capture.entries()[0]).toMatchObject({ level: 'info', service: 'test' });
  });

  it('penanda sensor tidak bisa dipakai menyelundupkan kunci baru ke baris log', () => {
    const capture = createLogCapture();

    capture.logger.info({ note: `x","level":"fatal","palsu":"${REDACTED}` }, 'catatan');

    const [entry] = capture.entries();
    expect(entry?.level).toBe('info');
    expect(entry).not.toHaveProperty('palsu');
  });
});
