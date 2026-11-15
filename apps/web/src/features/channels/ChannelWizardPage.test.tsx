import {
  API_ROUTES,
  WEBHOOK_HTTPS_WARNING,
  apiPath,
  type ChannelTestResult,
} from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeChannel, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';

const copy = t.channels.wizard;
const TOKEN = `EAAGtokenRahasia${'Q'.repeat(40)}`;
const SECRET = '9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a91';
const created = fakeChannel({
  id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e05',
  status: 'untested',
  lastTest: null,
  number: null,
});
const webhook = {
  channelId: created.id,
  callbackUrl: `http://127.0.0.1:3100/webhooks/whatsapp/${created.id}`,
  verifyToken: 'q7Vb2kLx9TzR4mWn8PcY3sHd6JfA1uGe5oKi0NvB2xE',
  verifyTokenRotatedAt: '2026-11-14T02:00:00.000Z',
  subscribeFields: ['messages', 'message_template_status_update', 'account_update'],
  warning: WEBHOOK_HTTPS_WARNING,
};
const okResult: ChannelTestResult = {
  ok: true,
  code: 'ok',
  message: 'Koneksi berhasil. Token, App Secret, Phone Number ID, dan WABA ID cocok.',
  testedAt: '2026-11-14T03:00:00.000Z',
  number: fakeChannel().number,
  warnings: [{ code: 'quality_medium', message: 'Kualitas nomor Sedang.' }],
};

/** Tenggat lebih longgar: `pnpm test` menjalankan semua paket bersamaan (mesin sibuk). */
const SLOW = { timeout: 5_000 };
const heading = (name: string) => screen.findByRole('heading', { level: 2, name }, SLOW);
const next = () => fireEvent.click(screen.getByRole('button', { name: copy.next }));
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function toIdsStep() {
  await heading(copy.steps.business.title);
  expect(screen.getByRole('link', { name: /business\.facebook\.com/ })).toHaveAttribute(
    'href',
    'https://business.facebook.com/',
  );
  next();
  await heading(copy.steps.app.title);
  next();
  await heading(copy.steps.number.title);
  next();
  await heading(copy.steps.ids.title);
}

async function fillAll() {
  fill(copy.steps.ids.name, 'CS Utama');
  fill(copy.steps.ids.phoneNumberId, '106540352242922');
  fill(copy.steps.ids.wabaId, '102290129340398');
  next();
  await heading(copy.steps.token.title);
  fill(copy.steps.token.label, TOKEN);
  next();
  await heading(copy.steps.secret.title);
  fill(copy.steps.secret.label, SECRET);
}

function routes(create: FakeHandler) {
  return {
    [`POST ${API_ROUTES.channels.settings}`]: create,
    [`POST ${apiPath(API_ROUTES.channels.test, { channelId: created.id })}`]: () => json(okResult),
    [`GET ${apiPath(API_ROUTES.channels.channel, { channelId: created.id })}`]: () =>
      json({ channel: created }),
    [`GET ${apiPath(API_ROUTES.channels.webhook, { channelId: created.id })}`]: () => json(webhook),
  };
}

