import { API_ROUTES, apiPath, type Message } from '@balesin/shared';
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
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import {
  addCopies,
  lastReplyAll,
  leftoverInput,
  newCopies,
  splitAddressInput,
  threadAddresses,
} from './email-recipients';
import {
  conversationQueryString,
  emailRecipientOptions,
  filterChips,
  withChannel,
} from './inbox-filters';

/** Tahap 9.0 — Kepada/Cc, alamat tujuan, Cc/Bcc & Balas semua di channel Email. */

const k = t.inbox.emailCopies;
const e = t.inbox.email;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const EMAIL = {
  id: '6f1c2a90-1111-4c4c-9a9a-0000000000c2',
  name: 'Email CS',
  type: 'email' as const,
};
const TELEGRAM = {
  id: '6f1c2a90-1111-4c4c-9a9a-0000000000c1',
  name: 'Bot CS',
  type: 'telegram' as const,
};
const CHANNELS = [
  fakeChannelSummary(),
  fakeChannelSummary({
    id: EMAIL.id,
    type: 'email',
    name: EMAIL.name,
    displayPhoneNumber: null,
    emailAddresses: ['cs@majujaya.co.id', 'billing@majujaya.co.id'],
  }),
  fakeChannelSummary({
    id: TELEGRAM.id,
    type: 'telegram',
    name: TELEGRAM.name,
    displayPhoneNumber: null,
    emailAddresses: [],
  }),
];

const email = fakeConversation({
  channel: EMAIL,
  windowApplies: false,
  windowExpiresAt: null,
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000e1',
    number: 21,
    displayName: 'Rudi',
    nameSource: 'channel',
    phone: null,
    waUsername: null,
    channelHandle: 'rudi@pelanggan.co.id',
  },
});
const telegram = fakeConversation({
  channel: TELEGRAM,
  windowApplies: false,
  windowExpiresAt: null,
  windowOpen: true,
  contact: {
    id: 'd0000000-0000-4000-8000-0000000000e2',
    number: 22,
    displayName: 'Andi',
    nameSource: 'channel',
    phone: null,
    waUsername: null,
    channelHandle: '@andi_dps',
  },
});

const emailBase = {
  subject: 'Tagihan ganda',
  hasHtml: false,
  authWarning: false,
  senderVerification: 'pass' as const,
  skippedAttachments: 0,
};
const inboundEmail = fakeMessage({
  text: 'Tagihan saya tertagih dua kali.',
  email: {
    ...emailBase,
    to: ['billing@majujaya.co.id', 'andi@pelanggan.co.id'],
    cc: ['sari@pelanggan.co.id'],
    bcc: [],
    recipient: 'billing@majujaya.co.id',
    replyAll: ['andi@pelanggan.co.id', 'sari@pelanggan.co.id'],
  },
  createdAt: ago(2 * HOUR),
});
const outboundEmail = fakeMessage({
  direction: 'outbound',
  senderKind: 'agent',
  status: 'delivered',
  text: 'Sudah kami koreksi.',
  email: {
    ...emailBase,
    subject: 'Re: Tagihan ganda',
    to: ['rudi@pelanggan.co.id'],
    cc: ['andi@pelanggan.co.id'],
    bcc: ['arsip@majujaya.co.id'],
    recipient: null,
    replyAll: [],
  },
  createdAt: ago(HOUR),
});

