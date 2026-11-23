import {
  type MailAccount,
  type MailAccountListResponse,
  type MailFolder,
  type MailSidebarResponse,
  type TeamUser,
} from '@balesin/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { accessLoosens, directChanges, grantableUsers, teamAccessLoosens } from './mail-access';
import { applyMailEvent, isMailEvent } from './mail-events';
import {
  emailDomain,
  formatBytes,
  needsAttention,
  parseWindow,
  relativeTime,
  syncErrorMessage,
  visibleFolders,
  windowValue,
} from './mail-format';
import { mailKeys } from './mail-queries';
import { parseMailAccountSearch, parseMailAccountsSearch, parseMailSearch } from './mail-search';
import { failedTitle, onlyConnectionFailures, testRows } from './test-rows';
import {
  createBody,
  displayNameFromAddress,
  initialServerValues,
  portForSecurity,
  resultFromSaveFailure,
  serverBody,
  stepOfField,
  testPassed,
  testSignature,
  unsupportedSuggestion,
  usableSuggestion,
  type GrantDraft,
} from './wizard-state';

const ACCOUNT_ID = '7a1b2c3d-0000-4000-8000-000000000001';
const FOLDER_ID = '7a1b2c3d-0000-4000-8000-0000000000f1';

function folder(overrides: Partial<MailFolder>): MailFolder {
  return {
    id: FOLDER_ID,
    accountId: ACCOUNT_ID,
    path: 'INBOX',
    name: 'Kotak masuk',
    role: 'inbox',
    parentId: null,
    depth: 0,
    selectable: true,
    unreadCount: 0,
    totalCount: 0,
    syncEnabled: true,
    hasOlderOnServer: false,
    ...overrides,
  };
}

describe('wizard: isian awal & deteksi', () => {
  it('nama akun dari alamat: pendek jadi huruf besar, panjang huruf depan besar', () => {
    expect(displayNameFromAddress('cs@majujaya.co.id')).toBe('CS');
    expect(displayNameFromAddress('billing@majujaya.co.id')).toBe('Billing');
    expect(displayNameFromAddress('@x')).toBe('');
  });

  it('preset cPanel: host mail.<domain>, 993/465 SSL/TLS, username alamat lengkap', () => {
    const values = initialServerValues('CS@MajuJaya.co.id', 'cpanel', null, 'PT Maju Jaya');
    expect(values).toMatchObject({
      displayName: 'CS',
      fromName: 'PT Maju Jaya',
      username: 'cs@majujaya.co.id',
      imapHost: 'mail.majujaya.co.id',
      imapPort: '993',
      imapSecurity: 'ssl',
      smtpHost: 'mail.majujaya.co.id',
      smtpPort: '465',
      smtpSecurity: 'ssl',
      sameCredentials: true,
    });
  });

  it('IMAP lain tanpa saran: host kosong, SMTP 587 STARTTLS', () => {
    const values = initialServerValues('a@b.id', 'imap', null, '');
    expect(values.imapHost).toBe('');
    expect(values.smtpPort).toBe('587');
    expect(values.smtpSecurity).toBe('starttls');
  });

  it('saran deteksi menang atas preset; username bagian lokal bila diminta', () => {
    const values = initialServerValues(
      'noc@contoh.id',
      'imap',
      {
        source: 'autoconfig',
        provider: 'imap',
        imap: { host: 'imap.contoh.id', port: 143, security: 'starttls' },
        smtp: { host: 'smtp.contoh.id', port: 587, security: 'starttls' },
        username: 'localpart',
        description: 'Dari autoconfig',
      },
      'Kantor',
    );
    expect(values).toMatchObject({
      username: 'noc',
      imapHost: 'imap.contoh.id',
      imapPort: '143',
      smtpHost: 'smtp.contoh.id',
    });
  });

  it('saran yang bisa dipakai vs penyedia yang belum didukung (Gmail/Microsoft)', () => {
    const gmail = {
      source: 'known_provider' as const,
      provider: 'google' as const,
      imap: null,
      smtp: null,
      username: 'address' as const,
      description: 'Pakai sandi aplikasi',
    };
    const cpanel = {
      source: 'guess' as const,
      provider: 'cpanel' as const,
      imap: { host: 'mail.x.id', port: 993, security: 'ssl' as const },
      smtp: { host: 'mail.x.id', port: 465, security: 'ssl' as const },
      username: 'address' as const,
      description: '',
    };
    expect(usableSuggestion([gmail, cpanel])).toBe(cpanel);
    expect(usableSuggestion([gmail])).toBeNull();
    expect(unsupportedSuggestion([gmail])).toBe(gmail);
  });

  it('ganti keamanan → port bawaan ikut berganti, port ketikan sendiri tidak ditimpa', () => {
    expect(portForSecurity('imap', '993', 'ssl', 'starttls')).toBe('143');
    expect(portForSecurity('smtp', '465', 'ssl', 'starttls')).toBe('587');
    expect(portForSecurity('smtp', '2525', 'ssl', 'starttls')).toBe('2525');
    expect(portForSecurity('imap', '', 'ssl', 'starttls')).toBe('143');
  });
});

