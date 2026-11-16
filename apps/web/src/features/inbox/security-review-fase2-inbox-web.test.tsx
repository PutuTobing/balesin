/**
 * Review keamanan Fase 2 — web inbox (docs/security-reviews/2026-11-17-fase2-inbox-web.md).
 * Penjaga regresi (`it`) + temuan yang dikunci `it.fails`. API & WebSocket tiruan (jsdom).
 */
import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeContact,
  fakeConversation,
  fakeMessage,
} from '../../test/fake-inbox';
import { FakeSocket } from '../../test/fake-socket';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { inboxKeys } from './inbox-queries';

const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const SECRET_TEXT = 'ISI-CHAT-RAHASIA-PELANGGAN-5512';

const evil = fakeConversation({
  unreadCount: 0,
  windowExpiresAt: inFuture(HOUR * 5),
  contact: {
    ...fakeConversation().contact,
    id: 'd0000000-0000-4000-8000-0000000000e1',
    number: 7,
    displayName: '<a href="javascript:alert(1)">Admin Sky Tech</a>',
    phone: '+6281299990000',
  },
});

const hostileMessages = [
  fakeMessage({
    id: 'e0000000-0000-4000-8000-0000000000e1',
    text: `${SECRET_TEXT} <img src=x onerror=alert(1)> https://phishing.contoh/login`,
    createdAt: inFuture(-3 * HOUR),
  }),
  fakeMessage({
    id: 'e0000000-0000-4000-8000-0000000000e2',
    type: 'document',
    text: null,
    media: {
      kind: 'document',
      mimeType: 'application/pdf',
      filename: '<b>tagihan</b>.pdf',
      voice: false,
      animated: false,
    },
    createdAt: inFuture(-2 * HOUR),
  }),
  fakeMessage({
    id: 'e0000000-0000-4000-8000-0000000000e3',
    text: 'Dari iklan',
    referral: {
      sourceType: 'ad',
      // Server sudah menyaring ke http(s); web tetap harus menampilkannya sebagai teks.
      sourceUrl: 'https://promo.contoh/klaim?x=<script>',
      headline: '<i>Promo</i>',
      body: 'Klik di sini',
    },
    createdAt: inFuture(-HOUR),
  }),
  fakeMessage({
    id: 'e0000000-0000-4000-8000-0000000000e4',
    type: 'location',
    text: null,
    location: {
      latitude: -6.2,
      longitude: 106.8,
      name: '<u>Kantor</u>',
      address: 'javascript:alert(1)',
    },
    createdAt: inFuture(-30 * 60_000),
  }),
  fakeMessage({
    id: 'e0000000-0000-4000-8000-0000000000e5',
    type: 'interactive',
    text: null,
    interactive: {
      kind: 'button_reply',
      id: 'x',
      title: '<a href=//evil>Bayar</a>',
      description: null,
    },
    createdAt: inFuture(-10 * 60_000),
  }),
];

const inbox = {
  conversations: [evil],
  messages: { [evil.id]: hostileMessages },
  contacts: [
    fakeContact({
      id: evil.contact.id,
      displayName: evil.contact.displayName,
      name: null,
      profileName: '<a href="javascript:alert(1)">Admin Sky Tech</a>',
      phone: evil.contact.phone,
    }),
  ],
  channels: [fakeChannelSummary()],
};

function chatRegion() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

