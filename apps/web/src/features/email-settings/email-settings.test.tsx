import {
  API_ROUTES,
  SMTP_PLAINTEXT_LOGIN_WARNING,
  type EmailSettingsResponse,
  type EmailSettingsView,
} from '@balesin/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, json } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import {
  applyPreset,
  canKeepStoredPassword,
  emailFormFromView,
  emptyEmailForm,
  isEmailFormDirty,
  toEmailInput,
  updateEmailForm,
} from './email-form';

const saved: EmailSettingsView = {
  fromName: 'CS Maju Jaya',
  fromAddress: 'cs@majujaya.co.id',
  replyTo: null,
  host: 'mail.majujaya.co.id',
  port: 465,
  security: 'ssl',
  username: 'cs@majujaya.co.id',
  hasPassword: true,
  passwordHint: '••••a123',
};

const savedResponse: EmailSettingsResponse = {
  source: 'database',
  settings: saved,
  status: 'connected',
  lastTest: {
    ok: true,
    code: 'ok',
    message: 'Berhasil terhubung ke server email. Pengaturan ini siap dipakai.',
    testedAt: new Date().toISOString(),
  },
  updatedAt: new Date().toISOString(),
  canStoreSecrets: true,
};

describe('aturan form email pengirim', () => {
  it('username mengikuti alamat pengirim sampai diubah sendiri', () => {
    let values = updateEmailForm(emptyEmailForm, { fromAddress: 'cs@majujaya.co.id' });
    expect(values.username).toBe('cs@majujaya.co.id');
    values = updateEmailForm(values, { username: 'login-lain' });
    values = updateEmailForm(values, { fromAddress: 'halo@majujaya.co.id' });
    expect(values.username).toBe('login-lain');
  });

  it('ganti keamanan mengganti port bawaan, tetapi tidak port yang diisi sendiri', () => {
    expect(updateEmailForm(emptyEmailForm, { security: 'starttls' }).port).toBe('587');
    const custom = { ...emptyEmailForm, port: '2525' };
    expect(updateEmailForm(custom, { security: 'starttls' }).port).toBe('2525');
  });

  it('preset mengisi host dari domain email (cPanel) atau host tetap (Gmail)', () => {
    const base = { ...emptyEmailForm, fromAddress: 'cs@majujaya.co.id' };
    expect(applyPreset(base, 'cpanel')).toMatchObject({
      host: 'mail.majujaya.co.id',
      port: '465',
      security: 'ssl',
    });
    expect(applyPreset(base, 'gmail')).toMatchObject({ host: 'smtp.gmail.com', port: '587' });
  });

  it('password tersimpan hanya boleh dipakai bila host/port/keamanan/username tidak berubah', () => {
    const form = emailFormFromView(saved);
    expect(form.password).toBe('');
    expect(canKeepStoredPassword(form, saved)).toBe(true);
    expect(toEmailInput(form, saved)).toMatchObject({ ok: true });
    for (const patch of [
      { host: 'smtp.majujaya.co.id' },
      { port: '587' },
      { security: 'starttls' as const },
      { username: 'lain@majujaya.co.id' },
    ]) {
      const changed = { ...form, ...patch };
      expect(canKeepStoredPassword(changed, saved)).toBe(false);
      expect(toEmailInput(changed, saved)).toEqual({
        ok: false,
        errors: { password: t.emailSettings.passwordReenter },
      });
    }
  });

  it('isian kosong opsional dikirim null; port jadi angka', () => {
    const result = toEmailInput({
      ...emptyEmailForm,
      fromName: 'CS',
      fromAddress: 'CS@MajuJaya.co.id',
      host: 'Mail.MajuJaya.co.id',
      port: '465',
      username: '',
    });
    expect(result).toEqual({
      ok: true,
      input: {
        fromName: 'CS',
        fromAddress: 'cs@majujaya.co.id',
        replyTo: null,
        host: 'mail.majujaya.co.id',
        port: 465,
        security: 'ssl',
        username: null,
      },
    });
  });

  it('form dianggap berubah bila isian atau password berbeda dari yang tersimpan', () => {
    const form = emailFormFromView(saved);
    expect(isEmailFormDirty(form, saved)).toBe(false);
    expect(isEmailFormDirty({ ...form, fromName: 'CS Baru' }, saved)).toBe(true);
    expect(isEmailFormDirty({ ...form, password: 'baru' }, saved)).toBe(true);
    expect(isEmailFormDirty(form, null)).toBe(true);
  });
});

