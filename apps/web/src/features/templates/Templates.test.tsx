import { API_ROUTES, apiPath, type MessageTemplate } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { apiError, json, type FakeHandler } from '../../test/fake-api';
import { fakeChannelSummary } from '../../test/fake-inbox';
import { fakeOtpTemplate, fakePreset, fakeTemplate } from '../../test/fake-templates';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import {
  contentFrom,
  draftFrom,
  draftIssues,
  editability,
  emptyDraft,
  nextVariable,
} from './template-form';
import { fillErrors, fillParameters, fillSpec } from './template-fill';

const c = t.templates;
const s = t.inbox.templateSend;
const LIST = API_ROUTES.templates.list;

describe('logika editor template', () => {
  it('variabel bernomor wajib berurutan dan berisi contoh; OTP hanya pengaturan kode', () => {
    const draft = {
      ...emptyDraft('c1'),
      name: 'tagihan_bulanan',
      body: 'Halo {{1}}, tagihan {{3}} ya.',
    };
    const fields = draftIssues(draft).map((issue) => issue.field);
    expect(fields).toContain('body.text'); // {{3}} tanpa {{2}}
    expect(fields).toContain('body.examples.1');
    expect(nextVariable(draft)).toBe('4');

    const ok = {
      ...draft,
      body: 'Halo {{1}}, tagihan {{2}} ya.',
      examples: { '1': 'Budi', '2': 'Rp150.000' },
    };
    expect(draftIssues(ok)).toEqual([]);
    // Contoh variabel yang sudah dihapus dari isi tidak ikut dikirim.
    expect(contentFrom({ ...ok, examples: { ...ok.examples, '9': 'sisa' } }).body.examples).toEqual(
      {
        '1': 'Budi',
        '2': 'Rp150.000',
      },
    );

    const otp = {
      ...emptyDraft('c1'),
      name: 'kode_masuk',
      category: 'AUTHENTICATION' as const,
      otpExpiry: '10',
    };
    expect(draftIssues(otp)).toEqual([]);
    expect(contentFrom(otp)).toMatchObject({
      header: null,
      buttons: [],
      authentication: { addSecurityRecommendation: true, codeExpirationMinutes: 10 },
    });
    expect(draftIssues({ ...otp, otpExpiry: '120' }).map((issue) => issue.field)).toContain(
      'authentication.codeExpirationMinutes',
    );
  });

  it('yang bisa diubah mengikuti status Meta', () => {
    expect(editability(fakeTemplate({ status: 'PENDING' }))).toMatchObject({
      content: false,
      lockedReason: 'review',
    });
    expect(editability(fakeTemplate({ status: 'APPROVED' }))).toMatchObject({
      content: true,
      identity: false, // sudah di Meta
      category: false, // sudah disetujui
    });
    expect(editability(fakeTemplate({ status: 'DRAFT', metaTemplateId: null }))).toMatchObject({
      content: true,
      identity: true,
      category: true,
    });
    const media = fakeTemplate({
      content: { ...fakeTemplate().content, header: { format: 'IMAGE' } },
    });
    expect(editability(media).lockedReason).toBe('media');
    expect(draftIssues(draftFrom(media)).map((issue) => issue.field)).toContain('header');
  });

  it('isian kirim: variabel isi/tombol tautan wajib, tanpa karakter kontrol; OTP = body.1', () => {
    const template = fakeTemplate({
      content: {
        ...fakeTemplate().content,
        buttons: [
          {
            type: 'URL',
            text: 'Bayar',
            url: 'https://contoh.id/bayar/{{1}}',
            example: 'https://contoh.id/bayar/123',
          },
        ],
      },
    });
    const spec = fillSpec(template);
    expect(spec.body).toEqual(['1', '2']);
    expect(spec.buttons).toEqual([{ index: 0, kind: 'URL', text: 'Bayar' }]);
    const errors = fillErrors(
      spec,
      { header: '', body: { '1': 'Budi', '2': 'a\tb' }, buttons: {} },
      false,
    );
    expect(errors).toEqual({
      'parameters.body.2': s.singleLine,
      'parameters.buttons.0': s.required,
    });
    expect(
      fillParameters(spec, {
        header: '',
        body: { '1': ' Budi ', '2': 'Nov' },
        buttons: { '0': 'INV-1' },
      }),
    ).toEqual({ body: { '1': 'Budi', '2': 'Nov' }, buttons: { '0': 'INV-1' } });
    const otp = fillSpec(fakeOtpTemplate());
    expect(otp).toMatchObject({ otp: true, body: ['1'], buttons: [] });
  });
});

function listRoutes(templates: MessageTemplate[], extra: Record<string, FakeHandler> = {}) {
  return {
    inbox: { channels: [fakeChannelSummary()] },
    routes: { [`GET ${LIST}`]: () => json({ templates }), ...extra },
  };
}

