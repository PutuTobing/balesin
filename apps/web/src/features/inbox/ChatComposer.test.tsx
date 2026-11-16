import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, fakeSession } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeContact,
  fakeConversation,
  fakeMessage,
} from '../../test/fake-inbox';
import { FakeSocket } from '../../test/fake-socket';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { filenameFromDisposition } from './message-media';
import { checkAttachment, guessMediaKind } from './attachments';
import { buildTimeline, isActionable } from './timeline';

const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const k = t.inbox.compose;

const open = fakeConversation({
  status: 'unserved',
  windowExpiresAt: inFuture(5 * HOUR),
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000c1',
    number: 1,
    displayName: 'Budi Santoso',
    nameSource: 'whatsapp',
    phone: '+6281234567890',
    waUsername: null,
  },
});
const closed = fakeConversation({
  status: 'served',
  windowExpiresAt: inFuture(-HOUR),
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000c2',
    number: 2,
    displayName: 'Sari',
    nameSource: 'team',
    phone: '+6281299990000',
    waUsername: null,
  },
});

const inbound = fakeMessage({ text: 'Halo kak, internet mati', createdAt: inFuture(-HOUR) });
const failed = fakeMessage({
  direction: 'outbound',
  senderKind: 'agent',
  senderUserId: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0009',
  text: 'Sudah kami cek',
  status: 'failed',
  failure: {
    reason: 'delivery_unknown',
    code: null,
    message: 'Koneksi ke Meta terputus saat mengirim.',
    retryable: true,
  },
  createdAt: inFuture(-30 * 60_000),
});
const photo = fakeMessage({
  type: 'image',
  text: 'Lampu LOS merah',
  media: { kind: 'image', mimeType: 'image/jpeg', filename: null, voice: false, animated: false },
  mediaAvailable: true,
  createdAt: inFuture(-20 * 60_000),
});
const doc = fakeMessage({
  type: 'document',
  text: null,
  media: {
    kind: 'document',
    mimeType: 'application/pdf',
    filename: '<b>tagihan</b>.pdf',
    voice: false,
    animated: false,
  },
  mediaAvailable: true,
  createdAt: inFuture(-10 * 60_000),
});

