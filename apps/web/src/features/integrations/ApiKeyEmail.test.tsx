import {
  API_ROUTES,
  apiPath,
  type ApiKey,
  type EmailOutboundEntry,
  type EmailSenderSettings,
} from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { json, type FakeHandler } from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { parseAttachmentHosts, scopeGroups } from './api-key-email';
import { emailOutboundQuery, parseEmailOutboundSearch } from './email-outbound-search';

const k = t.apiKeys;
const o = t.emailOutbound;
const SENDER = 'chn_6b1f2c3d-0000-4000-8000-000000000001';
const SENDER_2 = 'chn_6b1f2c3d-0000-4000-8000-000000000002';

const sender = (id: string, name: string, address: string): EmailSenderSettings => ({
  id,
  kind: 'channel',
  name,
  address,
  smtpMode: 'custom',
  hourlyLimit: 100,
  sentLastHour: 12,
  queued: 0,
  state: 'ok',
  throttledUntil: null,
  blockedReason: null,
  pausedBy: null,
  pausedAt: null,
});
const SENDERS = [
  sender(SENDER, 'Billing', 'billing@perusahaan.example'),
  sender(SENDER_2, 'CS', 'cs@perusahaan.example'),
];

const emailKey: ApiKey = {
  id: '6f1c2a90-4444-4c4c-9a9a-000000000011',
  name: 'Aplikasi billing',
  displayPrefix: 'blsn_live_0123456789abcdef_',
  scopes: ['email:send'],
  allowedIps: null,
  dailySendLimit: 500,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdBy: null,
  createdAt: '2026-11-20T03:00:00.000Z',
  status: 'active',
  emailSenders: [
    { id: SENDER, kind: 'channel', name: 'Billing', address: 'billing@perusahaan.example' },
  ],
  emailAttachmentHosts: ['billing.perusahaan.example'],
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    [`GET ${API_ROUTES.apiKeys.list}`]: () => json({ apiKeys: [emailKey] }),
    [`POST ${API_ROUTES.apiKeys.list}`]: ({ body }) =>
      json(
        {
          apiKey: { ...emailKey, id: '6f1c2a90-4444-4c4c-9a9a-000000000012', ...(body as object) },
          secret: `blsn_live_0123456789abcdef_${'S'.repeat(43)}`,
        },
        { status: 201 },
      ),
    [`PATCH ${apiPath(API_ROUTES.apiKeys.key, { apiKeyId: emailKey.id })}`]: ({ body }) =>
      json({
        apiKey: {
          ...emailKey,
          emailSenders: SENDERS.map(({ id, kind, name, address }) => ({ id, kind, name, address })),
          ...((body as { emailAttachmentHosts?: string[] }).emailAttachmentHosts
            ? {
                emailAttachmentHosts: (body as { emailAttachmentHosts: string[] })
                  .emailAttachmentHosts,
              }
            : {}),
        },
      }),
    [`GET ${API_ROUTES.apiKeys.settings}`]: () => json({ settings: { docsEnabled: false } }),
    [`GET ${API_ROUTES.emailSenders.list}`]: () => json({ senders: SENDERS }),
    ...extra,
  };
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  path: string,
) => api.requests.filter((request) => request.method === method && request.path === path);