describe('wizard tambah nomor WhatsApp', () => {
  it('9 langkah: isian per langkah, simpan dengan konfirmasi identitas, webhook, tes, selesai', async () => {
    const { api, router, queryClient } = await renderApp('/pengaturan/channel/tambah', {
      routes: routes(() => json({ channel: created, webhook }, { status: 201 })),
    });
    await toIdsStep();

    // Lanjut tanpa isian → error per isian, fokus ke isian pertama yang salah.
    next();
    const name = screen.getByLabelText(copy.steps.ids.name);
    await waitFor(() => expect(name).toHaveFocus(), SLOW);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Nama channel wajib diisi.')).toBeInTheDocument();

    await fillAll();
    // Isian rahasia: tipe password, tanpa isi otomatis.
    const secret = screen.getByLabelText(copy.steps.secret.label);
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('autocomplete', 'off');

    // Mundur lalu maju lagi: isian tetap ada.
    fireEvent.click(screen.getByRole('button', { name: copy.back }));
    await heading(copy.steps.token.title);
    expect(screen.getByLabelText(copy.steps.token.label)).toHaveValue(TOKEN);
    next();
    await heading(copy.steps.secret.title);
    expect(screen.getByLabelText(copy.steps.secret.label)).toHaveValue(SECRET);

    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    await confirmIdentity(copy.confirmTitle, copy.save);
    await heading(copy.steps.webhook.title);

    const create = api.requests.find(
      (request) => request.method === 'POST' && request.path === API_ROUTES.channels.settings,
    );
    expect(create?.body).toEqual({
      type: 'whatsapp',
      name: 'CS Utama',
      phoneNumberId: '106540352242922',
      wabaId: '102290129340398',
      accessToken: TOKEN,
      appSecret: SECRET,
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    // Rahasia tidak tertinggal di cache Query (termasuk cache mutasi) maupun storage.
    const cached = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
      queryClient.getMutationCache().getAll().length,
    ]);
    expect(cached).not.toContain(TOKEN);
    expect(cached).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
      TOKEN,
    );

    // Langkah webhook: nilai siap disalin, peringatan https, field langganan.
    expect(screen.getByText(webhook.callbackUrl)).toBeInTheDocument();
    expect(screen.getByText(webhook.verifyToken)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.channels.webhook.copyTokenLabel })).toBeVisible();
    expect(screen.getByText(WEBHOOK_HTTPS_WARNING)).toBeInTheDocument();
    expect(screen.getByText('message_template_status_update')).toBeInTheDocument();
    // Langkah isian sudah tersimpan: tidak ada tombol Kembali ke sana.
    expect(screen.queryByRole('button', { name: copy.back })).not.toBeInTheDocument();

    next();
    await heading(copy.steps.test.title);
    fireEvent.click(screen.getByRole('button', { name: t.channels.test.action }));
    expect(await screen.findByText(okResult.message, {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Kualitas nomor Sedang.')).toBeInTheDocument();
    expect(screen.getByText('10.000 pelanggan per 24 jam')).toBeInTheDocument();

    next();
    await heading(copy.steps.billing.title);
    fireEvent.click(screen.getByRole('button', { name: copy.finish }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/pengaturan/channel/${created.id}`),
    );
  });

  it('error isian dari server (409 Phone Number ID) kembali ke langkahnya', async () => {
    const message = 'Nomor ini sudah terhubung sebagai channel lain.';
    await renderApp('/pengaturan/channel/tambah', {
      routes: routes(() =>
        apiError(409, 'CONFLICT', message, { details: [{ field: 'phoneNumberId', message }] }),
      ),
    });
    await toIdsStep();
    await fillAll();
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    await confirmIdentity(copy.confirmTitle, copy.save);
    await heading(copy.steps.ids.title);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    const field = screen.getByLabelText(copy.steps.ids.phoneNumberId);
    await waitFor(() => expect(field).toHaveFocus(), SLOW);
  });

  it('password/kode konfirmasi salah: tetap di dialog dengan pesan di isiannya', async () => {
    await renderApp('/pengaturan/channel/tambah', {
      routes: routes(() =>
        apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
          details: [{ field: 'confirmation.code', message: 'Kode verifikasi salah.' }],
        }),
      ),
    });
    await toIdsStep();
    await fillAll();
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    const dialog = await confirmIdentity(copy.confirmTitle, copy.save);
    expect(await within(dialog).findByText('Kode verifikasi salah.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: copy.steps.secret.title })).toBeVisible();
  });

  it('server tanpa kunci enkripsi: wizard tidak dibuka, penjelasan tampil', async () => {
    await renderApp('/pengaturan/channel/tambah', {
      channelSettings: { channels: [], canStoreSecrets: false, maxChannels: 20 },
    });
    expect(
      await screen.findByRole('heading', { name: t.channels.list.noMasterKeyTitle }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.next })).not.toBeInTheDocument();
  });

  it('peran tanpa channels.manage dialihkan ke Pengaturan tanpa memanggil API channel', async () => {
    const { router, api } = await renderApp('/pengaturan/channel/tambah', {
      session: fakeSession('cs'),
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    expect(screen.queryByRole('link', { name: /Channel/ })).not.toBeInTheDocument();
    expect(api.requests.some((request) => request.path.includes('/channels'))).toBe(false);
  });
});
