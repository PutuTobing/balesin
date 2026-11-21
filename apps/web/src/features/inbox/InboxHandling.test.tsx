import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, fakeSession, json } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeConversation,
  fakeMessage,
  fakeQuickReply,
} from '../../test/fake-inbox';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { slashQuery } from './quick-replies';

const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const h = t.inbox.handling;
const k = t.inbox.compose;

const served = fakeConversation({
  status: 'served',
  assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
  windowExpiresAt: inFuture(5 * HOUR),
});
const agents = [
  {
    id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0009',
    name: 'Citra',
    role: 'cs' as const,
    active: true,
    openConversations: 3,
  },
  {
    id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0010',
    name: 'Agus Nonaktif',
    role: 'teknisi' as const,
    active: false,
    openConversations: 0,
  },
];
const salam = fakeQuickReply();
const jam = fakeQuickReply({
  shortcut: 'jam-buka',
  title: 'Jam operasional',
  body: 'Kami buka 08.00–21.00.',
});

const inbox = {
  conversations: [served],
  messages: { [served.id]: [fakeMessage({ text: 'Halo kak', createdAt: inFuture(-HOUR) })] },
  channels: [fakeChannelSummary()],
  agents,
  quickReplies: [salam, jam],
};

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function openChat(options: Parameters<typeof renderApp>[1] = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${served.id}`, { inbox, ...options });
  await chat().findByText('Halo kak');
  return view;
}

async function openMenu() {
  fireEvent.keyDown(chat().getByRole('button', { name: h.menu }), { key: 'Enter' });
  return within(await screen.findByRole('menu'));
}

describe('penanganan percakapan', () => {
  it('tandai selesai → composer diganti catatan; "Buka lagi" tersedia', async () => {
    const { api } = await openChat();
    fireEvent.click(chat().getByRole('button', { name: h.resolve }));
    await waitFor(() =>
      expect(api.requests.some((request) => request.path.endsWith('/resolve'))).toBe(true),
    );
    expect(await chat().findByText(k.resolved)).toBeVisible();
    expect(chat().getByRole('button', { name: h.reopen })).toBeEnabled();
  });

  it('HP: chat selesai punya "Buka lagi" di dasar layar → reopen', async () => {
    const resolved = { ...served, status: 'resolved' as const };
    act(() => setMediaQuery(media.hp, true));
    const { api } = await renderApp(`/inbox?chat=${served.id}`, {
      inbox: { ...inbox, conversations: [resolved] },
    });
    await chat().findByText('Halo kak');
    const note = await chat().findByText(k.resolved);
    const footer = within(note.parentElement!);
    fireEvent.click(footer.getByRole('button', { name: h.reopen }));
    await waitFor(() =>
      expect(api.requests.some((request) => request.path.endsWith('/reopen'))).toBe(true),
    );
  });

  it('chat selesai, CS tanpa inbox.initiate: tanpa composer & template, ada penjelasan izin', async () => {
    const resolved = { ...served, status: 'resolved' as const };
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${served.id}`, {
      inbox: { ...inbox, conversations: [resolved] },
      session: fakeSession('cs'),
    });
    await chat().findByText('Halo kak');
    expect(await chat().findByText(k.resolvedNoInitiate)).toBeVisible();
    expect(chat().queryByRole('textbox', { name: k.label })).toBeNull();
    expect(chat().queryByRole('button', { name: k.sendTemplate })).toBeNull();
    expect(chat().queryByRole('button', { name: k.template })).toBeNull();
    // Jalur yang ada tetap tersedia: buka lagi chatnya.
    expect(chat().getByRole('button', { name: h.reopen })).toBeEnabled();
  });

  it('chat selesai "dingin", CS tanpa inbox.initiate: "Buka lagi" nonaktif dengan alasan terbaca', async () => {
    const cold = {
      ...served,
      status: 'resolved' as const,
      windowExpiresAt: inFuture(-HOUR),
      windowOpen: false,
    };
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp(`/inbox?chat=${served.id}`, {
      inbox: { ...inbox, conversations: [cold] },
      session: fakeSession('cs'),
    });
    const note = await chat().findByText(k.resolvedStale);
    const reopen = chat().getByRole('button', { name: h.reopen });
    expect(reopen).toBeDisabled();
    expect(reopen).toHaveAttribute('aria-describedby', note.id);
    fireEvent.click(reopen);
    expect(api.requests.some((request) => request.path.endsWith('/reopen'))).toBe(false);
  });

  it('HP: chat "dingin" tanpa inbox.initiate — tombol dasar & item menu nonaktif berlasan', async () => {
    const cold = {
      ...served,
      status: 'resolved' as const,
      windowExpiresAt: inFuture(-HOUR),
      windowOpen: false,
    };
    act(() => setMediaQuery(media.hp, true));
    await renderApp(`/inbox?chat=${served.id}`, {
      inbox: { ...inbox, conversations: [cold] },
      session: fakeSession('cs'),
    });
    const note = await chat().findByText(k.resolvedStale);
    const footer = within(note.parentElement!);
    expect(footer.getByRole('button', { name: h.reopen })).toBeDisabled();
    const menu = await openMenu();
    const item = menu.getByRole('menuitem', { name: new RegExp(h.reopen) });
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent(h.reopenStale);
  });

  it('chat "dingin", Owner (punya inbox.initiate): "Buka lagi" tetap aktif', async () => {
    const cold = {
      ...served,
      status: 'resolved' as const,
      windowExpiresAt: inFuture(-HOUR),
      windowOpen: false,
    };
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${served.id}`, {
      inbox: { ...inbox, conversations: [cold] },
    });
    expect(await chat().findByText(k.resolved)).toBeVisible();
    expect(chat().getByRole('button', { name: h.reopen })).toBeEnabled();
  });

  it('buka lagi ditolak server (403): pesan server tampil apa adanya', async () => {
    const message =
      'Percakapan ini sudah selesai dan pelanggan tidak mengirim pesan dalam 24 jam terakhir. Membuka lagi butuh izin memulai percakapan.';
    const resolved = { ...served, status: 'resolved' as const };
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${served.id}`, {
      inbox: { ...inbox, conversations: [resolved] },
      session: fakeSession('cs'),
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.reopen, { conversationId: served.id })}`]: () =>
          apiError(403, 'FORBIDDEN', message),
      },
    });
    await chat().findByText(k.resolvedNoInitiate);
    fireEvent.click(chat().getByRole('button', { name: h.reopen }));
    expect(await screen.findByText(message)).toBeVisible();
  });

  it('chat selesai, Owner (punya inbox.initiate): catatan biasa tanpa penjelasan izin', async () => {
    const resolved = { ...served, status: 'resolved' as const };
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${served.id}`, {
      inbox: { ...inbox, conversations: [resolved] },
    });
    expect(await chat().findByText(k.resolved)).toBeVisible();
    expect(chat().queryByText(k.resolvedNoInitiate)).toBeNull();
    expect(chat().queryByRole('textbox', { name: k.label })).toBeNull();
  });

  it('403 saat kirim (chat baru saja diselesaikan): pesan server apa adanya + chat diambil ulang', async () => {
    const message =
      'Percakapan ini sudah selesai. Mengirim pesan baru ke percakapan yang sudah selesai butuh izin memulai percakapan.';
    let resolvedNow = false;
    const { api } = await openChat({
      session: fakeSession('cs'),
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: served.id })}`]: () => {
          resolvedNow = true;
          return apiError(403, 'FORBIDDEN', message);
        },
        [`GET ${apiPath(API_ROUTES.inbox.conversation, { conversationId: served.id })}`]: () =>
          json({ conversation: resolvedNow ? { ...served, status: 'resolved' } : served }),
      },
    });
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Halo lagi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await chat().findByText(message)).toBeVisible();
    expect(await chat().findByText(k.resolvedNoInitiate)).toBeVisible();
    expect(chat().queryByRole('textbox', { name: k.label })).toBeNull();
    expect(
      api.requests.filter((request) => request.path.endsWith(`/conversations/${served.id}`)).length,
    ).toBeGreaterThan(1);
  });

  it('429 jatah harian di chat yang kemudian selesai: kotak batas tetap tampil di atas catatan', async () => {
    let resolvedNow = false;
    await openChat({
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: served.id })}`]: () => {
          resolvedNow = true;
          return apiError(429, 'RATE_LIMITED', 'Jatah memulai percakapan hari ini sudah habis.', {
            retryAfter: 60,
          });
        },
        [`GET ${apiPath(API_ROUTES.inbox.conversation, { conversationId: served.id })}`]: () =>
          json({ conversation: resolvedNow ? { ...served, status: 'resolved' } : served }),
      },
    });
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Halo lagi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const alert = await chat().findByText(k.limitedTitle);
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Jatah memulai percakapan');
  });

  it('alihkan: dialog agen aktif dengan bebannya → assign userId', async () => {
    const { api } = await openChat();
    const menu = await openMenu();
    fireEvent.click(menu.getByRole('menuitem', { name: h.reassign }));
    const dialog = within(await screen.findByRole('dialog', { name: h.reassignTitle }));
    expect(dialog.getByText(h.currentAssignee('Rina Kartika'))).toBeVisible();
    expect(dialog.queryByText('Agus Nonaktif')).toBeNull();
    expect(dialog.getByText(h.load(3))).toBeVisible();
    fireEvent.click(dialog.getByRole('radio', { name: /Citra/ }));
    fireEvent.click(dialog.getByRole('button', { name: h.assignConfirm }));
    await waitFor(() =>
      expect(api.requests.find((request) => request.path.endsWith('/assign'))?.body).toEqual({
        userId: agents[0]?.id,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('kembalikan ke antrian oleh Teknisi → { conversation: null } → chat ditutup', async () => {
    const { router } = await openChat({
      session: fakeSession('teknisi', 'Rina Kartika'),
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.unassign, { conversationId: served.id })}`]: () =>
          json({ conversation: null }),
      },
    });
    const menu = await openMenu();
    // Teknisi tidak bisa mengalihkan, hanya mengembalikan chat miliknya.
    expect(menu.queryByRole('menuitem', { name: h.reassign })).toBeNull();
    fireEvent.click(menu.getByRole('menuitem', { name: h.unassign }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('chat'));
  });

  it('409 konflik: pesan server tampil dengan judul tindakan', async () => {
    await openChat({
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.resolve, { conversationId: served.id })}`]: () =>
          apiError(409, 'CONFLICT', 'Percakapan ini sudah ditangani orang lain.'),
      },
    });
    fireEvent.click(chat().getByRole('button', { name: h.resolve }));
    const alert = await chat().findByRole('alert');
    expect(alert).toHaveTextContent(h.failedTitle);
    expect(alert).toHaveTextContent('Percakapan ini sudah ditangani orang lain.');
  });
});

