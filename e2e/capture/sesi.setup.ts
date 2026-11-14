import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { request, test } from '@playwright/test';
import { E2E_OWNER, E2E_SETUP_TOKEN, OWNER_STATE_PATH } from '../stack/env';
import { totpAtStep, totpStep } from '../tests/two-factor';
import { BASE_URL } from '../viewports';

/**
 * Screenshot butuh sesi untuk layar di dalam aplikasi. Backend foto dimulai dari instalasi
 * kosong (`stack/start-backend.mjs`), jadi Owner dibuat langsung lewat API setup. Owner wajib
 * 2FA: sesi dari setup masih terbatas, jadi 2FA didaftarkan lewat API (kode TOTP dihitung dari
 * rahasianya) supaya terbit sesi penuh, lalu cookie sesinya disimpan. Layar wizard, halaman
 * masuk, dan layar pendaftaran 2FA memakai API tiruan (`mocks.ts`).
 */
test('buat Owner untuk sesi foto', async () => {
  const api = await request.newContext({
    baseURL: BASE_URL,
    // Permintaan pengubah data wajib ber-Origin sama dengan APP_URL.
    extraHTTPHeaders: { origin: BASE_URL },
  });
  const response = await api.post('/api/v1/setup/complete', {
    data: {
      setupToken: E2E_SETUP_TOKEN,
      owner: { name: E2E_OWNER.name, email: E2E_OWNER.email, password: E2E_OWNER.password },
      organization: { name: E2E_OWNER.organization, timezone: 'Asia/Jakarta' },
    },
  });
  if (response.status() !== 201) {
    throw new Error(`Setup gagal (${response.status()}): ${await response.text()}`);
  }
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const enroll = await api.post('/api/v1/auth/2fa/enroll', {
    headers: { 'x-csrf-token': csrfToken },
    data: {},
  });
  if (!enroll.ok())
    throw new Error(`Daftar 2FA gagal (${enroll.status()}): ${await enroll.text()}`);
  const { secret } = (await enroll.json()) as { secret: string };
  const confirm = await api.post('/api/v1/auth/2fa/enroll/confirm', {
    headers: { 'x-csrf-token': csrfToken },
    data: { code: totpAtStep(secret, totpStep()) },
  });
  if (!confirm.ok()) {
    throw new Error(`Konfirmasi 2FA gagal (${confirm.status()}): ${await confirm.text()}`);
  }
  mkdirSync(path.dirname(OWNER_STATE_PATH), { recursive: true });
  await api.storageState({ path: OWNER_STATE_PATH });
  await api.dispose();
});
