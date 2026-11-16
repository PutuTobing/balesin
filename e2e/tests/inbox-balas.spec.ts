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

test('rem darurat: 423 + banner, lalu dilanjutkan', async ({ page, expectHttpError }) => {
  owner = await ownerApi();
  const pause = await owner.api.post('/api/v1/settings/sending-limits/pause', {
    headers: { 'x-csrf-token': owner.csrf },
    data: { reason: 'Uji E2E' },
  });
  expect(pause.ok()).toBe(true);
  try {
    expectHttpError(`/api/v1/conversations/${conversationId}/messages`, 423);
    await openApp(page, `/inbox?chat=${conversationId}`);
    const chat = page.getByRole('region', { name: 'Ruang chat' });
    const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
    await box.fill('Pesan saat rem ditarik');
    await box.press('Enter');
    await expect(chat.getByText('Pengiriman sedang dihentikan')).toBeVisible();
    await expect(chat.getByText('Belum terkirim', { exact: true })).toBeVisible();
  } finally {
    const resume = await owner.api.post('/api/v1/settings/sending-limits/resume', {
      headers: { 'x-csrf-token': owner.csrf },
      data: { confirmation: owner.confirm() },
    });
    expect(resume.ok(), await resume.text()).toBe(true);
  }
});

test('di luar jendela 24 jam: composer diganti penjelasan + "Kirim template" nonaktif', async ({
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
  await expect(chat.getByRole('button', { name: /Kirim template/ })).toBeDisabled();
});