describe('balasan cepat "/" di composer', () => {
  it('slashQuery hanya untuk "/kata" utuh', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/sal')).toBe('sal');
    expect(slashQuery('halo /sal')).toBeNull();
    expect(slashQuery('/sal am')).toBeNull();
  });

  it('ketik "/" → daftar; panah + Enter memakai template → teks terisi variabel', async () => {
    const { api } = await openChat();
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: '/' } });
    const list = within(await chat().findByRole('listbox', { name: t.inbox.quickReplies.title }));
    expect(list.getAllByRole('option')).toHaveLength(2);
    expect(box).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(list.getByRole('option', { name: /jam-buka/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(box).toHaveValue('Halo kak Budi, dengan Rina di sini. Ada yang bisa kami bantu?'),
    );
    const used = api.requests.find(
      (request) =>
        request.path === apiPath(API_ROUTES.quickReplies.use, { quickReplyId: salam.id }),
    );
    expect(used?.body).toEqual({ conversationId: served.id });
    // Enter memilih template, bukan mengirim pesan.
    expect(
      api.requests.some(
        (request) => request.method === 'POST' && request.path.endsWith('/messages'),
      ),
    ).toBe(false);
  });

  it('Escape menutup daftar; tanpa hasil → keterangan', async () => {
    await openChat();
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: '/zzz' } });
    expect(await chat().findByText(t.inbox.quickReplies.notFound('zzz'))).toBeVisible();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(chat().queryByText(t.inbox.quickReplies.notFound('zzz'))).toBeNull();
  });
});

