import {
  API_ROUTES,
  apiPath,
  type ChannelSummary,
  type EmailTemplate,
  type EmailTemplateSummary,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { templatePreviewDocument } from './email-preview-document';
import {
  draftFromTemplate,
  hasUnpublishedChanges,
  publishIssues,
  scanVariables,
  slugFromName,
  syncVariables,
  templateBadge,
} from './email-template-form';

const c = t.emailTemplates;
const ID = '5f0c2a90-7777-4c4c-9a9a-000000000001';
const CHANNEL_ID = '6b1f2c3d-0000-4000-8000-000000000001';
const R = API_ROUTES.emailTemplates;

const content = {
  subject: 'Tagihan {{periode}}',
  html: '<p>Halo {{nama}}, total {{total}}.</p>{{qris}}',
  text: null,
  variables: [
    { name: 'periode', label: 'Periode', required: true, example: 'November 2026' },
    { name: 'nama', label: 'Nama', required: true, example: 'Budi' },
    { name: 'total', label: 'Total', required: true, example: 'Rp185.000' },
  ],
  layout: 'brand' as const,
  footerText: null,
};

const template: EmailTemplate = {
  id: ID,
  slug: 'tagihan-bulanan',
  name: 'Tagihan bulanan',
  description: null,
  presetKey: 'tagihan-bulanan',
  archived: false,
  publishedVersion: null,
  lastUsedAt: null,
  draft: content,
  published: null,
  createdAt: '2026-11-20T03:00:00.000Z',
  updatedAt: '2026-11-21T03:00:00.000Z',
};

const summary: EmailTemplateSummary = {
  id: ID,
  slug: 'tagihan-bulanan',
  name: 'Tagihan bulanan',
  description: null,
  presetKey: 'tagihan-bulanan',
  archived: false,
  publishedVersion: 2,
  hasUnpublishedChanges: true,
  subject: 'Tagihan {{periode}}',
  lastUsedAt: '2026-11-21T02:00:00.000Z',
  createdAt: '2026-11-20T03:00:00.000Z',
  updatedAt: '2026-11-21T03:00:00.000Z',
};

const emailChannel: ChannelSummary = {
  id: CHANNEL_ID,
  type: 'email',
  name: 'Billing',
  enabled: true,
  displayPhoneNumber: null,
  emailAddresses: ['billing@perusahaan.example'],
};

const PREVIEW_HTML =
  '<!doctype html><html><head><title>x</title></head><body><p>ISI-EMAIL-RAHASIA</p></body></html>';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  const item = apiPath(R.template, { templateId: ID });
  return {
    [`GET ${R.list}`]: ({ query }) =>
      json({ templates: query.get('archived') === 'true' ? [] : [summary] }),
    [`GET ${item}`]: () => json({ template }),
    [`PATCH ${item}`]: ({ body }) => {
      const patch = body as { draft?: typeof content; name?: string };
      return json({
        template: {
          ...template,
          ...(patch.name ? { name: patch.name } : {}),
          draft: patch.draft ?? template.draft,
        },
      });
    },
    [`POST ${apiPath(R.publish, { templateId: ID })}`]: () =>
      json({
        template: {
          ...template,
          publishedVersion: 1,
          published: {
            ...content,
            version: 1,
            publishedAt: '2026-11-22T03:00:00.000Z',
            publishedBy: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
          },
        },
      }),
    [`POST ${R.preview}`]: () =>
      json({
        subject: 'Tagihan November 2026',
        html: PREVIEW_HTML,
        text: 'Halo Budi',
        warnings: [],
      }),
    [`GET ${apiPath(R.versions, { templateId: ID })}`]: () => json({ versions: [] }),
    [`GET ${R.presets}`]: () =>
      json({
        presets: [
          {
            key: 'tagihan-bulanan',
            name: 'Tagihan bulanan',
            description: 'Tagihan rutin',
            subject: 'Tagihan {{periode}} — {{id_pelanggan}}',
            layout: 'brand',
            variables: content.variables,
          },
        ],
      }),
    ...extra,
  };
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  path: string,
) => api.requests.filter((request) => request.method === method && request.path === path);

