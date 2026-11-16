import { API_ROUTES, apiPath, type WhatsAppChannel } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  fakeChannel,
  fakeSession,
  json,
  type FakeHandler,
  type FakeRequest,
} from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';

const channel = fakeChannel();
const path = `/pengaturan/channel/${channel.id}`;
const at = (route: string) => apiPath(route, { channelId: channel.id });
const webhook = {
  channelId: channel.id,
  callbackUrl: channel.webhookUrl,
  verifyToken: 'tokenLamaVerify0000000000000000000000000000',
  verifyTokenRotatedAt: '2026-11-10T02:00:00.000Z',
  subscribeFields: ['messages', 'message_template_status_update', 'account_update'],
  warning: null,
};
const profile = {
  about: 'Internet cepat untuk rumah dan kantor.',
  address: 'Jl. Pahlawan No. 12',
  description: null,
  email: 'cs@majujaya.co.id',
  websites: ['https://majujaya.co.id'],
  vertical: 'PROF_SERVICES',
};

function detailRoutes(
  current: WhatsAppChannel = channel,
  extra: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> {
  return {
    [`GET ${at(API_ROUTES.channels.channel)}`]: () => json({ channel: current }),
    [`GET ${at(API_ROUTES.channels.webhook)}`]: () => json(webhook),
    [`GET ${at(API_ROUTES.channels.businessProfile)}`]: () =>
      json({ profile, fetchedAt: '2026-11-14T02:00:00.000Z' }),
    ...extra,
  };
}

const find = (requests: FakeRequest[], method: string, route: string) =>
  requests.filter((request) => request.method === method && request.path === at(route));

describe('halaman nomor WhatsApp', () => {
  it('ringkasan: nama, nomor, status, kualitas berlabel, batas pesan; rahasia hanya tersamar', async () => {
    await renderApp(path, { routes: detailRoutes() });
    expect(await screen.findByRole('heading', { level: 2, name: 'CS Utama' })).toBeVisible();
    expect(screen.getByText('+62 811-7200-345')).toBeInTheDocument();
    expect(screen.getByText('Terhubung', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Tinggi')).toBeInTheDocument();
    expect(screen.getByText('10.000 pelanggan per 24 jam')).toBeInTheDocument();
    expect(screen.getByText('••••Q2ZD')).toBeInTheDocument();
    expect(await screen.findByText(webhook.verifyToken)).toBeInTheDocument();
  });

  it('navigasi bagian: keenam lompatan menandai bagian yang dipilih sampai pengguna menggulir sendiri', async () => {
    await renderApp(path, { routes: detailRoutes() });
    const nav = await screen.findByRole('navigation', { name: t.channels.sections.label });
    const container = nav.closest<HTMLElement>('[class*="body"]')!;
    const labels = [
      t.channels.sections.summary,
      t.channels.webhook.title,
      t.channels.profile.title,
      t.channels.rename.title,
      t.channels.credentials.title,
      t.channels.access.title,
    ];
    for (const label of labels) {
      const link = within(nav).getByRole('link', { name: label });
      fireEvent.click(link);
      // Guliran dari kode (lompatan itu sendiri) tidak memindahkan penanda.
      fireEvent.scroll(container);
      expect(link).toHaveAttribute('aria-current', 'location');
      expect(
        within(nav)
          .getAllByRole('link')
          .filter((item) => item.hasAttribute('aria-current')),
      ).toHaveLength(1);
    }
    fireEvent.click(within(nav).getByRole('link', { name: t.channels.rename.title }));
    // Pengguna menggulir sendiri (roda) → kunci lepas, penanda mengikuti posisi gulir lagi.
    fireEvent.wheel(container);
    fireEvent.scroll(container);
    expect(within(nav).getByRole('link', { name: t.channels.rename.title })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('GET profil bisnis membawa header CSRF (rute itu memanggil Meta)', async () => {
    const { api } = await renderApp(path, { routes: detailRoutes() });
    await screen.findByDisplayValue(profile.about);
    const [read] = find(api.requests, 'GET', API_ROUTES.channels.businessProfile);
    expect(read?.headers['x-csrf-token']).toBe('csrf-tes-1');
  });

  it('tes koneksi 429: tombol terkunci dengan hitung mundur dan judul "dibatasi sementara"', async () => {
    await renderApp(path, {
      routes: detailRoutes(channel, {
        [`POST ${at(API_ROUTES.channels.test)}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Batas tes koneksi (10 kali per 5 menit) sudah tercapai.', {
            retryAfter: 125,
          }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: t.channels.test.action }));
    expect(await screen.findByText(t.channels.test.lockedTitle)).toBeInTheDocument();
    const locked = screen.getByRole('button', { name: /Coba lagi dalam 2:0\d/ });
    expect(locked).toBeDisabled();
  });

  it('tes gagal menampilkan pesan server apa adanya dan status ikut berubah', async () => {
    const message = 'Token System User ditolak Meta (salah, dicabut, atau milik aplikasi lain).';
    let current = channel;
    const lastTest = {
      ok: false,
      code: 'token_invalid' as const,
      message,
      testedAt: '2026-11-14T03:00:00.000Z',
    };
    await renderApp(path, {
      routes: {
        ...detailRoutes(channel),
        [`GET ${at(API_ROUTES.channels.channel)}`]: () => json({ channel: current }),
        [`POST ${at(API_ROUTES.channels.test)}`]: () => {
          current = { ...channel, status: 'failed', lastTest, warnings: [] };
          return json({ ...lastTest, number: null, warnings: [] });
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: t.channels.test.action }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText(t.channels.detail.lastFailedTitle)).toBeInTheDocument();
    // Satu kotak gagal saja (tanpa salinan "Koneksi gagal" di bawah tombol tes).
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(await screen.findByText('Koneksi gagal', { selector: 'span' })).toBeInTheDocument();
  });

  it('tes terakhir gagal karena token: aksi utama "Ganti kredensial" membuka form, Token terfokus', async () => {
    const failed = fakeChannel({
      status: 'failed',
      lastTest: {
        ok: false,
        code: 'token_invalid',
        message: 'Token System User ditolak Meta.',
        testedAt: '2026-11-14T03:00:00.000Z',
      },
    });
    await renderApp(path, { routes: detailRoutes(failed) });
    const notice = (await screen.findByText(t.channels.detail.lastFailedTitle)).closest(
      'div',
    )!.parentElement!;
    const fix = within(notice).getByRole('button', { name: t.channels.credentials.change });
    // Tombol tes turun jadi sekunder: mengulang tes dengan token yang sama tidak menolong.
    expect(screen.getByRole('button', { name: t.channels.test.action })).not.toHaveClass(/primary/);
    fireEvent.click(fix);
    const token = await screen.findByLabelText(new RegExp(`^${t.channels.credentials.token}`));
    await waitFor(() => expect(token).toHaveFocus());
    // Fakta kredensial disembunyikan selama form terbuka (nilainya tidak tampil dua kali).
    expect(screen.queryByText('••••Q2ZD')).not.toBeInTheDocument();
  });

  it('ganti kredensial: hanya isian berubah + konfirmasi identitas; nilai lama tidak pernah tampil', async () => {
    const { api } = await renderApp(path, {
      routes: detailRoutes(channel, {
        [`PATCH ${at(API_ROUTES.channels.channel)}`]: () =>
          json({
            channel: { ...channel, status: 'untested', lastTest: null, number: null },
          }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: t.channels.credentials.change }));
    const token = screen.getByLabelText(new RegExp(`^${t.channels.credentials.token}`));
    expect(token).toHaveValue('');
    expect(token).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: t.channels.credentials.save }));
    expect(await screen.findByText(t.channels.credentials.unchanged)).toBeInTheDocument();

    fireEvent.change(token, { target: { value: `EAAGbaru${'z'.repeat(30)}` } });
    fireEvent.click(screen.getByRole('button', { name: t.channels.credentials.save }));
    await confirmIdentity(t.channels.credentials.confirmTitle, t.channels.credentials.save);
    expect(await screen.findByText(t.channels.credentials.saved)).toBeInTheDocument();
    expect(find(api.requests, 'PATCH', API_ROUTES.channels.channel)[0]?.body).toEqual({
      accessToken: `EAAGbaru${'z'.repeat(30)}`,
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    expect(screen.getByText('Belum dites', { selector: 'span' })).toBeInTheDocument();
  });

  it('ganti nama tanpa konfirmasi identitas', async () => {
    const { api } = await renderApp(path, {
      routes: detailRoutes(channel, {
        [`PATCH ${at(API_ROUTES.channels.channel)}`]: () =>
          json({ channel: { ...channel, name: 'CS Pusat' } }),
      }),
    });
    const input = await screen.findByLabelText(t.channels.rename.label);
    const save = screen.getByRole('button', { name: t.channels.rename.save });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: 'CS Pusat' } });
    fireEvent.click(save);
    expect(await screen.findByText(t.channels.rename.saved)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(find(api.requests, 'PATCH', API_ROUTES.channels.channel)[0]?.body).toEqual({
      name: 'CS Pusat',
    });
  });

  it('nonaktifkan dengan dialog konfirmasi, aktifkan lagi dari kotak "Channel nonaktif"', async () => {
    const { api } = await renderApp(path, {
      routes: detailRoutes(channel, {
        [`POST ${at(API_ROUTES.channels.disable)}`]: () =>
          json({ channel: { ...channel, enabled: false, disabledAt: '2026-11-14T03:00:00.000Z' } }),
        [`POST ${at(API_ROUTES.channels.enable)}`]: () => json({ channel }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: t.channels.access.disable }));
    const dialog = await screen.findByRole('dialog', { name: t.channels.access.disableTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: t.channels.access.disableConfirm }));
    expect(await screen.findByText(/^Dinonaktifkan sejak /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.channels.detail.enable }));
    await waitFor(() =>
      expect(screen.queryByText(/^Dinonaktifkan sejak /)).not.toBeInTheDocument(),
    );
    expect(find(api.requests, 'POST', API_ROUTES.channels.enable)).toHaveLength(1);
  });

  it('hapus: konfirmasi identitas, lalu kembali ke daftar dengan pesan', async () => {
    const { api, router } = await renderApp(path, {
      routes: detailRoutes(channel, {
        [`DELETE ${at(API_ROUTES.channels.channel)}`]: () => json({ status: 'deleted' }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: t.channels.access.delete }));
    await confirmIdentity(
      t.channels.access.deleteTitle('CS Utama'),
      t.channels.access.deleteConfirm,
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan/channel'));
    expect(await screen.findByText(t.channels.list.deleted('CS Utama'))).toBeInTheDocument();
    expect(find(api.requests, 'DELETE', API_ROUTES.channels.channel)[0]?.body).toEqual({
      password: TEST_PASSWORD,
      code: TEST_CODE,
    });
  });

  it('buat ulang verify token lewat dialog konfirmasi', async () => {
    await renderApp(path, {
      routes: detailRoutes(channel, {
        [`POST ${at(API_ROUTES.channels.rotateVerifyToken)}`]: () =>
          json({ ...webhook, verifyToken: 'tokenBaruVerify111111111111111111111111111' }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: t.channels.webhook.rotate }));
    const dialog = await screen.findByRole('dialog', { name: t.channels.webhook.rotateTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: t.channels.webhook.rotateConfirm }));
    expect(await screen.findByText(t.channels.webhook.rotated)).toBeInTheDocument();
    expect(screen.getByText('tokenBaruVerify111111111111111111111111111')).toBeInTheDocument();
  });

  it('profil bisnis: kategori saja tanpa konfirmasi; website dengan konfirmasi identitas', async () => {
    const { api } = await renderApp(path, {
      routes: detailRoutes(channel, {
        [`PUT ${at(API_ROUTES.channels.businessProfile)}`]: (request) =>
          json({
            status: 'updated',
            profile: { ...profile, ...(request.body as object) },
            fetchedAt: '2026-11-14T03:00:00.000Z',
          }),
      }),
    });
    const vertical = await screen.findByLabelText(t.channels.profile.vertical);
    fireEvent.change(vertical, { target: { value: 'RETAIL' } });
    fireEvent.click(screen.getByRole('button', { name: t.channels.profile.save }));
    expect(await screen.findByText(t.channels.profile.saved)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(find(api.requests, 'PUT', API_ROUTES.channels.businessProfile)[0]?.body).toEqual({
      vertical: 'RETAIL',
    });

    fireEvent.change(screen.getByLabelText(/^Situs web 2/), {
      target: { value: 'https://majujaya.co.id/promo' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.channels.profile.save }));
    await confirmIdentity(t.channels.profile.confirmTitle, t.channels.profile.save);
    await waitFor(() =>
      expect(find(api.requests, 'PUT', API_ROUTES.channels.businessProfile)).toHaveLength(2),
    );
    expect(find(api.requests, 'PUT', API_ROUTES.channels.businessProfile)[1]?.body).toEqual({
      websites: ['https://majujaya.co.id', 'https://majujaya.co.id/promo'],
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('profil bisnis: 502 Meta ditampilkan sebagai pesan server; foto lewat WhatsApp Manager', async () => {
    const message = 'Token belum punya izin yang dibutuhkan.';
    await renderApp(path, {
      routes: detailRoutes(channel, {
        [`GET ${at(API_ROUTES.channels.businessProfile)}`]: () =>
          apiError(502, 'META_REQUEST_FAILED', message),
      }),
    });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText(t.channels.profile.loadFailedTitle)).toBeInTheDocument();
  });

  it('profil bisnis tidak dimuat sebelum tes koneksi berhasil', async () => {
    const untested = fakeChannel({ status: 'untested', lastTest: null, number: null });
    const { api } = await renderApp(path, { routes: detailRoutes(untested) });
    expect(await screen.findByText(t.channels.profile.needsConnection)).toBeInTheDocument();
    expect(screen.getByText(t.channels.detail.untested)).toBeInTheDocument();
    await act(() => Promise.resolve());
    expect(find(api.requests, 'GET', API_ROUTES.channels.businessProfile)).toHaveLength(0);
  });

  it('channel tidak ada (404) atau alamat bukan ID: "tidak ditemukan"', async () => {
    await renderApp(path, {
      routes: {
        [`GET ${at(API_ROUTES.channels.channel)}`]: () =>
          apiError(404, 'NOT_FOUND', 'Channel tidak ditemukan. Mungkin sudah dihapus.'),
        [`GET ${at(API_ROUTES.channels.webhook)}`]: () =>
          apiError(404, 'NOT_FOUND', 'Channel tidak ditemukan.'),
      },
    });
    expect(
      await screen.findByRole('heading', { name: t.channels.detail.notFoundTitle }),
    ).toBeInTheDocument();
  });

  it('CS tidak bisa membuka halaman nomor (dialihkan ke Pengaturan)', async () => {
    const { router } = await renderApp(path, { session: fakeSession('cs') });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
  });
});

describe('daftar channel & menu Pengaturan', () => {
  it('kosong: ajakan menghubungkan nomor pertama', async () => {
    await renderApp('/pengaturan/channel');
    expect(await screen.findByRole('heading', { name: t.channels.list.emptyTitle })).toBeVisible();
    expect(screen.getByRole('link', { name: t.channels.list.emptyAction })).toHaveAttribute(
      'href',
      '/pengaturan/channel/tambah',
    );
  });

  it('daftar: status & kualitas tiap nomor; tombol tambah nonaktif dengan alasan bila batas tercapai', async () => {
    await renderApp('/pengaturan/channel', {
      channelSettings: {
        channels: [
          channel,
          fakeChannel({
            id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02',
            name: 'Promo Lama',
            enabled: false,
          }),
        ],
        canStoreSecrets: true,
        maxChannels: 2,
      },
    });
    const list = await screen.findByRole('list', { name: t.channels.list.listLabel });
    expect(within(list).getAllByRole('link')).toHaveLength(2);
    expect(within(list).getByText('Nonaktif')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: t.channels.list.add });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(new RegExp(t.channels.list.limitTitle));
  });

  it('menu Pengaturan: Channel untuk Owner/Admin, tidak untuk CS', async () => {
    await renderApp('/pengaturan');
    const link = await screen.findByRole('link', { name: /^Channel/ });
    expect(link).toHaveAttribute('href', '/pengaturan/channel');
    expect(await within(link).findByText(t.channels.menuNone)).toBeInTheDocument();
    expect(within(link).getByText(t.channels.connectNow)).toBeInTheDocument();
  });

  it('menu Pengaturan: jumlah channel bermasalah disebut ("4 nomor · 1 koneksi gagal")', async () => {
    const make = (n: number, status: 'connected' | 'failed') =>
      fakeChannel({ id: `6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e1${n}`, name: `CS ${n}`, status });
    await renderApp('/pengaturan', {
      channelSettings: {
        channels: [
          make(1, 'connected'),
          make(2, 'failed'),
          make(3, 'connected'),
          make(4, 'connected'),
        ],
        canStoreSecrets: true,
        maxChannels: 20,
      },
    });
    const link = await screen.findByRole('link', { name: /^Channel/ });
    expect(await within(link).findByText('4 nomor')).toBeInTheDocument();
    expect(within(link).getByText('1 koneksi gagal')).toBeInTheDocument();
  });

  it('menu Pengaturan: CS tidak melihat Channel', async () => {
    await renderApp('/pengaturan', { session: fakeSession('cs') });
    await screen.findByRole('heading', { name: t.security.sectionTitle });
    expect(screen.queryByRole('link', { name: /Channel/ })).not.toBeInTheDocument();
  });
});