describe('isian akses email API key', () => {
  it('host lampiran: satu per baris, wildcard satu tingkat, baris salah disebut nomornya', () => {
    expect(
      parseAttachmentHosts(
        'Billing.Perusahaan.example\n\n*.contoh.co.id, billing.perusahaan.example',
      ),
    ).toEqual({
      hosts: ['billing.perusahaan.example', '*.contoh.co.id'],
      error: null,
    });
    expect(parseAttachmentHosts('billing.ok.id\nhttps://salah/x').error).toBe(
      k.emailHostsInvalid(2),
    );
  });

  it('izin dikelompokkan; email terakhir', () => {
    const groups = scopeGroups();
    expect(groups.map((group) => group.label)).toEqual([
      'Percakapan & pesan',
      'Kontak',
      'Tiket',
      'Email lewat API',
    ]);
    expect(groups.at(-1)?.scopes).toEqual(['email:read', 'email:send']);
  });

  it('saringan riwayat di URL: nilai asing dibuang, "sampai" inklusif', () => {
    const search = parseEmailOutboundSearch({
      apiKeyId: emailKey.id,
      senderId: 'bukan-pengirim',
      status: 'failed',
      from: '2026-11-01',
      to: '2026-11-02',
    });
    expect(search.senderId).toBeUndefined();
    const query = emailOutboundQuery(search);
    expect(query).toMatchObject({ apiKeyId: emailKey.id, status: 'failed' });
    expect(new Date(query.to ?? '').getTime() - new Date(query.from ?? '').getTime()).toBe(
      2 * 86_400_000,
    );
  });
});

