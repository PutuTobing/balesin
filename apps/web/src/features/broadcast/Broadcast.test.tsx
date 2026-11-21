import { API_ROUTES, apiPath, type BroadcastCampaign } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { fakeSession, json, type FakeHandler } from '../../test/fake-api';
import {
  AGUS,
  fakeBroadcast,
  fakeBroadcastSettings,
  fakeImportReport,
  fakeReport,
  withRecipients,
} from '../../test/fake-broadcasts';
import { fakeChannelSummary } from '../../test/fake-inbox';
import { fakeOtpTemplate, fakeTemplate } from '../../test/fake-templates';
import { confirmIdentity, TEST_CODE, TEST_PASSWORD } from '../../test/identity';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { expectSecretNowhere, secretSpies } from '../../test/secret-nowhere';
import {
  campaignProgress,
  guessMapping,
  mappingComplete,
  mappingSlots,
  usableForBroadcast,
  zonedToIso,
} from './broadcast-logic';

const b = t.broadcast;
const R = API_ROUTES.broadcasts;
const TEMPLATE = fakeTemplate({
  id: '7e000000-0000-4000-8000-000000000901',
  name: 'tagihan_bulanan',
});
const path = (route: string, broadcastId: string) => apiPath(route, { broadcastId });

function base(
  routes: Record<string, FakeHandler> = {},
  role: 'owner' | 'admin' | 'supervisor' = 'owner',
) {
  return {
    session: fakeSession(role),
    inbox: { channels: [fakeChannelSummary()] },
    routes: {
      [`GET ${API_ROUTES.templates.list}`]: () =>
        json({ templates: [TEMPLATE, fakeOtpTemplate()] }),
      [`GET ${apiPath(API_ROUTES.templates.template, { templateId: TEMPLATE.id })}`]: () =>
        json({ template: TEMPLATE }),
      ...routes,
    },
  };
}

describe('logika broadcast', () => {
  it('template OTP & judul media tidak bisa dipakai; pemetaan ditebak dari nama kolom', () => {
    expect(usableForBroadcast(TEMPLATE)).toBe(true);
    expect(usableForBroadcast(fakeOtpTemplate())).toBe(false);
    expect(
      usableForBroadcast(
        fakeTemplate({ content: { ...TEMPLATE.content, header: { format: 'IMAGE' } } }),
      ),
    ).toBe(false);
    const slots = mappingSlots(TEMPLATE.content);
    expect(slots.map((slot) => slot.key)).toEqual(['body.1', 'body.2']);
    const guessed = guessMapping({ body: {}, header: null, buttons: {} }, slots, ['nomor', 'nama']);
    expect(guessed.body['1']).toEqual({ kind: 'column', column: 'nama' });
    expect(mappingComplete(guessed, slots, ['nomor', 'nama'])).toBe(false);
    expect(
      mappingComplete(
        { ...guessed, body: { ...guessed.body, '2': { kind: 'text', value: 'Desember' } } },
        slots,
        ['nomor', 'nama'],
      ),
    ).toBe(true);
  });

  it('jadwal di zona organisasi → UTC; progres', () => {
    expect(zonedToIso('2026-11-30T08:00', 'Asia/Jakarta')).toBe('2026-11-30T01:00:00.000Z');
    expect(zonedToIso('2026-11-30T08:00', 'Asia/Makassar')).toBe('2026-11-30T00:00:00.000Z');
    expect(zonedToIso('bukan tanggal', 'Asia/Jakarta')).toBeNull();
    const campaign = withRecipients(fakeBroadcast(), 10);
    expect(campaignProgress({ counts: { ...campaign.counts, pending: 4 } }).done).toBe(6);
  });
});

