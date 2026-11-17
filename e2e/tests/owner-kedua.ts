import { randomInt } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { E2E_OWNER } from '../stack/env';
import { expect, submitLogin } from './fixtures';
import { openWatchedPage, type WatchedPage } from './konteks';
import { e2eSql, enrollRequiredTwoFactorViaApi, nextTotp } from './pengguna';

/**
 * Owner KEDUA milik satu tes (pola `channel.spec`): 2FA dengan rahasia & kode cadangannya sendiri,
 * jadi masuk dua langkah dan konfirmasi identitas TIDAK mengantre kode TOTP Owner utama yang
 * dipakai bergantian oleh semua tes paralel (`withOwnerCode`) — sumber timeout di run penuh.
 */
export interface SecondOwner {
  email: string;
  name: string;
  password: string;
  secret: string;
  lastStep: number;
  backupCodes: string[];
}

export async function createSecondOwner(tag: string): Promise<SecondOwner> {
  const email = `owner-${tag}-${Date.now().toString(36)}-${String(randomInt(1000, 9999))}@majujaya.test`;
  const name = `Dewi ${tag}`;
  const rows = await e2eSql(
    `insert into users (id, organization_id, email, name, password_hash, role, email_verified_at)
     select gen_random_uuid(), organization_id, $1, $2, password_hash, 'owner'::user_role, now()
     from users where email = $3
     returning id`,
    [email, name, E2E_OWNER.email],
  );
  if (rows.length !== 1) throw new Error('Owner E2E belum ada (alur-awal belum jalan?)');
  const password = E2E_OWNER.password;
  const twoFactor = await enrollRequiredTwoFactorViaApi({ email, password, name, role: 'admin' });
  return { email, name, password, ...twoFactor };
}

/** Langkah kedua halaman masuk dengan kode TOTP Owner kedua (rahasia sendiri, tanpa antre). */
export async function completeSecondOwnerCode(page: Page, owner: SecondOwner): Promise<void> {
  await expect(
    page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
  ).toBeVisible();
  const { code, step } = await nextTotp(owner.secret, owner.lastStep);
  owner.lastStep = step;
  await page.getByLabel('Kode verifikasi').fill(code);
  await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
}

/** Browser terpisah yang sudah masuk sebagai Owner kedua. */
export async function signInSecondOwner(
  browser: Browser,
  owner: SecondOwner,
  options: { hp?: boolean } = {},
): Promise<WatchedPage> {
  const watched = await openWatchedPage(browser, { hp: options.hp ?? false });
  watched.allow('/api/v1/auth/me', 401);
  await watched.page.goto('/masuk');
  await submitLogin(watched.page, owner.email, owner.password);
  await completeSecondOwnerCode(watched.page, owner);
  await expect(watched.page).toHaveURL(/\/inbox$/);
  return watched;
}

/** Isi dialog konfirmasi identitas dengan password + satu kode cadangan Owner kedua. */
export async function confirmAsSecondOwner(
  page: Page,
  owner: SecondOwner,
  dialogName: string | RegExp,
  confirmLabel: string,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password', { exact: true }).fill(owner.password);
  await dialog.getByLabel('Kode verifikasi').fill(owner.backupCodes.shift() ?? '');
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}
