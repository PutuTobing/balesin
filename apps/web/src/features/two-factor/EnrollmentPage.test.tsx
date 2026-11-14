import {
  API_ROUTES,
  CSRF_HEADER_NAME,
  type ConfirmTwoFactorEnrollmentResponse,
} from '@balesin/shared';
import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import {
  FAKE_BACKUP_CODES,
  FAKE_TOTP_SECRET,
  apiError,
  fakeEnrollment,
  fakeEnrollmentSession,
  fakeSession,
  json,
  type FakeApiOptions,
} from '../../test/fake-api';
import { media } from '../../lib/media';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const copy = t.twoFactor.enroll;
const codesCopy = t.twoFactor.backupCodes;

function confirmed(): ConfirmTwoFactorEnrollmentResponse {
  return {
    ...fakeSession(),
    csrfToken: 'csrf-penuh-baru',
    backupCodes: { codes: FAKE_BACKUP_CODES, generatedAt: '2026-11-14T02:00:00.000Z' },
  };
}

async function openEnrollment(options: FakeApiOptions = {}) {
  const view = await renderApp('/verifikasi-dua-langkah', {
    session: fakeEnrollmentSession(),
    ...options,
    routes: {
      [`POST ${API_ROUTES.twoFactor.enroll}`]: () => json(fakeEnrollment()),
      ...options.routes,
    },
  });
  await screen.findByRole('heading', { level: 1, name: copy.title });
  return view;
}

/** Semua data di cache Query dan cache mutasi, sebagai teks (untuk mencari kebocoran). */
function cacheText(queryClient: QueryClient): string {
  return JSON.stringify([
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data),
  ]);
}

const codeInput = () => screen.getByLabelText(copy.confirm.label);