describe('wizard: body permintaan', () => {
  const values = initialServerValues('cs@majujaya.co.id', 'cpanel', null, 'PT Maju Jaya');

  it('server: password hanya bila diisi; SMTP sama = tanpa username/password', () => {
    expect(serverBody(values, {})).toEqual({
      imap: {
        host: 'mail.majujaya.co.id',
        port: 993,
        security: 'ssl',
        username: 'cs@majujaya.co.id',
      },
      smtp: { host: 'mail.majujaya.co.id', port: 465, security: 'ssl', sameCredentials: true },
    });
    const separate = serverBody(
      { ...values, sameCredentials: false, smtpUsername: 'relay' },
      { imap: 'a', smtp: 'b' },
    );
    expect(separate.imap.password).toBe('a');
    expect(separate.smtp).toMatchObject({
      sameCredentials: false,
      username: 'relay',
      password: 'b',
    });
  });

  it('port bukan angka → NaN (ditolak skema, bukan dikirim)', () => {
    expect(serverBody({ ...values, imapPort: '99x' }, {}).imap.port).toBeNaN();
  });

  it('sidik tes berubah bila server berubah, tidak bila nama tampilan berubah', () => {
    const base = testSignature('cs@majujaya.co.id', values);
    expect(testSignature('CS@majujaya.co.id ', values)).toBe(base);
    expect(testSignature('cs@majujaya.co.id', { ...values, displayName: 'Lain' })).toBe(base);
    expect(testSignature('cs@majujaya.co.id', { ...values, imapPort: '143' })).not.toBe(base);
  });

  it('buat akun: akses hanya untuk akun bersama', () => {
    const grants: GrantDraft[] = [
      { principalType: 'department', id: 'd1', name: 'CS', meta: '3 orang', level: 'send' },
      { principalType: 'user', id: 'u1', name: 'Agus', meta: 'CS', level: 'manage' },
    ];
    const draft = {
      kind: 'shared' as const,
      provider: 'cpanel' as const,
      emailAddress: 'cs@majujaya.co.id',
      values,
      color: 'tagTeal' as const,
      syncWindowDays: 90 as const,
      grants,
    };
    const body = createBody(draft, { imap: 'rahasia' });
    expect(body.imap.password).toBe('rahasia');
    expect(body.access).toEqual([
      { principalType: 'department', departmentId: 'd1', level: 'send' },
      { principalType: 'user', userId: 'u1', level: 'manage' },
    ]);
    expect(createBody({ ...draft, kind: 'personal' }, { imap: 'x' }).access).toEqual([]);
  });

  it('galat dikembalikan ke langkah tempat isiannya', () => {
    expect(stepOfField('emailAddress')).toBe(1);
    expect(stepOfField('imap.host')).toBe(2);
    expect(stepOfField('smtp.password')).toBe(2);
    expect(stepOfField('fromName')).toBe(2);
    expect(stepOfField('access.0.userId')).toBe(4);
  });

  it('tes gagal saat menyimpan (502) → sisi yang gagal ditimpa dengan kode & pesan', () => {
    const previous = {
      testedAt: '2026-11-23T01:00:00.000Z',
      incoming: { ok: true, code: 'ok' as const, message: 'ok', durationMs: 900, details: null },
      outgoing: { ok: true, code: 'ok' as const, message: 'ok', durationMs: 800 },
    };
    const result = resultFromSaveFailure(previous, [
      {
        field: 'smtp',
        reason: 'smtp_auth_failed',
        message: 'Username atau password SMTP ditolak.',
      },
    ]);
    expect(result.incoming).toBe(previous.incoming);
    expect(result.outgoing).toMatchObject({ ok: false, code: 'smtp_auth_failed' });
    expect(testPassed(result)).toBe(false);
    expect(testPassed(previous)).toBe(true);
    // Kode tak dikenal → `unknown` dengan pesan server.
    expect(
      resultFromSaveFailure(null, [{ field: 'imap', reason: 'aneh', message: 'X' }]).incoming,
    ).toMatchObject({ code: 'unknown', message: 'X' });
  });
});

