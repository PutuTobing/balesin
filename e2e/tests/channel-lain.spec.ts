import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  FAKE_IMAP,
  FAKE_TELEGRAM,
  deliverFakeEmail,
  fakeChannelsInfo,
} from '../stack/fake-channels-data';
import { expect, isHp, openApp, test } from './fixtures';
import { confirmAsOwner } from './identitas';

/**
 * Pengaturan → Channel: bagian "Channel lain" (Telegram, Email, Messenger, Instagram) melawan stack
 * sungguhan. Telegram & IMAP memakai server TIRUAN stack E2E (`stack/fake-channels-server.ts`);
 * SMTP keluar = email pengirim sistem. Messenger/Instagram hanya kartu "Butuh App Review Meta".
 */
const CREATE_PATH = '/api/v1/settings/channel-connections';

test('kartu jenis channel dari server + validasi wizard Telegram & Email', async ({ page }) => {
  await openApp(page, '/pengaturan/channel');
  const add = page.getByRole('heading', { name: 'Tambah channel' });
  await expect(add).toBeVisible();
  for (const label of ['Telegram', 'Email', 'Messenger', 'Instagram']) {
    await expect(page.getByRole('link', { name: new RegExp(`Hubungkan ${label}`) })).toBeVisible();
  }
  await expect(page.getByText('Butuh App Review Meta').first()).toBeVisible();

  await page.getByRole('link', { name: /Hubungkan Telegram/ }).click();
  await expect(page.getByRole('heading', { name: 'Hubungkan Telegram' })).toBeVisible();
  await page.getByLabel('Nama channel').fill('Bot CS E2E');
  await page.getByLabel('Token bot').fill('bukan-token');
  await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
  await expect(page.getByText(/Token bot tidak valid/)).toBeVisible();
  // Token tidak pernah jadi atribut DOM.
  await expect(page.getByLabel('Token bot')).not.toHaveAttribute('value', /.+/);

  await page.goto('/pengaturan/channel/baru/email');
  await expect(page.getByRole('heading', { name: 'Hubungkan Email' })).toBeVisible();
  await page.getByLabel('Nama channel').fill('Email CS E2E');
  await page.getByLabel('Host IMAP').fill('http://mail.contoh.id/');
  await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
  await expect(page.getByText(/Host IMAP tidak valid/)).toBeVisible();
  if (isHp(page)) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

/** "Tes koneksi" di halaman channel → hasil pemeriksaan tampil. */
async function runConnectionTest(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Tes koneksi', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tes koneksi', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
}

test('Telegram sungguhan (Bot API tiruan): token salah ditolak, hubungkan, tes koneksi', async ({
  page,
  expectHttpError,
}) => {
  test.setTimeout(240_000);
  const hp = isHp(page);
  // Satu bot = satu channel per organisasi: proyek HP memakai bot kedua.
  const token = hp ? FAKE_TELEGRAM.secondToken : FAKE_TELEGRAM.token;
  const username = hp ? 'majujaya_hp_bot' : 'majujaya_cs_bot';
  const name = `Bot E2E ${String(randomInt(100, 999))}`;

  await openApp(page, '/pengaturan/channel/baru/telegram');
  await page.getByLabel('Nama channel').fill(name);

  if (!hp) {
    // Format sah tapi tidak dikenal Bot API → 400 di isian token, dialog identitas tertutup.
    expectHttpError(CREATE_PATH, 400);
    await page.getByLabel('Token bot').fill(FAKE_TELEGRAM.wrongToken);
    await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
    await confirmAsOwner(page, 'Hubungkan Telegram?', 'Hubungkan');
    await expect(page.getByText(/Token bot ditolak Telegram/).first()).toBeVisible();
  }

  await page.getByLabel('Token bot').fill(token);
  await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
  await confirmAsOwner(page, 'Hubungkan Telegram?', 'Hubungkan');
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText(/Channel terhubung\./)).toBeVisible();
  await expect(page.getByText(`@${username}`).first()).toBeVisible();

  await runConnectionTest(page);
  await expect(page.getByText('Token bot diterima Telegram.')).toBeVisible();

  if (!hp) {
    // Hapus = konfirmasi identitas; kembali ke daftar dengan pesan.
    await page.getByRole('button', { name: 'Hapus channel' }).click();
    await confirmAsOwner(page, 'Hapus channel ini?', 'Hapus permanen');
    await expect(page.getByText(`Channel ${name} dihapus.`)).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(`Buka channel ${name}`) })).toHaveCount(
      0,
    );
  }
});

