import { API_ROUTES, EMAIL_SENDER_VERIFICATION_LABELS, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { json } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeContact,
  fakeConversation,
  fakeMessage,
} from '../../test/fake-inbox';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { replyWindowOpen, windowExpiry } from './inbox-time';

const k = t.inbox.compose;
const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

const TELEGRAM = {
  id: '6f1c2a90-1111-4c4c-9a9a-0000000000b1',
  name: 'Bot CS',
  type: 'telegram' as const,
};
const EMAIL = {
  id: '6f1c2a90-1111-4c4c-9a9a-0000000000b2',
  name: 'Email CS',
  type: 'email' as const,
};
const MESSENGER = {
  id: '6f1c2a90-1111-4c4c-9a9a-0000000000b3',
  name: 'Halaman FB',
  type: 'messenger' as const,
};

const telegram = fakeConversation({
  channel: TELEGRAM,
  windowApplies: false,
  windowExpiresAt: null,
  windowOpen: true,
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000f1',
    number: 11,
    displayName: 'Andi',
    nameSource: 'channel',
    phone: null,
    waUsername: null,
    channelHandle: '@andi_dps',
  },
});
const email = fakeConversation({
  channel: EMAIL,
  windowApplies: false,
  windowExpiresAt: null,
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000f2',
    number: 12,
    displayName: 'Rudi',
    nameSource: 'channel',
    phone: null,
    waUsername: null,
    channelHandle: 'rudi@contoh.id',
  },
});
const messenger = fakeConversation({
  channel: MESSENGER,
  windowApplies: true,
  windowExpiresAt: inFuture(-HOUR),
  windowOpen: false,
  status: 'served',
});

const emailMessage = fakeMessage({
  text: 'Mohon kirim ulang tagihan bulan ini.',
  email: {
    subject: 'Tagihan November',
    hasHtml: true,
    authWarning: true,
    senderVerification: 'fail',
    skippedAttachments: 1,
  },
  createdAt: inFuture(-HOUR),
});

const inbox = {
  conversations: [telegram, email, messenger],
  messages: {
    [telegram.id]: [fakeMessage({ text: 'Halo dari Telegram', createdAt: inFuture(-HOUR) })],
    [email.id]: [emailMessage],
    [messenger.id]: [fakeMessage({ text: 'Halo dari Messenger', createdAt: inFuture(-2 * HOUR) })],
  },
  channels: [fakeChannelSummary()],
  contacts: [
    fakeContact({
      id: telegram.contact.id,
      displayName: 'Andi',
      nameSource: 'channel',
      name: null,
      profileName: 'Andi',
      phone: null,
      channelType: 'telegram',
      channelHandle: '@andi_dps',
    }),
  ],
};

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function openChat(id: string, text: string, routes = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${id}`, { inbox, routes });
  await chat().findByText(text);
  return view;
}

describe('aturan jendela per channel', () => {
  it('Telegram/Email tanpa jendela 24 jam: selalu bisa membalas, tanpa hitung mundur', () => {
    expect(replyWindowOpen(telegram, Date.now())).toBe(true);
    expect(windowExpiry(telegram)).toBeNull();
    expect(replyWindowOpen(messenger, Date.now())).toBe(false);
  });
});

describe('inbox multi-channel', () => {
  it('daftar: penanda nama dari channel, @username, dan jenis channel', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox', { inbox });
    const list = within(await screen.findByRole('region', { name: t.inbox.listLabel }));
    await list.findByText('@andi_dps');
    expect(list.getByText('@andi_dps')).toBeVisible();
    expect(list.getByText(`(${t.inbox.item.fromChannel('Telegram')})`)).toBeInTheDocument();
    expect(
      list.getByText(`${t.inbox.item.channelType('Email')}:`, { exact: false }),
    ).toBeInTheDocument();
  });

  it('Telegram: composer tanpa template, tanpa hitung mundur', async () => {
    await openChat(telegram.id, 'Halo dari Telegram');
    expect(chat().getByRole('textbox', { name: k.label })).toBeVisible();
    expect(chat().queryByRole('button', { name: k.template })).toBeNull();
    expect(chat().getByRole('button', { name: k.interactive })).toBeVisible();
    expect(await chat().findByText(/Telegram · @andi_dps/)).toBeVisible();
  });

  it('Email: subjek, peringatan verifikasi gagal, HTML hanya di iframe sandbox', async () => {
    await openChat(email.id, 'Mohon kirim ulang tagihan bulan ini.', {
      [`GET ${apiPath(API_ROUTES.inbox.emailHtml, { messageId: emailMessage.id })}`]: () =>
        json({ html: '<p>Mohon <b>kirim ulang</b></p><script>alert(1)</script>' }),
    });
    expect(chat().getByText('Tagihan November')).toBeVisible();
    expect(chat().getByText(EMAIL_SENDER_VERIFICATION_LABELS.fail)).toBeVisible();
    expect(chat().getByText(t.inbox.email.skippedAttachments(1))).toBeVisible();
    // Email: hanya teks & lampiran.
    expect(chat().queryByRole('button', { name: k.interactive })).toBeNull();
    expect(chat().queryByRole('button', { name: k.template })).toBeNull();

    fireEvent.click(chat().getByRole('button', { name: t.inbox.email.viewHtml }));
    const dialog = await screen.findByRole('dialog', { name: t.inbox.email.htmlTitle });
    const frame = await within(dialog).findByTitle(t.inbox.email.htmlFrameTitle);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('kirim ulang');
    // HTML email tidak pernah masuk ke dokumen aplikasi.
    expect(document.body.querySelector('script')).toBeNull();
    expect(dialog.querySelector('b')).toBeNull();
  });

  it('Messenger di luar jendela: tanpa tombol "Kirim template"', async () => {
    await openChat(messenger.id, 'Halo dari Messenger');
    expect(chat().getByText(t.inbox.compose.windowClosedNoTemplateBody)).toBeVisible();
    expect(chat().queryByRole('button', { name: t.inbox.compose.sendTemplate })).toBeNull();
  });
});