describe('hasil tes koneksi', () => {
  it('Masuk berhasil: folder, folder khusus, IDLE, kapasitas; Keluar gagal dengan sebab', () => {
    const rows = testRows(
      {
        testedAt: '2026-11-23T01:00:00.000Z',
        incoming: {
          ok: true,
          code: 'ok',
          message: 'Masuk ke IMAP berhasil.',
          durationMs: 1100,
          details: {
            folderCount: 14,
            inboxTotal: 3482,
            specialFolders: ['inbox', 'sent', 'drafts', 'trash'],
            idle: true,
            quota: { usedBytes: 812 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 },
            estimatedInitialSync: 640,
          },
        },
        outgoing: {
          ok: false,
          code: 'smtp_auth_failed',
          message: 'Username atau password SMTP ditolak server.',
          durationMs: 700,
        },
      },
      'cs@majujaya.co.id',
    );
    expect(rows.map((row) => [row.key, row.tone])).toEqual([
      ['incoming', 'ok'],
      ['special', 'ok'],
      ['outgoing', 'fail'],
      ['idle', 'info'],
      ['quota', 'info'],
    ]);
    expect(rows[0]?.body).toBe(t.mail.wizard.incomingDetail(14, 3482));
    expect(rows[1]?.body).toBe(t.mail.wizard.specialBody('Terkirim, Draf, dan Sampah'));
    expect(rows[2]?.body).toBe('Username atau password SMTP ditolak server.');
    expect(rows[4]?.body).toBe(t.mail.wizard.quota('812 MB', '2 GB'));
  });

  it('Masuk gagal: hanya baris galat (tanpa rincian folder)', () => {
    const rows = testRows(
      {
        testedAt: '2026-11-23T01:00:00.000Z',
        incoming: {
          ok: false,
          code: 'imap_auth_failed',
          message: 'Username atau password akun email ditolak server.',
          durationMs: 0,
          details: null,
        },
        outgoing: null,
      },
      'cs@majujaya.co.id',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tone: 'fail', title: t.mail.wizard.incomingFailed });
    expect(rows[0]?.durationMs).toBeUndefined();
  });

  it('judul galat per jenis kode: koneksi ≠ proses masuk (review 9A P9)', () => {
    const w = t.mail.wizard;
    expect(failedTitle('outgoing', 'smtp_connection_timeout')).toBe(w.outgoingUnreachable);
    expect(failedTitle('outgoing', 'smtp_tls_failed')).toBe(w.outgoingUnreachable);
    expect(failedTitle('outgoing', 'smtp_host_not_found')).toBe(w.outgoingUnreachable);
    expect(failedTitle('outgoing', 'smtp_auth_failed')).toBe(w.outgoingFailed);
    expect(failedTitle('outgoing', 'smtp_app_password_required')).toBe(w.outgoingFailed);
    expect(failedTitle('incoming', 'imap_certificate_invalid')).toBe(w.incomingUnreachable);
    expect(failedTitle('incoming', 'imap_auth_failed')).toBe(w.incomingFailed);

    const timeout = {
      testedAt: '2026-11-23T01:00:00.000Z',
      incoming: null,
      outgoing: {
        ok: false,
        code: 'smtp_connection_timeout',
        message: 'Server SMTP tidak merespons.',
        durationMs: 8000,
      },
    } as const;
    expect(onlyConnectionFailures(timeout)).toBe(true);
    expect(testRows(timeout, 'cs@majujaya.co.id')[0]?.hint).toBeTruthy();
    expect(
      onlyConnectionFailures({
        ...timeout,
        outgoing: { ...timeout.outgoing, code: 'smtp_auth_failed' },
      }),
    ).toBe(false);
  });
});

