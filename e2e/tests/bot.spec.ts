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
import { e2eSql } from './pengguna';

/**
 * Bot eksternal di web (Fase 3) melawan stack sungguhan: kartu Bot di halaman nomor (jadwal + batas
 * waktu tersimpan, mematikan meminta persetujuan) dan saklar bot per percakapan di kepala chat.
 * Desktop saja, berurutan (satu channel milik spec ini).
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let setup: Setup;
let channelId = '';

test.beforeEach(({ page }) => {
  test.skip(isHp(page), 'bot: sekali (desktop)');
});

test('kartu Bot: aktifkan dengan jadwal + batas waktu, tersimpan; mematikan minta persetujuan', async ({
  page,
}) => {
  setup = await createChannel('Bot', FAKE_META.numbers.inboxBot.id);
  const rows = await e2eSql<{ id: string }>(`select id from channels where name = $1`, [
    setup.channelName,
  ]);
  channelId = rows[0]?.id ?? '';
  await openApp(page, `/pengaturan/channel/${channelId}`);
  const card = page.getByRole('region', { name: 'Bot' });
  await expect(card.getByText('Mati', { exact: true })).toBeVisible();
  await card.getByRole('checkbox', { name: 'Aktifkan bot untuk nomor ini' }).check();
  await card.getByRole('radio', { name: 'Jadwal' }).click();
  await card.getByLabel('Batas waktu menunggu balasan bot (menit)').fill('20');
  await card.getByRole('button', { name: 'Simpan pengaturan bot' }).click();
  await expect(card.getByText('Pengaturan bot disimpan.')).toBeVisible();

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'Bot' });
  await expect(
    reloaded.getByRole('checkbox', { name: 'Aktifkan bot untuk nomor ini' }),
  ).toBeChecked();
  await expect(reloaded.getByLabel('Batas waktu menunggu balasan bot (menit)')).toHaveValue('20');
  await expect(reloaded.getByRole('radio', { name: 'Jadwal' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await reloaded.getByRole('checkbox', { name: 'Aktifkan bot untuk nomor ini' }).uncheck();
  await reloaded.getByRole('button', { name: 'Simpan pengaturan bot' }).click();
  const dialog = page.getByRole('dialog', { name: 'Matikan bot di nomor ini?' });
  await dialog.getByRole('button', { name: 'Matikan bot' }).click();
  await expect(reloaded.getByText('Pengaturan bot disimpan.')).toBeVisible();
  await expect(reloaded.getByText('Mati', { exact: true })).toBeVisible();
});

test('kepala chat: "Serahkan ke tim" dari bot; "Kembalikan ke bot" ditolak saat bot channel mati', async ({
  page,
  expectHttpError,
}) => {
  const customer = randomCustomer('Bima Bot');
  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer,
      body: 'Halo, ini dijawab bot?',
    }),
  );
  await expect.poll(() => conversationIdOf(customer.waId).catch(() => '')).not.toBe('');
  const id = await conversationIdOf(customer.waId);
  // Status bot langsung (bot channel ini sudah dimatikan di tes sebelumnya).
  await e2eSql(`update conversations set status = 'bot', assignee_user_id = null where id = $1`, [
    id,
  ]);

  await openApp(page, `/inbox?chat=${id}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await chat.getByRole('button', { name: 'Serahkan ke tim' }).click();
  await expect
    .poll(async () => {
      const rows = await e2eSql<{ status: string }>(
        `select status from conversations where id = $1`,
        [id],
      );
      return rows[0]?.status;
    })
    .toBe('unserved');
  await expect(chat.getByRole('button', { name: 'Serahkan ke tim' })).toHaveCount(0);

  // Bot channel mati → 409 dengan penjelasan dari server.
  expectHttpError(`/api/v1/conversations/${id}/bot`, 409);
  await chat.getByRole('button', { name: 'Tindakan chat' }).click();
  await page.getByRole('menuitem', { name: 'Kembalikan ke bot' }).click();
  await expect(chat.getByRole('alert')).toBeVisible();
});