const inbox = {
  conversations: [email, telegram],
  messages: {
    [email.id]: [inboundEmail, outboundEmail],
    [telegram.id]: [fakeMessage({ text: 'Halo dari Telegram', createdAt: ago(HOUR) })],
  },
  channels: CHANNELS,
  contacts: [
    fakeContact({
      id: email.contact.id,
      displayName: 'Rudi',
      nameSource: 'channel',
      name: null,
      profileName: 'Rudi',
      phone: null,
      email: null,
      channelType: 'email',
      channelHandle: 'rudi@pelanggan.co.id',
    }),
  ],
};

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function openChat(id = email.id, options: Parameters<typeof renderApp>[1] = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${id}`, { inbox, ...options });
  await chat().findByText(id === email.id ? 'Sudah kami koreksi.' : 'Halo dari Telegram');
  return view;
}

function sentBody(api: Awaited<ReturnType<typeof renderApp>>['api']) {
  return api.requests.find(
    (request) =>
      request.method === 'POST' &&
      request.path === apiPath(API_ROUTES.inbox.messages, { conversationId: email.id }),
  )?.body as Record<string, unknown> | undefined;
}

function typeAddress(field: 'Cc' | 'Bcc', value: string) {
  const input = chat().getByRole('textbox', { name: k.fieldLabel(field) });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}

// ── Logika murni ────────────────────────────────────────────────────────────

describe('alamat Cc/Bcc (logika)', () => {
  const context = { customer: 'rudi@pelanggan.co.id', own: ['cs@majujaya.co.id'] };

  it('memecah ketikan/tempelan: koma, titik koma, spasi, baris baru, bentuk Nama <alamat>', () => {
    expect(splitAddressInput('a@x.id, b@x.id;c@x.id\nAndi <andi@x.id> "d@x.id"  e@x.id')).toEqual([
      'a@x.id',
      'b@x.id',
      'c@x.id',
      'andi@x.id',
      'd@x.id',
      'e@x.id',
    ]);
  });

  it('huruf kecil, duplikat dibuang diam-diam, Cc tidak diulang di Bcc', () => {
    const first = addCopies(
      { cc: [], bcc: [] },
      'cc',
      ['Andi@Pelanggan.co.id', 'andi@pelanggan.co.id'],
      context,
    );
    expect(first.cc).toEqual(['andi@pelanggan.co.id']);
    expect(first.rejected).toEqual([]);
    const second = addCopies(first, 'bcc', ['ANDI@pelanggan.co.id'], context);
    expect(second.bcc).toEqual([]);
    expect(second.added).toEqual([]);
  });

  it('menolak format salah, alamat pelanggan, alamat channel sendiri; sisa ketikan = yang tidak sah', () => {
    const result = addCopies(
      { cc: [], bcc: [] },
      'cc',
      ['salah', 'rudi@pelanggan.co.id', 'CS@majujaya.co.id', 'ok@x.id'],
      context,
    );
    expect(result.cc).toEqual(['ok@x.id']);
    expect(result.rejected.map((item) => item.reason)).toEqual(['invalid', 'customer', 'self']);
    expect(leftoverInput(result)).toBe('salah');
  });

  it('alamat channel Email lain organisasi ditolak (server juga menolak 400)', () => {
    const result = addCopies({ cc: [], bcc: [] }, 'bcc', ['Tagihan@Lain.co.id'], {
      ...context,
      others: ['tagihan@lain.co.id'],
    });
    expect(result.bcc).toEqual([]);
    expect(result.rejected).toEqual([{ address: 'tagihan@lain.co.id', reason: 'otherChannel' }]);
  });

  it('maks. 10 gabungan Cc + Bcc', () => {
    const cc = Array.from({ length: 6 }, (_, index) => `cc${String(index)}@x.id`);
    const bcc = Array.from({ length: 4 }, (_, index) => `bcc${String(index)}@x.id`);
    const result = addCopies({ cc, bcc }, 'cc', ['lebih@x.id'], context);
    expect(result.cc).toHaveLength(6);
    expect(result.rejected).toEqual([{ address: 'lebih@x.id', reason: 'limit' }]);
  });

  it('alamat di utas: pelanggan, To/Cc masuk, To/Cc keluar yang terkirim (Bcc & gagal tidak)', () => {
    const failed = fakeMessage({
      direction: 'outbound',
      status: 'failed',
      email: { ...emailBase, to: ['rudi@pelanggan.co.id'], cc: ['gagal@x.id'], bcc: [] },
    });
    const known = threadAddresses([inboundEmail, outboundEmail, failed], 'rudi@pelanggan.co.id');
    expect([...known].sort()).toEqual(
      [
        'andi@pelanggan.co.id',
        'billing@majujaya.co.id',
        'rudi@pelanggan.co.id',
        'sari@pelanggan.co.id',
      ].sort(),
    );
    expect(
      newCopies(
        { cc: ['sari@pelanggan.co.id', 'baru@x.id'], bcc: ['arsip@majujaya.co.id'] },
        known,
      ),
    ).toEqual(['baru@x.id', 'arsip@majujaya.co.id']);
  });

  it('Balas semua = replyAll email MASUK terakhir', () => {
    const older = fakeMessage({ email: { ...emailBase, replyAll: ['lama@x.id'] } });
    expect(lastReplyAll([older, inboundEmail, outboundEmail] as Message[])).toEqual([
      'andi@pelanggan.co.id',
      'sari@pelanggan.co.id',
    ]);
    expect(lastReplyAll([outboundEmail])).toEqual([]);
  });
});

describe('saringan Alamat tujuan (logika)', () => {
  it('pilihan hanya dari channel Email dengan > 1 alamat; ikut saringan channel', () => {
    expect(emailRecipientOptions(CHANNELS, undefined)).toEqual([
      'cs@majujaya.co.id',
      'billing@majujaya.co.id',
    ]);
    expect(emailRecipientOptions(CHANNELS, TELEGRAM.id)).toEqual([]);
    expect(
      withChannel({ emailRecipient: 'billing@majujaya.co.id' }, TELEGRAM.id, CHANNELS),
    ).toEqual({ channelId: TELEGRAM.id, emailRecipient: undefined });
    expect(conversationQueryString({ emailRecipient: 'billing@majujaya.co.id' })).toBe(
      '?emailRecipient=billing%40majujaya.co.id',
    );
    expect(
      filterChips({ emailRecipient: 'billing@majujaya.co.id' }, { channels: CHANNELS, agents: [] }),
    ).toEqual([
      {
        key: 'emailRecipient',
        label: t.inbox.filters.chipEmailRecipient('billing@majujaya.co.id'),
      },
    ]);
  });
});

// ── Ruang chat ──────────────────────────────────────────────────────────────

describe('kepala email: Kepada, Cc, Bcc, alamat tujuan', () => {
  it('email masuk lewat alias: Kepada + Cc + "Dikirim ke billing@…"; keluar: Cc + Bcc hanya tim', async () => {
    await openChat();
    const values = chat()
      .getAllByLabelText(e.recipients)
      .flatMap((list) => Array.from(list.querySelectorAll('dd')));
    expect(values.map((item) => item.textContent)).toEqual([
      'billing@majujaya.co.id, andi@pelanggan.co.id',
      'sari@pelanggan.co.id',
      'rudi@pelanggan.co.id',
      'andi@pelanggan.co.id',
      'arsip@majujaya.co.id',
    ]);
    const via = chat().getByText('billing@majujaya.co.id', { selector: 'strong' });
    expect(via.closest('p')).toHaveTextContent(`${e.sentTo} billing@majujaya.co.id`);
    expect(chat().getByText(e.bccTeamOnly)).toBeInTheDocument();
  });

  it('banyak penerima: ringkas dengan "+n lainnya", bisa dibuka-tutup', async () => {
    const many = fakeMessage({
      text: 'Rapat tagihan.',
      email: {
        ...emailBase,
        to: ['cs@majujaya.co.id', 'a@x.id', 'b@x.id', 'c@x.id'],
        cc: ['d@x.id'],
        bcc: [],
        recipient: 'cs@majujaya.co.id',
        replyAll: ['a@x.id', 'b@x.id', 'c@x.id', 'd@x.id'],
      },
      createdAt: ago(10 * 60_000),
    });
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${email.id}`, {
      inbox: { ...inbox, messages: { [email.id]: [many] } },
    });
    await chat().findByText('Rapat tagihan.');
    expect(chat().getByText(e.more(2))).toBeVisible();
    // Alamat utama: tanpa baris "Dikirim ke".
    expect(chat().queryByText(e.sentTo, { exact: false })).toBeNull();
    const toggle = chat().getByRole('button', { name: e.showAll(5) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(chat().getByRole('button', { name: e.showLess })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(chat().queryByText(e.more(2))).toBeNull();
    expect(chat().getByText('c@x.id', { exact: false })).toBeVisible();
  });
});

