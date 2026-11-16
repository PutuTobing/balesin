import {
  mediaMessageNotification,
  textMessageNotification,
} from '../../apps/api/src/testing/fake-meta-webhooks';
import { FAKE_META } from '../stack/fake-meta-data';
import { expect, expectNoHorizontalScroll, isHp, openApp, test } from './fixtures';
import {
  conversationIdOf,
  conversationRow,
  createChannel,
  deliver,
  randomCustomer,
  shownPhone,
  signIn,
} from './inbox-bantu';
import { createUser, e2eSql, userId } from './pengguna';

/**
 * Inbox melawan stack sungguhan (Fase 2 butir 5): webhook WhatsApp BERTANDA TANGAN dikirim ke
 * penerima Balesin → worker membuat kontak/percakapan/pesan → percakapan tampil di daftar → dibuka →
 * pesan tampil (baca-saja) dan ditandai dibaca → pesan berikutnya muncul lewat WebSocket tanpa muat
 * ulang. Cakupan: CS melihat semua; Teknisi hanya percakapan yang di-assign kepadanya.
 *
 * Tiap proyek (desktop/HP) memakai channel + pelanggan sendiri (Phone Number ID & nomor unik), jadi
 * tes paralel tidak saling mengganggu.
 */
test.describe.configure({ timeout: 120_000 });

test('pesan masuk bertanda tangan tampil di daftar, bisa dibuka, dan pesan baru datang real-time', async ({
  page,
}) => {
  const hp = isHp(page);
  const setup = await createChannel(
    hp ? 'HP' : 'Desktop',
    hp ? FAKE_META.numbers.inboxHp.id : FAKE_META.numbers.inboxDesktop.id,
  );
  const customer = randomCustomer(hp ? 'Wulan Inbox HP' : 'Wulan Inbox Desktop');

  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer,
      body: 'Halo kak, internet mati. <b>tolong</b>',
    }),
  );
  await deliver(
    setup,
    mediaMessageNotification('document', {
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer,
      filename: 'tagihan-november.pdf',
    }),
  );

  await openApp(page, '/inbox');
  const row = conversationRow(page, customer.name);
  // Muncul lewat WebSocket/penyegaran cadangan tanpa muat ulang.
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(shownPhone(customer.waId));
  await expect(row).toContainText('Dokumen');
  await expect(row.getByText(/pesan belum dibaca/)).toHaveCount(1);
  await expect(row).toContainText(/\d+ jam/);
  await expectNoHorizontalScroll(page);

  const readRequest = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/conversations\/[^/]+\/read$/.test(response.url()),
  );
  await row.click();
  expect((await readRequest).status()).toBe(200);
  await expect(page).toHaveURL(/[?&]chat=[0-9a-f-]{36}/);

  const chat = page.getByRole('region', { name: 'Ruang chat' });
  // HTML dari pelanggan tampil sebagai teks.
  await expect(chat.getByText('Halo kak, internet mati. <b>tolong</b>')).toBeVisible();
  await expect(chat.getByText('Dokumen: tagihan-november.pdf')).toBeVisible();
  await expect(chat.getByRole('heading', { level: 2, name: customer.name })).toBeVisible();
  // Desktop: penanda di kepala chat. HP: subjudul cukup nomor, penanda ada di layar detail.
  if (!hp) await expect(chat.getByText(/dari WhatsApp/)).toBeVisible();
  // Jendela 24 jam terbuka: composer tersedia (butir 6).
  await expect(chat.getByRole('textbox', { name: 'Tulis balasan' })).toBeEnabled();

  // Pesan baru saat chat terbuka → muncul tanpa muat ulang.
  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer,
      body: 'Lampu LOS sudah merah dari pagi',
    }),
  );
  await expect(chat.getByText('Lampu LOS sudah merah dari pagi')).toBeVisible({
    timeout: 20_000,
  });
  await expectNoHorizontalScroll(page);

  if (hp) {
    // HP: chat = layar bertumpuk tanpa navigasi bawah; kembali ke daftar.
    await expect(page.getByRole('navigation', { name: 'Navigasi utama' })).toBeHidden();
    await expect(chat.getByRole('heading', { level: 2, name: customer.name })).toBeFocused();
    // Detail sebagai layar bertumpuk (`&detail=1`); kembali = ke chat.
    await chat.getByRole('button', { name: `Lihat detail ${customer.name}` }).click();
    await expect(page).toHaveURL(/[?&]detail=1/);
    const detail = page.getByRole('complementary', { name: 'Detail kontak' });
    await expect(detail.getByText('dari WhatsApp')).toBeVisible();
    await expect(detail.getByText(setup.channelName)).toBeVisible();
    await detail.getByRole('button', { name: 'Kembali ke chat' }).click();
    await expect(page).not.toHaveURL(/detail=/);
    await chat.getByRole('button', { name: 'Kembali ke daftar chat' }).click();
    await expect(page).not.toHaveURL(/chat=/);
    await expect(conversationRow(page, customer.name)).toBeFocused();
  } else {
    const detail = page.getByRole('complementary', { name: 'Detail kontak' });
    await expect(detail.getByText('Nama profil WhatsApp')).toBeVisible();
    await expect(detail.getByText(setup.channelName)).toBeVisible();
  }

  // Cari: nomor pelanggan (potongan ≥ 3 digit).
  if (hp) await openApp(page, '/inbox');
  await page.getByRole('searchbox', { name: 'Cari chat' }).fill(customer.waId.slice(-6));
  await expect(conversationRow(page, customer.name)).toBeVisible();
});