describe('Pengaturan → Email pengirim', () => {
  it('menampilkan status, waktu tes terakhir, sumber, dan password tersamar', async () => {
    await renderApp('/pengaturan/email', { emailSettings: savedResponse });

    expect(
      await screen.findByRole('heading', { level: 1, name: t.emailSettings.title }),
    ).toBeVisible();
    expect(screen.getByText('Terhubung')).toBeVisible();
    expect(screen.getByText(t.emailSettings.sources.database)).toBeVisible();
    expect(screen.getByText(/^Hari ini, \d{2}\.\d{2}$/)).toBeVisible();
    expect(screen.getByText(t.emailSettings.passwordKeep('••••a123'))).toBeVisible();
    expect(screen.getByLabelText(new RegExp(`^${t.emailSettings.password}`))).toHaveValue('');
  });

  it('tes tanpa perubahan memakai pengaturan tersimpan; setelah diubah memakai isian form', async () => {
    const { api } = await renderApp('/pengaturan/email', {
      emailSettings: savedResponse,
      routes: {
        [`POST ${API_ROUTES.settings.testEmailConnection}`]: () =>
          json({ ok: true, code: 'ok', message: 'Berhasil.', testedAt: new Date().toISOString() }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: t.emailSettings.title });

    fireEvent.click(screen.getByRole('button', { name: t.emailSettings.testConnection }));
    await screen.findByText('Berhasil.');
    fireEvent.change(screen.getByLabelText(t.emailSettings.fromName), {
      target: { value: 'CS Baru' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.emailSettings.testConnection }));
    await waitFor(() =>
      expect(
        api.requests.filter((r) => r.path === API_ROUTES.settings.testEmailConnection),
      ).toHaveLength(2),
    );

    const [stored, draft] = api.requests.filter(
      (r) => r.path === API_ROUTES.settings.testEmailConnection,
    );
    expect(stored?.body).toEqual({});
    expect(draft?.body).toMatchObject({ settings: { fromName: 'CS Baru', host: saved.host } });
    expect(draft?.body).not.toHaveProperty('settings.password');
  });

  it('error validasi dari server ditampilkan di isiannya', async () => {
    await renderApp('/pengaturan/email', {
      emailSettings: savedResponse,
      routes: {
        [`PUT ${API_ROUTES.settings.email}`]: () =>
          apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
            details: [{ field: 'port', message: 'Port ini tidak didukung.' }],
          }),
      },
    });
    await screen.findByRole('heading', { level: 1, name: t.emailSettings.title });

    fireEvent.click(screen.getByRole('button', { name: t.emailSettings.save }));

    expect(await screen.findByText('Port ini tidak didukung.')).toBeVisible();
    expect(screen.getByLabelText(t.emailSettings.port)).toHaveAttribute('aria-invalid', 'true');
  });

  it('"Tanpa enkripsi" dengan login memunculkan peringatan', async () => {
    await renderApp('/pengaturan/email', { emailSettings: savedResponse });
    await screen.findByRole('heading', { level: 1, name: t.emailSettings.title });
    expect(screen.queryByText(SMTP_PLAINTEXT_LOGIN_WARNING)).toBeNull();

    fireEvent.change(screen.getByLabelText(t.emailSettings.security), {
      target: { value: 'none' },
    });
    expect(screen.getByText(SMTP_PLAINTEXT_LOGIN_WARNING)).toBeVisible();
  });

  it('server tanpa master key: Simpan nonaktif dengan petunjuk', async () => {
    await renderApp('/pengaturan/email', {
      emailSettings: { ...savedResponse, canStoreSecrets: false },
    });
    expect(await screen.findByText(t.emailSettings.noMasterKeyTitle)).toBeVisible();
    expect(screen.getByRole('button', { name: t.emailSettings.save })).toBeDisabled();
  });
});