describe('akses', () => {
  const saved: GrantDraft[] = [
    { principalType: 'user', id: 'u1', name: 'Agus', meta: 'CS', level: 'send' },
  ];

  it('menambah penerima atau menaikkan hak = melonggarkan; menurunkan/menghapus tidak', () => {
    expect(accessLoosens(saved, [...saved])).toBe(false);
    expect(accessLoosens(saved, [{ ...saved[0]!, level: 'read' }])).toBe(false);
    expect(accessLoosens(saved, [])).toBe(false);
    expect(accessLoosens(saved, [{ ...saved[0]!, level: 'manage' }])).toBe(true);
    expect(
      accessLoosens(saved, [
        ...saved,
        { principalType: 'department', id: 'd1', name: 'CS', meta: '', level: 'read' },
      ]),
    ).toBe(true);
  });

  it('Tim → Akses email: hanya grant yang berubah dikirim; memberi/menaikkan = konfirmasi', () => {
    const initial = { a1: 'read' as const, a2: null };
    expect(directChanges(initial, { a1: 'read', a2: null })).toEqual([]);
    expect(directChanges(initial, { a1: null, a2: null })).toEqual([
      { accountId: 'a1', level: null },
    ]);
    expect(teamAccessLoosens(initial, { a1: null, a2: null })).toBe(false);
    expect(teamAccessLoosens(initial, { a1: 'send', a2: null })).toBe(true);
    expect(teamAccessLoosens(initial, { a1: 'read', a2: 'read' })).toBe(true);
  });

  it('Owner/Admin dan pengguna nonaktif tidak ditawarkan', () => {
    const user = (id: string, role: TeamUser['role'], status: TeamUser['status']) =>
      ({ id, name: id, role, status }) as TeamUser;
    expect(
      grantableUsers([
        user('Owner', 'owner', 'active'),
        user('Admin', 'admin', 'active'),
        user('Citra', 'supervisor', 'active'),
        user('Nonaktif', 'cs', 'disabled'),
        user('Agus', 'cs', 'locked'),
      ]).map((item) => item.id),
    ).toEqual(['Agus', 'Citra']);
  });
});

describe('format & alamat', () => {
  it('folder: peran dulu (urutan kontrak), lalu folder sendiri urut abjad; \\All disembunyikan', () => {
    const folders = [
      folder({ id: 'f-vendor', role: null, path: 'INBOX.Vendor', name: 'Vendor' }),
      folder({ id: 'f-trash', role: 'trash', path: 'Trash' }),
      folder({ id: 'f-all', role: 'all', path: '[Gmail]/All Mail' }),
      folder({ id: 'f-agen', role: null, path: 'INBOX.Agen', name: 'Agen' }),
      folder({ id: 'f-inbox', role: 'inbox' }),
      folder({ id: 'f-sent', role: 'sent', path: 'Sent' }),
      folder({ id: 'f-noselect', role: null, path: 'Arsip lama', selectable: false }),
    ];
    expect(visibleFolders(folders).map((item) => item.id)).toEqual([
      'f-inbox',
      'f-sent',
      'f-trash',
      'f-agen',
      'f-vendor',
    ]);
  });

  it('waktu relatif', () => {
    const now = Date.parse('2026-11-23T10:00:00.000Z');
    expect(relativeTime('2026-11-23T09:59:40.000Z', now)).toBe(t.mail.time.justNow);
    expect(relativeTime('2026-11-23T09:57:00.000Z', now)).toBe(t.mail.time.minutes(3));
    expect(relativeTime('2026-11-23T07:00:00.000Z', now)).toBe(t.mail.time.hours(3));
  });

  it('status yang perlu perhatian', () => {
    expect(needsAttention('auth_failed')).toBe(true);
    expect(needsAttention('error')).toBe(true);
    expect(needsAttention('ready')).toBe(false);
    expect(needsAttention('paused')).toBe(false);
  });

  it('pesan galat sinkron: pesan server, atau pesan kode tes tetap', () => {
    expect(syncErrorMessage('imap_auth_failed', 'Pesan server')).toBe('Pesan server');
    expect(syncErrorMessage('imap_auth_failed', null)).toMatch(/ditolak server/);
    expect(syncErrorMessage('kode_baru', null)).toBeNull();
    expect(syncErrorMessage(null, null)).toBeNull();
  });

  it('jendela sinkron ↔ isian', () => {
    expect(windowValue(null)).toBe('all');
    expect(parseWindow('all')).toBeNull();
    expect(parseWindow('365')).toBe(365);
    expect(parseWindow('lain')).toBe(90);
  });

  it('ukuran & domain', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(emailDomain('CS@Maju.Co.Id')).toBe('maju.co.id');
  });

  it('alamat: saringan & wizard', () => {
    expect(parseMailSearch({ f: 'belum-dibaca' })).toEqual({ f: 'belum-dibaca' });
    expect(parseMailSearch({ f: FOLDER_ID })).toEqual({ f: FOLDER_ID });
    expect(parseMailSearch({ f: '<script>' })).toEqual({});
    expect(parseMailAccountsSearch({ tambah: 'cpanel' })).toEqual({ tambah: 'cpanel' });
    expect(parseMailAccountsSearch({ tambah: 'baru' })).toEqual({ tambah: 'baru' });
    // Penyedia yang belum tersedia tidak bisa dipilih lewat alamat.
    expect(parseMailAccountsSearch({ tambah: 'google' })).toEqual({});
    expect(parseMailAccountSearch({ ubah: 'server' })).toEqual({ ubah: 'server' });
    expect(parseMailAccountSearch({ ubah: 'hapus' })).toEqual({});
  });
});