describe('logika editor template email', () => {
  it('memindai variabel: urut kemunculan, bawaan dipisah, nama tidak sah ditandai', () => {
    const scan = scanVariables({
      subject: 'Tagihan {{ periode }}',
      html: '<p>{{nama}} {{nama_organisasi}} {{Salah}}</p>{{qris}} {{periode}}',
      text: '{{total}}',
    });
    expect(scan.used).toEqual(['periode', 'nama', 'total']);
    expect(scan.builtins).toEqual(['nama_organisasi', 'qris']);
    expect(scan.invalid).toEqual([{ field: 'html', name: 'Salah' }]);
  });

  it('daftar variabel = yang dipakai; isian lama dipertahankan, juga setelah sempat terhapus', () => {
    const memory = new Map([
      ['total', { name: 'total', label: 'Total', required: false, example: 'Rp1' }],
    ]);
    const next = syncVariables(['nama', 'total'], [content.variables[1]!], memory);
    expect(next).toEqual([
      content.variables[1],
      { name: 'total', label: 'Total', required: false, example: 'Rp1' },
    ]);
    expect(syncVariables(['id_pelanggan'], [])[0]).toEqual({
      name: 'id_pelanggan',
      label: 'Id pelanggan',
      required: true,
      example: '',
    });
  });

  it('slug dari nama, pemeriksaan terbit, lencana & perubahan belum terbit', () => {
    expect(slugFromName('Tagihan Bulanan — Desember!')).toBe('tagihan-bulanan-desember');
    const draft = { ...draftFromTemplate(template), subject: ' ', html: '' };
    const issues = publishIssues(draft, scanVariables(draft));
    expect(issues.subject).toBe(c.subjectRequired);
    expect(issues.html).toBe(c.htmlRequired);
    expect(templateBadge({ archived: false, publishedVersion: 3 }).label).toBe('Terbit v3');
    expect(templateBadge({ archived: true, publishedVersion: 3 }).label).toBe(c.badge.archived);
    expect(hasUnpublishedChanges(template)).toBe(true);
    const published = {
      ...template,
      published: { ...content, version: 1, publishedAt: '', publishedBy: null },
    };
    expect(hasUnpublishedChanges(published)).toBe(false);
  });

  it('dokumen pratinjau: CSP sendiri + gaya gelap hanya di mode gelap', () => {
    const light = templatePreviewDocument(PREVIEW_HTML, 'light');
    expect(light).toContain('Content-Security-Policy');
    expect(light).not.toContain('invert(1)');
    const dark = templatePreviewDocument(PREVIEW_HTML, 'dark');
    expect(dark.indexOf('invert(1)')).toBeLessThan(dark.indexOf('</head>'));
  });
});

