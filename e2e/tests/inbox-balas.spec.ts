import {
  statusNotification,
  textMessageNotification,
} from '../../apps/api/src/testing/fake-meta-webhooks';
import { FAKE_META } from '../stack/fake-meta-data';
import { expect, isHp, openApp, test } from './fixtures';
import {
  conversationIdOf,
  conversationRow,
  createChannel,
  deliver,
  ownerApi,
  randomCustomer,
  type OwnerApi,
  type Setup,
} from './inbox-bantu';
import { e2eSql } from './pengguna';

/**
 * Ruang chat melawan stack sungguhan (Fase 2 butir 6): balas teks → api (202 `pending`) → worker →
 * Meta TIRUAN (wamid) → webhook status bertanda tangan → centang maju lewat WebSocket; unggah gambar;
 * rem darurat (423 + banner, lalu dilanjutkan); di luar jendela 24 jam composer diganti penjelasan.
 *
 * Hanya di desktop dan BERURUTAN: rem darurat berlaku untuk seluruh organisasi, jadi tidak boleh ada
 * tes kirim lain yang berjalan bersamaan (spec inbox lain tidak mengirim pesan).
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const REPLY = 'Halo kak Yanti, kami bantu cek jaringannya ya.';
/** JPEG 1×1 piksel (jenis ditentukan server dari isi berkas). */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

let setup: Setup;
let owner: OwnerApi;
const customer = randomCustomer('Yanti Balas');
let conversationId = '';

test.beforeEach(({ page }) => {
  test.skip(isHp(page), 'pengiriman diuji sekali (desktop), berurutan');
});

test.afterAll(async () => {
  await owner?.api.dispose();
});

async function wamidOf(text: string): Promise<string | null> {
  const rows = await e2eSql<{ wamid: string | null }>(
    `select wamid from messages where conversation_id = $1 and direction = 'outbound' and text = $2`,
    [conversationId, text],
  );
  return rows[0]?.wamid ?? null;
}

test('balas teks → worker → Meta tiruan → centang maju lewat webhook status', async ({ page }) => {
  setup = await createChannel('Balas', FAKE_META.numbers.inboxReply.id);
  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer,
      body: 'Kak, internet saya mati.',
    }),
  );
  await expect.poll(() => conversationIdOf(customer.waId).catch(() => '')).not.toBe('');
  conversationId = await conversationIdOf(customer.waId);

  await openApp(page, '/inbox');
  await conversationRow(page, customer.name).click();
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
  await box.fill(REPLY);
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(chat.getByText(REPLY)).toBeVisible();

  // Worker mengirim ke Meta tiruan → wamid tersimpan.
  await expect.poll(() => wamidOf(REPLY), { timeout: 30_000 }).not.toBeNull();
  const wamid = (await wamidOf(REPLY)) ?? '';
  for (const status of ['sent', 'delivered'] as const) {
    await deliver(
      setup,
      statusNotification({
        phoneNumberId: setup.phoneNumberId,
        wabaId: FAKE_META.wabaId,
        wamid,
        status,
        recipientWaId: customer.waId,
      }),
    );
  }
  const bubble = chat.getByRole('listitem').filter({ hasText: REPLY });
  await expect(bubble.getByText('Diterima')).toBeAttached({ timeout: 20_000 });
});

