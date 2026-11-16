import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, fakeSession, json } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeContact,
  fakeConversation,
  fakeMessage,
} from '../../test/fake-inbox';
import { FakeSocket } from '../../test/fake-socket';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

function list() {
  return within(screen.getByRole('region', { name: t.inbox.listLabel }));
}

function chatRegion() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

const budi = fakeConversation({
  unreadCount: 3,
  windowExpiresAt: inFuture(HOUR + 30 * 60_000),
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000b1',
    number: 1,
    displayName: 'Budi Santoso',
    nameSource: 'whatsapp',
    phone: '+6281234567890',
    waUsername: null,
  },
});
const sari = fakeConversation({
  status: 'served',
  assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0009', name: 'Citra' },
  windowExpiresAt: inFuture(-HOUR),
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000b2',
    number: 2,
    displayName: '<img src=x onerror=alert(1)>',
    nameSource: 'team',
    phone: '+6285700001111',
    waUsername: null,
  },
  lastMessage: {
    direction: 'outbound',
    type: 'text',
    text: 'Baik kak, teknisi meluncur.',
    status: 'read',
    createdAt: new Date().toISOString(),
  },
});

const messages = [
  fakeMessage({ text: 'Halo kak, internet mati', createdAt: inFuture(-2 * HOUR) }),
  fakeMessage({
    type: 'document',
    text: null,
    media: {
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'tagihan-nov.pdf',
      voice: false,
      animated: false,
    },
    createdAt: inFuture(-HOUR),
  }),
  fakeMessage({
    direction: 'outbound',
    senderKind: 'bot',
    text: '<script>alert(1)</script> Mohon tunggu',
    status: 'delivered',
    createdAt: inFuture(-30 * 60_000),
  }),
  fakeMessage({
    direction: 'outbound',
    senderKind: 'broadcast',
    text: 'Pengingat tagihan',
    status: 'failed',
    errorCode: 131047,
    failure: {
      reason: 'window_closed',
      code: 131047,
      message: 'Sesi 24 jam sudah habis. Pelanggan perlu membalas dulu, atau kirim template.',
      retryable: false,
    },
    createdAt: inFuture(-20 * 60_000),
  }),
];

const inbox = {
  conversations: [budi, sari],
  messages: { [budi.id]: messages },
  contacts: [fakeContact({ id: budi.contact.id, name: null, profileName: 'Budi Santoso' })],
  channels: [fakeChannelSummary()],
};

