import type { MailMessageDetail, MailMessageListResponse } from '@balesin/shared';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { MAIL_IDS, fakeMailDetail, fakeMailSummary } from '../../test/fake-mail';
import { applyMailEvent } from './mail-events';
import {
  actionFlash,
  addressLabel,
  addressName,
  aliasChip,
  attachmentKind,
  blockedAttachmentReason,
  dayGroup,
  groupMessages,
  isUnifiedView,
  isViewUrl,
  listParams,
  readerActions,
} from './mail-list';
import { mailKeys, patchMessageFlags, removeListedMessages } from './mail-queries';
import { parseMailSearch } from './mail-search';
import { onMailSignal, type MailSignal } from './mail-signals';

const NOW = new Date('2026-11-23T10:00:00+07:00');

describe('parameter daftar dari ?f=', () => {
  it('tampilan gabungan & folder', () => {
    expect(listParams(undefined)).toEqual({ view: 'inboxes' });
    expect(listParams('semua')).toEqual({ view: 'inboxes' });
    expect(listParams('belum-dibaca')).toEqual({ view: 'unread' });
    expect(listParams('berbintang')).toEqual({ view: 'starred' });
    expect(listParams(MAIL_IDS.csInbox)).toEqual({ view: 'folder', folderId: MAIL_IDS.csInbox });
    expect(isUnifiedView({ view: 'unread' })).toBe(true);
    expect(isUnifiedView({ view: 'folder', folderId: MAIL_IDS.csInbox })).toBe(false);
  });

  it('?m= hanya ID yang sah', () => {
    expect(parseMailSearch({ f: 'semua', m: MAIL_IDS.message1 })).toEqual({
      f: 'semua',
      m: MAIL_IDS.message1,
    });
    expect(parseMailSearch({ m: '../../rahasia' })).toEqual({});
  });
});

describe('pengelompokan hari', () => {
  it('Hari ini · Kemarin · Minggu ini · Lebih lama (hari kalender lokal)', () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    expect(dayGroup(at(0), NOW)).toBe('today');
    expect(dayGroup(at(1), NOW)).toBe('yesterday');
    expect(dayGroup(at(3), NOW)).toBe('week');
    expect(dayGroup(at(9), NOW)).toBe('older');
    expect(dayGroup('bukan tanggal', NOW)).toBe('older');

    const groups = groupMessages(
      [
        fakeMailSummary({ id: 'a', receivedAt: at(0) }),
        fakeMailSummary({ id: 'b', receivedAt: at(0) }),
        fakeMailSummary({ id: 'c', receivedAt: at(9) }),
      ],
      NOW,
    );
    expect(groups.map((group) => [group.group, group.messages.length])).toEqual([
      ['today', 2],
      ['older', 1],
    ]);
  });
});

describe('teks pengirim & alias', () => {
  it('nama atau alamat; "Nama <alamat>" hanya bila berbeda', () => {
    expect(addressName(null)).toBe(t.mail.list.noSender);
    expect(addressName({ address: 'a@b.id', name: '  ' })).toBe('a@b.id');
    expect(addressName({ address: 'a@b.id', name: 'Andi' })).toBe('Andi');
    expect(addressLabel({ address: 'a@b.id', name: 'Andi' })).toBe('Andi <a@b.id>');
    expect(addressLabel({ address: 'a@b.id', name: 'A@B.ID' })).toBe('a@b.id');
  });

  it('chip alias "ke billing@"', () => {
    expect(aliasChip('billing@majujaya.co.id')).toBe(t.mail.list.toChip('billing@'));
    expect(aliasChip(null)).toBeNull();
    expect(aliasChip('@tanpa-lokal')).toBeNull();
  });
});

describe('aksi panel baca per hak & folder', () => {
  it('Baca: hanya bendera', () => {
    expect(readerActions({ level: 'read', folderRole: 'inbox' })).toEqual({
      archive: false,
      trash: false,
      deletePermanently: false,
      spam: false,
      notSpam: false,
      move: false,
    });
  });

  it('Baca & kirim di Kotak masuk; hapus permanen di Sampah/Spam butuh Kelola', () => {
    expect(readerActions({ level: 'send', folderRole: 'inbox' })).toMatchObject({
      archive: true,
      trash: true,
      deletePermanently: false,
      spam: true,
      move: true,
    });
    expect(readerActions({ level: 'send', folderRole: 'trash' })).toMatchObject({
      trash: false,
      deletePermanently: false,
    });
    expect(readerActions({ level: 'manage', folderRole: 'junk' })).toMatchObject({
      trash: false,
      deletePermanently: true,
      spam: false,
      notSpam: true,
    });
    expect(readerActions({ level: 'manage', folderRole: 'archive' }).archive).toBe(false);
  });

  it('pemberitahuan per aksi', () => {
    expect(actionFlash('archive')).toBe(t.mail.reading.flash.archived);
    expect(actionFlash('move', 'Vendor')).toBe(t.mail.reading.flash.moved('Vendor'));
    expect(actionFlash('star')).toBeNull();
  });
});

