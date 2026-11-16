/**
 * Review keamanan Fase 2 — penanganan chat & template "/" di web
 * (docs/security-reviews/2026-11-18-fase2-penanganan-template-web.md). Penjaga regresi: isi template
 * dari server tetap teks dan hanya diisi SERVER, Teknisi tidak memanggil API agen/kelola template,
 * Blob media dibungkus tipe daftar putih, cache media dibatasi byte.
 */
import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { fakeSession, json } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeConversation,
  fakeMessage,
  fakeQuickReply,
} from '../../test/fake-inbox';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { CACHE_MAX_BYTES, safeBlob } from './message-media';

const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const k = t.inbox.compose;

const served = fakeConversation({
  status: 'served',
  assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
  windowExpiresAt: inFuture(5 * HOUR),
});
const hostile = fakeQuickReply({
  shortcut: 'promo',
  title: '<b>Promo</b>',
  body: '<img src=x onerror=alert(1)> Halo {nama}, saya {agen}. https://contoh.test',
});

const inbox = {
  conversations: [served],
  messages: { [served.id]: [fakeMessage({ text: 'Halo kak', createdAt: inFuture(-HOUR) })] },
  channels: [fakeChannelSummary()],
  agents: [],
  quickReplies: [hostile],
};

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

describe('template "/"', () => {
  it('isi & judul template tampil sebagai teks; variabel diisi SERVER (bukan klien)', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const filled = 'Halo Budi, saya Rina.';
    const { api } = await renderApp(`/inbox?chat=${served.id}`, {
      inbox,
      routes: {
        [`POST ${apiPath(API_ROUTES.quickReplies.use, { quickReplyId: hostile.id })}`]: () =>
          json({ text: filled }),
      },
    });
    await chat().findByText('Halo kak');
    const box = chat().getByRole('textbox', { name: k.label });
    fireEvent.change(box, { target: { value: '/' } });
    const list = within(await chat().findByRole('listbox', { name: t.inbox.quickReplies.title }));
    expect(list.getByText(hostile.body)).toBeVisible();
    expect(list.getByText('<b>Promo</b>')).toBeVisible();
    expect(document.querySelector('img[src="x"], b')).toBeNull();
    expect(document.querySelector('a[href*="contoh.test"]')).toBeNull();

    fireEvent.keyDown(box, { key: 'Enter' });
    // Teks composer = jawaban server apa adanya (klien tidak mengganti {nama}/{agen} sendiri).
    await waitFor(() => expect(box).toHaveValue(filled));
    const used = api.requests.find(
      (request) =>
        request.path === apiPath(API_ROUTES.quickReplies.use, { quickReplyId: hostile.id }),
    );
    expect(used?.headers['x-csrf-token']).toBeTruthy();
  });
});

describe('izin', () => {
  it('Teknisi: tidak memanggil daftar agen maupun API kelola template', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp(`/inbox?chat=${served.id}`, {
      inbox,
      session: fakeSession('teknisi', 'Arya Teknisi'),
    });
    await chat().findByText('Halo kak');
    expect(api.requests.some((request) => request.path === API_ROUTES.inbox.agents)).toBe(false);
  });

  it('Teknisi dialihkan dari Pengaturan → Template percakapan tanpa memanggil API template', async () => {
    const { router, api } = await renderApp('/pengaturan/template-percakapan', {
      inbox,
      session: fakeSession('teknisi', 'Arya Teknisi'),
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    expect(
      api.requests.some((request) => request.path.startsWith(API_ROUTES.quickReplies.list)),
    ).toBe(false);
  });
});

describe('media (putaran 2 composer)', () => {
  it('Blob dibungkus tipe daftar putih: SVG/HTML/tak dikenal → octet-stream', () => {
    expect(safeBlob(new Blob(['<svg/>'], { type: 'image/svg+xml' })).type).toBe(
      'application/octet-stream',
    );
    expect(safeBlob(new Blob(['<p>'], { type: 'text/html' })).type).toBe(
      'application/octet-stream',
    );
    expect(safeBlob(new Blob(['x'])).type).toBe('application/octet-stream');
    expect(safeBlob(new Blob(['x'], { type: 'IMAGE/PNG; charset=binary' })).type).toBe('image/png');
    expect(CACHE_MAX_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
  });
});
