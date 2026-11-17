import {
  interactiveReplyNotification,
  statusNotification,
  templateStatusNotification,
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
  signIn,
  type OwnerApi,
  type Setup,
} from './inbox-bantu';
import { OWNER_STATE_PATH } from '../stack/env';
import { openWatchedPage } from './konteks';
import { createUser, e2eSql, userId } from './pengguna';

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
  await dialog
    .getByLabel('Isi pesan', { exact: true })
    .fill('Halo kak {nama}, dengan {agen} di sini.');
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

test('di luar jendela 24 jam: composer diganti penjelasan + "Kirim template"', async ({ page }) => {
  await e2eSql(
    `update conversations set window_expires_at = now() - interval '1 hour' where id = $1`,
    [conversationId],
  );
  await openApp(page, `/inbox?chat=${conversationId}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await expect(chat.getByText('Sesi 24 jam sudah habis')).toBeVisible();
  await expect(chat.getByRole('textbox', { name: 'Tulis balasan' })).toHaveCount(0);
  // Fitur template sudah ada: aksi nyata (bukan tombol nonaktif / janji fitur).
  await expect(chat.getByRole('button', { name: 'Kirim template', exact: true })).toBeEnabled();
});

let templateName = '';
const TEMPLATE_TEXT = 'Halo Yanti, tagihan bulan Desember sudah terbit.';

/**
 * Template disetujui lewat jalur sungguhan: buat + ajukan (API, Meta tiruan → PENDING) → webhook
 * `message_template_status_update` APPROVED bertanda tangan → worker menandai disetujui.
 */
async function approvedTemplate(): Promise<string> {
  const { api, csrf } = await ownerApi();
  try {
    const rows = await e2eSql<{ id: string }>(`select id from channels where name = $1`, [
      setup.channelName,
    ]);
    const name = `tagihan_e2e_${Date.now().toString(36)}`;
    const created = await api.post('/api/v1/templates', {
      headers: { 'x-csrf-token': csrf },
      data: {
        channelId: rows[0]?.id,
        name,
        language: 'id',
        category: 'UTILITY',
        content: {
          parameterFormat: 'positional',
          header: null,
          body: {
            text: 'Halo {{1}}, tagihan bulan {{2}} sudah terbit.',
            examples: { '1': 'Budi', '2': 'November' },
          },
          footer: null,
          buttons: [],
          authentication: null,
        },
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { template } = (await created.json()) as { template: { id: string } };
    const submitted = await api.post(`/api/v1/templates/${template.id}/submit`, {
      headers: { 'x-csrf-token': csrf },
    });
    expect(submitted.ok(), await submitted.text()).toBe(true);
    const meta = ((await submitted.json()) as { template: { metaTemplateId: string } }).template
      .metaTemplateId;
    await deliver(
      setup,
      templateStatusNotification({ wabaId: FAKE_META.wabaId, id: meta, name, language: 'id' }),
    );
    await expect
      .poll(
        async () =>
          (
            await e2eSql<{ status: string }>(`select status from message_templates where id = $1`, [
              template.id,
            ])
          )[0]?.status,
      )
      .toBe('APPROVED');
    return name;
  } finally {
    await api.dispose();
  }
}

test('di luar sesi 24 jam: "Kirim template" → isi variabel → terkirim (wamid)', async ({
  page,
}) => {
  templateName = await approvedTemplate();
  await openApp(page, `/inbox?chat=${conversationId}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await chat.getByRole('button', { name: 'Kirim template', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Kirim template WhatsApp' });
  await dialog.getByRole('button', { name: new RegExp(templateName) }).click();
  await dialog.getByLabel('Nilai {{1}}', { exact: true }).fill('Yanti');
  await dialog.getByLabel('Nilai {{2}}', { exact: true }).fill('Desember');
  await expect(
    dialog.getByRole('figure', { name: 'Pratinjau pesan template' }).getByText(TEMPLATE_TEXT),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Kirim template', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(chat.getByText(TEMPLATE_TEXT)).toBeVisible();
  await expect(chat.getByText(`Template ${templateName}`)).toBeVisible();
  await expect.poll(() => wamidOf(TEMPLATE_TEXT)).not.toBeNull();
});

test('percakapan baru ke nomor yang belum pernah chat → chat terbuka, dipegang pemula', async ({
  page,
}) => {
  const fresh = randomCustomer('Pelanggan Baru');
  const [channel] = await e2eSql<{ id: string }>(`select id from channels where name = $1`, [
    setup.channelName,
  ]);
  await openApp(page, '/inbox');
  await page.getByRole('button', { name: 'Percakapan baru' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mulai percakapan baru' });
  const sender = dialog.getByLabel('Kirim dari nomor');
  // Banyak nomor di stack E2E: pilihan nomor selalu tampil (tunggu daftar nomornya dimuat).
  await sender.selectOption(channel?.id ?? '');
  // Format lokal 08… dinormalkan server ke +62….
  await dialog.getByLabel('Nomor tujuan').fill(`0${fresh.waId.slice(2)}`);
  await dialog.getByRole('button', { name: new RegExp(templateName) }).click();
  await dialog.getByLabel('Nilai {{1}}', { exact: true }).fill('Kak');
  await dialog.getByLabel('Nilai {{2}}', { exact: true }).fill('Januari');
  await dialog.getByRole('button', { name: 'Kirim dan buka chat' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/chat=[0-9a-f-]{36}/);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await expect(chat.getByText('Halo Kak, tagihan bulan Januari sudah terbit.')).toBeVisible();
  const [row] = await e2eSql<{ status: string; assignee_id: string | null }>(
    `select c.status, c.assignee_user_id as assignee_id from conversations c join contacts k on k.id = c.contact_id
     where k.phone = $1`,
    [`+${fresh.waId}`],
  );
  expect(row?.status).toBe('served');
  expect(row?.assignee_id).toBeTruthy();
});

/**
 * Ujung ke ujung di HP 390 px (butir 11/12): pesan masuk lewat webhook bertanda tangan → muncul di
 * daftar → buka (layar bertumpuk) → balas → centang maju lewat status webhook → tandai selesai dari
 * menu tindakan → kembali ke daftar. Di spec ini (bukan proyek hp-390) karena pengiriman harus
 * berurutan dengan uji rem darurat di atas.
 */
test('HP 390: masuk → tampil → buka → balas → dibaca → tandai selesai', async ({ browser }) => {
  // Konteks HP sungguhan (390, isMobile + layar sentuh) dengan sesi Owner proyek.
  const hp = await openWatchedPage(browser, { hp: true, storageState: OWNER_STATE_PATH });
  const { page } = hp;
  try {
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
    hp.expectClean();
  } finally {
    await hp.close();
  }
});

/* ------------------------------------------------------------------------------------------------
 * Celah butir 12 (QA penutupan Fase 2): status `read` di desktop, media keluar sampai status maju,
 * gagal diantar → "Kirim ulang" → terkirim, dan Teknisi membalas chat yang di-assign kepadanya
 * (Owner melihat balasan itu real-time). Tetap di spec berurutan ini: semuanya MENGIRIM pesan,
 * jadi tidak boleh bersamaan dengan uji rem darurat.
 * ---------------------------------------------------------------------------------------------- */

async function outboundWamid(conversation: string, text: string): Promise<string | null> {
  const rows = await e2eSql<{ wamid: string | null }>(
    `select wamid from messages where conversation_id = $1 and direction = 'outbound' and text = $2`,
    [conversation, text],
  );
  return rows[0]?.wamid ?? null;
}

async function deliverStatuses(
  waId: string,
  wamid: string,
  statuses: readonly ('sent' | 'delivered' | 'read' | 'failed')[],
) {
  for (const status of statuses) {
    await deliver(
      setup,
      statusNotification({
        phoneNumberId: setup.phoneNumberId,
        wabaId: FAKE_META.wabaId,
        wamid,
        status,
        recipientWaId: waId,
      }),
    );
  }
}

async function newInboundConversation(name: string, body: string) {
  const who = randomCustomer(name);
  await deliver(
    setup,
    textMessageNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer: who,
      body,
    }),
  );
  await expect.poll(() => conversationIdOf(who.waId).catch(() => '')).not.toBe('');
  return { who, id: await conversationIdOf(who.waId) };
}

test('desktop: gambar keluar dapat wamid lalu centang maju sampai Dibaca', async ({ page }) => {
  const { who, id } = await newInboundConversation('Rudi Gambar', 'Kak, ini lampu modemnya?');
  await openApp(page, `/inbox?chat=${id}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await chat.getByTestId('composer-file').setInputFiles({
    name: 'bukti.jpg',
    mimeType: 'image/jpeg',
    buffer: TINY_JPEG,
  });
  const caption = 'Contoh lampu normal';
  await chat.getByRole('textbox', { name: 'Tulis balasan' }).fill(caption);
  await chat.getByRole('button', { name: 'Kirim', exact: true }).click();
  const image = chat.getByRole('img', { name: `Gambar: ${caption}` });
  await expect(image).toBeVisible({ timeout: 20_000 });
  // Worker mengunggah ke Meta tiruan lalu mengirim → wamid tersimpan.
  await expect.poll(() => outboundWamid(id, caption), { timeout: 30_000 }).not.toBeNull();
  await deliverStatuses(who.waId, (await outboundWamid(id, caption)) ?? '', [
    'sent',
    'delivered',
    'read',
  ]);
  const bubble = chat
    .getByRole('listitem')
    .filter({ has: page.getByRole('img', { name: `Gambar: ${caption}` }) });
  await expect(bubble.getByText('Dibaca')).toBeAttached({ timeout: 20_000 });
});

test('desktop: gagal diantar (status failed) → penjelasan + Kirim ulang → terkirim → Dibaca', async ({
  page,
}) => {
  const { who, id } = await newInboundConversation('Tono Gagal', 'Kak, tolong cek tagihan saya.');
  const text = 'Tagihan kakak sudah kami cek, aman ya.';
  await openApp(page, `/inbox?chat=${id}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
  await box.fill(text);
  await box.press('Enter');
  await expect.poll(() => outboundWamid(id, text), { timeout: 30_000 }).not.toBeNull();
  const firstWamid = (await outboundWamid(id, text)) ?? '';

  // Meta melaporkan gagal (contoh resmi kode 131049) → penjelasan Indonesia + tombol kirim ulang.
  await deliverStatuses(who.waId, firstWamid, ['failed']);
  const bubble = chat.getByRole('listitem').filter({ hasText: text });
  await expect(bubble.getByText(/Meta menahan pesan ini/)).toBeVisible({ timeout: 20_000 });
  const resend = bubble.getByRole('button', { name: 'Kirim ulang' });
  await expect(resend).toBeVisible();
  await resend.click();
  await expect(resend).toHaveCount(0, { timeout: 20_000 });

  // Worker mengirim ulang → wamid BARU.
  await expect.poll(() => outboundWamid(id, text), { timeout: 30_000 }).not.toBe(firstWamid);
  await expect.poll(() => outboundWamid(id, text), { timeout: 30_000 }).not.toBeNull();
  const secondWamid = (await outboundWamid(id, text)) ?? '';
  await deliverStatuses(who.waId, secondWamid, ['sent', 'delivered', 'read']);
  await expect(bubble.getByText('Dibaca')).toBeAttached({ timeout: 20_000 });
  await expect(bubble.getByText(/Meta menahan pesan ini/)).toHaveCount(0);
  const rows = await e2eSql<{ count: string }>(
    `select count(*)::text as count from messages where conversation_id = $1 and direction = 'outbound'`,
    [id],
  );
  expect(rows[0]?.count, 'kirim ulang tidak membuat pesan ganda').toBe('1');
});

test('Teknisi membalas chat yang di-assign; Owner melihatnya real-time; status maju', async ({
  browser,
  page,
}) => {
  const { who, id } = await newInboundConversation('Agus Teknisi', 'Teknisinya jam berapa datang?');
  const technicianUser = await createUser('teknisi', 'balas');
  await e2eSql(`update conversations set assignee_user_id = $1, status = 'served' where id = $2`, [
    await userId(technicianUser.email),
    id,
  ]);

  // Owner (sesi proyek) membuka chat yang sama lebih dulu.
  await openApp(page, `/inbox?chat=${id}`);
  const ownerChat = page.getByRole('region', { name: 'Ruang chat' });
  await expect(ownerChat.getByText('Teknisinya jam berapa datang?')).toBeVisible();

  const technician = await signIn(browser, technicianUser, false);
  try {
    await technician.page.goto(`/inbox?chat=${id}`);
    const chat = technician.page.getByRole('region', { name: 'Ruang chat' });
    const box = chat.getByRole('textbox', { name: 'Tulis balasan' });
    await expect(box).toBeEnabled();
    const text = 'Saya meluncur jam 14.00 ya kak.';
    await box.fill(text);
    await box.press('Enter');
    await expect(chat.getByText(text)).toBeVisible();
    // Owner menerima balasan Teknisi tanpa muat ulang (WebSocket).
    await expect(ownerChat.getByText(text)).toBeVisible({ timeout: 20_000 });

    await expect.poll(() => outboundWamid(id, text), { timeout: 30_000 }).not.toBeNull();
    await deliverStatuses(who.waId, (await outboundWamid(id, text)) ?? '', [
      'sent',
      'delivered',
      'read',
    ]);
    await expect(
      chat.getByRole('listitem').filter({ hasText: text }).getByText('Dibaca'),
    ).toBeAttached({ timeout: 20_000 });
    await expect(
      ownerChat.getByRole('listitem').filter({ hasText: text }).getByText('Dibaca'),
    ).toBeAttached({ timeout: 20_000 });
    technician.expectClean();
  } finally {
    await technician.close();
  }
});

test('pesan interaktif: tombol dikirim (wamid) → pelanggan memilih → pilihannya tampil', async ({
  page,
}) => {
  const { who, id } = await newInboundConversation('Wina Tombol', 'Kak, mau tanya paket.');
  await openApp(page, `/inbox?chat=${id}`);
  const chat = page.getByRole('region', { name: 'Ruang chat' });
  await chat.getByRole('button', { name: 'Kirim tombol atau daftar pilihan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pesan dengan pilihan' });
  const body = 'Mau dibantu soal apa kak?';
  await dialog.getByLabel('Isi pesan', { exact: true }).fill(body);
  await dialog.getByLabel('Tombol 1', { exact: true }).fill('Tagihan');
  await dialog.getByLabel('Tombol 2', { exact: true }).fill('Gangguan');
  await dialog.getByRole('button', { name: 'Kirim', exact: true }).click();
  await expect(dialog).toBeHidden();
  const choices = chat.getByRole('list', { name: 'Pilihan yang dikirim' });
  await expect(choices.getByText('Tagihan')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => outboundWamid(id, body), { timeout: 30_000 }).not.toBeNull();

  await deliver(
    setup,
    interactiveReplyNotification({
      phoneNumberId: setup.phoneNumberId,
      wabaId: FAKE_META.wabaId,
      customer: who,
      reply: 'button_reply',
      id: 'tombol-2',
      title: 'Gangguan',
    }),
  );
  await expect(chat.getByText('Balasan tombol')).toBeVisible({ timeout: 20_000 });
});