describe('konten pelanggan tidak pernah menjadi HTML/tautan aktif', () => {
  it('nama, teks, nama berkas, iklan, lokasi, balasan tombol → teks; tanpa <a>/<img> dari data', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${evil.id}`, { inbox });
    const chat = chatRegion();
    expect(await chat.findByText(new RegExp(SECRET_TEXT))).toHaveAttribute('dir', 'auto');
    expect((await chat.findAllByText(/promo\.contoh/)).length).toBeGreaterThan(0);

    const root = document.body;
    // Tidak ada tautan yang berasal dari data pelanggan (tautan aplikasi sendiri: href relatif "/…").
    for (const anchor of root.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') ?? '';
      // Hanya rute aplikasi ("/…") dan tautan lewati-ke-konten ("#…").
      expect(href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'))).toBe(true);
    }
    expect(root.querySelector('img[src="x"], script, b, i, u')).toBeNull();
    // Tidak ada ATRIBUT yang memuat `javascript:` (teksnya sendiri boleh tampil apa adanya).
    for (const element of root.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.value.toLowerCase()).not.toContain('javascript:');
      }
    }
    expect(chat.getAllByText(/Admin Sky Tech/).length).toBeGreaterThan(0);
  });
});

describe('sesi berakhir / keluar', () => {
  it('WebSocket ditutup 4401 → halaman masuk, cache inbox dibuang, tidak menyambung ulang', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api, router, queryClient } = await renderApp(`/inbox?chat=${evil.id}`, { inbox });
    await chatRegion().findByText(new RegExp(SECRET_TEXT));
    const socket = FakeSocket.latest();
    expect(socket).toBeDefined();

    api.on(`GET ${API_ROUTES.auth.me}`, () =>
      apiError(401, 'UNAUTHENTICATED', 'Sesi kamu sudah berakhir.'),
    );
    const before = FakeSocket.instances.length;
    act(() => socket?.serverClose(4401));

    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
    await waitFor(() =>
      expect(queryClient.getQueryCache().findAll({ queryKey: inboxKeys.all })).toEqual([]),
    );
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET_TEXT);
    expect(FakeSocket.instances.length).toBe(before);
  });

  it('data inbox tidak ditulis ke storage, URL, atau konsol', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { router } = await renderApp(`/inbox?chat=${evil.id}`, { inbox });
    await chatRegion().findByText(new RegExp(SECRET_TEXT));
    const stored = JSON.stringify({ ...window.localStorage, ...window.sessionStorage });
    expect(stored).not.toContain(SECRET_TEXT);
    expect(stored).not.toContain(evil.contact.phone);
    expect(JSON.stringify(router.state.location)).not.toContain(evil.contact.phone);
    expect(Object.keys(router.state.location.search as object).sort()).toEqual(['chat']);
  });

  it('?chat= bukan UUID diabaikan (tidak dipakai sebagai path API)', async () => {
    const { api, router } = await renderApp('/inbox?chat=..%2F..%2Fauth%2Flogout', { inbox });
    await screen.findByRole('region', { name: t.inbox.listLabel });
    expect(router.state.location.search).not.toHaveProperty('chat');
    expect(api.requests.some((request) => request.path.includes('..'))).toBe(false);
    expect(api.requests.some((request) => request.path === API_ROUTES.auth.logout)).toBe(false);
  });
});

describe('R1 — 404 saat chat terbuka: sebagian cache lama tetap tersimpan', () => {
  // `forgetConversation` membuang pesan + baris daftar, tetapi query detail percakapan (nama,
  // nomor, cuplikan pesan terakhir) dan kontak (nomor, nama profil) tetap di cache sampai gc.
  it.fails('detail percakapan & kontak yang sudah di luar cakupan dibuang dari cache', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api, queryClient } = await renderApp(`/inbox?chat=${evil.id}`, { inbox });
    await chatRegion().findByText(new RegExp(SECRET_TEXT));
    await waitFor(() =>
      expect(queryClient.getQueryData(inboxKeys.contact(evil.contact.id))).toBeDefined(),
    );

    const gone = () => apiError(404, 'NOT_FOUND', 'Data tidak ditemukan.');
    api.on(`GET ${apiPath(API_ROUTES.inbox.conversation, { conversationId: evil.id })}`, gone);
    api.on(`GET ${apiPath(API_ROUTES.inbox.messages, { conversationId: evil.id })}`, gone);
    api.on(`GET ${apiPath(API_ROUTES.inbox.contact, { contactId: evil.contact.id })}`, gone);
    act(() => {
      FakeSocket.latest()?.receive({ type: 'hello', heartbeatSeconds: 30 });
      FakeSocket.latest()?.receive({
        type: 'conversation.updated',
        conversationId: evil.id,
        status: 'served',
        assigneeUserId: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0009',
        unreadCount: 0,
        lastMessageAt: new Date().toISOString(),
        windowExpiresAt: null,
      });
    });
    await chatRegion().findByRole('heading', { name: t.inbox.chat.notFoundTitle });

    expect(queryClient.getQueryData(inboxKeys.conversation(evil.id))).toBeUndefined();
    expect(queryClient.getQueryData(inboxKeys.contact(evil.contact.id))).toBeUndefined();
  });
});