test('unggah gambar → pratinjau → kirim → gambar tampil lewat Blob', async ({ page }) => {
  await openApp(page, `/inbox?chat=${conversationId}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await chat.getByTestId('composer-file').setInputFiles({
    name: 'lampu-los.jpg',
    mimeType: 'image/jpeg',
    buffer: TINY_JPEG,
  });
  await expect(chat.getByText('lampu-los.jpg')).toBeVisible();
  await chat.getByRole('textbox', { name: 'Tulis balasan' }).fill('Foto lampu modem');
  await chat.getByRole('button', { name: 'Kirim', exact: true }).click();
  const image = chat.getByRole('img', { name: 'Gambar: Foto lampu modem' });
  await expect(image).toBeVisible({ timeout: 20_000 });
  await expect(image).toHaveAttribute('src', /^blob:/);
});

test('rem darurat: banner, Kirim & Lampirkan nonaktif (draf tetap), lalu dilanjutkan', async ({
  page,
}) => {
  owner = await ownerApi();
  const pause = await owner.api.post('/api/v1/settings/sending-limits/pause', {
    headers: { 'x-csrf-token': owner.csrf },
    data: { reason: 'Uji E2E' },
  });
  expect(pause.ok()).toBe(true);
  try {
    // Owner (sesi proyek) melihat status rem dari pengaturan batas kirim.
    await openApp(page, `/inbox?chat=${conversationId}`);
    const chat = page.getByRole('region', { name: 'Ruang chat' });
    await expect(chat.getByText('Pengiriman sedang dihentikan')).toBeVisible();
    const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
    await box.fill('Draf saat rem ditarik');
    await expect(chat.getByRole('button', { name: 'Kirim', exact: true })).toBeDisabled();
    await expect(chat.getByRole('button', { name: 'Lampirkan berkas' })).toBeDisabled();
    await box.fill('');
  } finally {
    const resume = await owner.api.post('/api/v1/settings/sending-limits/resume', {
      headers: { 'x-csrf-token': owner.csrf },
      data: { confirmation: owner.confirm() },
    });
    expect(resume.ok(), await resume.text()).toBe(true);
  }
});

test('balasan cepat: dibuat di Pengaturan, dipakai dengan "/" di composer', async ({ page }) => {
  const shortcut = `salam${Date.now().toString(36)}`;
  await openApp(page, '/pengaturan/balasan-cepat');
  await page
    .getByRole('button', { name: /Tambah balasan cepat|Buat balasan cepat pertama/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Tambah balasan cepat' });
  await dialog.getByLabel('Shortcut').fill(shortcut);
  await dialog.getByLabel('Judul').fill('Salam pembuka');
  await dialog.getByLabel('Isi pesan').fill('Halo kak {nama}, dengan {agen} di sini.');
  await dialog.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText(`Balasan cepat /${shortcut} ditambahkan.`)).toBeVisible();

  await openApp(page, `/inbox?chat=${conversationId}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
  await box.fill(`/${shortcut}`);
  await expect(chat.getByRole('option', { name: new RegExp(shortcut) })).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue(/^Halo kak Yanti Balas, dengan .+ di sini\.$/);
  await box.fill('');
});

test('tandai selesai lalu buka lagi', async ({ page }) => {
  await openApp(page, `/inbox?chat=${conversationId}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await chat.getByRole('button', { name: 'Tandai selesai' }).click();
  await expect(chat.getByText(/Chat ini sudah selesai/)).toBeVisible();
  await chat.getByRole('button', { name: 'Buka lagi' }).click();
  await expect(chat.getByRole('textbox', { name: 'Tulis balasan' })).toBeVisible();
});

test('di luar jendela 24 jam: composer diganti penjelasan (tanpa tombol nonaktif)', async ({
  page,
}) => {
  await e2eSql(
    `update conversations set window_expires_at = now() - interval '1 hour' where id = $1`,
    [conversationId],
  );
  await openApp(page, `/inbox?chat=${conversationId}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await expect(chat.getByText('Sesi 24 jam sudah habis')).toBeVisible();
  await expect(chat.getByRole('textbox', { name: 'Tulis balasan' })).toHaveCount(0);
  await expect(chat.getByRole('button', { name: /template/i })).toHaveCount(0);
});

/**
 * Ujung ke ujung di HP 390 px (butir 11/12): pesan masuk lewat webhook bertanda tangan → muncul di
 * daftar → buka (layar bertumpuk) → balas → centang maju lewat status webhook → tandai selesai dari
 * menu tindakan → kembali ke daftar. Di spec ini (bukan proyek hp-390) karena pengiriman harus
 * berurutan dengan uji rem darurat di atas.
 */
test('HP 390: masuk → tampil → buka → balas → dibaca → tandai selesai', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const hpCustomer = randomCustomer('Sari Ponsel');
  const inbound = 'Kak, wifi di rumah putus-putus sejak semalam.';
  const reply = 'Baik kak Sari, kami cek dari sini ya.';
  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer: hpCustomer,
      body: inbound,
    }),
  );
  await expect.poll(() => conversationIdOf(hpCustomer.waId).catch(() => '')).not.toBe('');
  const hpConversation = await conversationIdOf(hpCustomer.waId);

  await openApp(page, '/inbox');
  // HP: navigasi bawah tampil di daftar.
  await expect(page.getByRole('navigation', { name: 'Navigasi utama' })).toBeVisible();
  await conversationRow(page, hpCustomer.name).click();
  await expect(page).toHaveURL(new RegExp(`chat=${hpConversation}`));
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await expect(chat.getByText(inbound)).toBeVisible();
  // Layar chat HP imersif: navigasi bawah disembunyikan, composer di dasar layar.
  await expect(page.getByRole('navigation', { name: 'Navigasi utama' })).toBeHidden();

  // Belum ditangani: ambil chat dulu, lalu balas.
  const claim = chat.getByRole('button', { name: 'Ambil chat' });
  if (await claim.isVisible()) await claim.click();
  const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
  await box.fill(reply);
  // HP: Enter = baris baru (keyboard ponsel); kirim lewat tombol.
  await chat.getByRole('button', { name: 'Kirim', exact: true }).click();
  await expect(box).toHaveValue('');
  await expect(chat.getByText(reply)).toBeVisible();
  const composerBox = await box.boundingBox();
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(844);

  const wamid = async () => {
    const rows = await e2eSql<{ wamid: string | null }>(
      `select wamid from messages where conversation_id = $1 and direction = 'outbound' and text = $2`,
      [hpConversation, reply],
    );
    return rows[0]?.wamid ?? null;
  };
  await expect.poll(wamid, { timeout: 30_000 }).not.toBeNull();
  const id = (await wamid()) ?? '';
  for (const status of ['sent', 'delivered', 'read'] as const) {
    await deliver(
      setup,
      statusNotification({
        phoneNumberId: setup.phoneNumberId,
        wabaId: FAKE_META.wabaId,
        wamid: id,
        status,
        recipientWaId: hpCustomer.waId,
      }),
    );
  }
  const bubble = chat.getByRole('listitem').filter({ hasText: reply });
  await expect(bubble.getByText('Dibaca')).toBeAttached({ timeout: 20_000 });

  // HP: "Tandai selesai" ada di menu tindakan kepala chat.
  await chat.getByRole('button', { name: 'Tindakan chat' }).click();
  await page.getByRole('menuitem', { name: 'Tandai selesai' }).click();
  await expect(chat.getByText(/Chat ini sudah selesai/)).toBeVisible();
  // Dibuka lagi supaya tab "Selesai" tetap kosong untuk inbox.spec (tidak ada chat selesai).
  await chat.getByRole('button', { name: 'Buka lagi' }).click();
  await expect(chat.getByRole('textbox', { name: 'Tulis balasan' })).toBeVisible();

  // Kembali (tombol kembali browser) → daftar, navigasi bawah tampil lagi.
  await page.goBack();
  await expect(page).not.toHaveURL(/chat=/);
  await expect(page.getByRole('navigation', { name: 'Navigasi utama' })).toBeVisible();
});