describe('event real-time Email', () => {
  function account(overrides: Partial<MailAccount> = {}): MailAccount {
    return {
      id: ACCOUNT_ID,
      kind: 'shared',
      provider: 'cpanel',
      displayName: 'CS',
      emailAddress: 'cs@majujaya.co.id',
      fromName: 'Tim CS',
      color: 'tagBlue',
      avatarUrl: null,
      owner: null,
      myLevel: 'manage',
      redacted: false,
      imap: null,
      smtp: null,
      trustedAuthServIds: null,
      syncWindowDays: 90,
      periodicSyncMinutes: 5,
      sentCopyMode: 'auto',
      warnExternalRecipients: false,
      warnings: [],
      sync: {
        state: 'initial_sync',
        lastSyncedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        nextAttemptAt: null,
        idleActive: false,
        initialProgress: { done: 10, total: 100 },
        lastTest: null,
      },
      stats: { messageCount: 0, unreadCount: 0, quota: null },
      createdAt: '2026-11-23T01:00:00.000Z',
      updatedAt: '2026-11-23T01:00:00.000Z',
      ...overrides,
    };
  }

  it('mail.account.status menambal status sinkron di daftar akun & kolom kiri', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<MailAccountListResponse>(mailKeys.accounts, {
      accounts: [account()],
      canConnectPersonal: true,
      canManageShared: true,
    });
    queryClient.setQueryData<MailSidebarResponse>(mailKeys.sidebar, {
      unified: { unreadCount: 0 },
      unread: { count: 0 },
      starred: { count: 0 },
      accounts: [
        {
          account: {
            id: ACCOUNT_ID,
            displayName: 'CS',
            emailAddress: 'cs@majujaya.co.id',
            color: 'tagBlue',
            avatarUrl: null,
            myLevel: 'manage',
            sync: { state: 'initial_sync' },
          },
          folders: [folder({ unreadCount: 2, totalCount: 5 })],
        },
      ],
    });
    const event = {
      type: 'mail.account.status' as const,
      accountId: ACCOUNT_ID,
      syncState: 'ready' as const,
      lastSyncedAt: '2026-11-23T02:00:00.000Z',
      errorCode: null,
      initialProgress: null,
    };
    expect(isMailEvent(event)).toBe(true);
    applyMailEvent(queryClient, event);
    const list = queryClient.getQueryData<MailAccountListResponse>(mailKeys.accounts);
    expect(list?.accounts[0]?.sync).toMatchObject({
      state: 'ready',
      lastSyncedAt: '2026-11-23T02:00:00.000Z',
      initialProgress: null,
      // Isian lain dipertahankan.
      idleActive: false,
    });
    const sidebar = queryClient.getQueryData<MailSidebarResponse>(mailKeys.sidebar);
    expect(sidebar?.accounts[0]?.account.sync.state).toBe('ready');

    applyMailEvent(queryClient, {
      type: 'mail.folder.counts',
      accountId: ACCOUNT_ID,
      folderId: FOLDER_ID,
      unreadCount: 7,
      totalCount: 40,
    });
    expect(
      queryClient.getQueryData<MailSidebarResponse>(mailKeys.sidebar)?.accounts[0]?.folders[0],
    ).toMatchObject({ unreadCount: 7, totalCount: 40 });
  });

  it('event Inbox bukan event Email', () => {
    expect(isMailEvent({ type: 'tags.changed' })).toBe(false);
  });
});
