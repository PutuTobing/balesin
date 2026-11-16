import { randomInt } from 'node:crypto';
import { request, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import {
  deliverWhatsAppWebhook,
  mediaMessageNotification,
  textMessageNotification,
} from '../../apps/api/src/testing/fake-meta-webhooks';
import { FAKE_META } from '../stack/fake-meta-data';
import { E2E_OWNER } from '../stack/env';
import { BASE_URL } from '../viewports';
import { expect, expectNoHorizontalScroll, isHp, openApp, submitLogin, test } from './fixtures';
import { openWatchedPage } from './konteks';
import { createUser, e2eSql, userId, type ExtraUser } from './pengguna';
import { totpAtStep, totpStep } from './two-factor';

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

interface Setup {
  appSecret: string;
  callbackUrl: string;
  phoneNumberId: string;
  channelName: string;
}

/**
 * Owner KEDUA khusus tes ini (pola `channel.spec`): konfirmasi identitas memakai kode cadangannya
 * sendiri, jadi tidak antre kode TOTP Owner utama yang dipakai bergantian oleh tes lain.
 * Mengembalikan konteks API yang sudah bersesi penuh.
 */
async function ownerApi(): Promise<{
  api: APIRequestContext;
  csrf: string;
  confirmation: { password: string; code: string };
}> {
  const email = `owner-inbox-${Date.now().toString(36)}-${randomInt(1000, 9999)}@majujaya.test`;
  const rows = await e2eSql(
    `insert into users (id, organization_id, email, name, password_hash, role, email_verified_at)
     select gen_random_uuid(), organization_id, $1, 'Dewi Inbox', password_hash, 'owner'::user_role, now()
     from users where email = $2
     returning id`,
    [email, E2E_OWNER.email],
  );
  if (rows.length !== 1) throw new Error('Owner E2E belum ada (alur-awal belum jalan?)');
  const password = E2E_OWNER.password;
  const api = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  const login = (await (
    await api.post('/api/v1/auth/login', { data: { email, password } })
  ).json()) as { status: string; csrfToken: string };
  if (login.status !== 'two_factor_enrollment_required') {
    throw new Error(`Login Owner kedua: ${login.status}`);
  }
  const headers = { 'x-csrf-token': login.csrfToken };
  const enroll = await api.post('/api/v1/auth/2fa/enroll', { headers, data: {} });
  const { secret } = (await enroll.json()) as { secret: string };
  const confirm = await api.post('/api/v1/auth/2fa/enroll/confirm', {
    headers,
    data: { code: totpAtStep(secret, totpStep()) },
  });
  if (!confirm.ok())
    throw new Error(`Konfirmasi 2FA (${confirm.status()}): ${await confirm.text()}`);
  const { backupCodes } = (await confirm.json()) as { backupCodes: { codes: string[] } };
  const me = (await (await api.get('/api/v1/auth/me')).json()) as {
    status: string;
    csrfToken: string;
  };
  if (me.status !== 'authenticated') throw new Error(`Sesi Owner kedua: ${me.status}`);
  return {
    api,
    csrf: me.csrfToken,
    confirmation: { password, code: backupCodes.codes[0] ?? '' },
  };
}

/** Channel WhatsApp baru lewat API (konfirmasi identitas Owner kedua), dengan App Secret tes. */
async function createChannel(label: string): Promise<Setup> {
  const phoneNumberId = `19${Date.now()}${randomInt(100, 999)}`.slice(0, 15);
  const channelName = `Inbox E2E ${label}`;
  const { api, csrf, confirmation } = await ownerApi();
  try {
    const response = await api.post('/api/v1/settings/channels', {
      headers: { 'x-csrf-token': csrf },
      data: {
        type: 'whatsapp',
        name: channelName,
        phoneNumberId,
        wabaId: FAKE_META.wabaId,
        accessToken: FAKE_META.token,
        appSecret: FAKE_META.appSecret,
        confirmation,
      },
    });
    if (!response.ok()) {
      throw new Error(`Buat channel (${response.status()}): ${await response.text()}`);
    }
    const body = (await response.json()) as { webhook: { callbackUrl: string } };
    return {
      appSecret: FAKE_META.appSecret,
      callbackUrl: body.webhook.callbackUrl,
      phoneNumberId,
      channelName,
    };
  } finally {
    await api.dispose();
  }
}

function randomCustomer(name: string) {
  return { waId: `62812${randomInt(1_000_000, 9_999_999)}`, userId: null, name };
}

async function deliver(setup: Setup, notification: unknown): Promise<void> {
  const response = await deliverWhatsAppWebhook(setup.callbackUrl, notification, setup.appSecret);
  expect(response.status, 'webhook diterima').toBe(200);
}

/** Nomor E.164 Indonesia seperti tampil di UI: +62 812-3456-7890. */
function shownPhone(waId: string): string {
  const local = waId.slice(2);
  return `+62 ${local.slice(0, 3)}-${local.slice(3, 7)}-${local.slice(7)}`;
}

async function conversationIdOf(waId: string): Promise<string> {
  const rows = await e2eSql<{ id: string }>(
    `select c.id from conversations c join contacts k on k.id = c.contact_id
     where k.phone = $1 order by c.created_at desc limit 1`,
    [`+${waId}`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Percakapan belum dibuat worker');
  return id;
}

function conversationRow(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Daftar chat' })
    .getByRole('button', { name: new RegExp(name) });
}

async function signIn(browser: Browser, user: ExtraUser, hp: boolean) {
  const watched = await openWatchedPage(browser, { hp });
  watched.allow('/api/v1/auth/me', 401);
  await watched.page.goto('/masuk');
  await submitLogin(watched.page, user.email, user.password);
  await expect(watched.page).toHaveURL(/\/inbox/);
  return watched;
}

test('pesan masuk bertanda tangan tampil di daftar, bisa dibuka, dan pesan baru datang real-time', async ({
  page,
}) => {
  const hp = isHp(page);
  const setup = await createChannel(hp ? 'HP' : 'Desktop');
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
  await expect(chat.getByText(/dari WhatsApp/)).toBeVisible();
  await expect(chat.getByRole('textbox')).toHaveCount(0);

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
    await chat.getByRole('button', { name: 'Kembali ke daftar chat' }).click();
    await expect(page).not.toHaveURL(/chat=/);
    await expect(conversationRow(page, customer.name)).toBeVisible();
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
  const setup = await createChannel('Cakupan');
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
