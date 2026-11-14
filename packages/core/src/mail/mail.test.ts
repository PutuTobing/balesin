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
  describeUserAgent,
  escapeHtml,
  renderAccountLockedEmail,
  renderAdminAccountNoticeEmail,
  renderAdminTwoFactorNoticeEmail,
  renderEmailSettingsChangedEmail,
  renderEmailVerificationEmail,
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderSecurityNoticeEmail,
  renderTestEmail,
  type EmailBrand,
} from './templates';
import { SECURITY_NOTICE_EVENTS, type SecurityNoticeEvent } from '../queues';
import { buildTokenLink } from '@balesin/shared';
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
  const mail = {
    to: 'tujuan@contoh.test',
    ...renderTestEmail({
      brand: {
        productName: 'Balesin Uji',
        organizationName: null,
        logoSrc: null,
        primaryColor: null,
      },
    }),
  };

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
  const brand = (overrides: Partial<EmailBrand> = {}): EmailBrand => ({
    productName: 'Balesin',
    organizationName: 'PT Maju Jaya',
    logoSrc: null,
    primaryColor: null,
    ...overrides,
  });
  const hostileBrand = brand({
    productName: 'Balesin\r\nBcc: korban@contoh.test',
    organizationName: '<script>alert(1)</script> Jaya',
  });
  const APP = 'https://balesin.contoh.co.id';
  const at = new Date('2026-11-13T03:30:00.000Z');

  /** Semua alamat http(s) di HTML hanya boleh tautan aplikasi. */
  function externalUrls(html: string): string[] {
    return [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)]
      .map((match) => match[0])
      .filter((url) => !url.startsWith(`${APP}/`));
  }

  it('email tes: bahasa Indonesia, sapaan "kamu", tanpa tautan atau gambar luar', () => {
    const mail = renderTestEmail({ brand: brand({ productName: 'Balesin <Uji>' }) });

    expect(mail.subject).toBe('Email tes dari Balesin <Uji>');
    expect(mail.text).toContain('pengaturan email pengirim sudah benar');
    expect(mail.text).not.toMatch(/\bAnda\b/i);
    expect(mail.html).toContain('Balesin &lt;Uji&gt;');
    expect(mail.html).not.toContain('<Uji>');
    expect(mail.html).not.toMatch(/<img|<a |<script|https?:\/\//i);
  });

  it('kerangka bermerek: nama produk, nama organisasi, logo hanya cid:/data:, warna dicek kontrasnya', () => {
    const withLogo = renderTestEmail({
      brand: brand({ logoSrc: 'cid:logo@balesin', primaryColor: '#0b5394' }),
    });
    expect(withLogo.html).toContain('<img src="cid:logo@balesin"');
    expect(withLogo.html).toContain('PT Maju Jaya');
    expect(withLogo.text).toContain('— Balesin · PT Maju Jaya');
    expect(withLogo.text).toContain('Email ini dikirim otomatis oleh Balesin untuk PT Maju Jaya.');

    // Logo dari alamat luar tidak pernah dirender.
    const remote = renderTestEmail({ brand: brand({ logoSrc: 'https://jahat.test/x.png' }) });
    expect(remote.html).not.toMatch(/<img/);

    const invitation = (primaryColor: string | null) =>
      renderInvitationEmail({
        brand: brand({ primaryColor }),
        timeZone: 'Asia/Jakarta',
        inviterName: 'Rina',
        role: 'cs',
        email: 'budi@contoh.test',
        link: `${APP}/undangan#token=abc`,
        expiresAt: at,
        twoFactorRequired: false,
      }).html;
    // Warna organisasi dengan kontras cukup dipakai untuk tombol.
    expect(invitation('#0b5394')).toContain('background:#0b5394');
    // Warna terlalu terang untuk teks putih: teks tombol memakai tinta gelap.
    expect(invitation('#ffd24d')).toMatch(/background:#ffd24d[\s\S]*color:#14202E/);
    // Bukan warna heksadesimal (data rusak): warna bawaan, tidak ada sisipan CSS.
    const broken = invitation('red;background:url(x)');
    expect(broken).not.toContain('url(x)');
    expect(broken).toContain('background:#1167D8');
  });

  it('undangan: tautan dari APP_URL, peran, kedaluwarsa, 2FA untuk peran wajib, nilai pengguna di-escape', () => {
    const link = buildTokenLink(APP, 'invitation', 'TokenAcak_123-xyz');
    const mail = renderInvitationEmail({
      brand: hostileBrand,
      timeZone: 'Asia/Jakarta',
      inviterName: '<b>Rina</b>\r\nBcc: x@contoh.test',
      role: 'admin',
      email: 'budi@contoh.test',
      link,
      expiresAt: at,
      twoFactorRequired: true,
    });

    expect(link).toBe(`${APP}/undangan#token=TokenAcak_123-xyz`);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain('mengundangmu');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.text).toContain('sebagai Admin');
    expect(mail.text).toContain('13 November 2026');
    expect(mail.text).toContain('verifikasi dua langkah');
    expect(mail.html).toContain('&lt;b&gt;Rina&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Rina</b>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(externalUrls(mail.html ?? '')).toEqual([]);
    expect(mail.text).not.toMatch(/\bAnda\b/i);

    const cs = renderInvitationEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      inviterName: 'Rina',
      role: 'cs',
      email: 'budi@contoh.test',
      link,
      expiresAt: at,
      twoFactorRequired: false,
    });
    expect(cs.text).not.toContain('verifikasi dua langkah');
  });

  it('tautan wajib http(s): template menolak skema lain', () => {
    expect(() =>
      renderEmailVerificationEmail({
        brand: brand(),
        timeZone: 'Asia/Jakarta',
        userName: 'Budi',
        email: 'budi@contoh.test',
        link: 'javascript:alert(1)',
        expiresAt: at,
      }),
    ).toThrow();
  });

  it('atur ulang password: 30 menit, asal permintaan (IP + perangkat), kode 2FA bila aktif', () => {
    const link = buildTokenLink(APP, 'passwordReset', 'abc');
    const mail = renderPasswordResetEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      userName: 'Budi',
      email: 'budi@contoh.test',
      link,
      expiresAt: at,
      requestedAt: at,
      origin: {
        ip: '203.0.113.7',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      },
      twoFactorEnabled: true,
    });
    expect(link).toBe(`${APP}/atur-ulang-password#token=abc`);
    expect(mail.text).toContain('30 menit');
    expect(mail.text).toContain('Alamat IP: 203.0.113.7');
    expect(mail.text).toContain('Perangkat: Chrome di Windows');
    expect(mail.text).toContain('kode cadangan');
    expect(mail.text).toContain('Kalau bukan kamu yang meminta');
    expect(externalUrls(mail.html ?? '')).toEqual([]);
  });

  it('verifikasi email dan pemberitahuan password diganti', () => {
    const verify = renderEmailVerificationEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      userName: 'Budi',
      email: 'budi@contoh.test',
      link: buildTokenLink(`${APP}/`, 'emailVerification', 'abc'),
      expiresAt: at,
    });
    expect(verify.text).toContain(`${APP}/verifikasi-email#token=abc`);
    expect(verify.subject).toContain('Verifikasi alamat email');

    const changed = renderSecurityNoticeEmail({
      brand: brand(),
      userName: 'Budi',
      event: 'password_changed',
      occurredAt: at,
      timeZone: 'Asia/Jakarta',
      origin: { ip: null, userAgent: null },
    });
    expect(changed.subject).toContain('Password akun Balesin-mu sudah diganti');
    expect(changed.text).toContain('Semua perangkat yang sedang masuk sudah dikeluarkan');
    expect(changed.text).toContain('Alamat IP: tidak diketahui');
    expect(changed.text).toContain('Perangkat: Perangkat tidak dikenal');
  });

  it('2FA aktif ke Owner/Admin: nama, peran, waktu, IP, perangkat', () => {
    const mail = renderAdminTwoFactorNoticeEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      recipientName: 'Rina',
      subject: { name: 'Budi <Admin>', email: 'budi@contoh.test', role: 'admin' },
      occurredAt: at,
      origin: {
        ip: '2001:db8::7',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      },
    });
    expect(mail.subject).toContain('(Admin)');
    expect(mail.text).toContain('Halo Rina,');
    expect(mail.text).toContain('budi@contoh.test');
    expect(mail.text).toContain('Alamat IP: 2001:db8::7');
    expect(mail.text).toContain('Perangkat: Safari di iPhone');
    expect(mail.html).toContain('Budi &lt;Admin&gt;');
    expect(mail.html).not.toContain('Budi <Admin>');
  });

  it('2FA diatur ulang (ke sasaran dan ke Owner lain) + reset password tanpa 2FA (ke Owner/Admin)', () => {
    const toTarget = renderSecurityNoticeEmail({
      brand: brand(),
      userName: 'Budi',
      event: 'two_factor_reset',
      occurredAt: at,
      timeZone: 'Asia/Jakarta',
      actor: { name: 'Sari <b>Owner</b>\r\nBcc: x@y.test', role: 'owner' },
    });
    expect(toTarget.subject).toContain('diatur ulang');
    expect(toTarget.text).toContain('Sari <b>Owner</b> Bcc: x@y.test (Owner) mengatur ulang');
    expect(toTarget.html).not.toContain('<b>Owner</b>');
    const anonymous = renderSecurityNoticeEmail({
      brand: brand(),
      userName: 'Budi',
      event: 'two_factor_reset',
      occurredAt: at,
      timeZone: 'Asia/Jakarta',
    });
    expect(anonymous.text).toContain('Owner atau Admin di tempatmu mengatur ulang');

    const toOwner = renderAdminAccountNoticeEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      recipientName: 'Rina',
      event: 'two_factor_reset',
      subject: { name: 'Adi <Admin>', email: 'adi@contoh.test', role: 'admin' },
      actor: { name: 'Sari', role: 'owner' },
      occurredAt: at,
      origin: { ip: '198.51.100.7', userAgent: null },
    });
    expect(toOwner.subject).toContain('Adi <Admin> (Admin)');
    expect(toOwner.text).toContain(
      'Sari (Owner) mengatur ulang verifikasi dua langkah Adi <Admin>',
    );
    expect(toOwner.text).toContain('Alamat IP: 198.51.100.7');
    expect(toOwner.html).toContain('Adi &lt;Admin&gt;');

    const reset = renderAdminAccountNoticeEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      recipientName: 'Rina',
      event: 'password_reset_without_two_factor',
      subject: { name: 'Dewi', email: 'dewi@contoh.test', role: 'supervisor' },
      occurredAt: at,
    });
    expect(reset.subject).toBe(
      'Dewi (Supervisor) mengatur ulang password tanpa verifikasi dua langkah',
    );
    expect(reset.text).toContain('belum mendaftarkannya');
    for (const mail of [toTarget, toOwner, reset]) {
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.text).not.toMatch(/\bAnda\b/i);
      expect(mail.html).not.toMatch(/<script|https?:\/\//i);
    }
  });

  it('perubahan tim oleh Admin (ke Owner): ubah peran dengan peran lama → baru, nonaktifkan', () => {
    const changed = renderAdminAccountNoticeEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      recipientName: 'Sari',
      event: 'role_changed',
      subject: { name: 'Budi <CS>', email: 'budi@contoh.test', role: 'supervisor' },
      actor: { name: 'Rudi', role: 'admin' },
      roleChange: { from: 'cs', to: 'supervisor' },
      occurredAt: at,
    });
    expect(changed.subject).toBe('Peran Budi <CS> di Balesin diubah oleh Rudi (Admin)');
    expect(changed.text).toContain('Perubahan peran: CS → Supervisor');
    expect(changed.html).toContain('Budi &lt;CS&gt;');
    const disabled = renderAdminAccountNoticeEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      recipientName: 'Sari',
      event: 'user_disabled',
      subject: { name: 'Tono', email: 'tono@contoh.test', role: 'teknisi' },
      actor: { name: 'Rudi', role: 'admin' },
      occurredAt: at,
    });
    expect(disabled.subject).toBe('Tono di Balesin dinonaktifkan oleh Rudi (Admin)');
    expect(disabled.text).toContain('menonaktifkan akun Tono');
    for (const mail of [changed, disabled]) {
      expect(mail.text).not.toMatch(/\bAnda\b/i);
    }
  });

  it('email pengirim diubah (ke Owner): pelaku, server lama → baru, IP; nilai pengguna di-escape', () => {
    const mail = renderEmailSettingsChangedEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      recipientName: 'Rina',
      actor: { name: 'Adi <Admin>', email: 'adi@contoh.test', role: 'admin' },
      previous: { host: 'mail.maju.test', port: 465, fromAddress: 'cs@maju.test' },
      next: { host: 'smtp.<lain>.test', port: 587, fromAddress: 'x@lain.test' },
      occurredAt: at,
      origin: { ip: '198.51.100.7', userAgent: null },
    });
    expect(mail.subject).toContain('diubah oleh Adi <Admin> (Admin)');
    expect(mail.text).toContain('mail.maju.test:465');
    expect(mail.text).toContain('smtp.<lain>.test:587');
    expect(mail.text).toContain('cs@maju.test → x@lain.test');
    expect(mail.text).toContain('Alamat IP: 198.51.100.7');
    expect(mail.text).toContain('pengaturan yang LAMA');
    expect(mail.html).toContain('smtp.&lt;lain&gt;.test');
    expect(mail.html).not.toContain('Adi <Admin>');

    const first = renderEmailSettingsChangedEmail({
      brand: brand(),
      timeZone: 'Asia/Jakarta',
      recipientName: null,
      actor: { name: 'Adi', email: 'adi@contoh.test', role: 'admin' },
      previous: null,
      next: { host: 'smtp.maju.test', port: 587, fromAddress: 'cs@maju.test' },
      occurredAt: at,
    });
    expect(first.text).toContain('Server sebelumnya: Belum diatur');
  });

  it('perkiraan perangkat dari user agent', () => {
    expect(describeUserAgent(null)).toBe('Perangkat tidak dikenal');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
      ),
    ).toBe('Samsung Internet di Android');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      ),
    ).toBe('Safari di macOS');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
      ),
    ).toBe('Microsoft Edge di Windows');
    expect(
      describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'),
    ).toBe('Firefox di Linux');
    expect(describeUserAgent('curl/8.5.0')).toBe('Perangkat tidak dikenal');
  });

  it('akun dikunci: nama di-escape, waktu dalam zona organisasi, subjek satu baris', () => {
    const mail = renderAccountLockedEmail({
      brand: brand({ productName: 'Balesin\r\nBcc: korban@contoh.test' }),
      userName: '<b>Budi</b>\nSantoso',
      failedAttempts: 5,
      lockMinutes: 15,
      lockedUntil: at,
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
    const render = (
      scope: 'source' | 'account' | 'device' | 'two_factor',
      trigger?: 'login' | 'reauth' | 'password_reset',
    ) =>
      renderAccountLockedEmail({
        brand: brand(),
        userName: 'Budi',
        failedAttempts: 5,
        lockMinutes: 15,
        lockedUntil: at,
        timeZone: 'Asia/Jakarta',
        scope,
        ...(trigger ? { trigger } : {}),
      }).text;

    expect(render('source')).toContain('5 kali percobaan masuk ke akunmu');
    expect(render('source')).toContain('dari satu jaringan');
    expect(render('source')).toContain('Dari jaringan dan perangkat lain kamu tetap bisa masuk');
    expect(render('account')).toContain('dari berbagai jaringan');
    expect(render('account')).toContain('perangkat yang biasa kamu pakai');
    expect(render('device')).toContain('dari perangkat yang pernah kamu pakai');
    expect(render('two_factor')).toContain('password yang BENAR, tetapi kode verifikasi');
    expect(render('two_factor')).toContain('password-mu sudah diketahui orang lain');
    const fromReauth = render('two_factor', 'reauth');
    expect(fromReauth).toContain('halaman Keamanan akun');
    expect(fromReauth).toContain('sedang masuk ke akunmu');
    expect(fromReauth).not.toContain('percobaan masuk ke akunmu');
    const fromReset = render('two_factor', 'password_reset');
    expect(fromReset).toContain('mengatur ulang password');
    expect(fromReset).toContain('bisa membuka email akunmu');
    for (const text of [render('two_factor'), fromReauth, fromReset]) {
      expect(text).not.toMatch(/ganti password|diatur ulang/);
    }
  });

  it('pemberitahuan keamanan: 2FA aktif, 2FA nonaktif, kode cadangan dipakai', () => {
    const render = (event: SecurityNoticeEvent, backupCodesRemaining?: number) =>
      renderSecurityNoticeEmail({
        brand: brand({ productName: 'Balesin\r\nBcc: korban@contoh.test' }),
        userName: '<b>Budi</b>',
        event,
        occurredAt: at,
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
    for (const event of SECURITY_NOTICE_EVENTS) {
      const mail = render(event, 1);
      expect(mail.text).toMatch(/Kalau bukan kamu/);
      expect(mail.text).not.toMatch(/\bAnda\b/i);
      expect(mail.html).not.toMatch(/<img|<a |<script|https?:\/\//i);
    }
  });

  it('zona waktu tak dikenal jatuh ke UTC, tidak melempar', () => {
    const mail = renderAccountLockedEmail({
      brand: brand(),
      userName: 'Budi',
      failedAttempts: 5,
      lockMinutes: 15,
      lockedUntil: at,
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
