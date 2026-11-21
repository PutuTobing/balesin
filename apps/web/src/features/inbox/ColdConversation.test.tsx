import { API_ROUTES, CONVERSATION_STALE_AFTER_MS, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, fakeSession } from '../../test/fake-api';
import { fakeChannelSummary, fakeConversation, fakeMessage } from '../../test/fake-inbox';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { conversationIsCold } from './inbox-time';

/**
 * Percakapan TERBUKA yang "dingin" (pelanggan diam > 7 hari, audit akhir P2-R2) dan kirim ulang
 * pesan broadcast (409): tanpa `inbox.initiate`, template & kotak tulis Email/Telegram nonaktif
 * dengan alasan terbaca; pesan server tampil apa adanya.
 */
const k = t.inbox.compose;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const TELEGRAM = {
  id: '6f1c2a90-1111-4c4c-9a9a-0000000000b1',
  name: 'Bot CS',
  type: 'telegram' as const,
};

const coldWa = fakeConversation({
  id: 'c0000000-0000-4000-8000-00000000c001',
  status: 'served',
  lastInboundAt: ago(8 * DAY),
  windowExpiresAt: ago(7 * DAY),
  windowOpen: false,
});
const coldTelegram = fakeConversation({
  id: 'c0000000-0000-4000-8000-00000000c002',
  status: 'served',
  channel: TELEGRAM,
  windowApplies: false,
  windowExpiresAt: null,
  windowOpen: true,
  lastInboundAt: ago(8 * DAY),
});
const warmTelegram = {
  ...coldTelegram,
  id: 'c0000000-0000-4000-8000-00000000c003',
  lastInboundAt: ago(DAY),
};

const inbound = fakeMessage({ text: 'Pesan lama pelanggan', createdAt: ago(8 * DAY) });
const broadcastFailed = fakeMessage({
  id: 'e0000000-0000-4000-8000-00000000b001',
  direction: 'outbound',
  senderKind: 'broadcast',
  text: 'Pengingat tagihan',
  status: 'failed',
  failure: { reason: 'delivery_unknown', code: null, message: 'Gagal terkirim.', retryable: true },
  createdAt: ago(DAY),
});
const agentFailed = fakeMessage({
  id: 'e0000000-0000-4000-8000-00000000b002',
  direction: 'outbound',
  senderKind: 'agent',
  text: 'Sudah kami cek',
  status: 'failed',
  failure: { reason: 'delivery_unknown', code: null, message: 'Gagal terkirim.', retryable: true },
  createdAt: ago(DAY),
});

const inbox = {
  conversations: [coldWa, coldTelegram, warmTelegram],
  messages: {
    [coldWa.id]: [inbound, broadcastFailed, agentFailed],
    [coldTelegram.id]: [inbound],
    [warmTelegram.id]: [inbound],
  },
  channels: [fakeChannelSummary()],
};

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function openChat(id: string, options: Parameters<typeof renderApp>[1] = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${id}`, { inbox, ...options });
  await chat().findByText('Pesan lama pelanggan');
  return view;
}

describe('percakapan dingin (> 7 hari) tanpa inbox.initiate', () => {
  it('logika: diam ≥ 7 hari atau belum pernah = dingin', () => {
    const now = Date.parse('2026-11-21T12:00:00.000Z');
    const at = (offset: number) => ({ lastInboundAt: new Date(now - offset).toISOString() });
    expect(conversationIsCold(at(CONVERSATION_STALE_AFTER_MS - 60_000), now)).toBe(false);
    expect(conversationIsCold(at(CONVERSATION_STALE_AFTER_MS), now)).toBe(true);
    expect(conversationIsCold({ lastInboundAt: null }, now)).toBe(true);
  });

  it('WhatsApp: "Kirim template" nonaktif dengan alasan terbaca (CS)', async () => {
    await openChat(coldWa.id, { session: fakeSession('cs') });
    const reason = chat().getByText(k.coldNoInitiate);
    const button = chat().getByRole('button', { name: k.sendTemplate });
    expect(button).toBeDisabled();
    expect(button.getAttribute('aria-describedby')).toContain(reason.id);
  });

  it('WhatsApp: Owner (punya inbox.initiate) tetap bisa kirim template', async () => {
    await openChat(coldWa.id);
    expect(chat().queryByText(k.coldNoInitiate)).toBeNull();
    expect(chat().getByRole('button', { name: k.sendTemplate })).toBeEnabled();
  });

  it('Telegram dingin: kotak tulis diganti penjelasan (CS); yang masih hangat tetap bisa dibalas', async () => {
    await openChat(coldTelegram.id, { session: fakeSession('cs') });
    expect(chat().getByText(k.coldNoInitiate)).toBeVisible();
    expect(chat().queryByRole('textbox', { name: k.label })).toBeNull();
  });

  it('Telegram < 7 hari: kotak tulis tetap ada (CS)', async () => {
    await openChat(warmTelegram.id, { session: fakeSession('cs') });
    expect(chat().getByRole('textbox', { name: k.label })).toBeVisible();
    expect(chat().queryByText(k.coldNoInitiate)).toBeNull();
  });
});

describe('kirim ulang', () => {
  it('pesan broadcast gagal: tanpa "Kirim ulang", ada penjelasan', async () => {
    await openChat(coldWa.id);
    expect(chat().getByText(k.broadcastNoResend)).toBeVisible();
    // Satu-satunya tombol "Kirim ulang" milik pesan agen.
    expect(chat().getAllByRole('button', { name: new RegExp(k.resend) })).toHaveLength(1);
  });

  it('ditolak server (403): pesan server tampil apa adanya', async () => {
    const message =
      'Pelanggan tidak mengirim pesan dalam 7 hari terakhir. Mengirim template atau pesan baru ke percakapan ini butuh izin memulai percakapan.';
    const { api } = await openChat(coldWa.id, {
      session: fakeSession('cs'),
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.retry, { messageId: agentFailed.id })}`]: () =>
          apiError(403, 'FORBIDDEN', message),
      },
    });
    fireEvent.click(chat().getByRole('button', { name: new RegExp(k.resend) }));
    await waitFor(() =>
      expect(api.requests.some((request) => request.path.endsWith('/retry'))).toBe(true),
    );
    expect(await chat().findByText(message)).toBeVisible();
  });
});
