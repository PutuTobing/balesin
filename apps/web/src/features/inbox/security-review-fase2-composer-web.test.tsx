/**
 * Review keamanan Fase 2 — composer web (docs/security-reviews/2026-11-18-fase2-composer-web.md).
 * Penjaga regresi (`it`) + temuan yang dikunci `it.fails`. API & WebSocket tiruan (jsdom).
 */
import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, fakeSession } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeContact,
  fakeConversation,
  fakeMessage,
} from '../../test/fake-inbox';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const k = t.inbox.compose;
const DRAFT = 'DRAF-RAHASIA-AGEN-A-5519';

const open = fakeConversation({ status: 'unserved', windowExpiresAt: inFuture(5 * HOUR) });
const inbound = fakeMessage({ text: 'Halo kak, internet mati', createdAt: inFuture(-HOUR) });
const photo = fakeMessage({
  id: 'e0000000-0000-4000-8000-0000000000f1',
  type: 'image',
  text: 'Foto KTP',
  media: { kind: 'image', mimeType: 'image/jpeg', filename: null, voice: false, animated: false },
  mediaAvailable: true,
  createdAt: inFuture(-20 * 60_000),
});

const inbox = {
  conversations: [open],
  messages: { [open.id]: [inbound, photo] },
  contacts: [fakeContact({ id: open.contact.id })],
  channels: [fakeChannelSummary()],
  agents: [],
};

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function openChat(options: Parameters<typeof renderApp>[1] = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${open.id}`, { inbox, ...options });
  await chat().findByText('Halo kak, internet mati');
  return view;
}

async function logout() {
  fireEvent.keyDown(
    await screen.findByRole('button', { name: t.auth.userMenu.open('Rina Kartika') }),
    { key: 'Enter' },
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: t.auth.userMenu.logout }));
}

describe('penjaga regresi', () => {
  it('object URL media dicabut saat chat ditutup', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { router } = await openChat();
    const image = await chat().findByRole('img', { name: t.inbox.media.imageAlt('Foto KTP') });
    const url = image.getAttribute('src');
    expect(url).toMatch(/^blob:/);
    await act(() => router.navigate({ to: '/inbox', search: {} }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(url));
  });

  it('error server ditampilkan sebagai teks (tanpa HTML)', async () => {
    await openChat({
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: open.id })}`]: () =>
          apiError(400, 'VALIDATION_ERROR', '<img src=x onerror=alert(1)> Pesan ditolak.'),
      },
    });
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: 'Halo' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(
      (await chat().findAllByText(/<img src=x onerror=alert\(1\)> Pesan ditolak\./)).length,
    ).toBeGreaterThan(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});

describe('R1 — cache modul (outbox & media) tidak dibuang saat keluar', () => {
  // `outbox.ts` (draf/teks gagal kirim + File) dan `message-media.ts` (≤ 40 Blob media, mis. foto
  // KTP) hidup di variabel modul. `clearAppData` hanya membuang cache Query; `resetOutbox` dan
  // `clearMediaCache` hanya dipanggil tes. Pengguna berikutnya di tab yang sama (komputer bersama)
  // melihat draf gagal milik pengguna sebelumnya dan bisa "Kirim ulang" atas namanya sendiri.
  it.fails(
    'setelah keluar, draf gagal kirim pengguna sebelumnya tidak tampil untuk pengguna berikutnya',
    async () => {
      await openChat({
        routes: {
          [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: open.id })}`]: () =>
            apiError(503, 'SERVICE_UNAVAILABLE', 'Server sibuk.'),
        },
      });
      const box = chat().getByRole('textbox', { name: k.label });
      fireEvent.change(box, { target: { value: DRAFT } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(await chat().findByText(k.notSent)).toBeVisible();

      await logout();
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeVisible());
      cleanup();

      await openChat({ session: fakeSession('cs', 'Dewi CS') });
      expect(chat().queryByText(DRAFT)).toBeNull(); // saat ini draf A tampil + "Kirim ulang"
    },
  );

  it.fails('setelah keluar, media yang sudah diunduh tidak dipakai ulang dari memori', async () => {
    const first = await openChat();
    await chat().findByRole('img', { name: t.inbox.media.imageAlt('Foto KTP') });
    const mediaPath = apiPath(API_ROUTES.inbox.media, { messageId: photo.id });
    expect(first.api.requests.filter((request) => request.path === mediaPath)).toHaveLength(1);

    await logout();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeVisible());
    cleanup();

    const second = await openChat({ session: fakeSession('cs', 'Dewi CS') });
    await chat().findByRole('img', { name: t.inbox.media.imageAlt('Foto KTP') });
    // Cache sudah dibuang → pengguna kedua mengunduh lewat server (cakupannya diperiksa ulang).
    expect(second.api.requests.filter((request) => request.path === mediaPath)).toHaveLength(1); // saat ini 0
  });
});