describe('Pengaturan → Template email', () => {
  it('daftar: lencana terbit + perubahan belum terbit; Supervisor boleh membuka', async () => {
    await renderApp('/pengaturan/template-email', {
      routes: routes(),
      session: fakeSession('supervisor'),
    });
    const row = await screen.findByRole('link', { name: c.open('Tagihan bulanan') });
    expect(within(row).getByText('Terbit v2')).toBeVisible();
    expect(within(row).getByText(c.unpublishedChanges)).toBeVisible();
    expect(within(row).getByText('tagihan-bulanan')).toBeVisible();
  });

  it('CS tidak punya templates.manage → dialihkan tanpa memuat template', async () => {
    const { router, api } = await renderApp('/pengaturan/template-email', {
      routes: routes(),
      session: fakeSession('cs'),
    });
    await waitFor(() =>
      expect(router.state.location.pathname).not.toBe('/pengaturan/template-email'),
    );
    expect(requestsTo(api, 'GET', R.list)).toHaveLength(0);
  });

  it('kosong → pakai preset (slug kembar dicoba dengan akhiran) → editor', async () => {
    let attempts = 0;
    const { router, api } = await renderApp('/pengaturan/template-email', {
      routes: routes({
        [`GET ${R.list}`]: () => json({ templates: [] }),
        [`POST ${apiPath(R.fromPreset, { presetId: 'tagihan-bulanan' })}`]: () => {
          attempts += 1;
          return attempts === 1
            ? apiError(409, 'CONFLICT', 'Slug itu sudah dipakai template lain.', {
                details: [{ field: 'slug', message: 'Slug itu sudah dipakai template lain.' }],
              })
            : json({ template }, { status: 201 });
        },
      }),
    });
    expect(await screen.findByText(c.emptyTitle)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.fromPreset }));
    const dialog = within(await screen.findByRole('dialog', { name: c.presetsTitle }));
    fireEvent.click(await dialog.findByRole('button', { name: c.presetUse('Tagihan bulanan') }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/pengaturan/template-email/${ID}`),
    );
    const calls = requestsTo(api, 'POST', apiPath(R.fromPreset, { presetId: 'tagihan-bulanan' }));
    expect(calls.map((call) => call.body)).toEqual([{}, { slug: 'tagihan-bulanan-2' }]);
  });

  it('editor: variabel baru dari subjek, simpan draf, terbitkan dengan konfirmasi identitas', async () => {
    const { api } = await renderApp(`/pengaturan/template-email/${ID}`, { routes: routes() });
    const subject = await screen.findByLabelText(c.subjectLabel);
    fireEvent.change(subject, { target: { value: 'Tagihan {{periode}} — {{id_pelanggan}}' } });
    expect(await screen.findByText('{{id_pelanggan}}')).toBeVisible();
    fireEvent.change(screen.getByLabelText(c.variableExampleFor('id_pelanggan')), {
      target: { value: 'PLG-00873' },
    });

    fireEvent.click(screen.getByRole('button', { name: c.publish }));
    await confirmIdentity(c.publishTitle('Tagihan bulanan'), c.publish);
    expect(await screen.findByText(c.published(1))).toBeVisible();

    const patch = requestsTo(api, 'PATCH', apiPath(R.template, { templateId: ID }))[0]?.body as {
      draft: { subject: string; variables: { name: string; example: string }[] };
    };
    expect(patch.draft.subject).toBe('Tagihan {{periode}} — {{id_pelanggan}}');
    expect(patch.draft.variables.map((variable) => variable.name)).toEqual([
      'periode',
      'id_pelanggan',
      'nama',
      'total',
    ]);
    expect(patch.draft.variables[1]?.example).toBe('PLG-00873');
    expect(requestsTo(api, 'POST', apiPath(R.publish, { templateId: ID }))[0]?.body).toEqual({
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('terbit ditolak server (400 per isian) → pesan di bawah HTML, dialog tertutup', async () => {
    await renderApp(`/pengaturan/template-email/${ID}`, {
      routes: routes({
        [`POST ${apiPath(R.publish, { templateId: ID })}`]: () =>
          apiError(400, 'VALIDATION_ERROR', 'Isian belum valid.', {
            details: [{ field: 'draft.html', message: 'HTML memuat bagian yang tidak boleh ada.' }],
          }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: c.publish }));
    await confirmIdentity(c.publishTitle('Tagihan bulanan'), c.publish);
    expect(await screen.findByText('HTML memuat bagian yang tidak boleh ada.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: c.publishTitle('Tagihan bulanan') })).toBeNull();
  });

  it('pratinjau di iframe sandbox="" srcdoc (isi email tidak masuk DOM) + kirim tes ke akun sendiri', async () => {
    const { api } = await renderApp(`/pengaturan/template-email/${ID}`, {
      routes: routes({
        [`POST ${apiPath(R.test, { templateId: ID })}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Kirim tes dibatasi 10 kali per 10 menit.', {
            retryAfter: 120,
          }),
      }),
      inbox: { channels: [emailChannel] },
    });
    const tab = await screen.findByRole('tab', { name: c.tabs.preview });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    const frame = await screen.findByTitle(
      c.previewFrame('Tagihan bulanan'),
      {},
      { timeout: 3000 },
    );
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('ISI-EMAIL-RAHASIA');
    expect(screen.queryByText('ISI-EMAIL-RAHASIA')).toBeNull();
    expect(screen.getByText(c.testHint('rina@majujaya.co.id'))).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: c.testSend }));
    expect(await screen.findByText(c.testLockedTitle)).toBeVisible();
    const body = requestsTo(api, 'POST', apiPath(R.test, { templateId: ID }))[0]?.body;
    expect(body).toMatchObject({ senderId: `chn_${CHANNEL_ID}`, which: 'draft' });
    expect(body).not.toHaveProperty('to');
  });

  it('riwayat: pulihkan versi lama ke draf tanpa konfirmasi identitas', async () => {
    const restored = { ...template, draft: { ...content, subject: 'Versi lama' } };
    const { api } = await renderApp(`/pengaturan/template-email/${ID}`, {
      routes: routes({
        [`GET ${apiPath(R.versions, { templateId: ID })}`]: () =>
          json({
            versions: [
              {
                version: 1,
                state: 'superseded',
                subject: 'Versi lama',
                createdBy: null,
                createdAt: '2026-11-20T03:00:00.000Z',
                publishedBy: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
                publishedAt: '2026-11-20T03:00:00.000Z',
              },
            ],
          }),
        [`POST ${apiPath(R.restore, { templateId: ID, versionId: '1' })}`]: () =>
          json({ template: restored }),
      }),
    });
    const tab = await screen.findByRole('tab', { name: c.tabs.history });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.click(await screen.findByRole('button', { name: c.versionRestoreLabel(1) }));
    const dialog = within(await screen.findByRole('dialog', { name: c.restoreTitle(1) }));
    act(() => {
      fireEvent.click(dialog.getByRole('button', { name: c.restoreConfirm }));
    });
    expect(await screen.findByText(c.restored(1))).toBeVisible();
    expect(await screen.findByDisplayValue('Versi lama')).toBeVisible();
    expect(
      requestsTo(api, 'POST', apiPath(R.restore, { templateId: ID, versionId: '1' })),
    ).toHaveLength(1);
  });
});