const inbox = {
  conversations: [open, closed],
  messages: { [open.id]: [inbound, failed, photo, doc], [closed.id]: [inbound] },
  contacts: [fakeContact({ id: open.contact.id })],
  channels: [fakeChannelSummary()],
  agents: [
    {
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0009',
      name: 'Citra',
      role: 'cs' as const,
      active: true,
      openConversations: 2,
    },
  ],
};

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function openChat(id = open.id, options: Parameters<typeof renderApp>[1] = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${id}`, { inbox, ...options });
  await chat().findByText('Halo kak, internet mati');
  return view;
}

describe('composer', () => {
  it('Enter mengirim teks dengan clientMessageId UUID; pesan tampil lalu kolom kosong lagi', async () => {
    const { api } = await openChat();
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Baik kak, kami cek dulu ya' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(box).toHaveValue(''));
    const sent = api.requests.find(
      (request) =>
        request.method === 'POST' &&
        request.path === apiPath(API_ROUTES.inbox.messages, { conversationId: open.id }),
    );
    expect(sent?.body).toMatchObject({ type: 'text', text: 'Baik kak, kami cek dulu ya' });
    expect((sent?.body as { clientMessageId: string }).clientMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sent?.headers['x-csrf-token']).toBeTruthy();
    expect(await chat().findByText('Baik kak, kami cek dulu ya')).toBeVisible();
    expect(chat().getAllByText(t.inbox.chat.deliveryStatus.pending).length).toBeGreaterThan(0);
  });

  it('Shift+Enter tidak mengirim; teks kosong tidak bisa dikirim', async () => {
    const { api } = await openChat();
    const box = chat().getByRole('textbox', { name: k.label });
    expect(chat().getByRole('button', { name: k.send })).toBeDisabled();
    fireEvent.change(box, { target: { value: 'baris satu' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(
      api.requests.some(
        (request) => request.method === 'POST' && request.path.endsWith('/messages'),
      ),
    ).toBe(false);
  });

  it('balas-kutip: pilih "Balas" di menu pesan → kutipan di composer → replyToMessageId', async () => {
    const { api } = await openChat();
    fireEvent.keyDown(chat().getAllByRole('button', { name: t.inbox.actions.open })[0]!, {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: t.inbox.actions.reply }));
    expect(await chat().findByText(k.replyingTo(t.inbox.actions.customer))).toBeVisible();

    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Siap kak' } });
    fireEvent.click(chat().getByRole('button', { name: k.send }));
    await waitFor(() =>
      expect(
        api.requests.find(
          (request) => request.method === 'POST' && request.path.endsWith('/messages'),
        )?.body,
      ).toMatchObject({ type: 'text', replyToMessageId: inbound.id }),
    );
  });

  it('reaksi: emoji dari menu pesan dikirim sebagai pesan reaksi', async () => {
    const { api } = await openChat();
    fireEvent.keyDown(chat().getAllByRole('button', { name: t.inbox.actions.open })[0]!, {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: t.inbox.actions.reactWith('🙏') }));
    await waitFor(() =>
      expect(
        api.requests.find(
          (request) => request.method === 'POST' && request.path.endsWith('/messages'),
        )?.body,
      ).toMatchObject({ type: 'reaction', targetMessageId: inbound.id, emoji: '🙏' }),
    );
  });

  it('429: pesan server + tombol kirim terkunci dengan hitung mundur; item bisa dikirim ulang', async () => {
    await openChat(open.id, {
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: open.id })}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Batas 20 pesan per menit di percakapan ini tercapai.', {
            retryAfter: 42,
          }),
      },
    });
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Halo' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const alert = await chat().findByText(k.limitedTitle);
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Batas 20 pesan per menit');
    expect(chat().getByRole('button', { name: '0:42' })).toBeDisabled();
    expect(chat().getByText(k.notSent)).toBeVisible();
    // Item outbox (pesan "failed" dari server juga punya "Kirim ulang"): yang terakhir = outbox.
    expect(chat().getAllByRole('button', { name: k.resend }).at(-1)).toBeEnabled();
  });

  it('423 rem darurat: banner pengiriman dihentikan', async () => {
    await openChat(open.id, {
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: open.id })}`]: () =>
          apiError(423, 'SENDING_PAUSED', 'Pengiriman sedang dihentikan oleh rem darurat.'),
      },
    });
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Halo' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await chat().findByText(k.pausedTitle)).toBeVisible();
  });

  it('409 WINDOW_CLOSED: percakapan diambil ulang', async () => {
    const { api } = await openChat(open.id, {
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: open.id })}`]: () =>
          apiError(409, 'WINDOW_CLOSED', 'Sesi 24 jam sudah habis.'),
      },
    });
    const before = api.requests.filter((request) =>
      request.path.endsWith(`/conversations/${open.id}`),
    ).length;
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Halo' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(
        api.requests.filter((request) => request.path.endsWith(`/conversations/${open.id}`)).length,
      ).toBeGreaterThan(before),
    );
  });

  it('di luar jendela 24 jam: composer diganti penjelasan + "Kirim template" nonaktif', async () => {
    await openChat(closed.id);
    expect(chat().queryByRole('textbox', { name: k.label })).toBeNull();
    expect(chat().getByText(k.windowClosedTitle)).toBeVisible();
    const template = chat().getByRole('button', { name: new RegExp(k.sendTemplate) });
    expect(template).toBeDisabled();
    expect(template).toHaveAccessibleDescription(k.templateSoon);
    // Pesan di luar jendela tidak bisa dibalas/diberi reaksi.
    expect(chat().queryByRole('button', { name: t.inbox.actions.open })).toBeNull();
  });

  it('Teknisi tanpa inbox.assign tidak melihat "Ambil chat"; CS bisa mengambil chat', async () => {
    const first = await openChat(open.id, { session: fakeSession('teknisi') });
    expect(chat().queryByRole('button', { name: k.claim })).toBeNull();
    first.unmount();

    const { api } = await openChat(open.id, { session: fakeSession('cs') });
    fireEvent.click(chat().getByRole('button', { name: k.claim }));
    await waitFor(() =>
      expect(api.requests.some((request) => request.path.endsWith('/claim'))).toBe(true),
    );
    await waitFor(() => expect(chat().queryByRole('button', { name: k.claim })).toBeNull());
  });

  it('pesan gagal yang retryable: "Kirim ulang" memanggil endpoint retry', async () => {
    const { api } = await openChat();
    fireEvent.click(chat().getByRole('button', { name: new RegExp(k.resend) }));
    await waitFor(() =>
      expect(
        api.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.path === apiPath(API_ROUTES.inbox.retry, { messageId: failed.id }),
        ),
      ).toBe(true),
    );
  });

  it('nama agen pengirim tampil dari daftar agen', async () => {
    await openChat();
    expect(await chat().findByText('Citra')).toBeVisible();
  });
});

describe('media pesan', () => {
  it('gambar dimuat lewat fetch ber-CSRF → object URL (bukan src ke API)', async () => {
    const { api } = await openChat();
    const image = await chat().findByRole('img', {
      name: t.inbox.media.imageAlt('Lampu LOS merah'),
    });
    expect(image.getAttribute('src')).toMatch(/^blob:/);
    const request = api.requests.find(
      (entry) => entry.path === apiPath(API_ROUTES.inbox.media, { messageId: photo.id }),
    );
    expect(request?.headers['x-csrf-token']).toBeTruthy();
    // Dokumen: kartu unduh, nama berkas sebagai teks.
    expect(chat().getByText('<b>tagihan</b>.pdf')).toBeVisible();
    expect(chat().getByRole('button', { name: new RegExp(t.inbox.media.download) })).toBeEnabled();
  });

  it('nama unduhan dari Content-Disposition server (RFC 5987), dibersihkan', () => {
    expect(
      filenameFromDisposition(`attachment; filename="a.bin"; filename*=UTF-8''tagihan%20nov.pdf`),
    ).toBe('tagihan nov.pdf');
    expect(filenameFromDisposition('attachment; filename="../../rahasia.txt"')).toBe(
      '.._.._rahasia.txt',
    );
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

describe('logika composer', () => {
  it('jenis & batas lampiran', () => {
    const file = (name: string, type: string, size: number) =>
      Object.defineProperty(new File(['x'], name, { type }), 'size', { value: size });
    expect(guessMediaKind({ name: 'a.jpg', type: 'image/jpeg' })).toBe('image');
    expect(guessMediaKind({ name: 'laporan.docx', type: '' })).toBe('document');
    expect(guessMediaKind({ name: 'a.exe', type: 'application/x-msdownload' })).toBeNull();
    expect(checkAttachment(file('a.jpg', 'image/jpeg', 6 * 1024 * 1024))).toBe(
      k.fileTooLarge('5 MB'),
    );
    expect(checkAttachment(file('a.exe', 'application/x-msdownload', 10))).toBe(k.fileUnsupported);
    expect(checkAttachment(file('a.png', 'image/png', 1000))).toBeNull();
  });

  it('pesan keluar baru bisa dibalas setelah sampai di WhatsApp; reaksi per arah', () => {
    expect(isActionable(fakeMessage())).toBe(true);
    expect(isActionable(fakeMessage({ direction: 'outbound', status: 'pending' }))).toBe(false);
    expect(isActionable(fakeMessage({ direction: 'outbound', status: 'delivered' }))).toBe(true);
    const target = fakeMessage();
    const model = buildTimeline([
      target,
      fakeMessage({ type: 'reaction', reaction: { emoji: '👍', messageId: target.id } }),
      fakeMessage({
        type: 'reaction',
        direction: 'outbound',
        reaction: { emoji: '🙏', messageId: target.id },
      }),
    ]);
    expect(model.reactions.get(target.id)).toEqual({ in: '👍', out: '🙏' });
  });

  it('event conversation.removed membuang chat yang sedang terbuka', async () => {
    await openChat();
    act(() => {
      FakeSocket.latest()?.receive({ type: 'hello', heartbeatSeconds: 30 });
      FakeSocket.latest()?.receive({ type: 'conversation.removed', conversationId: open.id });
    });
    expect(await chat().findByRole('heading', { name: t.inbox.chat.notFoundTitle })).toBeVisible();
  });
});
