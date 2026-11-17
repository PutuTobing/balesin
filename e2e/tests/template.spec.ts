import { randomInt } from 'node:crypto';
import { templateStatusNotification } from '../../apps/api/src/testing/fake-meta-webhooks';
import { FAKE_META } from '../stack/fake-meta-data';
import { expect, isHp, openApp, test } from './fixtures';
import { createChannel, deliver, type Setup } from './inbox-bantu';
import { e2eSql } from './pengguna';

/**
 * Pengaturan → Template WhatsApp melawan stack sungguhan (Fase 4): buat → pemeriksaan langsung →
 * "Ajukan ke Meta" (Meta tiruan: PENDING) → webhook `message_template_status_update` APPROVED →
 * "Disetujui"; preset → draf di editor → hapus. Tidak mengirim pesan (aman paralel dengan rem
 * darurat di `inbox-balas`); kirim template di luar sesi & percakapan baru ada di `inbox-balas`.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let setup: Setup;
let channelId = '';

test.beforeEach(({ page }) => {
  test.skip(isHp(page), 'alur Meta diuji sekali (desktop); tampilan HP lewat foto');
});

async function templateRow(name: string) {
  const rows = await e2eSql<{ id: string; status: string; meta_template_id: string | null }>(
    `select id, status, meta_template_id from message_templates where channel_id = $1 and name = $2`,
    [channelId, name],
  );
  return rows[0];
}

test('buat → ajukan (Menunggu tinjauan) → webhook status Meta → Disetujui', async ({ page }) => {
  setup = await createChannel('Template', FAKE_META.numbers.templates.id);
  const rows = await e2eSql<{ id: string }>(`select id from channels where name = $1`, [
    setup.channelName,
  ]);
  channelId = rows[0]?.id ?? '';
  const name = `info_gangguan_${randomInt(100_000, 999_999)}`;

  await openApp(page, '/pengaturan/template/baru');
  await page.getByLabel('Nomor WhatsApp').selectOption(channelId);
  await page.getByLabel('Nama template').fill(name);
  const body = page.getByRole('textbox', { name: 'Isi pesan' });
  await body.fill('{{1}} ada gangguan');
  // Pemeriksaan langsung (aturan Meta dari shared) sebelum apa pun dikirim.
  await expect(page.getByText(/hal perlu dibereskan sebelum diajukan/)).toBeVisible();
  await body.fill('Halo {{1}}, ada gangguan jaringan di area kamu. Tim kami sedang menanganinya.');
  await page.getByLabel('Contoh {{1}}').fill('Budi');
  await expect(page.getByText('Siap diajukan')).toBeVisible();
  await expect(
    page
      .getByRole('figure', { name: 'Pratinjau pesan template' })
      .getByText(/Halo Budi, ada gangguan/),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Ajukan ke Meta' }).click();
  await expect(page).toHaveURL(/\/pengaturan\/template\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Template diajukan.', { exact: false })).toBeVisible();
  await expect(page.getByText('Menunggu tinjauan Meta')).toBeVisible();
  // Sedang ditinjau: isi terkunci.
  await expect(page.getByRole('textbox', { name: 'Isi pesan' })).toBeDisabled();

  const row = await templateRow(name);
  expect(row?.status).toBe('PENDING');
  expect(row?.meta_template_id).toBeTruthy();
  await deliver(
    setup,
    templateStatusNotification({
      wabaId: FAKE_META.wabaId,
      id: row?.meta_template_id ?? '',
      name,
      language: 'id',
    }),
  );
  await expect.poll(async () => (await templateRow(name))?.status).toBe('APPROVED');
  await page.reload();
  await expect(page.getByText('Disetujui', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Isi pesan' })).toBeEnabled();

  await openApp(page, '/pengaturan/template');
  const list = page.getByRole('list', { name: 'Daftar template' });
  await expect(list.getByRole('link', { name: `Buka template ${name}` })).toBeVisible();
});

test('preset → draf terbuka di editor → hapus dengan konfirmasi', async ({ page }) => {
  await openApp(page, '/pengaturan/template');
  await page.getByRole('button', { name: 'Pakai preset' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pilih preset template' });
  const channel = dialog.getByLabel('Buat untuk nomor');
  if ((await channel.count()) > 0) await channel.selectOption(channelId);
  await dialog.getByRole('button', { name: 'Pakai preset Pembayaran diterima' }).click();
  await expect(page).toHaveURL(/\/pengaturan\/template\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/dibuat dari preset/)).toBeVisible();
  await expect(page.getByText('Draf', { exact: true })).toBeVisible();
  expect((await templateRow('pembayaran_diterima'))?.status).toBe('DRAFT');

  await page.getByRole('button', { name: 'Hapus template' }).click();
  const confirm = page.getByRole('dialog', { name: 'Hapus template pembayaran_diterima?' });
  await confirm.getByRole('button', { name: 'Hapus template' }).click();
  await expect(page).toHaveURL(/\/pengaturan\/template$/);
  await expect(page.getByText('Template pembayaran_diterima dihapus.')).toBeVisible();
  expect(await templateRow('pembayaran_diterima')).toBeUndefined();
});