describe('daftar kampanye', () => {
  it('kosong: ajakan buat kampanye', async () => {
    await renderApp('/broadcast', base());
    expect(await screen.findByText(b.emptyTitle)).toBeVisible();
    expect(screen.getByRole('link', { name: b.newCampaign })).toHaveAttribute(
      'href',
      '/broadcast/baru',
    );
  });

  it('kampanye berjalan: status, progres, penerima', async () => {
    const running = {
      ...withRecipients(fakeBroadcast({ name: 'Tagihan Desember', status: 'running' }), 100),
      counts: {
        sourceRows: 101,
        rejectedRows: 1,
        recipients: 100,
        pending: 40,
        queued: 60,
        skipped: 0,
        cancelled: 0,
      },
    };
    await renderApp(
      '/broadcast',
      base({ [`GET ${R.list}`]: () => json({ broadcasts: [running], nextCursor: null }) }),
    );
    const list = within(await screen.findByRole('list', { name: b.listLabel }));
    expect(list.getByRole('link', { name: b.open('Tagihan Desember') })).toBeVisible();
    expect(list.getByText(b.processed(60, 100))).toBeVisible();
    expect(list.getByRole('meter', { name: b.progressLabel })).toHaveAttribute(
      'aria-valuenow',
      '60',
    );
  });
});