describe('Pengaturan → API key: email', () => {
  it('buat key email:send: pengirim wajib dipilih, host lampiran dikirim', async () => {
    const { api } = await renderApp('/pengaturan/api-key', { routes: routes() });
    fireEvent.click(await screen.findByRole('button', { name: k.create }));
    const dialog = within(await screen.findByRole('dialog', { name: k.formTitle }));
    fireEvent.change(dialog.getByLabelText(k.nameLabel), { target: { value: 'Billing n8n' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: /Kirim pesan di percakapan/ }));
    fireEvent.click(dialog.getByRole('checkbox', { name: /Kirim, jadwalkan, batalkan/ }));
    expect(dialog.getByRole('checkbox', { name: /Baca status email/ })).toBeDisabled();

    fireEvent.click(dialog.getByRole('button', { name: k.next }));
    expect(await dialog.findByText(k.emailSendersRequired)).toBeVisible();

    fireEvent.click(await dialog.findByRole('checkbox', { name: /Billing/ }));
    fireEvent.change(dialog.getByLabelText(new RegExp(k.emailHostsLabel)), {
      target: { value: 'billing.perusahaan.example\n*.contoh.co.id' },
    });
    fireEvent.click(dialog.getByRole('button', { name: k.next }));
    await confirmIdentity(k.confirmTitle, k.next);
    await screen.findByRole('dialog', { name: k.secretTitle });
    expect(requestsTo(api, 'POST', API_ROUTES.apiKeys.list)[0]?.body).toMatchObject({
      scopes: ['email:send'],
      emailSenderIds: [SENDER],
      emailAttachmentHosts: ['billing.perusahaan.example', '*.contoh.co.id'],
    });
  });

  it('kartu key menampilkan pengirim & host; ubah akses = PATCH berkonfirmasi', async () => {
    const { api } = await renderApp('/pengaturan/api-key', { routes: routes() });
    expect(
      await screen.findByText(k.emailSenders('Billing (billing@perusahaan.example)')),
    ).toBeVisible();
    expect(screen.getByText(k.emailHosts('billing.perusahaan.example'))).toBeVisible();
    expect(
      screen.getByRole('link', { name: k.emailHistoryLabel('Aplikasi billing') }),
    ).toHaveAttribute('href', `/pengaturan/api-key/email-terkirim?apiKeyId=${emailKey.id}`);

    fireEvent.click(screen.getByRole('button', { name: k.emailEditLabel('Aplikasi billing') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: k.emailEditTitle('Aplikasi billing') }),
    );
    fireEvent.click(dialog.getByRole('button', { name: k.emailSave }));
    expect(await dialog.findByText(k.emailUnchanged)).toBeVisible();
    fireEvent.click(await dialog.findByRole('checkbox', { name: /CS/ }));
    fireEvent.click(dialog.getByRole('button', { name: k.emailSave }));
    await confirmIdentity(k.emailConfirmTitle, k.emailSave);
    expect(await screen.findByText(k.emailSaved('Aplikasi billing'))).toBeVisible();
    expect(
      requestsTo(api, 'PATCH', apiPath(API_ROUTES.apiKeys.key, { apiKeyId: emailKey.id }))[0]?.body,
    ).toEqual({
      emailSenderIds: [SENDER, SENDER_2],
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });
});

describe('Pengaturan → API key → Email terkirim', () => {
  const entry: EmailOutboundEntry = {
    id: '9d2f0000-0000-4000-8000-000000000001',
    status: 'failed',
    source: 'api',
    apiKey: { id: emailKey.id, name: 'Aplikasi billing' },
    sender: { id: SENDER, kind: 'channel', address: 'billing@perusahaan.example' },
    recipients: ['bu***@co***.example', 'sa***@co***.example', 'an***@co***.example'],
    recipientCount: 3,
    subject: 'Tagihan November 2026 — PLG-00873',
    template: { id: '1e7d0000-0000-4000-8000-000000000001', slug: 'tagihan-bulanan', version: 3 },
    metadata: { invoice_id: 'INV-2611-0873' },
    createdAt: '2026-11-22T02:00:00.000Z',
    sentAt: null,
    failure: {
      reason: 'recipient_rejected',
      message: 'Server email menolak semua alamat penerima.',
      smtpCode: 550,
    },
  };

  it('penerima tersamar, alasan gagal, metadata; saringan status masuk ke query', async () => {
    const { api } = await renderApp(`/pengaturan/api-key/email-terkirim?apiKeyId=${emailKey.id}`, {
      routes: routes({
        [`GET ${API_ROUTES.emailOutbound.list}`]: () => json({ emails: [entry], nextCursor: null }),
      }),
    });
    expect(await screen.findByText(entry.subject)).toBeVisible();
    expect(screen.getByText('bu***@co***.example')).toBeVisible();
    expect(screen.getByText(o.moreRecipients(1))).toBeVisible();
    expect(screen.getByText(/Server email menolak semua alamat penerima\./)).toBeVisible();
    expect(screen.getByText('INV-2611-0873')).toBeVisible();
    expect(requestsTo(api, 'GET', API_ROUTES.emailOutbound.list)[0]?.query.get('apiKeyId')).toBe(
      emailKey.id,
    );

    fireEvent.change(screen.getByLabelText(o.statusLabel), { target: { value: 'bounced' } });
    await waitFor(() =>
      expect(
        requestsTo(api, 'GET', API_ROUTES.emailOutbound.list).some(
          (request) => request.query.get('status') === 'bounced',
        ),
      ).toBe(true),
    );
  });

  it('kosong → ilustrasi + penjelasan', async () => {
    await renderApp('/pengaturan/api-key/email-terkirim', {
      routes: routes({
        [`GET ${API_ROUTES.emailOutbound.list}`]: () => json({ emails: [], nextCursor: null }),
      }),
    });
    expect(await screen.findByText(o.emptyTitle)).toBeVisible();
  });
});

describe('Pengaturan → Webhook: kejadian email', () => {
  it('kejadian dikelompokkan; email.* ber-label Indonesia', async () => {
    await renderApp('/pengaturan/webhook', {
      routes: {
        [`GET ${API_ROUTES.outgoingWebhooks.list}`]: () => json({ webhooks: [] }),
        [`GET ${API_ROUTES.outgoingWebhooks.privateNetwork}`]: () =>
          json({ settings: { cidrs: [] } }),
      },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: t.webhooks.create }))[0]!);
    const dialog = within(await screen.findByRole('dialog', { name: t.webhooks.formTitleCreate }));
    const group = dialog.getByRole('group', { name: t.webhooks.eventGroups.email });
    expect(within(group).getByRole('checkbox', { name: /Email API memantul/ })).toBeVisible();
    expect(within(group).getByText(t.webhooks.emailEventsHint)).toBeVisible();
  });
});