describe('daftar percakapan', () => {
  it('baris: nama + nomor, cuplikan, lencana belum dibaca, hitung mundur sesi', async () => {
    await renderApp('/inbox', { inbox });

    const row = within(await list().findByRole('button', { name: /Budi Santoso/ }));
    expect(row.getByText('Budi Santoso')).toHaveAttribute('dir', 'auto');
    expect(row.getByText('+62 812-3456-7890')).toBeVisible();
    expect(row.getByText('Halo kak, internet di rumah mati sejak pagi.')).toBeVisible();
    expect(row.getByText(t.inbox.item.unread(3))).toBeInTheDocument();
    // ≤ 2 jam: hampir habis.
    expect(row.getByText('1 jam 29 mnt').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'expiring',
    );
    expect(row.getByText(/Sesi WhatsApp tersisa 1 jam 29 menit/)).toBeInTheDocument();

    const other = within(list().getByRole('button', { name: /Citra/ }));
    // Nama berisi HTML tampil sebagai teks, tidak pernah ditafsirkan.
    expect(other.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(other.getByText(t.inbox.window.expiredShort).closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'expired',
    );
    expect(other.getByText(t.inbox.chat.deliveryStatus.read)).toBeInTheDocument();
  });

  it('tab menampilkan jumlah antrian berjalan (tanpa "Semua" dan "Selesai")', async () => {
    await renderApp('/inbox', { inbox });
    await list().findByRole('button', { name: /Budi Santoso/ });
    await waitFor(() =>
      expect(list().getByRole('tab', { name: /Belum dilayani/ })).toHaveTextContent('1'),
    );
    expect(list().getByRole('tab', { name: /^Dilayani/ })).toHaveAccessibleName(
      `${t.inbox.tabs.dilayani}, ${t.inbox.tabCountLabel(1)}`,
    );
    expect(list().getByRole('tab', { name: t.inbox.tabs.semua })).toHaveTextContent(/^Semua$/);
  });

  it('keyboard: daftar satu tab stop, panah atas/bawah berpindah baris', async () => {
    await renderApp('/inbox', { inbox });
    const first = await list().findByRole('button', { name: /Budi Santoso/ });
    const second = list().getByRole('button', { name: /Citra/ });
    expect(first).toHaveAttribute('tabindex', '0');
    expect(second).toHaveAttribute('tabindex', '-1');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'Home' });
    expect(first).toHaveFocus();
  });

  it('pencarian menunggu 2 huruf, lalu dikirim ke server sebagai q', async () => {
    const { api } = await renderApp('/inbox', { inbox });
    await list().findByRole('button', { name: /Budi Santoso/ });
    const input = list().getByRole('searchbox', { name: t.inbox.searchLabel });

    fireEvent.change(input, { target: { value: 'b' } });
    expect(list().getByText(t.inbox.searchTooShort)).toBeVisible();

    fireEvent.change(input, { target: { value: 'sari' } });
    expect(
      await list().findByRole('heading', { name: t.inbox.searchEmpty.title('sari') }),
    ).toBeVisible();
    const searched = api.requests.filter(
      (request) => request.path === API_ROUTES.inbox.conversations && request.query.get('q'),
    );
    expect(searched.map((request) => request.query.get('q'))).toEqual(['sari']);
  });

  it('pencarian dibatasi (429): pesan + tombol terkunci dengan hitung mundur', async () => {
    await renderApp('/inbox', {
      inbox,
      routes: {
        [`GET ${API_ROUTES.inbox.conversations}`]: ({ query }) =>
          query.get('q')
            ? apiError(429, 'RATE_LIMITED', 'Terlalu banyak pencarian. Tunggu sebentar.', {
                retryAfter: 42,
              })
            : json({ conversations: [budi], nextCursor: null }),
      },
    });
    await list().findByRole('button', { name: /Budi Santoso/ });
    fireEvent.change(list().getByRole('searchbox', { name: t.inbox.searchLabel }), {
      target: { value: 'budi' },
    });
    const alert = await list().findByRole('alert');
    expect(alert).toHaveTextContent(t.inbox.searchLimited);
    expect(alert).toHaveTextContent('Terlalu banyak pencarian. Tunggu sebentar.');
    const retry = within(alert).getByRole('button');
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent('0:42');
  });

  it('pencarian terlalu lama (503): pesan server + "Cari lagi"', async () => {
    await renderApp('/inbox', {
      inbox,
      routes: {
        [`GET ${API_ROUTES.inbox.conversations}`]: ({ query }) =>
          query.get('q')
            ? apiError(
                503,
                'SERVICE_UNAVAILABLE',
                'Pencarian terlalu lama. Persempit kata kuncinya lalu coba lagi.',
              )
            : json({ conversations: [budi], nextCursor: null }),
      },
    });
    await list().findByRole('button', { name: /Budi Santoso/ });
    fireEvent.change(list().getByRole('searchbox', { name: t.inbox.searchLabel }), {
      target: { value: 'budi' },
    });
    const alert = await list().findByRole('alert');
    expect(alert).toHaveTextContent(t.inbox.searchSlowTitle);
    expect(alert).toHaveTextContent('Persempit kata kuncinya');
    expect(within(alert).getByRole('button', { name: t.inbox.searchAgain })).toBeEnabled();
  });

  it('saring "Hampir habis" mengirim window=expiring dan tampil sebagai label yang bisa dihapus', async () => {
    const { api } = await renderApp('/inbox', { inbox });
    await list().findByRole('button', { name: /Budi Santoso/ });

    fireEvent.keyDown(list().getByRole('button', { name: t.inbox.filters.open }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Hampir habis' }));

    await waitFor(() =>
      expect(
        api.requests.some(
          (request) =>
            request.path === API_ROUTES.inbox.conversations &&
            request.query.get('window') === 'expiring',
        ),
      ).toBe(true),
    );
    expect(
      api.requests.some(
        (request) =>
          request.path === API_ROUTES.inbox.counts && request.query.get('window') === 'expiring',
      ),
    ).toBe(true);
    fireEvent.keyDown(menu, { key: 'Escape' });
    const chips = within(list().getByRole('list', { name: t.inbox.filters.activeLabel }));
    fireEvent.click(chips.getByRole('button', { name: t.inbox.filters.remove('Hampir habis') }));
    expect(list().queryByRole('list', { name: t.inbox.filters.activeLabel })).toBeNull();
  });

  it('Teknisi tidak melihat saringan agen (hanya chat miliknya)', async () => {
    await renderApp('/inbox', { inbox, session: fakeSession('teknisi') });
    await list().findByRole('button', { name: /Budi Santoso/ });
    fireEvent.keyDown(list().getByRole('button', { name: t.inbox.filters.open }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText(t.inbox.filters.assignee)).toBeNull();
    expect(within(menu).getByText(t.inbox.filters.window)).toBeInTheDocument();
  });

  it('gagal memuat: pesan server + "Coba lagi"', async () => {
    await renderApp('/inbox', {
      inbox,
      routes: {
        [`GET ${API_ROUTES.inbox.conversations}`]: () =>
          apiError(500, 'INTERNAL_ERROR', 'Terjadi kesalahan di server.'),
      },
    });
    // 5xx dicoba ulang sekali (jeda 1 detik) sebelum keadaan gagal tampil.
    expect(
      await list().findByRole('heading', { name: t.inbox.failed.title }, { timeout: 4000 }),
    ).toBeVisible();
    expect(list().getByRole('button', { name: t.common.retry })).toBeEnabled();
  });
});

describe('ruang chat baca-saja', () => {
  it('memilih chat membuka riwayat pesan dan menandainya dibaca', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api, router } = await renderApp('/inbox', { inbox });

    fireEvent.click(await list().findByRole('button', { name: /Budi Santoso/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ chat: budi.id }));

    const chat = chatRegion();
    expect(await chat.findByText('Halo kak, internet mati')).toHaveAttribute('dir', 'auto');
    expect(chat.getByRole('heading', { level: 2, name: 'Budi Santoso' })).toBeVisible();
    expect(chat.getByText(`+62 812-3456-7890 · ${t.inbox.item.fromWhatsApp}`)).toBeVisible();
    expect(chat.getByText('Dokumen: tagihan-nov.pdf')).toBeVisible();
    // Teks berisi tag tetap teks.
    expect(chat.getByText('<script>alert(1)</script> Mohon tunggu')).toBeVisible();
    expect(chat.getByText(t.inbox.chat.senders.bot, { selector: 'p' })).toBeVisible();
    expect(chat.getByText(t.inbox.chat.deliveryStatus.delivered)).toBeInTheDocument();
    expect(chat.queryByRole('textbox')).toBeNull();

    await waitFor(() =>
      expect(
        api.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.path === apiPath(API_ROUTES.inbox.read, { conversationId: budi.id }),
        ),
      ).toBe(true),
    );
    const read = api.requests.find((request) => request.method === 'POST');
    expect(read?.headers['x-csrf-token']).toBeTruthy();

    // Panel detail memuat identitas kontak.
    const detail = within(screen.getByRole('complementary', { name: t.inbox.detail.label }));
    expect(await detail.findByText(t.inbox.detail.profileName)).toBeVisible();
    expect(detail.getByText(t.inbox.item.status.unserved)).toBeVisible();
  });

  it('chat yang tidak tersedia lagi (404) ditutup dari tampilan, tanpa data lama', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp(`/inbox?chat=${budi.id}`, { inbox });
    expect(await chatRegion().findByText('Halo kak, internet mati')).toBeVisible();

    const gone = () => apiError(404, 'NOT_FOUND', 'Data tidak ditemukan.');
    api.on(`GET ${apiPath(API_ROUTES.inbox.conversation, { conversationId: budi.id })}`, gone);
    api.on(`GET ${apiPath(API_ROUTES.inbox.messages, { conversationId: budi.id })}`, gone);

    // Event real-time untuk chat yang terbuka → detail diambil ulang → 404.
    act(() => {
      FakeSocket.latest()?.receive({ type: 'hello', heartbeatSeconds: 30 });
      FakeSocket.latest()?.receive({
        type: 'conversation.updated',
        conversationId: budi.id,
        status: 'served',
        assigneeUserId: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0009',
        unreadCount: 0,
        lastMessageAt: new Date().toISOString(),
        windowExpiresAt: null,
      });
    });

    expect(
      await chatRegion().findByRole('heading', { name: t.inbox.chat.notFoundTitle }),
    ).toBeVisible();
    expect(chatRegion().queryByText('Halo kak, internet mati')).toBeNull();
  });

  it('HP: chat bertumpuk, fokus ke judul, detail bertumpuk, kembali ke baris yang sama', async () => {
    act(() => setMediaQuery(media.hp, true));
    const { router } = await renderApp('/inbox', { inbox });
    const row = await list().findByRole('button', { name: /Budi Santoso/ });
    fireEvent.click(row);

    const title = await chatRegion().findByRole('heading', { level: 2, name: 'Budi Santoso' });
    await waitFor(() => expect(title).toHaveFocus());
    expect(document.querySelector('[data-hp-immersive]')).not.toBeNull();
    // HP: subjudul cukup nomor ("dari WhatsApp" ada di layar detail).
    expect(chatRegion().getByText('+62 812-3456-7890')).toBeVisible();
    expect(chatRegion().queryByText(/dari WhatsApp/)).toBeNull();

    // Kepala chat → detail bertumpuk (`&detail=1`).
    fireEvent.click(
      chatRegion().getByRole('button', { name: t.inbox.chat.openDetail('Budi Santoso') }),
    );
    await waitFor(() => expect(router.state.location.search).toMatchObject({ detail: 1 }));
    const detail = within(await screen.findByRole('complementary', { name: t.inbox.detail.label }));
    expect(await detail.findByText(t.inbox.item.fromWhatsApp)).toBeVisible();
    expect(detail.getByText(t.inbox.detail.status)).toBeVisible();
    fireEvent.click(detail.getByRole('button', { name: t.inbox.detail.backToChat }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('detail'));

    fireEvent.click(chatRegion().getByRole('button', { name: t.inbox.chat.back }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('chat'));
    await waitFor(() => expect(list().getByRole('button', { name: /Budi Santoso/ })).toHaveFocus());
  });

  it('pesan gagal: penyebab + solusi dari server di bawah gelembung', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${budi.id}`, { inbox });
    const reason = await chatRegion().findByText(
      'Sesi 24 jam sudah habis. Pelanggan perlu membalas dulu, atau kirim template.',
    );
    expect(chatRegion().queryByText(/kode 131047/)).toBeNull();
    // Di luar gelembung (latar halaman), bukan di dalamnya.
    expect(reason.closest('li')?.textContent).toContain('Pengingat tagihan');
    expect(reason.parentElement?.previousElementSibling).not.toBeNull();
  });

  it('WebSocket inbox disambungkan ke origin aplikasi tanpa token', async () => {
    await renderApp('/inbox', { inbox });
    await waitFor(() => expect(FakeSocket.latest()).toBeDefined());
    expect(FakeSocket.latest()?.url).toBe('ws://localhost:3000/api/v1/inbox/stream');
  });
});