describe('wizard kampanye', () => {
  it('dasar → buat draf (template OTP tidak ditawarkan)', async () => {
    const created = fakeBroadcast({ name: 'Tagihan Desember' });
    const { api, router } = await renderApp(
      '/broadcast/baru',
      base({
        [`POST ${R.list}`]: () => json({ broadcast: created }, { status: 201 }),
        [`GET ${path(R.broadcast, created.id)}`]: () => json({ broadcast: created }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(b.nameLabel), {
      target: { value: 'Tagihan Desember' },
    });
    const template = await screen.findByLabelText(b.templateLabel);
    expect(within(template).queryByText(/kode_verifikasi/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: b.next }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/broadcast/${created.id}`));
    expect(
      api.requests.find((request) => request.method === 'POST' && request.path === R.list)?.body,
    ).toEqual({
      name: 'Tagihan Desember',
      channelId: fakeChannelSummary().id,
      templateId: TEMPLATE.id,
    });
    // Draf tersimpan → langkah penerima.
    expect(await screen.findByRole('heading', { name: b.sourceTitle })).toBeVisible();
  });

  it('nomor pengirim bawaan = nomor pertama yang punya template siap broadcast (QA R3)', async () => {
    const empty = fakeChannelSummary({
      id: 'ca000000-0000-4000-8000-000000000001',
      name: 'Inbox Bot',
      displayPhoneNumber: null,
    });
    const ready = fakeChannelSummary();
    await renderApp('/broadcast/baru', {
      ...base({
        [`GET ${API_ROUTES.templates.list}`]: ({ query }) =>
          json({ templates: query.get('channelId') === ready.id ? [TEMPLATE] : [] }),
      }),
      inbox: { channels: [empty, ready] },
    });
    const sender = await screen.findByLabelText(b.channelLabel);
    expect(sender).toHaveValue(ready.id);
    expect(await screen.findByLabelText(b.templateLabel)).toHaveValue(TEMPLATE.id);
    expect(screen.queryByText(b.noTemplates)).toBeNull();
  });

  it('unggah berkas → laporan baris tidak valid; isi variabel → pratinjau; ajukan dengan konfirmasi identitas', async () => {
    act(() => setMediaQuery(media.desktop, true));
    let campaign: BroadcastCampaign = fakeBroadcast({ name: 'Tagihan Desember' });
    const { api } = await renderApp(
      `/broadcast/${campaign.id}`,
      base({
        [`GET ${path(R.broadcast, campaign.id)}`]: () => json({ broadcast: campaign }),
        [`POST ${path(R.upload, campaign.id)}`]: () => {
          campaign = withRecipients(campaign, 3);
          return json({ broadcast: campaign, report: fakeImportReport() });
        },
        [`PATCH ${path(R.broadcast, campaign.id)}`]: (request) => {
          campaign = { ...campaign, ...(request.body as Partial<BroadcastCampaign>) };
          return json({ broadcast: campaign });
        },
        [`GET ${path(R.preview, campaign.id)}`]: () =>
          json({
            samples: [
              {
                recipientId: '7a000000-0000-4000-8000-000000000101',
                row: 2,
                phone: '+6281234567890',
                headerText: null,
                text: 'Halo Budi, tagihan bulan Desember sudah terbit. Terima kasih.',
                missing: [],
                invalid: [],
              },
            ],
            problems: { missing: 1, invalid: 0 },
          }),
        [`GET ${path(R.estimate, campaign.id)}`]: () =>
          json({
            estimate: {
              currency: 'IDR',
              category: 'UTILITY',
              recipients: 3,
              billable: 2,
              free: 1,
              unknownRate: 0,
              total: 726,
              rateSource: 'Perkiraan bawaan.',
              computedAt: new Date().toISOString(),
            },
          }),
        [`POST ${path(R.submit, campaign.id)}`]: () => {
          campaign = { ...campaign, status: 'scheduled' };
          return json({ broadcast: campaign });
        },
        [`GET ${path(R.report, campaign.id)}`]: () =>
          json({ report: fakeReport({ recipients: 3, pending: 3 }) }),
        [`GET ${path(R.recipients, campaign.id)}`]: () =>
          json({ recipients: [], nextCursor: null }),
      }),
    );
    // Langkah penerima: unggah CSV.
    await screen.findByRole('heading', { name: b.sourceTitle });
    const file = new File(['nomor,nama,bulan\n0812,Budi,Desember'], 'pelanggan.csv', {
      type: 'text/csv',
    });
    fireEvent.change(screen.getByTestId('broadcast-file'), { target: { files: [file] } });
    expect(await screen.findByText(b.reportSummary(3, 4))).toBeVisible();
    // Satu daftar per penyebab: jumlah, penyebab, lalu contoh nomor baris.
    expect(screen.getByText('Nomor tidak valid')).toBeVisible();
    expect(screen.getByText(b.issueRows('4', 0))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: b.next }));

    // Langkah isi: {{1}} ditebak dari kolom "nama"; {{2}} dipilih "bulan" → simpan otomatis → pratinjau.
    await screen.findByRole('heading', { name: b.variablesTitle });
    expect(await screen.findByLabelText(b.variableLabel('1'))).toHaveValue('nama');
    fireEvent.change(screen.getByLabelText(b.variableLabel('2')), {
      target: { value: 'bulan' },
    });
    expect(
      await screen.findByText(
        'Halo Budi, tagihan bulan Desember sudah terbit. Terima kasih.',
        {},
        { timeout: 3000 },
      ),
    ).toBeVisible();
    expect(screen.getByText(b.problems(1, 0))).toBeVisible();
    await waitFor(() =>
      expect(api.requests.some((request) => request.method === 'PATCH')).toBe(true),
    );
    expect(api.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      mapping: {
        body: { '1': { kind: 'column', column: 'nama' }, '2': { kind: 'column', column: 'bulan' } },
        header: null,
        buttons: {},
      },
    });
    fireEvent.click(screen.getByRole('button', { name: b.next }));

    // Langkah kirim: perkiraan biaya, lalu ajukan dengan konfirmasi identitas.
    expect(await screen.findByText(b.estimateFree(1))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: b.submit }));
    await confirmIdentity(b.confirmSubmitTitle, b.submit);
    await waitFor(() =>
      expect(
        api.requests.find((request) => request.path === path(R.submit, campaign.id))?.body,
      ).toEqual({
        confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
      }),
    );
    // Diajukan → halaman detail (terjadwal).
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tagihan Desember' }),
    ).toBeVisible();
    expect(screen.getAllByText(b.scheduledTitle).length).toBeGreaterThan(0);
  });
});

describe('detail kampanye', () => {
  const pending = withRecipients(
    fakeBroadcast({
      name: 'Promo Desember',
      status: 'pending_approval',
      createdBy: AGUS,
      approval: {
        required: true,
        threshold: 50,
        requestedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        rejectionReason: null,
      },
    }),
    120,
  );
  const detailRoutes = (campaign: BroadcastCampaign, extra: Record<string, FakeHandler> = {}) => ({
    [`GET ${path(R.broadcast, campaign.id)}`]: () => json({ broadcast: campaign }),
    [`GET ${path(R.report, campaign.id)}`]: () => json({ report: fakeReport() }),
    [`GET ${path(R.recipients, campaign.id)}`]: () => json({ recipients: [], nextCursor: null }),
    ...extra,
  });

  it('menunggu persetujuan: penyetuju (bukan pembuat) menyetujui dengan konfirmasi identitas', async () => {
    const { api } = await renderApp(
      `/broadcast/${pending.id}`,
      base(
        detailRoutes(pending, {
          [`POST ${path(R.approve, pending.id)}`]: () =>
            json({ broadcast: { ...pending, status: 'scheduled' } }),
        }),
      ),
    );
    expect(await screen.findByText(b.pendingBody(50), { exact: false })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: b.approve }));
    await confirmIdentity(b.confirmApproveTitle, b.approve);
    await waitFor(() =>
      expect(api.requests.some((request) => request.path === path(R.approve, pending.id))).toBe(
        true,
      ),
    );
  });

  it('pembuat tidak bisa menyetujui kampanyenya sendiri', async () => {
    const own = { ...pending, createdBy: { id: fakeSession().user.id, name: 'Rina Kartika' } };
    await renderApp(`/broadcast/${own.id}`, base(detailRoutes(own)));
    expect(await screen.findByText(b.pendingOwn, { exact: false })).toBeVisible();
    expect(screen.queryByRole('button', { name: b.approve })).toBeNull();
  });

  it('dijeda rem otomatis: Supervisor tidak bisa melanjutkan (butuh Owner/Admin)', async () => {
    const paused = {
      ...withRecipients(fakeBroadcast({ status: 'paused' }), 100),
      pause: {
        reason: 'failure_spike' as const,
        at: new Date().toISOString(),
        by: null,
        requiresAdmin: true,
      },
    };
    await renderApp(`/broadcast/${paused.id}`, base(detailRoutes(paused), 'supervisor'));
    expect(await screen.findByText('Rem otomatis: terlalu banyak pesan gagal')).toBeVisible();
    expect(screen.getByText(b.resumeNeedsAdmin, { exact: false })).toBeVisible();
    expect(screen.getByRole('button', { name: b.resume })).toBeDisabled();
  });

  it('laporan: angka hasil + alasan gagal; ekspor CSV lewat GET ber-CSRF ke Blob', async () => {
    const running = withRecipients(fakeBroadcast({ status: 'running' }), 100);
    const created: string[] = [];
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob.type);
      return 'blob:ekspor';
    };
    URL.revokeObjectURL = () => undefined;
    const { api } = await renderApp(
      `/broadcast/${running.id}`,
      base(
        detailRoutes(running, {
          [`GET ${path(R.exportCsv, running.id)}`]: () =>
            new Response('baris,nomor\n2,+6281234567890\n', {
              status: 200,
              headers: { 'content-type': 'text/csv' },
            }),
        }),
      ),
    );
    const stats = within(await screen.findByRole('region', { name: b.statsLabel }));
    expect(stats.getByText(b.processed(60, 100))).toBeVisible();
    expect(stats.getByText('Pesan tidak bisa diantar.', { exact: false })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: b.exportCsv }));
    expect(await screen.findByText(b.exported)).toBeVisible();
    const request = api.requests.find((item) => item.path === path(R.exportCsv, running.id));
    expect(request?.headers['x-csrf-token']).toBeTruthy();
    expect(created).toHaveLength(1);
  });
});

describe('pengaturan broadcast, konektor data, alarm Telegram', () => {
  it('Batas kirim → Broadcast: Admin melihat bahwa melonggarkan hanya Owner', async () => {
    await renderApp(
      '/pengaturan/batas-kirim',
      base(
        {
          [`GET ${R.settings}`]: () => json({ settings: fakeBroadcastSettings() }),
          [`GET ${API_ROUTES.sendingLimits.settings}`]: () =>
            json({
              limits: {
                dailyPerUser: 500,
                dailyPerOrganization: 5000,
                perConversationPerMinute: 20,
                paused: null,
                sentLast24Hours: 3,
              },
            }),
        },
        'admin',
      ),
    );
    expect(await screen.findByText(b.settings.ownerOnly)).toBeVisible();
    expect(screen.getByLabelText(b.settings.approvalThreshold)).toHaveValue('50');
  });

  it('konektor: peringatan parameter rahasia di URL; nilai header tidak pernah di cache/DOM', async () => {
    const spies = secretSpies();
    const secret = 'Bearer rahasia-billing-123456';
    const view = await renderApp(
      '/pengaturan/konektor-data',
      base({
        [`GET ${R.connectors}`]: () => json({ connectors: [] }),
        [`POST ${R.connectors}`]: (request) => {
          const body = request.body as { name: string; url: string };
          return json(
            {
              connector: {
                id: '7c000000-0000-4000-8000-000000000001',
                name: body.name,
                url: body.url,
                authHeaderName: 'Authorization',
                authHeaderTail: '3456',
                itemsPath: 'data',
                phoneField: 'no_hp',
                lastTest: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
            { status: 201 },
          );
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t.connectors.add }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t.connectors.formTitleCreate }),
    );
    fireEvent.change(dialog.getByLabelText(t.connectors.nameLabel), {
      target: { value: 'Billing' },
    });
    fireEvent.change(dialog.getByLabelText(t.connectors.urlLabel), {
      target: { value: 'https://billing.contoh.id/api/menunggak?token=abc' },
    });
    expect(dialog.getByText(t.connectors.secretParams('token'))).toBeVisible();
    fireEvent.change(dialog.getByLabelText(t.connectors.urlLabel), {
      target: { value: 'https://billing.contoh.id/api/menunggak' },
    });
    fireEvent.change(dialog.getByLabelText(t.connectors.authHeaderValue), {
      target: { value: secret },
    });
    fireEvent.change(dialog.getByLabelText(t.connectors.itemsPath), { target: { value: 'data' } });
    fireEvent.change(dialog.getByLabelText(t.connectors.phoneField), {
      target: { value: 'no_hp' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t.connectors.save }));
    await confirmIdentity(t.connectors.confirmTitle, t.connectors.save);
    expect(await screen.findByText(t.connectors.created('Billing'))).toBeVisible();
    const sent = view.api.requests.find(
      (request) => request.method === 'POST' && request.path === R.connectors,
    );
    expect((sent?.body as { auth: { headerValue: string } }).auth.headerValue).toBe(secret);
    expectSecretNowhere(view, secret, spies);
  });

  it('Telegram belum diatur: penjelasan; simpan token lewat konfirmasi identitas, token tidak tersimpan di mana pun', async () => {
    const spies = secretSpies();
    const token = '123456789:AAHfiqksKZ8WmR2zSjiQ7_v4TMAKdiHm9T0';
    const view = await renderApp(
      '/pengaturan/alarm',
      base({
        [`GET ${API_ROUTES.alarms.telegram}`]: () =>
          json({
            telegram: {
              configured: false,
              enabled: false,
              tokenTail: null,
              chatId: null,
              lastTest: null,
              updatedAt: null,
            },
          }),
        [`PUT ${API_ROUTES.alarms.telegram}`]: () =>
          json({
            telegram: {
              configured: true,
              enabled: true,
              tokenTail: '9T0',
              chatId: '-1001234567890',
              lastTest: null,
              updatedAt: new Date().toISOString(),
            },
          }),
      }),
    );
    expect(await screen.findByText(t.alarms.notConfiguredTitle)).toBeVisible();
    fireEvent.change(screen.getByLabelText(t.alarms.tokenLabel), { target: { value: token } });
    fireEvent.change(screen.getByLabelText(t.alarms.chatIdLabel), {
      target: { value: '-1001234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.alarms.save }));
    await confirmIdentity(t.alarms.confirmTitle, t.alarms.save);
    expect(await screen.findByText(t.alarms.saved)).toBeVisible();
    const sent = view.api.requests.find((request) => request.method === 'PUT');
    expect(sent?.body).toMatchObject({ botToken: token, chatId: '-1001234567890', enabled: true });
    expectSecretNowhere(view, token, spies);
  });
});
