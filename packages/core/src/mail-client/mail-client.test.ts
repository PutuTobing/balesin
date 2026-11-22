import { mailFolderRoleOf } from '@balesin/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_IMAP_CERT } from '../channels/testing/test-cert';
import type { ImapPolicy } from '../channels/email-imap';
import { resolveMailHost, strictMailAddressAllowed } from '../mail/host-guard';
import { Secret } from '../secret';
import { decodeTextPreview, parseAutoconfigXml } from './autoconfig';
import { mailDeliveredTo, parseMailHeaderBlock } from './headers';
import { classifyMailImapError, openMailImapSession, testMailIncoming } from './imap-account';
import { mailOutgoingCodeOf } from './smtp-account';
import { startFakeMailImap, type FakeMailImapServer } from './testing/fake-mail-imap';

const DAY = 24 * 60 * 60 * 1000;

function email(input: {
  from: string;
  subject: string;
  text?: string;
  headers?: string[];
}): string {
  return [
    `From: ${input.from}`,
    'To: cs@contoh.test',
    `Subject: ${input.subject}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@pengirim.test>`,
    'Date: Tue, 17 Nov 2026 10:00:00 +0700',
    ...(input.headers ?? []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.text ?? 'Halo tim, internet kantor mati sejak pagi.',
    '',
  ].join('\r\n');
}

describe('penjaga host ketat akun Email (SSRF)', () => {
  const rule = { privateCidrs: ['10.20.0.0/16'] };

  it('privat hanya lewat allowlist; loopback/metadata/cadangan selalu ditolak', () => {
    expect(strictMailAddressAllowed('203.0.113.10', rule)).toBe(true);
    expect(strictMailAddressAllowed('10.20.1.5', rule)).toBe(true);
    expect(strictMailAddressAllowed('10.30.1.5', rule)).toBe(false);
    expect(strictMailAddressAllowed('192.168.1.10', rule)).toBe(false);
    expect(strictMailAddressAllowed('127.0.0.1', rule)).toBe(false);
    expect(strictMailAddressAllowed('169.254.169.254', rule)).toBe(false);
    expect(strictMailAddressAllowed('::ffff:127.0.0.1', rule)).toBe(false);
    expect(strictMailAddressAllowed('64:ff9b::a9fe:a9fe', rule)).toBe(false);
    expect(strictMailAddressAllowed('fd00:ec2::254', rule)).toBe(false);
    // Loopback hanya bila diizinkan eksplisit (tes).
    expect(strictMailAddressAllowed('127.0.0.1', { ...rule, allowLoopback: true })).toBe(true);
  });

  it('DNS campuran (satu publik, satu privat) ditolak', async () => {
    const result = await resolveMailHost('mail.contoh.test', {
      lookup: () =>
        Promise.resolve([
          { address: '203.0.113.10', family: 4 },
          { address: '192.168.1.5', family: 4 },
        ]),
      strict: { privateCidrs: [] },
    });
    expect(result).toEqual({ ok: false, code: 'host_blocked' });
  });

  it('tanpa aturan ketat perilaku lama tetap (privat boleh untuk Email pengirim sistem)', async () => {
    const result = await resolveMailHost('192.168.1.5');
    expect(result.ok).toBe(true);
  });
});

describe('autoconfig (tanpa DTD/entitas)', () => {
  const xml = `<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="contoh.test">
<incomingServer type="pop3"><hostname>pop.contoh.test</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
<incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
<outgoingServer type="smtp"><hostname>smtp.contoh.test</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></outgoingServer>
</emailProvider></clientConfig>`;

  it('membaca IMAP + SMTP yang didukung', () => {
    expect(parseAutoconfigXml(xml, 'contoh.test')).toEqual({
      imap: { host: 'imap.contoh.test', port: 993, security: 'ssl', username: 'address' },
      smtp: { host: 'smtp.contoh.test', port: 587, security: 'starttls', username: 'localpart' },
    });
  });

  it('DOCTYPE/ENTITY ditolak utuh; port/keamanan tak didukung diabaikan', () => {
    expect(parseAutoconfigXml(`<!DOCTYPE x [<!ENTITY a "b">]>${xml}`, 'contoh.test')).toBeNull();
    const plain = xml.replace(
      '<socketType>SSL</socketType><username>',
      '<socketType>plain</socketType><username>',
    );
    expect(parseAutoconfigXml(plain, 'contoh.test')?.imap).toBeNull();
    expect(parseAutoconfigXml('<html>bukan</html>', 'contoh.test')).toBeNull();
  });

  it('host jahat (URL/IP literal bertitik dua) ditolak', () => {
    const evil = xml.replace('imap.%EMAILDOMAIN%', 'http://169.254.169.254/');
    expect(parseAutoconfigXml(evil, 'contoh.test')?.imap).toBeNull();
  });

  it('cuplikan: base64 & quoted-printable didekode, kutipan dibuang', () => {
    expect(
      decodeTextPreview({
        raw: Buffer.from(Buffer.from('Halo dunia\r\n> kutipan').toString('base64')),
        encoding: 'base64',
        charset: 'utf-8',
        html: false,
      }).trim(),
    ).toBe('Halo dunia');
    expect(
      decodeTextPreview({
        raw: Buffer.from('Caf=C3=A9 buka'),
        encoding: 'quoted-printable',
        charset: 'utf-8',
        html: false,
      }),
    ).toBe('Café buka');
  });
});

describe('header email', () => {
  it('verifikasi hanya dari Authentication-Results teratas server tepercaya', async () => {
    const block = Buffer.from(
      [
        'Authentication-Results: mail.contoh.test; spf=pass smtp.mailfrom=bank.test; dkim=pass header.d=bank.test; dmarc=pass',
        'Authentication-Results: palsu.example; dmarc=fail',
        'From: "Bank‮ Resmi" <Info@Bank.Test>',
        'To: cs@contoh.test, b@luar.test',
        'Delivered-To: billing@contoh.test',
        'Subject: Tagihan\u0007 bulan ini',
        '',
      ].join('\r\n'),
    );
    const header = await parseMailHeaderBlock(block, {
      trustedAuthServIds: ['mail.contoh.test'],
      identities: ['cs@contoh.test'],
    });
    expect(header.senderVerification).toBe('pass');
    expect(header.authDetails).toEqual({
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      authServId: 'mail.contoh.test',
    });
    expect(header.from?.address).toBe('info@bank.test');
    expect(header.from?.name).not.toContain('‮');
    expect(header.subject).not.toContain('\u0007');
    // Delivered-To cocok DOMAIN akun → alias.
    expect(header.deliveredTo).toBe('billing@contoh.test');
  });

  it('Delivered-To di luar domain akun tidak dipercaya', () => {
    expect(
      mailDeliveredTo({
        envelope: ['korban@lain.test'],
        to: [{ address: 'cs@contoh.test', name: null }],
        cc: [],
        identities: ['cs@contoh.test'],
      }),
    ).toBe('cs@contoh.test');
  });
});

describe('kode galat', () => {
  it('SMTP Microsoft 365 / sandi aplikasi dikenali dari petunjuk', () => {
    expect(
      mailOutgoingCodeOf({
        ok: false,
        code: 'auth_failed',
        diagnostic: { stage: 'smtp', hint: 'm365_auth_disabled' },
      }),
    ).toBe('smtp_auth_disabled_m365');
    expect(
      mailOutgoingCodeOf({ ok: false, code: 'host_blocked', diagnostic: { stage: 'dns' } }),
    ).toBe('smtp_host_blocked');
    expect(mailOutgoingCodeOf({ ok: true })).toBe('ok');
  });

  it('IMAP: teks balasan dipindai (sandi aplikasi, IMAP mati, terlalu banyak sambungan)', () => {
    const imapError = (responseText: string) =>
      Object.assign(new Error('x'), { authenticationFailed: true, responseText });
    expect(
      classifyMailImapError(imapError('[ALERT] Application-specific password required')).code,
    ).toBe('imap_app_password_required');
    expect(classifyMailImapError(imapError('Your account is not enabled for IMAP use.')).code).toBe(
      'imap_not_enabled',
    );
    expect(
      classifyMailImapError(imapError('Maximum number of connections from user+IP exceeded')).code,
    ).toBe('imap_too_many_connections');
    expect(classifyMailImapError(imapError('Login gagal')).code).toBe('imap_auth_failed');
  });
});

describe('adaptor IMAP terhadap server tiruan', () => {
  let server: FakeMailImapServer;
  let policy: ImapPolicy;
  const config = () => ({
    host: 'imap.contoh.test',
    port: server.port,
    security: 'ssl' as const,
    username: 'cs@contoh.test',
    password: new Secret('rahasia-imap'),
  });

  beforeAll(async () => {
    server = await startFakeMailImap();
    policy = {
      allowedPorts: [server.port],
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      testCa: TEST_IMAP_CERT,
      strict: { privateCidrs: [], allowLoopback: true },
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
    };
    server.add('INBOX', email({ from: 'Budi <budi@pelanggan.test>', subject: 'Internet mati' }), {
      internalDate: new Date(Date.now() - DAY),
    });
    server.add('INBOX', email({ from: 'Lama <lama@pelanggan.test>', subject: 'Lama sekali' }), {
      internalDate: new Date(Date.now() - 200 * DAY),
      flags: ['\\Seen'],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('tes Masuk: folder, peran khusus, IDLE, perkiraan sinkron awal sesuai jendela', async () => {
    const result = await testMailIncoming(config(), policy, {
      syncWindowDays: 90,
      roleOf: (folder) => mailFolderRoleOf(folder).role,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.details.folderCount).toBe(5);
    expect(result.details.inboxTotal).toBe(2);
    expect(result.details.specialFolders.sort()).toEqual(['drafts', 'junk', 'sent', 'trash']);
    expect(result.details.idle).toBe(true);
    expect(result.details.estimatedInitialSync).toBe(1);
    // Password tidak pernah tercatat di daftar perintah.
    expect(server.commands.join('\n')).not.toContain('rahasia-imap');
  });

  it('password salah → imap_auth_failed; host privat tanpa allowlist → imap_host_blocked', async () => {
    const wrong = await testMailIncoming({ ...config(), password: new Secret('salah') }, policy, {
      syncWindowDays: 90,
      roleOf: () => null,
    });
    expect(wrong).toMatchObject({ ok: false, code: 'imap_auth_failed' });
    const blocked = await testMailIncoming(
      config(),
      { ...policy, strict: { privateCidrs: [] } },
      {
        syncWindowDays: 90,
        roleOf: () => null,
      },
    );
    expect(blocked).toMatchObject({ ok: false, code: 'imap_host_blocked' });
  });

  it('header, bendera, cuplikan, dan IDLE (EXISTS)', async () => {
    const session = await openMailImapSession(config(), policy);
    try {
      const status = await session.status('INBOX');
      expect(status).toMatchObject({ messages: 2, unseen: 1 });
      const selected = await session.select('INBOX');
      expect(selected.exists).toBe(2);
      const uids = await session.searchUids(null);
      const messages = await session.fetchHeaders(uids);
      const first = messages.find((message) => message.uid === 1);
      expect(first?.headers?.toString()).toContain('Subject: Internet mati');
      expect(
        decodeTextPreview(
          first?.textPreview ?? {
            raw: Buffer.alloc(0),
            encoding: null,
            charset: null,
            html: false,
          },
        ),
      ).toContain('internet kantor mati');
      expect((await session.fetchFlags([2])).at(0)?.flags).toContain('\\Seen');

      const abort = new AbortController();
      const changes: string[] = [];
      const idle = session.idle({
        maxMs: 5_000,
        signal: abort.signal,
        onChange: (change) => {
          changes.push(change);
          abort.abort();
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      server.add('INBOX', email({ from: 'Baru <baru@pelanggan.test>', subject: 'Baru' }));
      await idle;
      expect(changes).toContain('exists');
    } finally {
      await session.close();
    }
  });
});