test('Email sungguhan (IMAP tiruan): hubungkan, tes koneksi, email masuk tampil di inbox', async ({
  page,
}) => {
  // Satu kotak masuk tiruan dipakai bersama: hanya satu proyek yang mengambilnya.
  test.skip(isHp(page), 'Kotak masuk IMAP tiruan hanya satu; dicakup proyek desktop.');
  test.setTimeout(360_000);
  const suffix = String(randomInt(1000, 9999));
  const name = `Email E2E ${suffix}`;
  const { imapPort } = await fakeChannelsInfo();

  await openApp(page, '/pengaturan/channel/baru/email');
  await page.getByLabel('Nama channel').fill(name);
  await page.getByLabel('Alamat email channel').fill(`cs-${suffix}@majujaya.test`);
  await page.getByLabel('Nama pengirim').fill('CS Maju Jaya');
  const imap = page.getByRole('group', { name: 'Email masuk (IMAP)' });
  await imap.getByLabel('Host IMAP').fill(FAKE_IMAP.host);
  await imap.getByLabel('Port').fill(String(imapPort));
  await imap.getByLabel('Username').fill(FAKE_IMAP.username);
  await imap.getByLabel('Password', { exact: true }).fill(FAKE_IMAP.password);
  await imap.getByLabel('Cek email tiap (menit)').fill('1');
  await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
  await confirmAsOwner(page, 'Hubungkan Email?', 'Hubungkan');
  await expect(page.getByRole('heading', { name })).toBeVisible();
  // Password IMAP tidak pernah tampil lagi.
  await expect(page.getByText(FAKE_IMAP.password)).toHaveCount(0);

  await runConnectionTest(page);
  await expect(page.getByText('Kotak masuk (IMAP) tersambung dan folder ditemukan.')).toBeVisible();

  // Putaran pertama worker hanya mencatat posisi kotak masuk (email lama dilewati) — tunggu itu
  // dulu, baru kirim email baru.
  await expect(async () => {
    await page.reload();
    // Tunggu datanya tampil dulu (kerangka memuat juga "tanpa Belum pernah dicek").
    await expect(page.getByRole('heading', { name: 'Kotak masuk' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText('Belum pernah dicek')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 120_000, intervals: [5_000] });

  const customer = `Rudi Email ${suffix}`;
  const subject = `Tagihan E2E ${suffix}`;
  await deliverFakeEmail(
    [
      `From: "${customer}" <rudi.${suffix}@pelanggan.test>`,
      `To: ${FAKE_IMAP.username}`,
      `Subject: ${subject}`,
      `Message-ID: <e2e-${suffix}@pelanggan.test>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Mohon kirim ulang tagihan bulan ini.',
      '',
    ].join('\r\n'),
  );

  await page.goto('/inbox');
  const search = page.getByRole('searchbox', { name: 'Cari chat' });
  // Baris chat (tombol di daftar), bukan judul "Tidak ketemu chat untuk …" yang juga memuat nama.
  const row = page
    .getByRole('region', { name: 'Daftar chat' })
    .getByRole('button', { name: new RegExp(customer) });
  await expect(async () => {
    await search.fill('');
    await search.fill(customer);
    await expect(row.first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 180_000, intervals: [10_000] });
  await row.first().click();
  const room = page.getByRole('region', { name: 'Ruang chat' });
  await expect(room.getByText(subject).first()).toBeVisible();
  await expect(room.getByText('Mohon kirim ulang tagihan bulan ini.')).toBeVisible();
});