test('cakupan: CS melihat semua percakapan, Teknisi hanya yang di-assign kepadanya', async ({
  browser,
  page,
}) => {
  test.skip(isHp(page), 'cakupan peran cukup diuji sekali (desktop)');
  const setup = await createChannel('Cakupan', FAKE_META.numbers.inboxScope.id);
  const customer = randomCustomer('Fajar Cakupan');
  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer,
      body: 'Mau pasang baru kak',
    }),
  );
  await expect.poll(() => conversationIdOf(customer.waId).catch(() => null)).not.toBeNull();
  const conversationId = await conversationIdOf(customer.waId);

  const cs = await signIn(browser, await createUser('cs', 'inbox'), false);
  await expect(conversationRow(cs.page, customer.name)).toBeVisible({ timeout: 30_000 });
  cs.expectClean();
  await cs.close();

  const technicianUser = await createUser('teknisi', 'inbox');
  const technician = await signIn(browser, technicianUser, false);
  await expect(technician.page.getByRole('tabpanel')).toBeVisible();
  await expect(conversationRow(technician.page, customer.name)).toHaveCount(0);
  // Teknisi tidak punya saringan agen.
  await technician.page.getByRole('button', { name: /^Saring chat/ }).click();
  await expect(technician.page.getByRole('menu')).toBeVisible();
  await expect(technician.page.getByRole('menu').getByText('Agen', { exact: true })).toHaveCount(0);
  await technician.page.keyboard.press('Escape');

  // Membuka alamat chat yang bukan miliknya → "tidak ditemukan", tanpa isi pesan.
  technician.allow(`/api/v1/conversations/${conversationId}`, 404);
  await technician.page.goto(`/inbox?chat=${conversationId}`);
  await expect(
    technician.page.getByRole('heading', { name: 'Chat tidak ditemukan' }),
  ).toBeVisible();
  await expect(technician.page.getByText('Mau pasang baru kak')).toHaveCount(0);

  await e2eSql(`update conversations set assignee_user_id = $1, status = 'served' where id = $2`, [
    await userId(technicianUser.email),
    conversationId,
  ]);
  await technician.page.goto('/inbox?tab=dilayani');
  await expect(conversationRow(technician.page, customer.name)).toBeVisible();
  await conversationRow(technician.page, customer.name).click();
  await expect(
    technician.page.getByRole('region', { name: 'Ruang chat' }).getByText('Mau pasang baru kak'),
  ).toBeVisible();
  technician.expectClean();
  await technician.close();
});
