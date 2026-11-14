import {
  API_ROUTES,
  CSRF_HEADER_NAME,
  type TwoFactorChallengeResponse,
  type VerifyTwoFactorResponse,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  fakeEnrollment,
  fakeEnrollmentSession,
  fakeSession,
  json,
  type FakeApi,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';

const copy = t.twoFactor.login;
const EMAIL = 'rina@majujaya.co.id';
const PASSWORD = 'Kopi-Senja-Tenang-42';

function challenge(
  overrides: Partial<TwoFactorChallengeResponse> = {},
): TwoFactorChallengeResponse {
  return {
    status: 'two_factor_required',
    challengeToken: 'tantangan-1',
    expiresAt: '2026-11-14T00:05:00.000Z',
    attemptsRemaining: 3,
    methods: ['totp', 'backup_code'],
    ...overrides,
  };
}

function verified(
  method: 'totp' | 'backup_code',
  backupCodesRemaining = 10,
): VerifyTwoFactorResponse {
  return {
    ...fakeSession(),
    csrfToken: 'csrf-setelah-2fa',
    twoFactor: { method, backupCodesRemaining },
  };
}

async function passwordStep(path = '/masuk', routes: Parameters<typeof renderApp>[1] = {}) {
  const view = await renderApp(path, {
    session: null,
    ...routes,
    routes: {
      [`POST ${API_ROUTES.auth.login}`]: () => json(challenge()),
      ...routes.routes,
    },
  });
  await screen.findByRole('heading', { level: 1, name: t.auth.login.heading('PT Maju Jaya') });
  fireEvent.change(screen.getByLabelText(t.auth.login.email), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText(t.auth.login.password), {
    target: { value: PASSWORD },
  });
  fireEvent.click(screen.getByRole('button', { name: t.auth.login.submit }));
  return view;
}

const codeInput = () => screen.getByLabelText(copy.totpLabel);
const verifyButton = () => screen.getByRole('button', { name: copy.submit });

function onVerify(api: FakeApi, handler: (code: string) => Response) {
  api.on(`POST ${API_ROUTES.twoFactor.verify}`, (request) => {
    const body = request.body as { challengeToken: string; code: string };
    return handler(body.code);
  });
}

describe('halaman masuk: langkah kedua (2FA)', () => {
  it('password benar + 2FA aktif → isian kode 6 digit yang siap diisi otomatis', async () => {
    await passwordStep();

    expect(await screen.findByRole('heading', { level: 1, name: copy.totpTitle })).toBeVisible();
    expect(screen.getByText(copy.totpSubtitle(EMAIL))).toBeVisible();
    const input = codeInput();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    // Tantangan tidak pernah masuk ke URL atau penyimpanan browser.
    expect(window.location.href).not.toContain('tantangan-1');
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
      'tantangan-1',
    );
  });

  it('kode ditempel utuh ("123 456") → dikirim bersama tantangan, lalu ke tujuan awal', async () => {
    const { api, router } = await passwordStep('/masuk?redirect=%2Fpengaturan');
    onVerify(api, () => {
      api.setSession(verified('totp'));
      return json(verified('totp'));
    });
    await screen.findByRole('heading', { level: 1, name: copy.totpTitle });

    fireEvent.change(codeInput(), { target: { value: '123 456' } });
    expect(codeInput()).toHaveValue('123456');
    fireEvent.click(verifyButton());

    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    const verify = api.requests.find((request) => request.path === API_ROUTES.twoFactor.verify);
    expect(verify?.body).toEqual({ challengeToken: 'tantangan-1', code: '123456' });
    // Langkah kedua publik: tanpa token CSRF.
    expect(verify?.headers[CSRF_HEADER_NAME]).toBeUndefined();

    // Permintaan berikutnya memakai token CSRF dari sesi baru.
    fireEvent.keyDown(
      await screen.findByRole('button', { name: t.auth.userMenu.open('Rina Kartika') }),
      { key: 'Enter' },
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: t.auth.userMenu.logout }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/masuk'));
    const logout = api.requests.find((request) => request.path === API_ROUTES.auth.logout);
    expect(logout?.headers[CSRF_HEADER_NAME]).toBe('csrf-setelah-2fa');
  });

  it('kode salah → pesan server di isian, isian dipilih untuk diketik ulang', async () => {
    const { api } = await passwordStep();
    const message = 'Kode salah. Sisa 2 percobaan.';
    onVerify(api, () =>
      apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
        details: [{ field: 'code', message }],
      }),
    );
    await screen.findByRole('heading', { level: 1, name: copy.totpTitle });
    fireEvent.change(codeInput(), { target: { value: '000000' } });
    fireEvent.click(verifyButton());

    expect(await screen.findByText(message)).toBeVisible();
    await waitFor(() => expect(codeInput()).toHaveFocus());
    expect(codeInput()).toHaveAttribute('aria-invalid', 'true');
    expect(codeInput().getAttribute('aria-describedby')).toBeTruthy();
    // Bukan error tingkat form: tidak ada kotak role="alert".
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('kode bukan 6 digit → ditolak di browser tanpa memanggil server', async () => {
    const { api } = await passwordStep();
    await screen.findByRole('heading', { level: 1, name: copy.totpTitle });
    fireEvent.change(codeInput(), { target: { value: '12a3' } });
    fireEvent.click(verifyButton());
    expect(await screen.findByText(/Masukkan 6 digit kode/)).toBeVisible();
    expect(api.requests.some((request) => request.path === API_ROUTES.twoFactor.verify)).toBe(
      false,
    );
  });

  it('"Pakai kode cadangan" mengganti isian; masuk dengan kode cadangan → sisa kode + saran buat baru', async () => {
    const { api, router } = await passwordStep();
    onVerify(api, (code) => {
      expect(code).toBe('k7m2px9q4r');
      api.setSession(verified('backup_code', 2));
      return json(verified('backup_code', 2));
    });
    await screen.findByRole('heading', { level: 1, name: copy.totpTitle });

    fireEvent.click(screen.getByRole('button', { name: copy.useBackup }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.backupTitle })).toBeVisible();
    const input = screen.getByLabelText(copy.backupLabel);
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(input, { target: { value: 'K7M2P-X9Q4R' } });
    fireEvent.click(verifyButton());

    expect(
      await screen.findByRole('heading', { level: 1, name: copy.backupUsed.title }),
    ).toHaveFocus();
    expect(screen.getByText(copy.backupUsed.body(2))).toBeVisible();
    expect(screen.getByText(copy.backupUsed.low)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: copy.backupUsed.makeNew }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan/keamanan'));
  });

  it('kode cadangan habis → tautan kode cadangan diganti penjelasan', async () => {
    await passwordStep('/masuk', {
      routes: { [`POST ${API_ROUTES.auth.login}`]: () => json(challenge({ methods: ['totp'] })) },
    });
    await screen.findByRole('heading', { level: 1, name: copy.totpTitle });
    expect(screen.queryByRole('button', { name: copy.useBackup })).toBeNull();
    expect(screen.getByText(copy.noBackupCodes)).toBeVisible();
  });

  it('tantangan ditolak server (3 kode salah) → kembali ke password dengan pesannya, email tetap', async () => {
    const { api } = await passwordStep();
    const message = 'Kode salah 3 kali. Masuk lagi dengan email dan password-mu.';
    onVerify(api, () => apiError(401, 'TWO_FACTOR_CHALLENGE_INVALID', message));
    await screen.findByRole('heading', { level: 1, name: copy.totpTitle });
    fireEvent.change(codeInput(), { target: { value: '111111' } });
    fireEvent.click(verifyButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(
      screen.getByRole('heading', { level: 1, name: t.auth.login.heading('PT Maju Jaya') }),
    ).toBeVisible();
    expect(screen.getByLabelText(t.auth.login.email)).toHaveValue(EMAIL);
    expect(screen.getByLabelText(t.auth.login.password)).toHaveValue('');
    expect(screen.getByLabelText(t.auth.login.password)).toHaveFocus();
    // Bukan sesi habis: tidak ada pesan "Sesimu sudah berakhir".
    expect(screen.queryByText(t.auth.login.sessionEnded)).toBeNull();
  });

  it('5 menit tanpa kode → tantangan kedaluwarsa, kembali ke password dengan penjelasan', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await passwordStep();
      await screen.findByRole('heading', { level: 1, name: copy.totpTitle });
      await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 500));

      expect(await screen.findByRole('status')).toHaveTextContent(copy.expired);
      expect(screen.getByLabelText(t.auth.login.password)).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Kembali ke email dan password" → langkah password tanpa pesan', async () => {
    await passwordStep();
    await screen.findByRole('heading', { level: 1, name: copy.totpTitle });
    fireEvent.click(screen.getByRole('button', { name: copy.back }));
    expect(
      await screen.findByRole('heading', { level: 1, name: t.auth.login.heading('PT Maju Jaya') }),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(t.auth.login.email)).toHaveValue(EMAIL);
  });

  it('429 terkunci: hitung mundur di tombol bergaya terkunci, pesan server di bawahnya', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api } = await passwordStep();
      const message =
        'Terlalu banyak kode salah. Verifikasi dua langkah akun ini dikunci 15 menit.';
      onVerify(api, () => apiError(429, 'RATE_LIMITED', message, { retryAfter: 900 }));
      await screen.findByRole('heading', { level: 1, name: copy.totpTitle });
      fireEvent.change(codeInput(), { target: { value: '222222' } });
      fireEvent.click(verifyButton());

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(copy.lockedTitle)).toBeVisible();
      expect(alert).toHaveTextContent(message);
      expect(alert.textContent).not.toMatch(/\d:\d{2}/);
      const locked = screen.getByRole('button', { name: t.auth.login.countdownButton('15:00') });
      expect(locked).toBeDisabled();
      expect(locked).toHaveAttribute('data-locked');
      // Fokus tidak jatuh ke <body>.
      await waitFor(() => expect(codeInput()).toHaveFocus());

      // Selama terkunci, batas 5 menit tantangan tidak memulangkan ke password.
      await act(() => vi.advanceTimersByTimeAsync(6 * 60_000));
      expect(screen.getByRole('heading', { level: 1, name: copy.totpTitle })).toBeVisible();

      // Kunci habis → kembali ke password (tantangan sudah kedaluwarsa), diumumkan sopan.
      await act(() => vi.advanceTimersByTimeAsync(9 * 60_000 + 1_000));
      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: t.auth.login.heading('PT Maju Jaya'),
        }),
      ).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent(copy.unlocked);
    } finally {
      vi.useRealTimers();
    }
  });

  it('peran wajib 2FA belum mendaftar → sesi terbatas, langsung ke layar pendaftaran', async () => {
    const { router } = await passwordStep('/masuk?redirect=%2Fkontak', {
      routes: {
        [`POST ${API_ROUTES.auth.login}`]: () => json(fakeEnrollmentSession('supervisor')),
        [`POST ${API_ROUTES.twoFactor.enroll}`]: () => json(fakeEnrollment()),
      },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/verifikasi-dua-langkah'));
    expect(router.state.location.search).toEqual({ redirect: '/kontak' });
    expect(await screen.findByText(t.twoFactor.enroll.requiredBody('Supervisor'))).toBeVisible();
  });
});