describe('Pengaturan → Template WhatsApp', () => {
  it('daftar: status, alasan penolakan dalam bahasa Indonesia, perubahan belum diajukan, saringan', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const approved = fakeTemplate({ name: 'tagihan_bulanan' });
    const rejected = fakeTemplate({
      name: 'promo_akhir_tahun',
      category: 'MARKETING',
      status: 'REJECTED',
      rejectedReason: 'INVALID_FORMAT',
      qualityScore: null,
    });
    const changed = fakeTemplate({ name: 'jadwal_teknisi', localChanges: true });
    await renderApp('/pengaturan/template', listRoutes([approved, rejected, changed]));
    const list = within(await screen.findByRole('list', { name: c.listLabel }));
    expect(list.getByRole('link', { name: c.open('tagihan_bulanan') })).toBeVisible();
    expect(list.getByText(c.rejectedReason(c.reasons.INVALID_FORMAT!))).toBeVisible();
    expect(list.getByText(c.localChanges)).toBeVisible();
    expect(list.getAllByText('Disetujui')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText(c.statusLabel), { target: { value: 'REJECTED' } });
    expect(list.queryByRole('link', { name: c.open('tagihan_bulanan') })).toBeNull();
    expect(list.getByRole('link', { name: c.open('promo_akhir_tahun') })).toBeVisible();
    fireEvent.change(screen.getByLabelText(c.searchLabel), { target: { value: 'tidak-ada' } });
    expect(screen.getByText(c.notFound)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.resetFilters }));
    expect(
      within(screen.getByRole('list', { name: c.listLabel })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it('sinkron dari Meta → ringkasan; kartu = tautan ke halaman ubah (hapus hanya di sana)', async () => {
    const template = fakeTemplate({ name: 'tagihan_bulanan' });
    await renderApp(
      '/pengaturan/template',
      listRoutes([template], {
        [`POST ${API_ROUTES.templates.sync}`]: () =>
          json({
            channels: [
              {
                channelId: template.channelId,
                ok: true,
                error: null,
                created: 2,
                updated: 1,
                removed: 0,
              },
            ],
          }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: c.sync }));
    expect(await screen.findByText(c.syncDone(2, 1, 0))).toBeVisible();
    expect(screen.getByRole('link', { name: c.open('tagihan_bulanan') })).toHaveAttribute(
      'href',
      `/pengaturan/template/${template.id}`,
    );
    expect(screen.queryByRole('button', { name: c.remove('tagihan_bulanan') })).toBeNull();
  });

  it('kosong: ajakan preset/buat/sinkron; preset → draf dibuka di editor', async () => {
    const created = fakeTemplate({
      name: 'gangguan_jaringan',
      status: 'DRAFT',
      metaTemplateId: null,
      source: 'preset',
      submittedAt: null,
    });
    const { api, router } = await renderApp(
      '/pengaturan/template',
      listRoutes([], {
        [`GET ${API_ROUTES.templates.presets}`]: () => json({ presets: [fakePreset()] }),
        [`POST ${apiPath(API_ROUTES.templates.fromPreset, { presetId: 'isp_gangguan_jaringan' })}`]:
          () => json({ template: created }, { status: 201 }),
        [`GET ${apiPath(API_ROUTES.templates.template, { templateId: created.id })}`]: () =>
          json({ template: created }),
      }),
    );
    expect(await screen.findByText(c.emptyTitle)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.fromPreset }));
    const dialog = within(await screen.findByRole('dialog', { name: c.presetsTitle }));
    fireEvent.click(
      await dialog.findByRole('button', { name: c.presetUse('Info gangguan jaringan') }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/pengaturan/template/${created.id}`),
    );
    expect(await screen.findByText(c.presetCreated('gangguan_jaringan'))).toBeVisible();
    expect(
      api.requests.find((request) => request.path.endsWith('/presets/isp_gangguan_jaringan'))?.body,
    ).toEqual({ channelId: fakeChannelSummary().id });
  });
});

describe('editor template', () => {
  it('buat baru: nama jadi snake_case, pemeriksaan langsung, lalu Ajukan = simpan + ajukan', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const saved = fakeTemplate({ name: 'info_tagihan', status: 'DRAFT', metaTemplateId: null });
    const submitted = { ...saved, status: 'PENDING' as const };
    const { api, router } = await renderApp(
      '/pengaturan/template/baru',
      listRoutes([], {
        [`POST ${LIST}`]: () => json({ template: saved }, { status: 201 }),
        [`POST ${apiPath(API_ROUTES.templates.submit, { templateId: saved.id })}`]: () =>
          json({ template: submitted }),
        [`GET ${apiPath(API_ROUTES.templates.template, { templateId: saved.id })}`]: () =>
          json({ template: submitted }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(c.nameLabel), {
      target: { value: 'Info Tagihan' },
    });
    expect(screen.getByLabelText(c.nameLabel)).toHaveValue('info_tagihan');
    fireEvent.change(screen.getByLabelText(c.bodyLabel), { target: { value: 'Halo kak' } });
    fireEvent.click(screen.getByRole('button', { name: c.addVariable }));
    expect(screen.getByLabelText(c.bodyLabel)).toHaveValue('Halo kak {{1}}');
    // Pratinjau & pemeriksaan langsung: diakhiri variabel + contoh belum diisi.
    expect(screen.getByText(c.issuesTitle(2))).toBeVisible();
    fireEvent.change(screen.getByLabelText(c.bodyLabel), {
      target: { value: 'Halo kak {{1}}, tagihan sudah terbit.' },
    });
    fireEvent.change(screen.getByLabelText(c.exampleLabel('1')), { target: { value: 'Budi' } });
    expect(screen.getByText(c.issuesTitle(0))).toBeVisible();
    expect(
      within(screen.getByRole('figure', { name: c.previewLabel })).getByText(
        'Halo kak Budi, tagihan sudah terbit.',
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: c.submit }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/pengaturan/template/${saved.id}`),
    );
    expect(await screen.findByText(c.submitted)).toBeVisible();
    const create = api.requests.find(
      (request) => request.method === 'POST' && request.path === LIST,
    );
    expect(create?.body).toMatchObject({
      name: 'info_tagihan',
      language: 'id',
      category: 'UTILITY',
      content: {
        body: { text: 'Halo kak {{1}}, tagihan sudah terbit.', examples: { '1': 'Budi' } },
      },
    });
    expect(api.requests.some((request) => request.path.endsWith('/submit'))).toBe(true);
  });

  it('ajukan ditolak di klien bila masih ada masalah; galat 400 server jatuh di isiannya', async () => {
    const draft = fakeTemplate({ name: 'info', status: 'DRAFT', metaTemplateId: null });
    const { api } = await renderApp(
      `/pengaturan/template/${draft.id}`,
      listRoutes([draft], {
        [`GET ${apiPath(API_ROUTES.templates.template, { templateId: draft.id })}`]: () =>
          json({ template: draft }),
        [`PATCH ${apiPath(API_ROUTES.templates.template, { templateId: draft.id })}`]: (request) =>
          json({ template: { ...draft, ...(request.body as object) } }),
        [`POST ${apiPath(API_ROUTES.templates.submit, { templateId: draft.id })}`]: () =>
          apiError(400, 'VALIDATION_ERROR', 'Isi template belum sesuai.', {
            details: [{ field: 'content.footer.text', message: 'Catatan kaki ditolak.' }],
          }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(c.bodyLabel), {
      target: { value: '{{1}} halo' },
    });
    fireEvent.click(screen.getByRole('button', { name: c.submit }));
    expect(await screen.findByText(c.fixFirst)).toBeVisible();
    expect(api.requests.some((request) => request.path.endsWith('/submit'))).toBe(false);

    fireEvent.change(screen.getByLabelText(c.bodyLabel), { target: { value: 'Halo {{1}} ya' } });
    fireEvent.change(screen.getByLabelText(c.exampleLabel('1')), { target: { value: 'Budi' } });
    fireEvent.click(screen.getByRole('button', { name: c.submit }));
    expect(await screen.findByText('Catatan kaki ditolak.')).toBeVisible();
  });

  it('sedang ditinjau Meta: isian terkunci, tanpa tombol ajukan', async () => {
    const pending = fakeTemplate({ name: 'tagihan', status: 'PENDING' });
    await renderApp(
      `/pengaturan/template/${pending.id}`,
      listRoutes([pending], {
        [`GET ${apiPath(API_ROUTES.templates.template, { templateId: pending.id })}`]: () =>
          json({ template: pending }),
      }),
    );
    expect(await screen.findByText(c.locked.review)).toBeVisible();
    expect(screen.getByLabelText(c.bodyLabel)).toBeDisabled();
    expect(screen.queryByRole('button', { name: c.submitChanges })).toBeNull();
    expect(screen.getByRole('button', { name: c.removeConfirm })).toBeEnabled();
  });

  it('tidak ditemukan (404): penjelasan + kembali ke daftar', async () => {
    const id = '7e000000-0000-4000-8000-00000000ffff';
    await renderApp(
      `/pengaturan/template/${id}`,
      listRoutes([], {
        [`GET ${apiPath(API_ROUTES.templates.template, { templateId: id })}`]: () =>
          apiError(404, 'NOT_FOUND', 'Template tidak ditemukan.'),
      }),
    );
    expect(await screen.findByText(c.notFoundTitle)).toBeVisible();
    expect(screen.getByRole('link', { name: c.backToList })).toBeVisible();
  });
});
