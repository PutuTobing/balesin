import { API_ROUTES, apiPath, type MessageTemplate } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { fakeChannelSummary, fakeConversation, fakeMessage } from '../../test/fake-inbox';
import { fakeOtpTemplate, fakeTemplate } from '../../test/fake-templates';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const k = t.inbox.compose;
const s = t.inbox.templateSend;
const n = t.inbox.newConversation;
const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

const expired = fakeConversation({
  status: 'served',
  assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
  windowExpiresAt: inFuture(-HOUR),
});
const messagesPath = apiPath(API_ROUTES.inbox.messages, { conversationId: expired.id });

function chat() {
  return within(screen.getByRole('region', { name: t.inbox.chat.label }));
}

async function openExpired(templates: MessageTemplate[], routes: Record<string, FakeHandler> = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${expired.id}`, {
    inbox: {
      conversations: [expired],
      messages: {
        [expired.id]: [fakeMessage({ text: 'Halo kak', createdAt: inFuture(-30 * HOUR) })],
      },
      channels: [fakeChannelSummary()],
    },
    routes: {
      [`GET ${API_ROUTES.templates.list}`]: () => json({ templates }),
      ...routes,
    },
  });
  await chat().findByText('Halo kak');
  return view;
}

async function openTemplateDialog() {
  fireEvent.click(chat().getByRole('button', { name: k.sendTemplate }));
  return within(await screen.findByRole('dialog', { name: s.title }));
}

const sentBody = (api: Awaited<ReturnType<typeof renderApp>>['api']) =>
  api.requests.find((request) => request.method === 'POST' && request.path === messagesPath)?.body;

describe('kirim template di luar sesi 24 jam', () => {
  it('pilih template disetujui nomor ini → isi variabel (pratinjau langsung) → kirim type template', async () => {
    const template = fakeTemplate({ name: 'tagihan_bulanan' });
    const { api } = await openExpired([template]);
    const dialog = await openTemplateDialog();
    fireEvent.click(await dialog.findByRole('button', { name: /tagihan_bulanan/ }));
    // Hanya template DISETUJUI milik nomor percakapan ini yang diminta.
    const list = api.requests.find((request) => request.path === API_ROUTES.templates.list);
    expect(list?.query.get('status')).toBe('APPROVED');
    expect(list?.query.get('channelId')).toBe(expired.channel.id);

    fireEvent.click(dialog.getByRole('button', { name: s.send }));
    expect(await dialog.findAllByText(s.required)).toHaveLength(2);
    expect(sentBody(api)).toBeUndefined();

    fireEvent.change(dialog.getByLabelText(s.bodyValue('1')), { target: { value: 'Budi' } });
    fireEvent.change(dialog.getByLabelText(s.bodyValue('2')), { target: { value: 'Desember' } });
    expect(
      within(dialog.getByRole('figure', { name: t.templates.previewLabel })).getByText(
        'Halo Budi, tagihan bulan Desember sudah terbit. Terima kasih.',
      ),
    ).toBeVisible();
    fireEvent.click(dialog.getByRole('button', { name: s.send }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: s.title })).toBeNull());
    expect(sentBody(api)).toMatchObject({
      type: 'template',
      templateId: template.id,
      parameters: { body: { '1': 'Budi', '2': 'Desember' }, buttons: {} },
    });
  });

  it('galat 400 server per variabel tampil di isiannya', async () => {
    const template = fakeTemplate({ name: 'tagihan_bulanan' });
    await openExpired([template], {
      [`POST ${messagesPath}`]: () =>
        apiError(400, 'VALIDATION_ERROR', 'Nilai variabel tidak sah.', {
          details: [
            { field: 'parameters.body.2', message: 'Nilai variabel template wajib diisi.' },
          ],
        }),
    });
    const dialog = await openTemplateDialog();
    fireEvent.click(await dialog.findByRole('button', { name: /tagihan_bulanan/ }));
    fireEvent.change(dialog.getByLabelText(s.bodyValue('1')), { target: { value: 'Budi' } });
    fireEvent.change(dialog.getByLabelText(s.bodyValue('2')), { target: { value: 'Des' } });
    fireEvent.click(dialog.getByRole('button', { name: s.send }));
    expect(await dialog.findByText('Nilai variabel template wajib diisi.')).toBeVisible();
  });

  it('judul gambar: berkas wajib → diunggah dulu, lalu header.mediaId ikut terkirim', async () => {
    const template = fakeTemplate({
      name: 'promo_bergambar',
      content: {
        ...fakeTemplate().content,
        header: { format: 'IMAGE' },
        body: { text: 'Promo spesial bulan ini untuk pelanggan setia.', examples: {} },
      },
    });
    const { api } = await openExpired([template]);
    const dialog = await openTemplateDialog();
    fireEvent.click(await dialog.findByRole('button', { name: /promo_bergambar/ }));
    fireEvent.click(dialog.getByRole('button', { name: s.send }));
    expect(await dialog.findByText(s.mediaRequired)).toBeVisible();
    const file = new File(['gambar'], 'promo.jpg', { type: 'image/jpeg' });
    fireEvent.change(dialog.getByTestId('template-media'), { target: { files: [file] } });
    expect(dialog.getAllByText('promo.jpg').length).toBeGreaterThan(0);
    fireEvent.click(dialog.getByRole('button', { name: s.send }));
    await waitFor(() => expect(sentBody(api)).toBeDefined());
    expect(sentBody(api)).toMatchObject({
      parameters: { header: { mediaId: '7a000000-0000-4000-8000-000000000001' } },
    });
  });

  it('OTP: satu isian kode; pesan OTP gagal tidak menawarkan "Kirim ulang"', async () => {
    const otp = fakeOtpTemplate();
    const failedOtp = fakeMessage({
      direction: 'outbound',
      senderKind: 'agent',
      type: 'template',
      text: 'Kode verifikasi: ••••••',
      status: 'failed',
      failure: {
        reason: 'meta_rejected',
        code: 131000,
        retryable: true,
        message: 'Meta menolak pesan ini.',
      },
      template: { templateId: otp.id, name: otp.name, language: 'id', category: 'AUTHENTICATION' },
      createdAt: inFuture(-HOUR / 2),
    });
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp(`/inbox?chat=${expired.id}`, {
      inbox: {
        conversations: [expired],
        messages: { [expired.id]: [failedOtp] },
        channels: [fakeChannelSummary()],
      },
      routes: { [`GET ${API_ROUTES.templates.list}`]: () => json({ templates: [otp] }) },
    });
    expect(await chat().findByText(k.otpNoResend)).toBeVisible();
    expect(chat().getByText(t.inbox.content.templateNamed('kode_verifikasi'))).toBeVisible();
    expect(chat().queryByRole('button', { name: k.resend })).toBeNull();

    const dialog = await openTemplateDialog();
    fireEvent.click(await dialog.findByRole('button', { name: /kode_verifikasi/ }));
    expect(dialog.getByText(s.otpHint)).toBeVisible();
    fireEvent.change(dialog.getByLabelText(s.otpCode), { target: { value: '482913' } });
    fireEvent.click(dialog.getByRole('button', { name: s.send }));
    await waitFor(() => expect(sentBody(api)).toBeDefined());
    expect(sentBody(api)).toMatchObject({ parameters: { body: { '1': '482913' } } });
  });
});

describe('percakapan baru', () => {
  const start = API_ROUTES.inbox.start;

  async function openInbox(
    role: 'owner' | 'cs' = 'owner',
    routes: Record<string, FakeHandler> = {},
  ) {
    act(() => setMediaQuery(media.desktop, true));
    return renderApp('/inbox', {
      session: fakeSession(role),
      inbox: { channels: [fakeChannelSummary()] },
      routes: {
        [`GET ${API_ROUTES.templates.list}`]: () =>
          json({
            templates: [
              fakeTemplate({ name: 'sapa_pelanggan' }),
              fakeTemplate({
                name: 'promo_bergambar',
                content: { ...fakeTemplate().content, header: { format: 'IMAGE' } },
              }),
            ],
          }),
        ...routes,
      },
    });
  }

  it('Owner: nomor tujuan + template → POST start → chat baru dibuka', async () => {
    const conversation = fakeConversation({ status: 'served' });
    const { api, router } = await openInbox('owner', {
      [`POST ${start}`]: () =>
        json(
          {
            message: fakeMessage({ direction: 'outbound', type: 'template' }),
            conversationId: conversation.id,
          },
          { status: 202 },
        ),
    });
    fireEvent.click(await screen.findByRole('button', { name: n.open }));
    const dialog = within(await screen.findByRole('dialog', { name: n.title }));
    expect(dialog.getByLabelText(n.phoneLabel)).toHaveValue('+62');
    // Template berjudul berkas tidak bisa memulai percakapan (unggahan butuh percakapan).
    expect(await dialog.findByRole('button', { name: /promo_bergambar/ })).toBeDisabled();

    fireEvent.click(dialog.getByRole('button', { name: n.start }));
    expect(await dialog.findByText(n.phoneInvalid)).toBeVisible();
    expect(dialog.getByText(n.noTemplate)).toBeVisible();

    fireEvent.change(dialog.getByLabelText(n.phoneLabel), { target: { value: '0812 3456 7890' } });
    fireEvent.click(dialog.getByRole('button', { name: /sapa_pelanggan/ }));
    fireEvent.change(dialog.getByLabelText(s.bodyValue('1')), { target: { value: 'Budi' } });
    fireEvent.change(dialog.getByLabelText(s.bodyValue('2')), { target: { value: 'Desember' } });
    fireEvent.click(dialog.getByRole('button', { name: n.start }));
    await waitFor(() =>
      expect((router.state.location.search as { chat?: string }).chat).toBe(conversation.id),
    );
    expect(api.requests.find((request) => request.path === start)?.body).toMatchObject({
      channelId: fakeChannelSummary().id,
      phone: '0812 3456 7890',
      parameters: { body: { '1': 'Budi', '2': 'Desember' } },
    });
  });

  it('batas harian (429) tampil sebagai pesan; CS tidak punya tombolnya', async () => {
    await openInbox('owner', {
      [`POST ${start}`]: () =>
        apiError(
          429,
          'RATE_LIMITED',
          'Batas harian memulai percakapan baru tercapai. Coba lagi dalam 3 jam.',
        ),
    });
    fireEvent.click(await screen.findByRole('button', { name: n.open }));
    const dialog = within(await screen.findByRole('dialog', { name: n.title }));
    fireEvent.change(dialog.getByLabelText(n.phoneLabel), { target: { value: '+6281234567890' } });
    fireEvent.click(await dialog.findByRole('button', { name: /sapa_pelanggan/ }));
    fireEvent.change(dialog.getByLabelText(s.bodyValue('1')), { target: { value: 'Budi' } });
    fireEvent.change(dialog.getByLabelText(s.bodyValue('2')), { target: { value: 'Des' } });
    fireEvent.click(dialog.getByRole('button', { name: n.start }));
    expect(await dialog.findByText(/Batas harian memulai percakapan baru/)).toBeVisible();
  });

  it('CS (tanpa inbox.initiate) tidak melihat "Percakapan baru"', async () => {
    await openInbox('cs');
    await screen.findByRole('heading', { level: 1, name: t.inbox.title });
    expect(screen.queryByRole('button', { name: n.open })).toBeNull();
  });
});
