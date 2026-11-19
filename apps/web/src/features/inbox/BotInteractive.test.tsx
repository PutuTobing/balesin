import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, json } from '../../test/fake-api';
import { fakeChannelSummary, fakeConversation, fakeMessage } from '../../test/fake-inbox';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { channelBotKey } from '../channels/bot-form';

const h = t.inbox.handling;
const k = t.inbox.compose;
const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

const withBot = fakeConversation({ status: 'bot', windowExpiresAt: inFuture(5 * HOUR) });
const served = fakeConversation({
  status: 'served',
  assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
  windowExpiresAt: inFuture(5 * HOUR),
});

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function open(conversation: typeof withBot, routes = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${conversation.id}`, {
    inbox: {
      conversations: [conversation],
      messages: {
        [conversation.id]: [fakeMessage({ text: 'Halo bot', createdAt: inFuture(-HOUR) })],
      },
      channels: [fakeChannelSummary()],
    },
    routes,
  });
  await chat().findByText('Halo bot');
  return view;
}

describe('bot per percakapan', () => {
  it('dipegang bot: "Serahkan ke tim" → POST bot { active: false }', async () => {
    const path = apiPath(API_ROUTES.inbox.bot, { conversationId: withBot.id });
    const { api } = await open(withBot, {
      [`POST ${path}`]: () => json({ conversation: { ...withBot, status: 'unserved' } }),
    });
    // Ambil alih ada di menu tindakan (dan di dasar ruang chat).
    fireEvent.keyDown(chat().getByRole('button', { name: h.menu }), { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: h.botTakeOver })).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(chat().getByRole('button', { name: h.botHandoff }));
    await waitFor(() =>
      expect(api.requests.find((request) => request.path === path)?.body).toEqual({
        active: false,
      }),
    );
  });

  it('dipegang agen: "Kembalikan ke bot" di menu; 409 (bot channel mati) tampil sebagai pesan', async () => {
    const path = apiPath(API_ROUTES.inbox.bot, { conversationId: served.id });
    const { api } = await open(served, {
      [`POST ${path}`]: () =>
        apiError(409, 'CONFLICT', 'Bot di channel ini sedang mati. Nyalakan dulu di Pengaturan.'),
    });
    fireEvent.keyDown(chat().getByRole('button', { name: h.menu }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: h.botResume }));
    await waitFor(() =>
      expect(api.requests.find((request) => request.path === path)?.body).toEqual({
        active: true,
      }),
    );
    expect(await chat().findByText(/Bot di channel ini sedang mati/)).toBeVisible();
  });

  it('409 "belum ada penerima bot": pesan server tampil apa adanya', async () => {
    const path = apiPath(API_ROUTES.inbox.bot, { conversationId: served.id });
    const message =
      'Belum ada penerima bot aktif untuk channel ini. Tambahkan webhook bot di Pengaturan → Webhook, lalu coba lagi.';
    await open(served, { [`POST ${path}`]: () => apiError(409, 'CONFLICT', message) });
    fireEvent.keyDown(chat().getByRole('button', { name: h.menu }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: h.botResume }));
    expect(await chat().findByText(message)).toBeVisible();
  });

  it('pengaturan bot channel sudah di cache dengan receiverReady false → tombol nonaktif + alasan terbaca', async () => {
    const view = await open(served);
    view.queryClient.setQueryData(channelBotKey(served.channel.id), {
      settings: {
        enabled: true,
        hours: { mode: 'always' },
        timeoutMinutes: 15,
        channelType: 'whatsapp',
        timezone: 'Asia/Jakarta',
        activeNow: true,
        receiverReady: false,
        updatedAt: null,
      },
    });
    fireEvent.keyDown(chat().getByRole('button', { name: h.menu }), { key: 'Enter' });
    const item = await screen.findByRole('menuitem', { name: new RegExp(h.botResume) });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(within(item).getByText(h.botResumeNoReceiver)).toBeVisible();
    fireEvent.click(item);
    expect(
      view.api.requests.some(
        (request) => request.path === apiPath(API_ROUTES.inbox.bot, { conversationId: served.id }),
      ),
    ).toBe(false);
  });
});

describe('pesan interaktif', () => {
  it('tombol balasan: validasi batas Meta lalu kirim type interactive', async () => {
    const { api } = await open(served);
    fireEvent.click(chat().getByRole('button', { name: k.interactive }));
    const dialog = within(await screen.findByRole('dialog', { name: k.interactiveTitle }));
    fireEvent.click(dialog.getByRole('button', { name: k.ivSend }));
    expect(await dialog.findByText('Isi pesan wajib diisi.')).toBeVisible();

    fireEvent.change(dialog.getByLabelText(k.ivBody), {
      target: { value: 'Mau dibantu soal apa kak?' },
    });
    fireEvent.change(dialog.getByLabelText(k.ivButton(1)), { target: { value: 'Tagihan' } });
    fireEvent.change(dialog.getByLabelText(k.ivButton(2)), { target: { value: 'Gangguan' } });
    expect(dialog.getByText(k.ivCount(8, 20))).toBeVisible();
    fireEvent.click(dialog.getByRole('button', { name: k.ivAddButton }));
    // Maks. 3 tombol: tombol tambah hilang.
    expect(dialog.queryByRole('button', { name: k.ivAddButton })).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: k.ivRemoveButton(3) }));
    fireEvent.click(dialog.getByRole('button', { name: k.ivSend }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sent = api.requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path === apiPath(API_ROUTES.inbox.messages, { conversationId: served.id }),
    )?.body as { type: string; interactive: unknown };
    expect(sent.type).toBe('interactive');
    expect(sent.interactive).toEqual({
      kind: 'button',
      body: 'Mau dibantu soal apa kak?',
      buttons: [
        { id: 'tombol-1', title: 'Tagihan' },
        { id: 'tombol-2', title: 'Gangguan' },
      ],
    });
  });

  it('daftar: lebih dari satu bagian wajib berjudul', async () => {
    await open(served);
    fireEvent.click(chat().getByRole('button', { name: k.interactive }));
    const dialog = within(await screen.findByRole('dialog', { name: k.interactiveTitle }));
    fireEvent.click(dialog.getByRole('radio', { name: k.interactiveKinds.list }));
    fireEvent.change(dialog.getByLabelText(k.ivBody), { target: { value: 'Pilih paket' } });
    fireEvent.change(dialog.getByLabelText(k.ivListButton), { target: { value: 'Lihat paket' } });
    fireEvent.click(dialog.getByRole('button', { name: k.ivAddSection }));
    for (const [index, input] of dialog.getAllByLabelText(/^Pilihan \d/).entries()) {
      fireEvent.change(input, { target: { value: `Paket ${String(index + 1)}` } });
    }
    fireEvent.click(dialog.getByRole('button', { name: k.ivSend }));
    expect(
      await dialog.findByText('Judul bagian wajib diisi bila daftar punya lebih dari satu bagian.'),
    ).toBeVisible();
  });

  it('riwayat: tombol yang dikirim tampil sebagai teks biasa', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${served.id}`, {
      inbox: {
        conversations: [served],
        messages: {
          [served.id]: [
            fakeMessage({
              direction: 'outbound',
              senderKind: 'bot',
              type: 'interactive',
              text: 'Pilih layanan',
              status: 'delivered',
              interactiveMessage: {
                kind: 'button',
                body: 'Pilih layanan',
                buttons: [
                  { id: 'a', title: '<b>Tagihan</b>' },
                  { id: 'b', title: 'Gangguan' },
                ],
              },
            }),
          ],
        },
        channels: [fakeChannelSummary()],
      },
    });
    const list = await chat().findByRole('list', { name: t.inbox.content.choicesLabel });
    expect(within(list).getByText('<b>Tagihan</b>')).toBeVisible();
    expect(list.querySelector('b')).toBeNull();
  });
});
