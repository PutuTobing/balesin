import { randomInt } from 'node:crypto';
import { templateStatusNotification } from '../../apps/api/src/testing/fake-meta-webhooks';
import { FAKE_META } from '../stack/fake-meta-data';
import { expect, test } from './fixtures';
import { createChannel, deliver, ownerApi, type Setup } from './inbox-bantu';
import type { WatchedPage } from './konteks';
import {
  confirmAsSecondOwner,
  createSecondOwner,
  signInSecondOwner,
  type SecondOwner,
} from './owner-kedua';
import { e2eSql } from './pengguna';

/**
 * Broadcast melawan stack sungguhan (Fase 4, docs/KONTRAK-API-BROADCAST.md): buat kampanye dari CSV
 * kecil → isi variabel → pratinjau → ajukan (konfirmasi identitas) → worker mengirim lewat Meta
 * tiruan → laporan; kampanye di atas ambang menunggu persetujuan Owner LAIN → disetujui → dijeda →
 * dibatalkan.
 *
 * Proyek `berurutan` (playwright.config): berjalan SETELAH proyek paralel, satu per satu — rem darurat
 * di `inbox-balas` menjeda semua kampanye organisasi, dan ambang persetujuan berlaku organisasi.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let setup: Setup;
let channelId = '';
let templateId = '';
let templateName = '';
let creator: SecondOwner;
let creatorBrowser: WatchedPage;
let firstCampaign = '';

const phone = () => `0812${String(randomInt(10_000_000, 99_999_999))}`;

async function campaignRow(name: string) {
  const rows = await e2eSql<{ id: string; status: string }>(
    `select id, status from broadcast_campaigns where name = $1`,
    [name],
  );
  return rows[0];
}

/** Template DISETUJUI lewat jalur sungguhan (buat + ajukan + webhook status APPROVED). */
async function approvedTemplate(): Promise<void> {
  const { api, csrf } = await ownerApi();
  try {
    templateName = `tagihan_broadcast_${Date.now().toString(36)}`;
    const created = await api.post('/api/v1/templates', {
      headers: { 'x-csrf-token': csrf },
      data: {
        channelId,
        name: templateName,
        language: 'id',
        category: 'UTILITY',
        content: {
          parameterFormat: 'positional',
          header: null,
          body: {
            text: 'Halo {{1}}, tagihan internet bulan {{2}} sudah terbit.',
            examples: { '1': 'Budi', '2': 'Desember' },
          },
          footer: null,
          buttons: [],
          authentication: null,
        },
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    templateId = ((await created.json()) as { template: { id: string } }).template.id;
    const submitted = await api.post(`/api/v1/templates/${templateId}/submit`, {
      headers: { 'x-csrf-token': csrf },
    });
    expect(submitted.ok(), await submitted.text()).toBe(true);
    const meta = ((await submitted.json()) as { template: { metaTemplateId: string } }).template
      .metaTemplateId;
    await deliver(
      setup,
      templateStatusNotification({ wabaId: FAKE_META.wabaId, id: meta, name: templateName }),
    );
    await expect
      .poll(
        async () =>
          (
            await e2eSql<{ status: string }>(`select status from message_templates where id = $1`, [
              templateId,
            ])
          )[0]?.status,
      )
      .toBe('APPROVED');
  } finally {
    await api.dispose();
  }
}

/** Ambang persetujuan organisasi lewat API (mengetatkan boleh siapa pun yang berizin). */
async function setApprovalThreshold(threshold: number): Promise<void> {
  const { api, csrf, confirm } = await ownerApi();
  try {
    const current = (await (await api.get('/api/v1/settings/broadcast')).json()) as {
      settings: Record<string, unknown>;
    };
    const { updatedAt: _, updatedBy: __, ...values } = current.settings;
    const response = await api.put('/api/v1/settings/broadcast', {
      headers: { 'x-csrf-token': csrf },
      data: { ...values, approvalThreshold: threshold, confirmation: confirm() },
    });
    expect(response.ok(), await response.text()).toBe(true);
  } finally {
    await api.dispose();
  }
}

/** Wizard: dasar → unggah CSV → variabel ({{2}} dari kolom "bulan") → halaman kirim. */
async function draftCampaign(page: WatchedPage['page'], name: string, csv: string) {
  await page.goto('/broadcast/baru');
  await page.getByLabel('Nama kampanye').fill(name);
  const sender = page.getByLabel('Kirim dari nomor');
  // Banyak nomor di stack E2E: pilihan nomor selalu tampil (tunggu daftar nomornya dimuat).
  await sender.selectOption(channelId);
  await page.getByLabel('Template', { exact: true }).selectOption(templateId);
  await page.getByRole('button', { name: 'Lanjut' }).click();
  await expect(page).toHaveURL(/\/broadcast\/[0-9a-f-]{36}$/);

  await page.getByTestId('broadcast-file').setInputFiles({
    name: 'pelanggan.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await expect(page.getByText(/2 penerima siap/)).toBeVisible();
  await expect(page.getByText('Baris 4: Nomor tidak valid')).toBeVisible();
  await page.getByRole('button', { name: 'Lanjut' }).click();

  await expect(page.getByLabel('Variabel {{1}}', { exact: true })).toHaveValue('nama');
  await page.getByLabel('Variabel {{2}}', { exact: true }).selectOption('bulan');
  await expect(
    page
      .getByRole('region', { name: 'Pratinjau beberapa penerima' })
      .getByText(/Halo Budi, tagihan/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Lanjut' }).click();
  await expect(page.getByRole('region', { name: 'Perkiraan biaya' })).toBeVisible();
}

test.afterAll(async () => {
  await creatorBrowser?.close();
  await setApprovalThreshold(50).catch(() => undefined);
});

test('CSV kecil → ajukan → terkirim lewat Meta tiruan → laporan', async ({ browser }) => {
  setup = await createChannel('Broadcast', FAKE_META.numbers.broadcast.id);
  const rows = await e2eSql<{ id: string }>(`select id from channels where name = $1`, [
    setup.channelName,
  ]);
  channelId = rows[0]?.id ?? '';
  await approvedTemplate();
  await setApprovalThreshold(50);

  creator = await createSecondOwner('broadcast');
  creatorBrowser = await signInSecondOwner(browser, creator);
  const page = creatorBrowser.page;
  const name = `Tagihan Desember ${randomInt(1000, 9999)}`;
  firstCampaign = name;
  await draftCampaign(
    page,
    name,
    `nomor,nama,bulan\n${phone()},Budi,Desember\n${phone()},Sari,Desember\nabc,Rusak,Desember\n`,
  );
  await page.getByRole('button', { name: 'Ajukan kampanye' }).click();
  await confirmAsSecondOwner(page, creator, 'Ajukan kampanye ini?', 'Ajukan kampanye');

  // Di bawah ambang → dijadwalkan segera → worker mengirim → selesai.
  await expect
    .poll(async () => (await campaignRow(name))?.status, { timeout: 60_000 })
    .toBe('completed');
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByText('Selesai', { exact: true }).first()).toBeVisible();
  const stats = page.getByRole('region', { name: 'Hasil kampanye' });
  await expect(stats.getByText('2 dari 2 diproses')).toBeVisible();
  const recipients = page.getByRole('list', { name: 'Daftar penerima' });
  await expect(recipients.getByRole('listitem')).toHaveCount(2);
});

test('di atas ambang: menunggu persetujuan Owner LAIN → disetujui → dijeda → dibatalkan', async ({
  browser,
}) => {
  await setApprovalThreshold(1);
  const page = creatorBrowser.page;
  const name = `Promo terjadwal ${randomInt(1000, 9999)}`;
  await draftCampaign(
    page,
    name,
    `nomor,nama,bulan\n${phone()},Budi,Desember\n${phone()},Sari,Desember\nabc,Rusak,Desember\n`,
  );
  // Dijadwalkan besok (tetap `scheduled` setelah disetujui, supaya bisa dijeda & dibatalkan).
  await page.getByRole('radio', { name: 'Pada waktu tertentu' }).click();
  const tomorrow = new Date(Date.now() + 26 * 3_600_000);
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(tomorrow)
    .replace(' ', 'T');
  await page.getByLabel('Tanggal dan jam').fill(local);
  await page.getByRole('button', { name: 'Ajukan kampanye' }).click();
  await confirmAsSecondOwner(page, creator, 'Ajukan kampanye ini?', 'Ajukan kampanye');
  await expect(page.getByText('Menunggu persetujuan', { exact: true }).first()).toBeVisible();
  // Pembuat tidak bisa menyetujui kampanyenya sendiri.
  await expect(page.getByRole('button', { name: 'Setujui' })).toHaveCount(0);
  expect((await campaignRow(name))?.status).toBe('pending_approval');

  const approver = await createSecondOwner('penyetuju');
  const approverBrowser = await signInSecondOwner(browser, approver);
  try {
    const row = await campaignRow(name);
    await approverBrowser.page.goto(`/broadcast/${row?.id ?? ''}`);
    await approverBrowser.page.getByRole('button', { name: 'Setujui' }).click();
    await confirmAsSecondOwner(approverBrowser.page, approver, 'Setujui kampanye ini?', 'Setujui');
    await expect(
      approverBrowser.page.getByText('Terjadwal', { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await approverBrowser.close();
  }
  expect((await campaignRow(name))?.status).toBe('scheduled');

  await page.reload();
  await page.getByRole('button', { name: 'Jeda' }).click();
  await expect(page.getByText('Dijeda pengguna')).toBeVisible();
  expect((await campaignRow(name))?.status).toBe('paused');

  await page.getByRole('button', { name: 'Batalkan kampanye' }).click();
  const dialog = page.getByRole('dialog', { name: 'Batalkan kampanye?' });
  await dialog.getByRole('button', { name: 'Batalkan kampanye' }).click();
  await expect(page.getByText('Dibatalkan', { exact: true }).first()).toBeVisible();
  expect((await campaignRow(name))?.status).toBe('cancelled');
});

test('laporan: pesan kampanye pertama terkirim lewat Meta tiruan (wamid → Terkirim)', async () => {
  const page = creatorBrowser.page;
  const row = await campaignRow(firstCampaign);
  await page.goto(`/broadcast/${row?.id ?? ''}`);
  const stats = page.getByRole('region', { name: 'Hasil kampanye' });
  // Laporan terus disegarkan selama masih ada pesan yang menunggu jawaban Meta.
  await expect(
    stats.locator('dt', { hasText: 'Terkirim' }).locator('xpath=following-sibling::dd'),
  ).toHaveText('2', { timeout: 30_000 });
});
