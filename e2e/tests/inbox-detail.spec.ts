import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { textMessageNotification } from '../../apps/api/src/testing/fake-meta-webhooks';
import { FAKE_META } from '../stack/fake-meta-data';
import { expect, isHp, openApp, test } from './fixtures';
import {
  conversationIdOf,
  createChannel,
  deliver,
  randomCustomer,
  type Setup,
} from './inbox-bantu';

/**
 * Panel detail chat melawan stack sungguhan (Fase 2 butir 8): tag kontak (buat & pasang), ubah
 * kontak, catatan sesi, pesan ditandai, log, dan ekspor data kontak (UU PDP). Hapus kontak butuh
 * konfirmasi identitas (TOTP Owner) — diuji di tes komponen dan tes api.
 *
 * Desktop saja dan berurutan: satu percakapan dipakai bersama oleh tes-tes di bawah.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const INBOUND = 'Kak, tolong catat alamat baru saya ya.';
const TAG = `E2E Detail ${String(randomInt(10_000, 99_999))}`;
const customer = randomCustomer('Wulan Detail');
let setup: Setup;
let conversationId = '';

test.beforeEach(({ page }) => {
  test.skip(isHp(page), 'panel detail diuji sekali (desktop); HP memakai komponen yang sama');
});

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Detail kontak' });
}

async function openChat(page: Page): Promise<void> {
  await openApp(page, `/inbox?chat=${conversationId}`);
  await expect(page.getByRole('region', { name: 'Ruang chat' }).getByText(INBOUND)).toBeVisible();
}

test('tag kontak: buat tag baru dari panel, terpasang dan tetap ada setelah dimuat ulang', async ({
  page,
}) => {
  setup = await createChannel('Detail', FAKE_META.numbers.inboxDetail.id);
  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer,
      body: INBOUND,
    }),
  );
  await expect.poll(() => conversationIdOf(customer.waId).catch(() => '')).not.toBe('');
  conversationId = await conversationIdOf(customer.waId);

  await openChat(page);
  await panel(page).getByRole('button', { name: 'Tambah tag' }).click();
  const search = page.getByRole('textbox', { name: 'Cari atau buat tag' });
  await search.fill(TAG);
  await search.press('Enter');
  await expect(panel(page).getByRole('button', { name: `Lepas tag ${TAG}` })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(panel(page).getByText(TAG)).toBeVisible();
});

test('ubah kontak: email dan atribut tersimpan, log mencatat isian tanpa isinya', async ({
  page,
}) => {
  await openChat(page);
  await panel(page).getByRole('button', { name: 'Ubah kontak' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ubah kontak' });
  await dialog.getByLabel('Email').fill('wulan@contoh.test');
  await dialog.getByRole('button', { name: 'Tambah atribut' }).click();
  await dialog.getByLabel('Nama atribut').fill('ID pelanggan');
  await dialog.getByLabel('Nilai').fill('PLG-7781');
  await dialog.getByRole('button', { name: 'Simpan' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel(page).getByText('wulan@contoh.test')).toBeVisible();
  await expect(panel(page).getByText('PLG-7781')).toBeVisible();

  await panel(page).getByRole('tab', { name: 'Log' }).click();
  await expect(panel(page).getByText(/mengubah data kontak \(Email, Atribut\)/)).toBeVisible();
  await expect(panel(page).getByText(TAG)).toBeVisible();
  await expect(panel(page).getByText('wulan@contoh.test')).toHaveCount(0);
});

test('catatan sesi: tulis, ubah, hapus', async ({ page }) => {
  await openChat(page);
  await panel(page).getByRole('tab', { name: 'Catatan' }).click();
  await panel(page)
    .getByRole('textbox', { name: 'Catatan sesi' })
    .fill('Alamat baru: Jl. Melati 3.');
  await panel(page).getByRole('button', { name: 'Simpan catatan' }).click();
  await expect(panel(page).getByText('Alamat baru: Jl. Melati 3.')).toBeVisible();

  await panel(page).getByRole('button', { name: 'Ubah catatan' }).click();
  await panel(page)
    .getByRole('textbox', { name: 'Ubah catatan' })
    .fill('Alamat baru: Jl. Melati 5.');
  await panel(page).getByRole('button', { name: 'Simpan', exact: true }).click();
  await expect(panel(page).getByText('Alamat baru: Jl. Melati 5.')).toBeVisible();
  await expect(panel(page).getByText(/diubah/)).toBeVisible();

  await panel(page).getByRole('button', { name: 'Hapus catatan' }).click();
  await page
    .getByRole('dialog', { name: 'Hapus catatan ini?' })
    .getByRole('button', { name: 'Hapus catatan' })
    .click();
  await expect(panel(page).getByText('Belum ada catatan di chat ini.')).toBeVisible();
});

test('tandai pesan: tampil di Berkas → Ditandai, lalu lepas tanda', async ({ page }) => {
  await openChat(page);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await chat
    .getByRole('button', { name: /^Aksi untuk pesan/ })
    .last()
    .click();
  await page.getByRole('menuitem', { name: 'Tandai pesan' }).click();
  await expect(chat.getByText('Ditandai')).toHaveCount(1);

  await panel(page).getByRole('tab', { name: 'Berkas' }).click();
  await panel(page).getByRole('radio', { name: 'Ditandai' }).click();
  await expect(panel(page).getByText(INBOUND)).toBeVisible();

  await chat
    .getByRole('button', { name: /^Aksi untuk pesan/ })
    .last()
    .click();
  await page.getByRole('menuitem', { name: 'Lepas tanda' }).click();
  await expect(panel(page).getByText(/Belum ada pesan yang ditandai/)).toBeVisible();
});

test('ekspor data kontak: unduhan JSON berisi kontak dan pesannya', async ({ page }) => {
  await openChat(page);
  const download = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Ekspor data kontak' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^kontak-\d+\.json$/);
  const data = JSON.parse(await readFile(await file.path(), 'utf8')) as {
    contact: { phone: string; email: string; tags: string[] };
    messages: { text: string | null }[];
  };
  expect(data.contact.phone).toBe(`+${customer.waId}`);
  expect(data.contact.email).toBe('wulan@contoh.test');
  expect(data.contact.tags).toContain(TAG);
  expect(data.messages.some((message) => message.text === INBOUND)).toBe(true);
  await expect(panel(page).getByText('Data kontak diunduh (JSON).')).toBeVisible();
});
