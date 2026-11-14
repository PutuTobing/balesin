import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv, resolveSmtpFallback, smtpFallbackEnvShape } from '../env';
import { Secret } from '../secret';
import { TimeoutError } from '../timeout';
import { classifyMailAddress, isBlockedMailAddress, resolveMailHost } from './host-guard';
import { fallbackEmailSettings, openStoredEmailSettings, SMTP_PASSWORD_PURPOSE } from './settings';
import {
  allowedSmtpPorts,
  classifySmtpError,
  isPlaintextLoginRejected,
  plaintextLoginPolicy,
  sendSmtpMail,
  verifySmtpConnection,
  type SmtpConnectionConfig,
} from './smtp';
import {
  escapeHtml,
  renderAccountLockedEmail,
  renderSecurityNoticeEmail,
  renderTestEmail,
} from './templates';
import { createSecretBox } from '../crypto';
import { z } from 'zod';

describe('penjaga alamat SMTP', () => {
  it('memblokir link-local/metadata, alamat tak-tentu, multicast, dan yang bukan IP', () => {
    for (const address of [
      '169.254.169.254',
      '169.254.0.1',
      '0.0.0.0',
      '0.1.2.3',
      '224.0.0.1',
      '255.255.255.255',
      '100.100.100.200',
      '::',
      'fe80::1',
      'ff02::1',
      'fd00:ec2::254',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      'bukan-ip',
      '',
    ]) {
      expect(isBlockedMailAddress(address), address).toBe(true);
    }
  });

  it('mengizinkan alamat publik, privat, dan loopback (server email internal itu sah)', () => {
    for (const address of [
      '203.0.113.10',
      '8.8.8.8',
      '10.0.0.5',
      '192.168.1.20',
      '172.16.0.9',
      '127.0.0.1',
      '::1',
      '2001:db8::25',
      '::ffff:203.0.113.10',
    ]) {
      expect(isBlockedMailAddress(address), address).toBe(false);
    }
  });

  it('IPv6 yang membawa IPv4 terblokir ikut diblokir (NAT64, 6to4, SIIT), juga Teredo dan ::/96', () => {
    for (const address of [
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b:1::a9fe:a9fe',
      '64:ff9b:1:a9fe:a9:fe00::',
      '2002:a9fe:a9fe::1',
      '2002:0000:0001::1',
      '::ffff:0:a9fe:a9fe',
      '::ffff:0:169.254.169.254',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '::a9fe:a9fe',
      '::0.0.0.2',
      'fe80::1%eth0',
    ]) {
      expect(isBlockedMailAddress(address), address).toBe(true);
    }
  });

  it('menggolongkan alamat: jaringan lokal vs internet (dasar aturan "Tanpa enkripsi")', () => {
    for (const address of [
      '10.0.0.5',
      '172.16.0.9',
      '192.168.1.20',
      '127.0.0.1',
      '100.64.1.1',
      '::1',
      'fd12:3456::25',
      '::ffff:10.0.0.5',
      '64:ff9b::a00:5',
    ]) {
      expect(classifyMailAddress(address), address).toBe('private');
    }
    for (const address of [
      '203.0.113.10',
      '8.8.8.8',
      '2001:db8::25',
      '64:ff9b::808:808',
      '2002:cb00:710a::1',
      '::ffff:203.0.113.10',
    ]) {
      expect(classifyMailAddress(address), address).toBe('public');
    }
  });

  it('nama host di-resolve sekali; IPv4 didahulukan; nama dipakai untuk verifikasi TLS', async () => {
    const result = await resolveMailHost('mail.contoh.test', {
      lookup: () =>
        Promise.resolve([
          { address: '2001:db8::25', family: 6 },
          { address: '203.0.113.25', family: 4 },
        ]),
    });

    expect(result).toEqual({
      ok: true,
      address: '203.0.113.25',
      servername: 'mail.contoh.test',
      addressClass: 'public',
    });
    // Golongan "jaringan lokal" hanya bila SEMUA alamat hasil resolve lokal.
    const mixed = await resolveMailHost('relay.contoh.test', {
      lookup: () =>
        Promise.resolve([
          { address: '10.0.0.25', family: 4 },
          { address: '203.0.113.25', family: 4 },
        ]),
    });
    expect(mixed).toMatchObject({ ok: true, address: '10.0.0.25', addressClass: 'public' });
  });

  it('alamat IP langsung tidak di-resolve dan tidak punya nama TLS', async () => {
    const lookup = () => Promise.reject(new Error('tidak boleh dipanggil'));

    expect(await resolveMailHost('203.0.113.25', { lookup })).toEqual({
      ok: true,
      address: '203.0.113.25',
      servername: undefined,
      addressClass: 'public',
    });
    expect(await resolveMailHost('[2001:db8::25]', { lookup })).toMatchObject({
      ok: true,
      address: '2001:db8::25',
    });
    expect(await resolveMailHost('169.254.169.254', { lookup })).toEqual({
      ok: false,
      code: 'host_blocked',
    });
  });

  it('satu saja alamat terblokir di antara hasil DNS membuat seluruh host ditolak', async () => {
    const result = await resolveMailHost('campuran.contoh.test', {
      lookup: () =>
        Promise.resolve([
          { address: '203.0.113.25', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]),
    });

    expect(result).toEqual({ ok: false, code: 'host_blocked' });
  });

  it('DNS gagal, kosong, atau terlalu lama dibedakan', async () => {
    expect(
      await resolveMailHost('a.test', { lookup: () => Promise.reject(new Error('ENOTFOUND')) }),
    ).toEqual({ ok: false, code: 'host_not_found' });
    expect(await resolveMailHost('a.test', { lookup: () => Promise.resolve([]) })).toEqual({
      ok: false,
      code: 'host_not_found',
    });
    expect(
      await resolveMailHost('a.test', {
        lookup: () => new Promise(() => undefined),
        timeoutMs: 30,
      }),
    ).toEqual({ ok: false, code: 'connection_timeout' });
  });
});

describe('klasifikasi error SMTP', () => {
  const classify = (error: unknown) => classifySmtpError(error).code;

  it.each([
    [{ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }, 'auth_failed'],
    [{ code: 'EAUTH', command: 'AUTH' }, 'auth_unsupported'],
    [{ code: 'ENOAUTH' }, 'auth_failed'],
    [{ responseCode: 534 }, 'auth_failed'],
    [{ code: 'ETLS', command: 'STARTTLS', responseCode: 502 }, 'tls_failed'],
    [{ code: 'ESOCKET', message: 'ssl3_get_record:wrong version number' }, 'tls_failed'],
    [{ code: 'ESOCKET', cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }, 'certificate_invalid'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'certificate_invalid'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'certificate_invalid'],
    [{ code: 'EDNS' }, 'host_not_found'],
    [{ code: 'ENOTFOUND' }, 'host_not_found'],
    [{ code: 'ESOCKET', cause: { code: 'ECONNREFUSED' } }, 'connection_refused'],
    [{ code: 'ECONNREFUSED' }, 'connection_refused'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, 'connection_timeout'],
    [{ code: 'EHOSTUNREACH' }, 'connection_timeout'],
    [{ code: 'EENVELOPE', responseCode: 550, command: 'MAIL FROM' }, 'sender_rejected'],
    [{ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }, 'recipient_rejected'],
    [{ code: 'EENVELOPE', responseCode: 530, command: 'MAIL FROM' }, 'auth_failed'],
    [{ code: 'EMESSAGE', responseCode: 554, command: 'DATA' }, 'message_rejected'],
    [{ code: 'ECONNECTION' }, 'connection_refused'],
    [{ code: 'ESESUATU' }, 'unknown'],
    ['bukan objek', 'unknown'],
    [null, 'unknown'],
  ])('%j → %s', (error, expected) => {
    expect(classify(error)).toBe(expected);
  });

  it('batas waktu total dikenali, dan diagnosanya tidak pernah memuat teks balasan server', () => {
    expect(classify(new TimeoutError('Operasi SMTP', 10))).toBe('connection_timeout');

    const { diagnostic } = classifySmtpError({
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
      response: '535 RAHASIA-BALASAN-SERVER',
      message: 'Invalid login: 535 RAHASIA-BALASAN-SERVER',
    });
    expect(diagnostic).toEqual({
      stage: 'smtp',
      errorCode: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('RAHASIA');
  });
});

describe('klien SMTP terhadap server tiruan', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** Server SMTP mini: menjawab tiap perintah lewat `reply`, mencatat semua yang diterima. */
  async function fakeSmtp(reply: (line: string, socket: Socket) => string | undefined) {
    const received: string[] = [];
    const sockets = new Set<Socket>();
    const instance = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      let inData = false;
      socket.write('220 tiruan.contoh.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('latin1').split('\r\n').filter(Boolean)) {
          received.push(line);
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write(reply('<akhir data>', socket) ?? '250 2.0.0 diterima\r\n');
            }
            continue;
          }
          const custom = reply(line, socket);
          if (custom !== undefined) socket.write(custom);
          else if (/^EHLO/i.test(line)) socket.write('250-tiruan\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (/^DATA/i.test(line)) {
            inData = true;
            socket.write('354 lanjut\r\n');
          } else if (/^QUIT/i.test(line)) socket.end('221 dah\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    server = instance;
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
    const { port } = instance.address() as AddressInfo;
    const config: SmtpConnectionConfig = {
      host: '127.0.0.1',
      port,
      security: 'none',
      username: 'cs@contoh.test',
      password: new Secret('sandi-smtp-uji'),
    };
    return { config, policy: { allowedPorts: [port], timeouts: { totalMs: 5_000 } }, received };
  }

  const sender = { fromName: 'Balesin "Uji"', fromAddress: 'cs@contoh.test', replyTo: null };
  const mail = { to: 'tujuan@contoh.test', ...renderTestEmail({ productName: 'Balesin Uji' }) };

  it('verifikasi: sambung + login; password dikirim ke server, tidak ke tempat lain', async () => {
    const { config, policy, received } = await fakeSmtp((line) =>
      /^AUTH/i.test(line) ? '235 2.7.0 masuk\r\n' : undefined,
    );

    expect(await verifySmtpConnection(config, policy)).toEqual({ ok: true });
    const auth = received.find((line) => /^AUTH PLAIN/i.test(line)) ?? '';
    expect(Buffer.from(auth.split(' ')[2] ?? '', 'base64').toString()).toBe(
      '\u0000cs@contoh.test\u0000sandi-smtp-uji',
    );
  });

  it('tanpa username tidak ada perintah AUTH sama sekali', async () => {
    const { config, policy, received } = await fakeSmtp(() => undefined);

    expect(
      await verifySmtpConnection({ ...config, username: null, password: null }, policy),
    ).toEqual({ ok: true });
    expect(received.some((line) => /^AUTH/i.test(line))).toBe(false);
  });

  it.each([
    ['login ditolak', /^AUTH/i, '535 5.7.8 ditolak\r\n', 'auth_failed'],
    ['pengirim ditolak', /^MAIL FROM/i, '550 5.1.0 pengirim ditolak\r\n', 'sender_rejected'],
    ['penerima ditolak', /^RCPT TO/i, '550 5.1.1 tidak dikenal\r\n', 'recipient_rejected'],
    ['pesan ditolak', /^<akhir data>/, '554 5.7.1 ditolak sebagai spam\r\n', 'message_rejected'],
  ])('kirim: %s → kode yang tepat', async (_label, pattern, response, expected) => {
    const { config, policy } = await fakeSmtp((line) => {
      if (pattern.test(line)) return response;
      return /^AUTH/i.test(line) ? '235 masuk\r\n' : undefined;
    });

    const result = await sendSmtpMail(config, sender, mail, policy);

    expect(result).toMatchObject({ ok: false, code: expected });
    expect(JSON.stringify(result)).not.toContain('ditolak');
  });

  it('kirim berhasil: amplop, pengirim, balas-ke, dan isi sampai apa adanya', async () => {
    const { config, policy, received } = await fakeSmtp((line) =>
      /^AUTH/i.test(line) ? '235 masuk\r\n' : undefined,
    );

    const result = await sendSmtpMail(
      config,
      { ...sender, replyTo: 'bantuan@contoh.test' },
      mail,
      policy,
    );

    expect(result).toEqual({ ok: true });
    const wire = received.join('\n');
    expect(wire).toContain('MAIL FROM:<cs@contoh.test>');
    expect(wire).toContain('RCPT TO:<tujuan@contoh.test>');
    expect(wire).toMatch(/^From: "Balesin \\"Uji\\"" <cs@contoh\.test>$/m);
    expect(wire).toMatch(/^Reply-To: bantuan@contoh\.test$/m);
    expect(wire).toMatch(/^Subject: Email tes dari Balesin Uji$/m);
  });

  it('port di luar daftar izin dan host terblokir ditolak sebelum ada sambungan', async () => {
    const { config, received } = await fakeSmtp(() => undefined);

    const port = await verifySmtpConnection(config, { allowedPorts: [25, 465, 587] });
    const host = await verifySmtpConnection(
      { ...config, host: '169.254.169.254' },
      { allowedPorts: [config.port] },
    );

    expect(port).toEqual({ ok: false, code: 'port_not_allowed', diagnostic: { stage: 'policy' } });
    expect(host).toEqual({ ok: false, code: 'host_blocked', diagnostic: { stage: 'dns' } });
    expect(received).toEqual([]);
  });

  it('sambungan dibuat ke alamat hasil resolve, bukan me-resolve ulang nama host', async () => {
    const { config, policy, received } = await fakeSmtp((line) =>
      /^AUTH/i.test(line) ? '235 masuk\r\n' : undefined,
    );
    let lookups = 0;

    const result = await verifySmtpConnection(
      { ...config, host: 'mail.hanya-di-tes.invalid' },
      {
        ...policy,
        lookup: () => {
          lookups += 1;
          return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(lookups).toBe(1);
    expect(received.length).toBeGreaterThan(0);
  });

  it('server yang tidak pernah menyapa dihentikan batas waktu', async () => {
    const silent = createServer((socket) => socket.on('error', () => undefined));
    server = silent;
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const started = Date.now();

    const result = await verifySmtpConnection(
      { host: '127.0.0.1', port, security: 'none', username: null, password: null },
      { allowedPorts: [port], timeouts: { greetingMs: 200, socketMs: 200, totalMs: 600 } },
    );

    expect(result).toMatchObject({ ok: false, code: 'connection_timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('"Tanpa enkripsi" + login ke host internet ditolak sebelum menyambung (production)', async () => {
    let connected = false;
    const trap = createServer((socket) => {
      connected = true;
      socket.destroy();
    });
    server = trap;
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
    const { port } = trap.address() as AddressInfo;
    const publicLookup = () => Promise.resolve([{ address: '203.0.113.25', family: 4 }]);
    const config: SmtpConnectionConfig = {
      host: 'mail.publik.test',
      port,
      security: 'none',
      username: 'cs@contoh.test',
      password: new Secret('sandi-smtp-uji'),
    };

    const result = await verifySmtpConnection(config, {
      allowedPorts: [port],
      lookup: publicLookup,
      plaintextLogin: 'private-only',
    });
    expect(result).toMatchObject({ ok: false, code: 'insecure_login' });
    expect(connected).toBe(false);

    // Pemeriksaan saat menyimpan: hanya kombinasi tanpa enkripsi + login ke internet yang ditolak.
    const policy = { lookup: publicLookup, plaintextLogin: 'private-only' as const };
    expect(await isPlaintextLoginRejected(config, policy)).toBe(true);
    expect(await isPlaintextLoginRejected({ ...config, username: null }, policy)).toBe(false);
    expect(await isPlaintextLoginRejected({ ...config, security: 'starttls' }, policy)).toBe(false);
    expect(
      await isPlaintextLoginRejected(config, {
        lookup: () => Promise.resolve([{ address: '192.168.1.5', family: 4 }]),
        plaintextLogin: 'private-only',
      }),
    ).toBe(false);
    expect(await isPlaintextLoginRejected(config, { ...policy, plaintextLogin: 'allow' })).toBe(
      false,
    );
    expect(plaintextLoginPolicy(true)).toBe('private-only');
    expect(plaintextLoginPolicy(false)).toBe('allow');
  });

  it('daftar port: production hanya port SMTP baku; di luar itu ditambah penangkap email lokal', () => {
    expect(allowedSmtpPorts(true)).toEqual([25, 465, 587, 2525]);
    expect(allowedSmtpPorts(false)).toEqual([25, 465, 587, 2525, 1025]);
  });
});

describe('pengaturan tersimpan dan cadangan .env', () => {
  const organizationId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const secretBox = createSecretBox(new Secret(Buffer.alloc(32, 7)));
  const row = {
    organizationId,
    fromName: 'Balesin',
    fromAddress: 'cs@contoh.test',
    replyTo: null,
    host: 'mail.contoh.test',
    port: 465,
    security: 'ssl' as const,
    username: 'cs@contoh.test',
    passwordEncrypted: secretBox.encrypt('sandi-tersimpan', {
      organizationId,
      purpose: SMTP_PASSWORD_PURPOSE,
    }),
  };

  it('membuka password tersimpan; hasilnya tetap terbungkus Secret', () => {
    const opened = openStoredEmailSettings(row, secretBox);

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.settings.connection.password?.reveal()).toBe('sandi-tersimpan');
    expect(JSON.stringify(opened)).not.toContain('sandi-tersimpan');
    expect(opened.settings.sender).toEqual({
      fromName: 'Balesin',
      fromAddress: 'cs@contoh.test',
      replyTo: null,
    });
  });

  it('tanpa kotak rahasia, kunci berbeda, atau organisasi berbeda: secret_unavailable', () => {
    const otherBox = createSecretBox(new Secret(Buffer.alloc(32, 9)));

    expect(openStoredEmailSettings(row, null)).toEqual({ ok: false, code: 'secret_unavailable' });
    expect(openStoredEmailSettings(row, otherBox)).toEqual({
      ok: false,
      code: 'secret_unavailable',
    });
    expect(
      openStoredEmailSettings(
        { ...row, organizationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c' },
        secretBox,
      ),
    ).toEqual({ ok: false, code: 'secret_unavailable' });
  });

  it('server tanpa login tidak butuh kotak rahasia', () => {
    const opened = openStoredEmailSettings(
      { ...row, username: null, passwordEncrypted: null },
      null,
    );

    expect(opened).toMatchObject({ ok: true, settings: { connection: { password: null } } });
  });

  const fallbackEnv = (source: Record<string, string>) =>
    resolveSmtpFallback(parseEnv(z.object(smtpFallbackEnvShape()), source));

  it('SMTP_* kosong = tanpa cadangan; terisi = cadangan dengan nama + alamat pengirim', () => {
    expect(fallbackEnv({})).toBeNull();

    const fallback = fallbackEnv({
      SMTP_HOST: 'Mail.Contoh.CO.ID',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'cs@contoh.co.id',
      SMTP_PASSWORD: 'sandi-env',
      SMTP_FROM: 'Balesin Contoh <CS@Contoh.co.id>',
    });
    expect(fallback).toMatchObject({
      host: 'mail.contoh.co.id',
      port: 587,
      security: 'starttls',
      username: 'cs@contoh.co.id',
      fromName: 'Balesin Contoh',
      fromAddress: 'cs@contoh.co.id',
    });
    expect(JSON.stringify(fallback)).not.toContain('sandi-env');
    if (!fallback) return;
    expect(fallbackEmailSettings(fallback).connection.password?.reveal()).toBe('sandi-env');

    expect(
      fallbackEnv({ SMTP_HOST: 'mail.contoh.test', SMTP_FROM: 'cs@contoh.test' }),
    ).toMatchObject({
      security: 'ssl',
      port: 465,
      fromName: 'cs@contoh.test',
      fromAddress: 'cs@contoh.test',
    });
  });

  it('SMTP_HOST tanpa SMTP_FROM, atau SMTP_FROM yang bukan alamat, ditolak dengan nama variabel', () => {
    expect(() => fallbackEnv({ SMTP_HOST: 'mail.contoh.test' })).toThrow(EnvValidationError);
    expect(() => fallbackEnv({ SMTP_HOST: 'mail.contoh.test' })).toThrow(/SMTP_FROM/);
    expect(() =>
      fallbackEnv({ SMTP_HOST: 'mail.contoh.test', SMTP_FROM: 'bukan alamat rahasia-nyasar' }),
    ).toThrow(/SMTP_FROM/);
    try {
      fallbackEnv({ SMTP_HOST: 'mail.contoh.test', SMTP_FROM: 'bukan alamat rahasia-nyasar' });
    } catch (error) {
      expect((error as Error).message).not.toContain('rahasia-nyasar');
    }
  });
});

describe('template email', () => {
  it('email tes: bahasa Indonesia, sapaan "kamu", tanpa tautan atau gambar luar', () => {
    const mail = renderTestEmail({ productName: 'Balesin <Uji>' });

    expect(mail.subject).toBe('Email tes dari Balesin <Uji>');
    expect(mail.text).toContain('pengaturan email pengirim sudah benar');
    expect(mail.text).not.toMatch(/\bAnda\b/i);
    expect(mail.html).toContain('Balesin &lt;Uji&gt;');
    expect(mail.html).not.toContain('<Uji>');
    expect(mail.html).not.toMatch(/<img|<a |<script|https?:\/\//i);
  });

  it('akun dikunci: nama di-escape, waktu dalam zona organisasi, subjek satu baris', () => {
    const mail = renderAccountLockedEmail({
      productName: 'Balesin\r\nBcc: korban@contoh.test',
      userName: '<b>Budi</b>\nSantoso',
      failedAttempts: 5,
      lockMinutes: 15,
      lockedUntil: new Date('2026-11-13T03:30:00.000Z'),
      timeZone: 'Asia/Jakarta',
    });

    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain('Halo <b>Budi</b> Santoso,');
    expect(mail.text).toContain('13 November 2026');
    expect(mail.text).toContain('10.30');
    expect(mail.text).toContain('(Asia/Jakarta)');
    expect(mail.text).toContain('selama 15 menit');
    expect(mail.html).toContain('&lt;b&gt;Budi&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Budi</b>');
    expect(mail.text).not.toMatch(/\bAnda\b/i);
  });

  it('isi menyesuaikan lingkup kunci: satu jaringan, banyak jaringan, perangkat dikenal', () => {
    const render = (scope: 'source' | 'account' | 'device' | 'two_factor') =>
      renderAccountLockedEmail({
        productName: 'Balesin',
        userName: 'Budi',
        failedAttempts: 5,
        lockMinutes: 15,
        lockedUntil: new Date('2026-11-13T03:30:00.000Z'),
        timeZone: 'Asia/Jakarta',
        scope,
      }).text;

    expect(render('source')).toContain('5 kali percobaan masuk ke akunmu');
    expect(render('source')).toContain('dari satu jaringan');
    expect(render('source')).toContain('Dari jaringan dan perangkat lain kamu tetap bisa masuk');
    expect(render('account')).toContain('dari berbagai jaringan');
    expect(render('account')).toContain('perangkat yang biasa kamu pakai');
    expect(render('device')).toContain('dari perangkat yang pernah kamu pakai');
    expect(render('two_factor')).toContain('password yang BENAR, tetapi kode verifikasi');
    expect(render('two_factor')).toContain('password-mu sudah diketahui orang lain');
    const fromReauth = renderAccountLockedEmail({
      productName: 'Balesin',
      userName: 'Budi',
      failedAttempts: 5,
      lockMinutes: 15,
      lockedUntil: new Date('2026-11-13T03:30:00.000Z'),
      timeZone: 'Asia/Jakarta',
      scope: 'two_factor',
      trigger: 'reauth',
    }).text;
    expect(fromReauth).toContain('halaman Keamanan akun');
    expect(fromReauth).toContain('sedang masuk ke akunmu');
    expect(fromReauth).not.toContain('percobaan masuk ke akunmu');
    for (const text of [render('two_factor'), fromReauth]) {
      expect(text).not.toMatch(/ganti password|diatur ulang/);
    }
  });

  it('pemberitahuan keamanan: 2FA aktif, 2FA nonaktif, kode cadangan dipakai', () => {
    const render = (
      event:
        | 'two_factor_enabled'
        | 'two_factor_disabled'
        | 'backup_code_used'
        | 'backup_codes_regenerated',
      backupCodesRemaining?: number,
    ) =>
      renderSecurityNoticeEmail({
        productName: 'Balesin\r\nBcc: korban@contoh.test',
        userName: '<b>Budi</b>',
        event,
        occurredAt: new Date('2026-11-13T03:30:00.000Z'),
        timeZone: 'Asia/Jakarta',
        ...(backupCodesRemaining === undefined ? {} : { backupCodesRemaining }),
      });

    const enabled = render('two_factor_enabled');
    expect(enabled.subject).not.toMatch(/[\r\n]/);
    expect(enabled.subject).toContain('Verifikasi dua langkah');
    expect(enabled.text).toContain('diaktifkan pada 13 November 2026');
    expect(enabled.text).toContain('(Asia/Jakarta)');
    expect(enabled.html).toContain('&lt;b&gt;Budi&lt;/b&gt;');
    expect(enabled.html).not.toContain('<b>Budi</b>');
    expect(render('two_factor_disabled').text).toContain('dinonaktifkan pada');
    expect(render('backup_code_used', 3).text).toContain(
      'Sisa kode cadangan yang masih berlaku: 3',
    );
    expect(render('backup_code_used', 0).text).toContain('sudah habis');
    // Tidak menyarankan fitur yang belum ada (reset 2FA oleh Owner/Admin, ganti password).
    expect(render('backup_code_used', 3).text).not.toMatch(/diatur ulang|ganti password/);
    const regenerated = render('backup_codes_regenerated');
    expect(regenerated.subject).toContain('dibuat ulang');
    expect(regenerated.text).toContain('Semua kode cadangan lama tidak berlaku lagi');
    for (const event of [
      'two_factor_enabled',
      'two_factor_disabled',
      'backup_code_used',
      'backup_codes_regenerated',
    ] as const) {
      const mail = render(event, 1);
      expect(mail.text).toContain('Kalau bukan kamu');
      expect(mail.text).not.toMatch(/\bAnda\b/i);
      expect(mail.html).not.toMatch(/<img|<a |<script|https?:\/\//i);
    }
  });

  it('zona waktu tak dikenal jatuh ke UTC, tidak melempar', () => {
    const mail = renderAccountLockedEmail({
      productName: 'Balesin',
      userName: 'Budi',
      failedAttempts: 5,
      lockMinutes: 15,
      lockedUntil: new Date('2026-11-13T03:30:00.000Z'),
      timeZone: 'Mars/Olympus',
    });

    expect(mail.text).toContain('(UTC)');
  });

  it('escapeHtml menutup kelima karakter berbahaya', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
