import {
  deleteChannelRequestSchema,
  API_ROUTES,
  apiPath,
  channelTypeInfos,
  type EmailChannel,
  type MetaSocialChannel,
  type TelegramChannel,
} from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../../i18n/id';
import { json, type FakeHandler } from '../../../test/fake-api';
import { confirmIdentity, TEST_CODE, TEST_PASSWORD } from '../../../test/identity';
import { renderApp } from '../../../test/render-app';

const c = t.connections;
const R = API_ROUTES.channelConnections;
const NOW = '2026-11-18T03:00:00.000Z';
const TOKEN = '1234567890:AAH-tes-token-bot-telegram-abcdefghij';

const base = {
  enabled: true,
  disabledAt: null,
  status: 'connected' as const,
  lastTest: null,
  credentialsUpdatedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const TELEGRAM: TelegramChannel = {
  ...base,
  id: '6f1c2a90-2222-4c4c-9a9a-000000000001',
  type: 'telegram',
  name: 'Bot CS',
  botUsername: 'majujaya_bot',
  botId: '1234567890',
  botTokenHint: '••••ghij',
  webhook: {
    url: 'http://localhost:3000/webhooks/telegram/6f1c2a90-2222-4c4c-9a9a-000000000001',
    registeredAt: null,
    warning: 'Telegram hanya mengirim pesan ke alamat https publik.',
  },
};

const EMAIL: EmailChannel = {
  ...base,
  id: '6f1c2a90-2222-4c4c-9a9a-000000000002',
  type: 'email',
  name: 'Email CS',
  emailAddress: 'cs@majujaya.co.id',
  fromName: 'CS Maju Jaya',
  imap: {
    host: 'mail.majujaya.co.id',
    port: 993,
    security: 'ssl',
    username: 'cs@majujaya.co.id',
    passwordHint: '••••',
    folder: 'INBOX',
  },
  pollIntervalMinutes: 2,
  markAsRead: true,
  senderVerification: { trustedAuthServIds: ['mail.majujaya.co.id'], isDefault: true },
  smtp: { mode: 'system' },
  mailbox: {
    lastPolledAt: NOW,
    lastPollOk: false,
    lastPollCode: 'imap_auth_failed',
    lastPollMessage: 'Username atau password IMAP ditolak.',
    skippedMessages: 3,
  },
};

const MESSENGER: MetaSocialChannel = {
  ...base,
  enabled: false,
  status: 'untested',
  id: '6f1c2a90-2222-4c4c-9a9a-000000000003',
  type: 'messenger',
  name: 'Halaman FB',
  pageId: '1234567890123',
  instagramAccountId: null,
  pageAccessTokenHint: '••••abcd',
  appSecretHint: '••••ef01',
  webhookUrl: 'https://balesin.contoh.id/webhooks/messenger/x',
  requiresAppReview: true,
  reviewNote: 'Butuh App Review Meta (izin pages_messaging).',
};

function routes(channels: unknown[], extra: Record<string, FakeHandler> = {}) {
  return {
    routes: {
      [`GET ${R.list}`]: () =>
        json({ channels, types: channelTypeInfos(), canStoreSecrets: true, maxChannels: 20 }),
      ...extra,
    },
  };
}

describe('Pengaturan → Channel lain', () => {
  it('daftar channel lain + kartu tambah per jenis (Messenger butuh App Review)', async () => {
    await renderApp('/pengaturan/channel', routes([TELEGRAM, MESSENGER]));
    const list = within(await screen.findByRole('list', { name: c.listLabel }));
    expect(list.getByRole('link', { name: c.open('Bot CS') })).toHaveAttribute(
      'href',
      `/pengaturan/channel/lain/${TELEGRAM.id}`,
    );
    expect(list.getByText(c.reviewBadge)).toBeVisible();
    expect(screen.getByRole('link', { name: new RegExp(c.addLabel('Telegram')) })).toHaveAttribute(
      'href',
      '/pengaturan/channel/baru/telegram',
    );
  });

  it('hubungkan Telegram: token tak terkendali + konfirmasi identitas', async () => {
    let body: unknown = null;
    const { router } = await renderApp(
      '/pengaturan/channel/baru/telegram',
      routes([], {
        [`POST ${R.list}`]: (request) => {
          body = request.body;
          return json({ channel: TELEGRAM, webhook: null }, { status: 201 });
        },
        [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
          json({ channel: TELEGRAM }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(c.name), { target: { value: 'Bot CS' } });
    fireEvent.click(screen.getByRole('button', { name: c.create }));
    expect(await screen.findByText(/Token bot wajib diisi/)).toBeVisible();

    const token = screen.getByLabelText(c.botToken);
    fireEvent.change(token, { target: { value: TOKEN } });
    // Rahasia tidak pernah jadi atribut DOM.
    expect(token.getAttribute('value')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: c.create }));
    await confirmIdentity(c.confirmTitle('Telegram'), c.create);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/pengaturan/channel/lain/${TELEGRAM.id}`),
    );
    expect(body).toEqual({
      type: 'telegram',
      name: 'Bot CS',
      botToken: TOKEN,
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    expect(await screen.findByText(c.created)).toBeVisible();
    // Peringatan alamat webhook dari server.
    expect(screen.getByText(TELEGRAM.webhook.warning ?? '')).toBeVisible();
  });

  it('hubungkan Email: IMAP + SMTP sistem + server verifikasi bawaan', async () => {
    let body: Record<string, unknown> | null = null;
    await renderApp(
      '/pengaturan/channel/baru/email',
      routes([], {
        [`POST ${R.list}`]: (request) => {
          body = request.body as Record<string, unknown>;
          return json({ channel: EMAIL, webhook: null }, { status: 201 });
        },
        [`GET ${apiPath(R.channel, { channelId: EMAIL.id })}`]: () => json({ channel: EMAIL }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(c.name), { target: { value: 'Email CS' } });
    fireEvent.change(screen.getByLabelText(c.emailAddress), {
      target: { value: 'cs@majujaya.co.id' },
    });
    fireEvent.change(screen.getByLabelText(c.fromName), { target: { value: 'CS Maju Jaya' } });
    fireEvent.change(screen.getByLabelText(c.imapHost), {
      target: { value: 'mail.majujaya.co.id' },
    });
    fireEvent.change(screen.getAllByLabelText(c.username)[0]!, {
      target: { value: 'cs@majujaya.co.id' },
    });
    fireEvent.change(screen.getAllByLabelText(c.password)[0]!, {
      target: { value: 'rahasia-imap' },
    });
    fireEvent.click(screen.getByRole('button', { name: c.create }));
    await confirmIdentity(c.confirmTitle('Email'), c.create);
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({
      type: 'email',
      imap: {
        host: 'mail.majujaya.co.id',
        port: 993,
        security: 'ssl',
        password: 'rahasia-imap',
        folder: 'INBOX',
      },
      smtp: { mode: 'system' },
      trustedAuthServIds: null,
      pollIntervalMinutes: 2,
    });
  });

  it('halaman Email: status kotak masuk gagal + ubah nama tanpa konfirmasi', async () => {
    let patched: unknown = null;
    await renderApp(
      `/pengaturan/channel/lain/${EMAIL.id}`,
      routes([EMAIL], {
        [`GET ${apiPath(R.channel, { channelId: EMAIL.id })}`]: () => json({ channel: EMAIL }),
        [`PATCH ${apiPath(R.channel, { channelId: EMAIL.id })}`]: (request) => {
          patched = request.body;
          return json({ channel: { ...EMAIL, name: 'Email Tagihan' } });
        },
      }),
    );
    expect(await screen.findByText('Username atau password IMAP ditolak.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.edit }));
    const dialog = await screen.findByRole('dialog', { name: c.editTitle });
    fireEvent.change(within(dialog).getByLabelText(c.name), {
      target: { value: 'Email Tagihan' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: c.save }));
    await waitFor(() => expect(patched).toEqual({ type: 'email', name: 'Email Tagihan' }));
    expect(screen.queryByRole('dialog', { name: c.editConfirmTitle })).toBeNull();
  });

  it('ubah token lalu Batal di konfirmasi: isian diberi keterangan isi ulang; simpan tanpa token tidak mengklaim diganti', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      `/pengaturan/channel/lain/${TELEGRAM.id}`,
      routes([TELEGRAM], {
        [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
          json({ channel: TELEGRAM }),
        [`PATCH ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: (request) => {
          bodies.push(request.body);
          return json({ channel: { ...TELEGRAM, name: 'Bot Tagihan' } });
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: c.edit }));
    let dialog = await screen.findByRole('dialog', { name: c.editTitle });
    fireEvent.change(within(dialog).getByLabelText(c.botToken), { target: { value: TOKEN } });
    fireEvent.click(within(dialog).getByRole('button', { name: c.save }));
    const identity = await screen.findByRole('dialog', { name: c.editConfirmTitle });
    fireEvent.click(within(identity).getByRole('button', { name: t.identity.cancel }));

    dialog = await screen.findByRole('dialog', { name: c.editTitle });
    const token = within(dialog).getByLabelText(c.botToken);
    expect(token).toHaveValue('');
    expect(within(dialog).getByText(c.refillSecret)).toBeVisible();
    expect(bodies).toHaveLength(0);

    // Hanya nama yang diubah (token dibiarkan kosong): pesan jujur, tidak "kredensial diganti".
    fireEvent.change(within(dialog).getByLabelText(c.name), { target: { value: 'Bot Tagihan' } });
    fireEvent.click(within(dialog).getByRole('button', { name: c.save }));
    await waitFor(() => expect(bodies).toEqual([{ type: 'telegram', name: 'Bot Tagihan' }]));
    expect(await screen.findByText(c.savedWithoutSecret)).toBeVisible();
  });

  it('halaman Telegram: kartu Bot tanpa sesi 24 jam; bot aktif tanpa penerima native → peringatan', async () => {
    const bot = t.channels.bot;
    await renderApp(
      `/pengaturan/channel/lain/${TELEGRAM.id}`,
      routes([TELEGRAM], {
        [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
          json({ channel: TELEGRAM }),
        [`GET ${apiPath(API_ROUTES.channels.bot, { channelId: TELEGRAM.id })}`]: () =>
          json({
            settings: {
              enabled: true,
              hours: { mode: 'always' },
              timeoutMinutes: 15,
              channelType: 'telegram',
              timezone: 'Asia/Jakarta',
              activeNow: true,
              receiverReady: false,
              updatedAt: null,
            },
          }),
      }),
    );
    const card = within(
      (await screen.findByRole('heading', { level: 2, name: bot.title })).closest('section')!,
    );
    expect(await card.findByText(bot.noWindowNote('Telegram'))).toBeVisible();
    expect(card.getByText(bot.receiverMissingOther)).toBeVisible();
    expect(card.getByRole('checkbox', { name: bot.enable(bot.placeChannel) })).toBeChecked();
  });

  it('halaman Messenger: App Review + aktifkan menunggu tes berhasil', async () => {
    await renderApp(
      `/pengaturan/channel/lain/${MESSENGER.id}`,
      routes([MESSENGER], {
        [`GET ${apiPath(R.channel, { channelId: MESSENGER.id })}`]: () =>
          json({ channel: MESSENGER }),
        [`GET ${apiPath(R.webhook, { channelId: MESSENGER.id })}`]: () =>
          json({
            channelId: MESSENGER.id,
            callbackUrl: MESSENGER.webhookUrl,
            verifyToken: 'verif-123',
            verifyTokenRotatedAt: NOW,
            subscribeFields: ['messages'],
            warning: null,
          }),
      }),
    );
    // Isi peringatan dari teks web (tidak mengulang judul "Butuh App Review Meta").
    expect(await screen.findByText(c.metaReviewBody.messenger ?? '')).toBeVisible();
    expect(screen.getByRole('button', { name: c.enable })).toBeDisabled();
    expect(screen.getByText(c.enableBlocked)).toBeVisible();
    expect(await screen.findByText('verif-123')).toBeVisible();
  });

  it('tes koneksi menampilkan hasil per pemeriksaan', async () => {
    await renderApp(
      `/pengaturan/channel/lain/${TELEGRAM.id}`,
      routes([TELEGRAM], {
        [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
          json({ channel: TELEGRAM }),
        [`POST ${apiPath(R.test, { channelId: TELEGRAM.id })}`]: () =>
          json({
            ok: false,
            code: 'telegram_webhook_not_registered',
            message: 'Webhook bot belum terpasang.',
            testedAt: NOW,
            checks: [
              { name: 'bot', ok: true, code: 'ok', message: 'OK' },
              {
                name: 'webhook',
                ok: false,
                code: 'telegram_webhook_not_registered',
                message: 'Webhook bot belum terpasang.',
              },
            ],
          }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: c.test }));
    expect(await screen.findAllByText('Webhook bot belum terpasang.')).not.toHaveLength(0);
    expect(screen.getAllByText(c.checkLabels.webhook ?? '').length).toBeGreaterThan(0);
  });

  it('hapus channel: konfirmasi identitas → kembali ke daftar', async () => {
    let body: unknown = null;
    const { router } = await renderApp(
      `/pengaturan/channel/lain/${TELEGRAM.id}`,
      routes([TELEGRAM], {
        [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
          json({ channel: TELEGRAM }),
        [`DELETE ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: (request) => {
          body = request.body;
          return json({ status: 'deleted' });
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: c.delete }));
    await confirmIdentity(c.deleteTitle, c.deleteConfirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan/channel'));
    // Bentuk yang diterima server (`deleteChannelRequestSchema`): password & kode di tingkat atas.
    expect(body).toEqual({ password: TEST_PASSWORD, code: TEST_CODE });
    expect(deleteChannelRequestSchema.safeParse(body).success).toBe(true);
  });
});