describe('pendaftaran 2FA wajib', () => {
  it('QR dibuat di browser dari otpauthUri, kunci tampil untuk diketik dan bisa disalin', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { api } = await openEnrollment();

    const qr = await screen.findByRole('img', { name: copy.add.qrLabel });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    // Modul QR tergambar sebagai satu jalur SVG (bukan gambar dari layanan luar).
    expect(qr.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(200);
    expect(document.querySelector('img[src^="http"]')).toBeNull();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeVisible();
    expect(
      screen.getByText(copy.add.entryName('Balesin', 'rina@majujaya.co.id'), { exact: false }),
    ).toBeVisible();
    // Penjelasan kenapa wajib, sesuai peran.
    expect(screen.getByText(copy.requiredBody('Owner'))).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: copy.add.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FAKE_TOTP_SECRET));
    expect(await screen.findByText(copy.add.copiedAnnouncement)).toBeInTheDocument();

    // Sesi terbatas memulai tanpa password, satu kali saja.
    const enrolls = api.requests.filter((request) => request.path === API_ROUTES.twoFactor.enroll);
    expect(enrolls).toHaveLength(1);
    expect(enrolls[0]?.body).toEqual({});
  });

  it('HP: tombol membuka aplikasi autentikator lewat tautan otpauth://', async () => {
    setMediaQuery(media.hp, true);
    await openEnrollment();
    const link = await screen.findByRole('link', { name: copy.add.openApp });
    expect(link.getAttribute('href')).toMatch(/^otpauth:\/\/totp\//);
    expect(screen.getByText(copy.add.bodyHp)).toBeVisible();
  });

  it('kode salah → pesan di isian; kode benar → sesi penuh + token CSRF baru, lalu kode cadangan', async () => {
    const view = await openEnrollment();
    await screen.findByRole('img', { name: copy.add.qrLabel });
    view.api.on(`POST ${API_ROUTES.twoFactor.confirmEnrollment}`, (request) => {
      const { code } = request.body as { code: string };
      if (code !== '654321') {
        return apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
          details: [{ field: 'code', message: 'Kode tidak cocok. Periksa jam ponselmu.' }],
        });
      }
      view.api.setSession(confirmed());
      return json(confirmed());
    });

    fireEvent.change(codeInput(), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.submit }));
    expect(await screen.findByText('Kode tidak cocok. Periksa jam ponselmu.')).toBeVisible();
    await waitFor(() => expect(codeInput()).toHaveFocus());

    fireEvent.change(codeInput(), { target: { value: '654 321' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.submit }));

    const heading = await screen.findByRole('heading', { level: 1, name: codesCopy.title });
    expect(heading).toHaveFocus();
    for (const code of FAKE_BACKUP_CODES) expect(screen.getByText(code)).toBeVisible();
    const confirm = view.api.requests.findLast(
      (request) => request.path === API_ROUTES.twoFactor.confirmEnrollment,
    );
    expect(confirm?.headers[CSRF_HEADER_NAME]).toBe('csrf-terbatas');
    expect(confirm?.body).toEqual({ code: '654321' });
    // Rahasia sudah dibuang dari layar; kode cadangan tidak ada di cache Query.
    expect(screen.queryByText(/JBSW Y3DP/)).toBeNull();
    expect(cacheText(view.queryClient)).not.toContain(FAKE_BACKUP_CODES[0]);
    expect(cacheText(view.queryClient)).not.toContain(FAKE_TOTP_SECRET);

    // Lanjut wajib mencentang "sudah disimpan".
    fireEvent.click(screen.getByRole('button', { name: codesCopy.continueTo(t.nav.inbox) }));
    const checkbox = screen.getByRole('checkbox', { name: codesCopy.confirm });
    expect(checkbox).toHaveFocus();
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(codesCopy.confirmRequired)).toBeVisible();
    expect(view.router.state.location.pathname).toBe('/verifikasi-dua-langkah');

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: codesCopy.continueTo(t.nav.inbox) }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/inbox'));
    await screen.findByRole('heading', { level: 1, name: t.inbox.title });

    // Menutup layar tidak memulai pendaftaran baru (2FA sudah aktif).
    expect(
      view.api.requests.filter((request) => request.path === API_ROUTES.twoFactor.enroll),
    ).toHaveLength(1);
    // Setelah layar ditutup, kode cadangan tidak tertinggal di cache mana pun.
    expect(cacheText(view.queryClient)).not.toContain(FAKE_BACKUP_CODES[0]);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
      FAKE_BACKUP_CODES[0],
    );

    // Permintaan berikutnya memakai token CSRF sesi penuh yang baru.
    fireEvent.keyDown(
      await screen.findByRole('button', { name: t.auth.userMenu.open('Rina Kartika') }),
      { key: 'Enter' },
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: t.auth.userMenu.logout }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/masuk'));
    const logout = view.api.requests.find((request) => request.path === API_ROUTES.auth.logout);
    expect(logout?.headers[CSRF_HEADER_NAME]).toBe('csrf-penuh-baru');
  });

  it('unduh .txt: nama berkas memuat nama produk dari branding, isinya semua kode', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:kode';
    });
    URL.revokeObjectURL = vi.fn();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const view = await openEnrollment({
      branding: {
        productName: 'CS Nusantara',
        organizationName: 'PT Nusantara',
        primaryColor: null,
        logoUrl: null,
      },
      routes: { [`POST ${API_ROUTES.twoFactor.confirmEnrollment}`]: () => json(confirmed()) },
    });
    await screen.findByRole('img', { name: copy.add.qrLabel });
    fireEvent.change(codeInput(), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.submit }));
    await screen.findByRole('heading', { level: 1, name: codesCopy.title });

    fireEvent.click(screen.getByRole('button', { name: codesCopy.download }));
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('kode-cadangan-cs-nusantara.txt');
    const text = await created[0]?.text();
    expect(text).toContain('CS Nusantara');
    expect(text).toContain('rina@majujaya.co.id');
    for (const code of FAKE_BACKUP_CODES) expect(text).toContain(code);
    // Tautan sementara sudah dilepas dari dokumen.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(view.router.state.location.pathname).toBe('/verifikasi-dua-langkah');
  });

  it('15 menit berlalu → QR kedaluwarsa; "Buat kode QR baru" meminta rahasia baru', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api } = await openEnrollment();
      await screen.findByRole('img', { name: copy.add.qrLabel });
      await act(() => vi.advanceTimersByTimeAsync(15 * 60_000 + 500));

      expect(await screen.findByText(copy.expiredTitle)).toBeVisible();
      expect(screen.queryByRole('img', { name: copy.add.qrLabel })).toBeNull();
      expect(codeInput()).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: copy.restart }));
      expect(await screen.findByRole('img', { name: copy.add.qrLabel })).toBeVisible();
      expect(
        api.requests.filter((request) => request.path === API_ROUTES.twoFactor.enroll),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('server menjawab 409 saat konfirmasi (QR kedaluwarsa) → layar kedaluwarsa', async () => {
    await openEnrollment({
      routes: {
        [`POST ${API_ROUTES.twoFactor.confirmEnrollment}`]: () =>
          apiError(409, 'CONFLICT', 'Kode QR sudah kedaluwarsa. Mulai lagi.'),
      },
    });
    await screen.findByRole('img', { name: copy.add.qrLabel });
    fireEvent.change(codeInput(), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.submit }));
    expect(await screen.findByText(copy.expiredTitle)).toBeVisible();
  });

  it('rahasia gagal dibuat (503) → pesan server dengan Coba lagi', async () => {
    let fail = true;
    await openEnrollment({
      routes: {
        [`POST ${API_ROUTES.twoFactor.enroll}`]: () =>
          fail
            ? apiError(503, 'SERVICE_UNAVAILABLE', 'Kunci enkripsi server belum diisi.')
            : json(fakeEnrollment()),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Kunci enkripsi server belum diisi.',
    );
    expect(screen.getByText(copy.startFailedTitle)).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: t.common.retry }));
    expect(await screen.findByRole('img', { name: copy.add.qrLabel })).toBeVisible();
  });

  it('Keluar dari layar pendaftaran → halaman masuk', async () => {
    const { router } = await openEnrollment();
    fireEvent.click(screen.getByRole('button', { name: t.auth.userMenu.logout }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
  });
});
