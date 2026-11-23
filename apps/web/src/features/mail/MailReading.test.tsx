import {
  API_ROUTES,
  MAIL_ATTACHMENT_WARN_MESSAGE,
  apiPath,
  type MailMessageDetail,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { json, type FakeHandler, type FakeRequest } from '../../test/fake-api';
import {
  MAIL_IDS,
  fakeMailAccount,
  fakeMailDetail,
  fakeMailSummary,
  fakeSidebar,
} from '../../test/fake-mail';
import { FakeSocket } from '../../test/fake-socket';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const m = t.mail;
const r = m.reading;
const l = m.list;

const cs = fakeMailAccount();
const VIEW_URL = '/api/v1/mail/view/token-tampilan';
const VIEW_URL_IMAGES = '/api/v1/mail/view/token-gambar';

const first = fakeMailSummary();
const second = fakeMailSummary({
  id: MAIL_IDS.message2,
  from: { address: 'billing@vendor.example', name: 'Sistem Billing' },
  subject: 'Settlement harian',
  snippet: 'Ringkasan pembayaran pelanggan.',
  isRead: true,
  isStarred: true,
  hasAttachments: false,
  deliveredTo: 'tagihan@majujaya.co.id',
  deliveredToAlias: true,
  receivedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
});

interface Setup {
  messages?: ReturnType<typeof fakeMailSummary>[];
  detail?: MailMessageDetail;
  routes?: Record<string, FakeHandler>;
}

function setup({ messages = [first, second], detail = fakeMailDetail(), routes = {} }: Setup = {}) {
  return {
    routes: {
      [`GET ${API_ROUTES.mail.accounts}`]: () =>
        json({ accounts: [cs], canConnectPersonal: true, canManageShared: true }),
      [`GET ${API_ROUTES.mail.sidebar}`]: () => json(fakeSidebar([cs])),
      [`GET ${API_ROUTES.mail.messages}`]: () =>
        json({ messages, nextCursor: null, olderOnServer: false }),
      [`GET ${apiPath(API_ROUTES.mail.message, { messageId: detail.id })}`]: () =>
        json({ message: detail }),
      [`POST ${apiPath(API_ROUTES.mail.messageView, { messageId: detail.id })}`]: (
        request: FakeRequest,
      ) => {
        const show = (request.body as { images?: string }).images === 'show';
        return json({
          url: show ? VIEW_URL_IMAGES : VIEW_URL,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          remoteImages: { count: detail.body.remoteImages.count, shown: show },
        });
      },
      [`POST ${API_ROUTES.mail.messageActions}`]: (request: FakeRequest) => {
        const body = request.body as { messageIds: string[] };
        return json({
          results: body.messageIds.map((id) => ({ id, ok: true })),
          applied: body.messageIds.length,
        });
      },
      ...routes,
    },
  };
}

function actions(api: { requests: FakeRequest[] }) {
  return api.requests.filter((request) => request.path === API_ROUTES.mail.messageActions);
}

function list() {
  return within(screen.getByRole('region', { name: l.label }));
}

beforeEach(() => {
  act(() => setMediaQuery(media.desktop, true));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('menu Email — daftar', () => {
  it('Semua kotak masuk: baris per hari, belum dibaca, alias, akun asal; kursor & batas dikirim', async () => {
    const { api } = await renderApp('/email', setup());
    const rows = await screen.findAllByRole('button', { name: /NOC Nusaraya|Sistem Billing/ });
    expect(rows).toHaveLength(2);
    // Kelompok hari.
    expect(list().getByRole('heading', { name: l.groups.today })).toBeVisible();
    expect(list().getByRole('heading', { name: l.groups.week })).toBeVisible();
    // Pembaca layar mendapat status lengkap; tampilan gabungan menyebut akun asal.
    expect(rows[0]).toHaveAccessibleName(expect.stringContaining(`${l.unread}, ${l.attachment}`));
    expect(rows[0]).toHaveAccessibleName(expect.stringContaining(l.accountLabel('CS Maju Jaya')));
    expect(rows[1]).toHaveAccessibleName(
      expect.stringContaining(l.toChipLabel('tagihan@majujaya.co.id')),
    );
    expect(within(rows[1] as HTMLElement).getByText(l.toChip('tagihan@'))).toBeVisible();
    expect(rows[0]).toHaveAttribute('data-unread');
    expect(rows[1]).not.toHaveAttribute('data-unread');
    // Satu tab stop untuk seluruh daftar.
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    expect(rows[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });

    const request = api.requests.find((item) => item.path === API_ROUTES.mail.messages);
    expect(request?.query.get('view')).toBe('inboxes');
    expect(request?.query.get('limit')).toBe('50');
    expect(request?.query.get('cursor')).toBeNull();
  });

  it('folder satu akun: view=folder + folderId; tanpa penanda akun di baris', async () => {
    const { api } = await renderApp(`/email?f=${MAIL_IDS.csVendor}`, setup());
    const rows = await screen.findAllByRole('button', { name: /NOC Nusaraya|Sistem Billing/ });
    expect(rows[0]).not.toHaveAccessibleName(
      expect.stringContaining(l.accountLabel('CS Maju Jaya')),
    );
    const request = api.requests.find((item) => item.path === API_ROUTES.mail.messages);
    expect(request?.query.get('view')).toBe('folder');
    expect(request?.query.get('folderId')).toBe(MAIL_IDS.csVendor);
  });

  it('keadaan kosong per tampilan', async () => {
    await renderApp('/email?f=berbintang', setup({ messages: [] }));
    expect(await screen.findByText(l.empty.starred.title)).toBeVisible();
  });

  it('Semua kotak masuk kosong → "Kotak masuk bersih"', async () => {
    await renderApp('/email', setup({ messages: [] }));
    expect(await screen.findByText(l.empty.inboxes.title)).toBeVisible();
  });

  it('daftar gagal dimuat → pesan + Coba lagi', async () => {
    await renderApp(
      '/email',
      setup({
        routes: {
          [`GET ${API_ROUTES.mail.messages}`]: () =>
            json({ error: { code: 'INTERNAL', message: 'Server sibuk.' } }, { status: 500 }),
        },
      }),
    );
    expect(await screen.findByText(l.loadFailedTitle, {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByRole('button', { name: t.common.retry })).toBeVisible();
  });

  it('event WS email baru → daftar dimuat ulang', async () => {
    const { api } = await renderApp('/email', setup());
    await screen.findAllByRole('button', { name: /NOC Nusaraya/ });
    const before = api.requests.filter((item) => item.path === API_ROUTES.mail.messages).length;
    act(() =>
      FakeSocket.latest()?.receive({
        type: 'mail.message.created',
        accountId: MAIL_IDS.cs,
        folderId: MAIL_IDS.csInbox,
        messageId: MAIL_IDS.message3,
        receivedAt: new Date().toISOString(),
      }),
    );
    await waitFor(
      () =>
        expect(
          api.requests.filter((item) => item.path === API_ROUTES.mail.messages).length,
        ).toBeGreaterThan(before),
      { timeout: 3000 },
    );
  });
});

describe('menu Email — panel baca', () => {
  it('membuka email: tandai dibaca, kepala lengkap, isi di iframe sandbox ber-token, gambar diblokir', async () => {
    const { api, router } = await renderApp('/email', setup());
    fireEvent.click(await screen.findByRole('button', { name: /NOC Nusaraya/ }));

    expect(router.state.location.search).toMatchObject({ m: MAIL_IDS.message1 });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Jadwal pemeliharaan 26 November' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(actions(api)[0]?.body).toEqual({
        messageIds: [MAIL_IDS.message1],
        action: 'mark_read',
      }),
    );
    // Asal email + verifikasi + penerima.
    expect(screen.getByText(r.folderChip('Kotak masuk', 'CS Maju Jaya'))).toBeVisible();
    expect(screen.getByText(r.verified)).toBeVisible();
    expect(screen.getByText(/Tono <tono@majujaya\.co\.id>/)).toBeVisible();
    expect(screen.getByText(r.receivedIn, { exact: false })).toBeVisible();

    const frame = await screen.findByTitle(r.frameTitle('Jadwal pemeliharaan 26 November'));
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', VIEW_URL);
    expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-same-origin/);
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).not.toHaveAttribute('srcdoc');

    // Gambar luar diblokir → minta token baru dengan izin gambar.
    expect(screen.getByText(r.images.blocked)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: r.images.show }));
    await waitFor(() =>
      expect(screen.getByTitle(r.frameTitle('Jadwal pemeliharaan 26 November'))).toHaveAttribute(
        'src',
        VIEW_URL_IMAGES,
      ),
    );
    expect(screen.queryByText(r.images.blocked)).toBeNull();
  });

  it('"Selalu dari pengirim ini" menyimpan pengirim lalu menampilkan gambar', async () => {
    const { api } = await renderApp(
      `/email?m=${MAIL_IDS.message1}`,
      setup({
        routes: {
          [`POST ${API_ROUTES.mail.remoteImageSenders}`]: () =>
            json({
              senders: [{ address: 'noc@nusaraya.example', createdAt: '2026-11-23T01:00:00.000Z' }],
            }),
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: r.images.always }));
    expect(await screen.findByText(r.images.alwaysSaved('noc@nusaraya.example'))).toBeVisible();
    expect(
      api.requests.find((item) => item.path === API_ROUTES.mail.remoteImageSenders)?.body,
    ).toEqual({ address: 'noc@nusaraya.example' });
  });

  it('teks polos dirender sebagai teks (markup tidak dijalankan), tanpa iframe', async () => {
    const detail = fakeMailDetail({
      body: {
        state: 'ready',
        hasHtml: false,
        text: 'Halo <img src=x onerror=alert(1)> tim',
        remoteImages: { count: 0, senderAllowed: false, autoBlocked: false },
      },
    });
    await renderApp(`/email?m=${MAIL_IDS.message1}`, setup({ detail }));
    expect(await screen.findByText('Halo <img src=x onerror=alert(1)> tim')).toBeVisible();
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('isi masih diambil → kerangka + keterangan, lalu event WS memuat isinya', async () => {
    let ready = false;
    const loading = fakeMailDetail({
      body: {
        state: 'loading',
        hasHtml: false,
        text: null,
        remoteImages: { count: 0, senderAllowed: false, autoBlocked: false },
      },
    });
    const done = fakeMailDetail({
      body: {
        state: 'ready',
        hasHtml: false,
        text: 'Isi sudah tiba.',
        remoteImages: { count: 0, senderAllowed: false, autoBlocked: false },
      },
    });
    await renderApp(
      `/email?m=${MAIL_IDS.message1}`,
      setup({
        detail: done,
        routes: {
          [`GET ${apiPath(API_ROUTES.mail.message, { messageId: MAIL_IDS.message1 })}`]: () =>
            json({ message: ready ? done : loading }),
        },
      }),
    );
    expect(await screen.findByText(r.bodyLoading)).toBeVisible();
    ready = true;
    act(() =>
      FakeSocket.latest()?.receive({
        type: 'mail.message.updated',
        accountId: MAIL_IDS.cs,
        messageId: MAIL_IDS.message1,
        fields: ['body'],
      }),
    );
    expect(await screen.findByText('Isi sudah tiba.')).toBeVisible();
  });

  it('gagal verifikasi + peringatan tampil sebagai Notice', async () => {
    const detail = fakeMailDetail(
      {
        verification: {
          result: 'fail',
          label:
            'Email ini gagal pemeriksaan keaslian pengirim. Hati-hati dengan tautan dan lampirannya.',
          spf: 'fail',
          dkim: null,
          dmarc: 'fail',
          authServId: null,
        },
        warningDetails: [
          { type: 'lookalike_sender', message: 'Alamat pengirim mirip domain kita.' },
        ],
        body: {
          state: 'ready',
          hasHtml: true,
          text: null,
          remoteImages: { count: 3, senderAllowed: true, autoBlocked: true },
        },
      },
      { senderVerification: 'fail' },
    );
    await renderApp(`/email?m=${MAIL_IDS.message1}`, setup({ detail }));
    expect(await screen.findByText(r.failedTitle)).toBeVisible();
    expect(screen.getByText(r.failedBadge)).toBeVisible();
    expect(screen.getByText('Alamat pengirim mirip domain kita.')).toBeVisible();
    // Email gagal verifikasi: gambar tidak otomatis, tanpa "Selalu dari pengirim ini".
    expect(await screen.findByText(r.images.autoBlocked)).toBeVisible();
    expect(screen.queryByRole('button', { name: r.images.always })).toBeNull();
  });

  it('Arsipkan: aksi dikirim, email hilang dari daftar, panel ditutup, pemberitahuan tampil', async () => {
    const { api, router } = await renderApp(`/email?m=${MAIL_IDS.message1}`, setup());
    const toolbar = await screen.findByRole('group', { name: r.toolbar });
    fireEvent.click(within(toolbar).getByRole('button', { name: r.archive }));

    expect(await screen.findByText(r.flash.archived)).toBeVisible();
    expect(
      actions(api).some((item) => (item.body as { action: string }).action === 'archive'),
    ).toBe(true);
    expect(router.state.location.search).not.toHaveProperty('m');
    expect(list().queryByRole('button', { name: /NOC Nusaraya/ })).toBeNull();
    expect(screen.getByText(r.title)).toBeVisible();
  });

  it('aksi gagal sebagian → pesan galat server tampil dan bisa ditutup', async () => {
    await renderApp(
      `/email?m=${MAIL_IDS.message1}`,
      setup({
        routes: {
          [`POST ${API_ROUTES.mail.messageActions}`]: (request: FakeRequest) => {
            const body = request.body as { messageIds: string[]; action: string };
            return json({
              results: body.messageIds.map((id) =>
                body.action === 'mark_read'
                  ? { id, ok: true }
                  : {
                      id,
                      ok: false,
                      error: { code: 'FORBIDDEN', message: 'Hakmu di akun ini hanya Baca.' },
                    },
              ),
              applied: 0,
            });
          },
        },
      }),
    );
    const toolbar = await screen.findByRole('group', { name: r.toolbar });
    fireEvent.click(within(toolbar).getByRole('button', { name: r.trash }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hakmu di akun ini hanya Baca.');
    fireEvent.click(within(alert).getByRole('button', { name: t.common.close }));
    await waitFor(() => expect(screen.queryByText('Hakmu di akun ini hanya Baca.')).toBeNull());
  });

  it('bintang & tandai belum dibaca berganti seketika', async () => {
    const { api } = await renderApp(`/email?m=${MAIL_IDS.message1}`, setup());
    const toolbar = await screen.findByRole('group', { name: r.toolbar });
    fireEvent.click(within(toolbar).getByRole('button', { name: r.star }));
    expect(await within(toolbar).findByRole('button', { name: r.unstar })).toBeVisible();
    await waitFor(() =>
      expect(actions(api).map((item) => (item.body as { action: string }).action)).toContain(
        'star',
      ),
    );
    fireEvent.click(await within(toolbar).findByRole('button', { name: r.markUnread }));
    expect(await within(toolbar).findByRole('button', { name: r.markRead })).toBeVisible();
  });

  it('pindah ke folder lewat menu', async () => {
    const { api } = await renderApp(`/email?m=${MAIL_IDS.message1}`, setup());
    const toolbar = await screen.findByRole('group', { name: r.toolbar });
    const trigger = within(toolbar).getByRole('button', { name: r.move });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Vendor' }));
    await waitFor(() =>
      expect(
        actions(api).find((item) => (item.body as { action: string }).action === 'move')?.body,
      ).toEqual({
        messageIds: [MAIL_IDS.message1],
        action: 'move',
        targetFolderId: MAIL_IDS.csVendor,
      }),
    );
    expect(await screen.findByText(r.flash.moved('Vendor'))).toBeVisible();
  });

  it('di Sampah: "Hapus permanen" lewat konfirmasi', async () => {
    const detail = fakeMailDetail({}, { folderRole: 'trash', isRead: true });
    const { api } = await renderApp(`/email?m=${MAIL_IDS.message1}`, setup({ detail }));
    const toolbar = await screen.findByRole('group', { name: r.toolbar });
    expect(within(toolbar).queryByRole('button', { name: r.trash })).toBeNull();
    fireEvent.click(within(toolbar).getByRole('button', { name: r.deletePermanently }));
    const dialog = await screen.findByRole('dialog', { name: r.deleteConfirm.title });
    expect(actions(api)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: r.deleteConfirm.confirm }));
    await waitFor(() =>
      expect(actions(api)[0]?.body).toMatchObject({ action: 'delete_permanently' }),
    );
  });

  it('hak Baca saja: tanpa arsip/hapus/spam/pindah, tetap bisa bintang', async () => {
    const detail = fakeMailDetail({ myLevel: 'read' });
    await renderApp(`/email?m=${MAIL_IDS.message1}`, setup({ detail }));
    const toolbar = await screen.findByRole('group', { name: r.toolbar });
    for (const name of [r.archive, r.trash, r.spam, r.move]) {
      expect(within(toolbar).queryByRole('button', { name })).toBeNull();
    }
    expect(within(toolbar).getByRole('button', { name: r.star })).toBeVisible();
  });

  it('email sudah tidak ada (404) → keadaan "sudah tidak ada"', async () => {
    await renderApp(
      `/email?m=${MAIL_IDS.message3}`,
      setup({
        routes: {
          [`GET ${apiPath(API_ROUTES.mail.message, { messageId: MAIL_IDS.message3 })}`]: () =>
            json(
              { error: { code: 'NOT_FOUND', message: 'Email tidak ditemukan.' } },
              { status: 404 },
            ),
        },
      }),
    );
    expect(await screen.findByText(r.notFoundTitle)).toBeVisible();
  });
});

describe('menu Email — lampiran', () => {
  let saved: string[];
  beforeEach(() => {
    saved = [];
    URL.createObjectURL = vi.fn(() => 'blob:lampiran');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
  });

  const pdfPath = apiPath(API_ROUTES.mail.attachment, { attachmentId: MAIL_IDS.attachmentPdf });
  const zipPath = apiPath(API_ROUTES.mail.attachment, { attachmentId: MAIL_IDS.attachmentZip });
  const file = (type: string) =>
    new Response(new Blob(['%PDF-1.4']), { status: 200, headers: { 'content-type': type } });

  it('unduh PDF; berkas diblokir tanpa tombol unduh', async () => {
    await renderApp(
      `/email?m=${MAIL_IDS.message1}`,
      setup({ routes: { [`GET ${pdfPath}`]: () => file('application/pdf') } }),
    );
    const section = await screen.findByRole('region', { name: /3 lampiran/ });
    expect(within(section).getByText(r.attachments.blocked)).toBeVisible();
    // Alasan singkat tampil di kartu (bukan hanya untuk pembaca layar); arsip ditandai.
    expect(
      within(section).getByText(new RegExp(r.attachments.blockedReasons.program ?? '')),
    ).toBeVisible();
    expect(within(section).getByText(r.attachments.risky)).toBeVisible();
    expect(
      within(section).queryByRole('button', { name: r.attachments.download('faktur.exe') }),
    ).toBeNull();
    fireEvent.click(
      within(section).getByRole('button', {
        name: r.attachments.download('Jadwal-Pemeliharaan.pdf'),
      }),
    );
    await waitFor(() => expect(saved).toEqual(['Jadwal-Pemeliharaan.pdf']));
  });

  it('ZIP: konfirmasi dulu, ?confirm=1; server masih mengambil (202) → unduh otomatis setelah event siap', async () => {
    let cached = false;
    const { api } = await renderApp(
      `/email?m=${MAIL_IDS.message1}`,
      setup({
        routes: {
          [`GET ${zipPath}`]: () =>
            cached ? file('application/octet-stream') : json({ state: 'loading' }, { status: 202 }),
        },
      }),
    );
    const section = await screen.findByRole('region', { name: /3 lampiran/ });
    fireEvent.click(
      within(section).getByRole('button', { name: r.attachments.download('Foto-ODP.zip') }),
    );
    const dialog = await screen.findByRole('dialog', { name: r.attachments.warnTitle });
    expect(within(dialog).getByText(MAIL_ATTACHMENT_WARN_MESSAGE)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: r.attachments.warnConfirm }));

    expect(
      await within(section).findByRole('status', {
        name: r.attachments.preparingLabel('Foto-ODP.zip'),
      }),
    ).toBeVisible();
    expect(api.requests.find((item) => item.path === zipPath)?.query.get('confirm')).toBe('1');

    cached = true;
    act(() =>
      FakeSocket.latest()?.receive({
        type: 'mail.attachment.ready',
        accountId: MAIL_IDS.cs,
        attachmentId: MAIL_IDS.attachmentZip,
      }),
    );
    await waitFor(() => expect(saved).toEqual(['Foto-ODP.zip']));
  });
});

describe('menu Email — HP', () => {
  beforeEach(() => {
    act(() => {
      setMediaQuery(media.desktop, false);
      setMediaQuery(media.hp, true);
    });
  });

  it('daftar → baca layar penuh (navigasi bawah disembunyikan) → kembali', async () => {
    const { router } = await renderApp('/email', setup());
    fireEvent.click(await screen.findByRole('button', { name: /NOC Nusaraya/ }));
    const back = await screen.findByRole('button', { name: r.back });
    expect(document.querySelector('[data-hp-immersive]')).not.toBeNull();
    expect(router.state.location.search).toMatchObject({ m: MAIL_IDS.message1 });
    // Fokus pindah ke subjek (pembaca layar langsung di email yang dibuka).
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 2, name: 'Jadwal pemeliharaan 26 November' }),
      ),
    );
    fireEvent.click(back);
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('m'));
    expect(document.querySelector('[data-hp-immersive]')).toBeNull();
  });
});