describe('composer channel Email: Cc/Bcc & Balas semua', () => {
  it('Cc/Bcc: chip alamat, format salah tetap di kolom dengan penjelasan, terkirim bersama pesan', async () => {
    const { api } = await openChat();
    expect(chat().getByText(k.to, { selector: 'span' }).parentElement).toHaveTextContent(
      `${k.to}rudi@pelanggan.co.id`,
    );
    const toggle = chat().getByRole('button', { name: k.toggleLabel });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const cc = typeAddress('Cc', 'Sari@Pelanggan.co.id, salah');
    expect(
      within(chat().getByRole('list', { name: k.fieldLabel('Cc') })).getByText(
        'sari@pelanggan.co.id',
      ),
    ).toBeVisible();
    expect(cc).toHaveValue('salah');
    expect(chat().getByRole('alert')).toHaveTextContent(k.invalid('salah'));
    fireEvent.change(cc, { target: { value: '' } });
    typeAddress('Bcc', 'arsip@majujaya.co.id');
    expect(chat().getByText(k.count(2, 10))).toBeVisible();
    expect(chat().getByText(k.bccNote)).toBeVisible();

    const box = chat().getByRole('textbox', { name: t.inbox.compose.label });
    fireEvent.change(box, { target: { value: 'Sudah kami kirim ulang.' } });
    fireEvent.click(chat().getByRole('button', { name: t.inbox.compose.send }));
    await waitFor(() => expect(sentBody(api)).toBeDefined());
    expect(sentBody(api)).toMatchObject({
      type: 'text',
      text: 'Sudah kami kirim ulang.',
      cc: ['sari@pelanggan.co.id'],
      bcc: ['arsip@majujaya.co.id'],
    });
    // Setelah kirim: Cc/Bcc kosong & tertutup lagi.
    await waitFor(() =>
      expect(chat().getByRole('button', { name: k.toggleLabel })).toHaveAttribute(
        'aria-expanded',
        'false',
      ),
    );
  });

  it('Enter di kolom alamat tidak mengirim pesan; alamat pelanggan & channel sendiri ditolak', async () => {
    const { api } = await openChat();
    fireEvent.click(chat().getByRole('button', { name: k.toggleLabel }));
    const box = chat().getByRole('textbox', { name: t.inbox.compose.label });
    fireEvent.change(box, { target: { value: 'Draf' } });
    typeAddress('Cc', 'rudi@pelanggan.co.id');
    expect(chat().getByRole('alert')).toHaveTextContent(k.customer);
    typeAddress('Cc', 'billing@majujaya.co.id');
    expect(chat().getByRole('alert')).toHaveTextContent(k.self);
    expect(sentBody(api)).toBeUndefined();
    expect(chat().queryByRole('list', { name: k.fieldLabel('Cc') })).toBeNull();
  });

  it('Balas semua mengisi Cc dari email masuk terakhir (tanpa pelanggan & alamat channel)', async () => {
    const { api } = await openChat();
    fireEvent.click(chat().getByRole('button', { name: k.replyAllLabel(2) }));
    const list = within(chat().getByRole('list', { name: k.fieldLabel('Cc') }));
    expect(list.getAllByRole('listitem').map((item) => item.firstChild?.textContent)).toEqual([
      'andi@pelanggan.co.id',
      'sari@pelanggan.co.id',
    ]);
    expect(screen.getByText(k.replyAllDone(2))).toBeInTheDocument();
    // Alamat sudah ada di utas: tanpa penanda "baru".
    expect(chat().queryByText(k.newBadge)).toBeNull();
    fireEvent.change(chat().getByRole('textbox', { name: t.inbox.compose.label }), {
      target: { value: 'Baik, semua sudah kami tembuskan.' },
    });
    fireEvent.keyDown(chat().getByRole('textbox', { name: t.inbox.compose.label }), {
      key: 'Enter',
    });
    await waitFor(() =>
      expect(sentBody(api)).toMatchObject({
        cc: ['andi@pelanggan.co.id', 'sari@pelanggan.co.id'],
      }),
    );
    expect(sentBody(api)).not.toHaveProperty('bcc');
  });

  it('tanpa izin memulai percakapan: alamat baru ditandai + penjelasan; galat server tampil apa adanya', async () => {
    const message =
      'Ada alamat Cc/Bcc yang belum pernah ada di utas email ini. Minta izin ke Owner atau Admin.';
    const { api } = await openChat(email.id, {
      session: fakeSession('cs'),
      routes: {
        [`POST ${apiPath(API_ROUTES.inbox.messages, { conversationId: email.id })}`]: () =>
          apiError(403, 'FORBIDDEN', message),
      },
    });
    fireEvent.click(chat().getByRole('button', { name: k.toggleLabel }));
    typeAddress('Cc', 'sari@pelanggan.co.id');
    expect(chat().queryByText(k.newNoInitiateTitle)).toBeNull();
    typeAddress('Cc', 'baru@lain.co.id');
    const chip = within(chat().getByRole('list', { name: k.fieldLabel('Cc') }))
      .getByText('baru@lain.co.id')
      .closest('li');
    expect(chip).toHaveTextContent(`${k.newBadge}, ${k.newBadgeLabel}`);
    expect(chat().getByText(k.newNoInitiateTitle)).toBeVisible();
    expect(chat().getByText(k.newNoInitiateBody(1))).toBeVisible();

    fireEvent.change(chat().getByRole('textbox', { name: t.inbox.compose.label }), {
      target: { value: 'Halo semua' },
    });
    fireEvent.click(chat().getByRole('button', { name: t.inbox.compose.send }));
    expect(await chat().findByText(message)).toBeVisible();
    expect(sentBody(api)).toMatchObject({ cc: ['sari@pelanggan.co.id', 'baru@lain.co.id'] });
  });

  it('dengan izin: alamat baru tetap ditandai dengan keterangan jatah', async () => {
    await openChat(email.id, { session: fakeSession('supervisor') });
    fireEvent.click(chat().getByRole('button', { name: k.toggleLabel }));
    typeAddress('Bcc', 'baru@lain.co.id');
    expect(chat().getByText(k.newInitiate(1))).toBeVisible();
    expect(chat().queryByText(k.newNoInitiateTitle)).toBeNull();
  });

  it('batas 10 alamat: hitungan penuh, kolom ketik nonaktif, hapus chip membuka lagi', async () => {
    await openChat();
    fireEvent.click(chat().getByRole('button', { name: k.toggleLabel }));
    typeAddress(
      'Cc',
      Array.from({ length: 11 }, (_, index) => `orang${String(index)}@x.id`).join(' '),
    );
    expect(chat().getByRole('alert')).toHaveTextContent(k.limit(10));
    expect(chat().getByText(k.full(10))).toBeVisible();
    expect(chat().getByRole('textbox', { name: k.fieldLabel('Cc') })).toBeDisabled();
    expect(chat().getByRole('button', { name: k.toggleLabelCount(10) })).toBeVisible();
    fireEvent.click(chat().getByRole('button', { name: k.remove('orang0@x.id') }));
    expect(chat().getByRole('textbox', { name: k.fieldLabel('Cc') })).toBeEnabled();
    expect(chat().getByText(k.count(9, 10))).toBeVisible();
  });

  it('channel non-Email: tanpa Cc/Bcc dan Balas semua', async () => {
    await openChat(telegram.id);
    expect(chat().queryByRole('button', { name: k.toggleLabel })).toBeNull();
    expect(chat().queryByText(k.replyAll)).toBeNull();
  });
});

describe('daftar percakapan: saringan Alamat tujuan', () => {
  it('channel Email dengan alias → pilihan alamat; memilih mengirim emailRecipient', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp('/inbox', { inbox });
    fireEvent.keyDown(await screen.findByRole('button', { name: t.inbox.filters.open }), {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText(t.inbox.filters.emailRecipient)).toBeVisible();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'billing@majujaya.co.id' }));
    await waitFor(() =>
      expect(
        api.requests.some(
          (request) =>
            request.path === API_ROUTES.inbox.conversations &&
            request.query.get('emailRecipient') === 'billing@majujaya.co.id',
        ),
      ).toBe(true),
    );
  });

  it('tanpa alias: saringan tidak tampil', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox', {
      inbox: {
        ...inbox,
        channels: [
          fakeChannelSummary({
            id: EMAIL.id,
            type: 'email',
            name: EMAIL.name,
            displayPhoneNumber: null,
            emailAddresses: ['cs@majujaya.co.id'],
          }),
        ],
      },
    });
    fireEvent.keyDown(await screen.findByRole('button', { name: t.inbox.filters.open }), {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText(t.inbox.filters.emailRecipient)).toBeNull();
  });
});
