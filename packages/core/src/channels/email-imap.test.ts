import { afterEach, describe, expect, it } from 'vitest';

import { Secret } from '../secret';
import { pollImapMailbox, testImapConnection, type ImapPolicy } from './email-imap';
import { startFakeImap, testEmail, type FakeImapServer } from './testing/fake-imap';
import { TEST_IMAP_CERT } from './testing/test-cert';

const lookup = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
let server: FakeImapServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function policy(port: number, extra: Partial<ImapPolicy> = {}): ImapPolicy {
  return {
    allowedPorts: [port],
    lookup,
    testCa: TEST_IMAP_CERT,
    timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
    ...extra,
  };
}

const config = (port: number, overrides: Record<string, unknown> = {}) => ({
  host: 'localhost',
  port,
  security: 'ssl' as const,
  username: 'cs@contoh.test',
  password: new Secret('rahasia-imap'),
  folder: 'INBOX',
  ...overrides,
});

describe('testImapConnection', () => {
  it('berhasil: TLS + login + folder', async () => {
    server = await startFakeImap();
    expect(await testImapConnection(config(server.port), policy(server.port))).toEqual({
      ok: true,
    });
    // Password tidak pernah tercatat di daftar perintah tiruan (disamarkan) — dan folder dibuka read-only.
    expect(server.commands).toContain('LOGIN ***');
    expect(server.commands.some((command) => command.startsWith('EXAMINE'))).toBe(true);
  });

  it.each([
    ['password salah', { password: new Secret('salah') }, 'imap_auth_failed'],
    ['folder tidak ada', { folder: 'Arsip' }, 'imap_folder_not_found'],
  ])('%s → %s', async (_label, overrides, code) => {
    server = await startFakeImap();
    expect(
      await testImapConnection(config(server.port, overrides), policy(server.port)),
    ).toMatchObject({
      ok: false,
      code,
    });
  });

  it('sertifikat tidak dipercaya (tanpa CA tes) → imap_certificate_invalid', async () => {
    server = await startFakeImap();
    const result = await testImapConnection(config(server.port), {
      ...policy(server.port),
      testCa: undefined,
    });
    expect(result).toMatchObject({ ok: false, code: 'imap_certificate_invalid' });
  });

  it('server tanpa TLS ditolak (STARTTLS wajib; tidak pernah login teks polos)', async () => {
    server = await startFakeImap({ plain: true });
    const result = await testImapConnection(
      config(server.port, { security: 'starttls' }),
      policy(server.port),
    );
    expect(result).toMatchObject({ ok: false, code: 'imap_tls_failed' });
    expect(server.commands).not.toContain('LOGIN ***');
  });

  it('port di luar daftar izin & host link-local diblokir sebelum menyambung', async () => {
    server = await startFakeImap();
    expect(
      await testImapConnection(config(server.port), {
        ...policy(server.port),
        allowedPorts: [993],
      }),
    ).toMatchObject({ ok: false, code: 'imap_port_not_allowed' });
    expect(
      await testImapConnection(
        config(server.port, { host: '169.254.169.254' }),
        policy(server.port),
      ),
    ).toMatchObject({ ok: false, code: 'imap_host_blocked' });
    expect(server.commands).toEqual([]);
  });
});

describe('pollImapMailbox', () => {
  it('putaran pertama hanya mencatat posisi; berikutnya mengambil email baru + tandai dibaca', async () => {
    server = await startFakeImap();
    server.add(testEmail({ from: 'lama@pelanggan.test' }));
    const seen: number[] = [];
    const options = {
      maxMessages: 10,
      markAsRead: true,
      onMessage: ({ uid, raw }: { uid: number; raw: Buffer | null }) => {
        expect(raw?.toString('utf8')).toContain('From:');
        seen.push(uid);
        return Promise.resolve();
      },
    };
    const first = await pollImapMailbox(
      config(server.port),
      policy(server.port),
      { uidValidity: null, lastUid: 0 },
      options,
    );
    expect(first).toEqual({ position: { uidValidity: 1, lastUid: 1 }, processed: 0, more: false });

    server.add(testEmail({ from: 'budi@pelanggan.test' }));
    server.add(testEmail({ from: 'sari@pelanggan.test' }));
    const second = await pollImapMailbox(
      config(server.port),
      policy(server.port),
      first.position,
      options,
    );
    expect(second).toEqual({ position: { uidValidity: 1, lastUid: 3 }, processed: 2, more: false });
    expect(seen).toEqual([2, 3]);
    expect(server.messages.map((message) => message.seen)).toEqual([false, true, true]);

    // Tidak ada yang baru → tidak ada yang diproses (email terakhir tidak diulang oleh rentang `n:*`).
    const third = await pollImapMailbox(
      config(server.port),
      policy(server.port),
      second.position,
      options,
    );
    expect(third.processed).toBe(0);
  });

  it('batas per putaran → `more`; UIDVALIDITY berubah → mulai lagi dari yang terbaru', async () => {
    server = await startFakeImap();
    for (let index = 0; index < 3; index += 1)
      server.add(testEmail({ from: `p${String(index)}@x.test` }));
    const options = { maxMessages: 2, markAsRead: false, onMessage: () => Promise.resolve() };
    const result = await pollImapMailbox(
      config(server.port),
      policy(server.port),
      { uidValidity: 1, lastUid: 0 },
      options,
    );
    expect(result).toMatchObject({ position: { lastUid: 2 }, processed: 2, more: true });
    expect(server.messages.every((message) => !message.seen)).toBe(true);

    server.setUidValidity(9);
    const reset = await pollImapMailbox(
      config(server.port),
      policy(server.port),
      result.position,
      options,
    );
    expect(reset).toEqual({ position: { uidValidity: 9, lastUid: 3 }, processed: 0, more: false });
  });
});