describe('Pengaturan → Balasan cepat', () => {
  it('alamat lama /pengaturan/template-percakapan dialihkan ke /pengaturan/balasan-cepat', async () => {
    const { router } = await renderApp('/pengaturan/template-percakapan', { inbox });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan/balasan-cepat'));
    expect(await screen.findByText('/salam')).toBeVisible();
  });

  it('daftar, tambah (validasi klien), hapus dengan konfirmasi', async () => {
    const { api } = await renderApp('/pengaturan/balasan-cepat', { inbox });
    expect(await screen.findByText('/salam')).toBeVisible();
    expect(screen.getAllByText(t.quickReplies.used(12), { exact: false })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: t.quickReplies.add }));
    const dialog = within(await screen.findByRole('dialog', { name: t.quickReplies.addTitle }));
    fireEvent.change(dialog.getByLabelText(t.quickReplies.shortcutLabel), {
      target: { value: '/Promo' },
    });
    fireEvent.change(dialog.getByLabelText(t.quickReplies.titleLabel), {
      target: { value: 'Promo' },
    });
    fireEvent.change(dialog.getByLabelText(t.quickReplies.bodyLabel), {
      target: { value: 'Halo {pelanggan}' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t.quickReplies.save }));
    expect(await dialog.findByText(/Variabel \{pelanggan\} tidak dikenal/)).toBeVisible();

    fireEvent.change(dialog.getByLabelText(t.quickReplies.bodyLabel), {
      target: { value: 'Halo ' },
    });
    fireEvent.click(dialog.getByRole('button', { name: /\{nama\}/ }));
    fireEvent.click(dialog.getByRole('button', { name: t.quickReplies.save }));
    await waitFor(() =>
      expect(
        api.requests.find(
          (request) => request.method === 'POST' && request.path === API_ROUTES.quickReplies.list,
        )?.body,
      ).toEqual({ shortcut: 'promo', title: 'Promo', body: 'Halo {nama}' }),
    );

    fireEvent.click(await screen.findByRole('button', { name: t.quickReplies.remove('salam') }));
    fireEvent.click(await screen.findByRole('button', { name: t.quickReplies.removeConfirm }));
    expect(await screen.findByText(t.quickReplies.deleted('salam'))).toBeVisible();
  });

  it('CS tanpa quick_replies.manage dialihkan dari halaman kelola', async () => {
    const { router } = await renderApp('/pengaturan/balasan-cepat', {
      inbox,
      session: fakeSession('cs'),
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
  });
});