describe('URL dokumen tampilan', () => {
  it('hanya /api/v1/mail/view/<token>', () => {
    expect(isViewUrl('/api/v1/mail/view/AbC_12-x')).toBe(true);
    expect(isViewUrl('https://jahat.example/api/v1/mail/view/abc')).toBe(false);
    expect(isViewUrl('/api/v1/mail/view/abc/../../auth/me')).toBe(false);
    expect(isViewUrl('/api/v1/mail/view/')).toBe(false);
    expect(isViewUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('jenis lampiran', () => {
  it('dari jenis & akhiran nama', () => {
    expect(attachmentKind('application/pdf', 'a.bin')).toBe('pdf');
    expect(attachmentKind('image/png', 'a.png')).toBe('image');
    expect(attachmentKind('application/octet-stream', 'Rekap.XLSX')).toBe('sheet');
    expect(attachmentKind('application/zip', 'foto.zip')).toBe('archive');
    expect(attachmentKind('application/octet-stream', 'surat.docx')).toBe('doc');
    expect(attachmentKind('application/octet-stream', 'data')).toBe('other');
  });

  it('alasan singkat lampiran diblokir (tampil di kartu, selaras golongan server)', () => {
    expect(blockedAttachmentReason('application/octet-stream', 'pemasang.EXE')).toBe('program');
    expect(blockedAttachmentReason('application/x-msdownload', 'setup')).toBe('program');
    expect(blockedAttachmentReason('text/html', 'faktur.html')).toBe('web');
    expect(blockedAttachmentReason('image/svg+xml', 'logo')).toBe('web');
    expect(blockedAttachmentReason('application/octet-stream', 'Rekap.xlsm')).toBe('macro');
    expect(blockedAttachmentReason('application/msword', 'surat.doc')).toBe('legacyOffice');
    // Nama aman tapi tetap diblokir server = isinya (mis. program berganti nama).
    expect(blockedAttachmentReason('application/pdf', 'faktur.pdf')).toBe('content');
    for (const reason of ['program', 'web', 'macro', 'legacyOffice', 'content']) {
      expect(t.mail.reading.attachments.blockedReasons[reason], reason).toBeTruthy();
    }
  });
});

type ListData = InfiniteData<MailMessageListResponse, string | null>;
type DetailData = { message: MailMessageDetail };

function seeded() {
  const queryClient = new QueryClient();
  queryClient.setQueryData<ListData>(mailKeys.messages({ view: 'inboxes' }), {
    pages: [
      {
        messages: [fakeMailSummary(), fakeMailSummary({ id: MAIL_IDS.message2, isRead: true })],
        nextCursor: null,
        olderOnServer: false,
      },
    ],
    pageParams: [null],
  });
  queryClient.setQueryData<DetailData>(mailKeys.message(MAIL_IDS.message1), {
    message: fakeMailDetail(),
  });
  return queryClient;
}

function listedIds(queryClient: QueryClient) {
  return queryClient
    .getQueryData<ListData>(mailKeys.messages({ view: 'inboxes' }))
    ?.pages[0]?.messages.map((message) => message.id);
}

describe('cache daftar & detail', () => {
  it('tambal bendera di daftar dan detail', () => {
    const queryClient = seeded();
    patchMessageFlags(queryClient, [MAIL_IDS.message1], { isRead: true, isStarred: true });
    const list = queryClient.getQueryData<ListData>(mailKeys.messages({ view: 'inboxes' }));
    expect(list?.pages[0]?.messages[0]).toMatchObject({ isRead: true, isStarred: true });
    expect(
      queryClient.getQueryData<DetailData>(mailKeys.message(MAIL_IDS.message1))?.message.isStarred,
    ).toBe(true);
  });

  it('email dipindah/dihapus hilang dari semua daftar', () => {
    const queryClient = seeded();
    removeListedMessages(queryClient, [MAIL_IDS.message1]);
    expect(listedIds(queryClient)).toEqual([MAIL_IDS.message2]);
  });

  it('event WS: dihapus → keluar dari daftar; lampiran siap → tersimpan + sinyal; aksi gagal → sinyal', () => {
    const queryClient = seeded();
    const signals: MailSignal[] = [];
    const stop = onMailSignal((signal) => signals.push(signal));
    applyMailEvent(queryClient, {
      type: 'mail.message.deleted',
      accountId: MAIL_IDS.cs,
      folderId: MAIL_IDS.csInbox,
      messageId: MAIL_IDS.message2,
    });
    expect(listedIds(queryClient)).toEqual([MAIL_IDS.message1]);

    applyMailEvent(queryClient, {
      type: 'mail.attachment.ready',
      accountId: MAIL_IDS.cs,
      attachmentId: MAIL_IDS.attachmentZip,
    });
    const detail = queryClient.getQueryData<DetailData>(mailKeys.message(MAIL_IDS.message1));
    expect(
      detail?.message.attachments.find((item) => item.id === MAIL_IDS.attachmentZip)?.cached,
    ).toBe(true);

    applyMailEvent(queryClient, {
      type: 'mail.action.failed',
      accountId: MAIL_IDS.cs,
      messageIds: [MAIL_IDS.message1],
      action: 'archive',
      code: 'server_rejected',
    });
    stop();
    expect(signals).toEqual([
      { type: 'attachment.ready', attachmentId: MAIL_IDS.attachmentZip },
      { type: 'action.failed', messageIds: [MAIL_IDS.message1] },
    ]);
  });
});
