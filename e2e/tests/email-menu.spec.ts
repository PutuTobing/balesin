import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { OWNER_STATE_PATH } from '../stack/env';
import {
  FAKE_MAIL,
  deliverFakeMail,
  fakeChannelsInfo,
  fakeSmtpMessages,
  type FakeSmtpMessage,
} from '../stack/fake-channels-data';
import { expect, expectNoHorizontalScroll, mainNav, openApp, test } from './fixtures';
import { confirmAsOwner } from './identitas';
import { signIn } from './inbox-bantu';
import { openWatchedPage } from './konteks';
import { findMail, readMail } from './mailpit';
import { createUser, e2eSql } from './pengguna';

/**
 * Menu Email (Fase 9A/9B) melawan stack E2E sungguhan (api + worker + web):
 *  - server IMAP multi-folder TIRUAN + SMTP TIRUAN ber-TLS (`stack/fake-channels-server.ts`,
 *    sertifikat tes, hanya 127.0.0.1) untuk kotak surat akun;
 *  - email verifikasi alamat lewat Email pengirim SISTEM (= Mailpit, diatur `email-pengirim.spec.ts`).
 *
 * Alur: Owner menghubungkan akun lewat wizard (IMAP lain) → tes koneksi → simpan → langkah 5
 * Verifikasi (kode dari Mailpit) → email masuk muncul di daftar, panel baca menampilkan isinya dan
 * gambar luar diblokir → balas (toast batal kirim → "Kirim sekarang" → sampai di SMTP tiruan) → kirim
 * lalu "Batalkan" (tidak terkirim, draf kembali) → CS/Teknisi tanpa akses tidak melihat akun itu →
 * tampilan HP 390 px.
 *
 * Proyek `berurutan` (satu per satu, setelah `email-pengirim.spec.ts` mengatur Email pengirim): kotak
 * surat tiruan hanya satu dan alamatnya unik di organisasi, jadi berkas ini berjalan sekali, berurutan.
 */

// Batas waktu juga mencakup penyiapan fixture (context browser) — di mesin sibuk bisa > 30 dtk.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const stamp = `${Date.now().toString(36)}${randomInt(100, 999)}`;
const ACCOUNT_NAME = `CS Bersama ${stamp}`;
const SUBJECT = `Tagihan Oktober belum masuk ${stamp}`;
const CUSTOMER = { name: 'Budi Santoso', address: `budi.${stamp}@pelanggan-contoh.test` };
const MESSAGE_ID = `<tanya-${stamp}@pelanggan-contoh.test>`;
/** Host gambar luar (domain .invalid tidak pernah ada): permintaan ke sini = gambar tidak diblokir. */
const TRACKER_HOST = 'pelacak.contoh.invalid';

let accountId = '';

function incomingEmail(): string {
  const boundary = `batas-${stamp}`;
  return [
    `From: "${CUSTOMER.name}" <${CUSTOMER.address}>`,
    `To: ${FAKE_MAIL.address}`,
    `Subject: ${SUBJECT}`,
    `Message-ID: ${MESSAGE_ID}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Halo, pembayaran tagihan Oktober saya belum tercatat. Mohon dicek. Nomor pelanggan 12345.',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body>',
    '<p>Halo, pembayaran tagihan Oktober saya <b>belum tercatat</b>. Mohon dicek.</p>',
    '<p>Nomor pelanggan 12345.</p>',
    `<img src="https://${TRACKER_HOST}/piksel.png?id=${stamp}" width="1" height="1" alt="">`,
    '</body></html>',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Email yang diterima SMTP tiruan untuk pelanggan dan memuat `text`. */
async function deliveredTo(text: string): Promise<FakeSmtpMessage[]> {
  return (await fakeSmtpMessages()).filter(
    (message) => message.to.includes(CUSTOMER.address) && message.raw.includes(text),
  );
}

/** Kode 6 angka dari email verifikasi (Mailpit) untuk alamat akun yang tiba setelah `since`. */
async function verificationCode(since: Date): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        for (const message of await findMail(FAKE_MAIL.address)) {
          if (new Date(message.Created).getTime() < since.getTime() - 1000) continue;
          const found = /Kode verifikasi alamat pengirim: (\d{6})/.exec(message.Subject)?.[1];
          if (found) {
            const { Text } = await readMail(message.ID);
            expect(Text).toContain(found);
            code = found;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000, message: 'email verifikasi alamat di Mailpit' },
    )
    .toBe(true);
  return code;
}

function mailRow(page: Page) {
  return page.getByRole('button', { name: new RegExp(SUBJECT) });
}

async function openMessage(page: Page): Promise<void> {
  await openApp(page, '/email');
  await expect(mailRow(page)).toBeVisible({ timeout: 30_000 });
  await mailRow(page).click();
  await expect(page.getByRole('heading', { name: SUBJECT })).toBeVisible();
}

/**
 * Wizard hanya menerima port standar (IMAP 993/143, SMTP 465/587) — benar untuk produk. Server tiruan
 * berjalan di port acak di 127.0.0.1, jadi (seperti port forwarding / NAT) permintaan wizard ke API
 * diterjemahkan: 993 → port IMAP tiruan, 465 → port SMTP tiruan. Penjaga port & host di API dan
 * worker tetap berlaku penuh (port tiruan diizinkan hanya lewat variabel tes non-produksi).
 */
async function forwardStandardPorts(page: Page): Promise<void> {
  const { mailImapPort, mailSmtpPort } = await fakeChannelsInfo();
  await page.route(/\/api\/v1\/mail\/accounts(\/test)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON() as {
      imap?: { port?: number };
      smtp?: { port?: number };
    };
    if (body.imap?.port === 993) body.imap.port = mailImapPort;
    if (body.smtp?.port === 465) body.smtp.port = mailSmtpPort;
    await route.continue({ postData: JSON.stringify(body) });
  });
}

test('Owner menghubungkan akun IMAP lewat wizard, tes koneksi, simpan, lalu verifikasi alamat dengan kode dari Mailpit', async ({
  page,
}) => {
  await forwardStandardPorts(page);

  await openApp(page, '/pengaturan/akun-email');
  await page.getByRole('button', { name: 'Hubungkan akun email' }).first().click();
  const wizard = page.getByRole('dialog', { name: 'Hubungkan akun email' });
  await expect(wizard).toBeVisible();

  // Langkah 1: alamat + penyedia IMAP lain.
  await wizard.getByLabel('Alamat email').fill(FAKE_MAIL.address);
  await wizard.getByRole('radio', { name: /IMAP lain/ }).click();
  await wizard.getByRole('button', { name: 'Lanjut' }).click();

  // Langkah 2: detail akun & server. TLS wajib; port standar (lihat `forwardStandardPorts`).
  await wizard.getByLabel('Nama akun').fill(ACCOUNT_NAME);
  await wizard.getByLabel('Nama pengirim').fill('CS Maju Jaya');
  await wizard.getByLabel('Username', { exact: true }).fill(FAKE_MAIL.username);
  await wizard.getByLabel('Password atau sandi aplikasi').fill(FAKE_MAIL.password);
  const incoming = wizard.getByRole('group', { name: 'Server masuk (IMAP)' });
  await incoming.getByLabel('Host').fill(FAKE_MAIL.host);
  await expect(incoming.getByRole('radio', { name: 'SSL/TLS' })).toBeChecked();
  await expect(incoming.getByLabel('Port')).toHaveValue('993');
  const outgoing = wizard.getByRole('group', { name: 'Server keluar (SMTP)' });
  await outgoing.getByLabel('Host').fill(FAKE_MAIL.host);
  // SMTP tiruan memakai TLS langsung: ganti dari STARTTLS → port ikut berganti 587 → 465.
  await outgoing.getByRole('radio', { name: 'SSL/TLS' }).check();
  await expect(outgoing.getByLabel('Port')).toHaveValue('465');
  await wizard.getByRole('button', { name: 'Tes koneksi' }).click();

  // Langkah 3: tes koneksi sungguhan ke IMAP & SMTP tiruan.
  await expect(wizard.getByText('Masuk ke IMAP berhasil')).toBeVisible({ timeout: 30_000 });
  await expect(wizard.getByText('Masuk ke SMTP berhasil')).toBeVisible();
  await expect(
    wizard.getByText(`Siap mengirim sebagai ${FAKE_MAIL.address}.`, { exact: false }),
  ).toBeVisible();
  await expect(wizard.getByText(/Sinkron awal mengambil email 90 hari terakhir/)).toBeVisible();
  await expect(wizard.getByText('Tes koneksi belum lolos')).toHaveCount(0);
  await wizard.getByRole('button', { name: 'Lanjut' }).click();

  // Langkah 4: akun bersama (bawaan) → simpan dengan konfirmasi identitas.
  await wizard.getByRole('button', { name: 'Simpan & mulai sinkron' }).click();
  const since = new Date();
  await confirmAsOwner(page, 'Konfirmasi akun bersama', 'Simpan & mulai sinkron');

  // Langkah 5: Verifikasi alamat utama — email verifikasi lewat Email pengirim sistem (Mailpit).
  await expect(
    wizard.getByText(`${ACCOUNT_NAME} terhubung. Sinkron awal sedang berjalan.`),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    wizard.getByRole('heading', { name: `Verifikasi ${FAKE_MAIL.address}` }),
  ).toBeVisible();
  const code = await verificationCode(since);
  await wizard.getByLabel(`Kode verifikasi untuk ${FAKE_MAIL.address}`).fill(code);
  await wizard.getByRole('button', { name: 'Verifikasi kode' }).click();
  await expect(wizard.getByText('Alamat terverifikasi')).toBeVisible();
  await wizard.getByRole('button', { name: 'Selesai', exact: true }).click();
  await expect(wizard).toBeHidden();

  const rows = await e2eSql<{ id: string }>(
    'select id from mail_accounts where display_name = $1',
    [ACCOUNT_NAME],
  );
  expect(rows).toHaveLength(1);
  accountId = rows[0]?.id ?? '';
  // Kredensial tidak pernah tersimpan polos.
  const secrets = await e2eSql<{ raw: string }>(
    'select row_to_json(a)::text as raw from mail_accounts a where id = $1',
    [accountId],
  );
  expect(secrets[0]?.raw).not.toContain(FAKE_MAIL.password);
});

test('email masuk di IMAP tiruan muncul di menu Email; panel baca menampilkan isi, gambar luar diblokir', async ({
  page,
}) => {
  expect(accountId, 'akun dari tes sebelumnya').not.toBe('');
  const trackerRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(TRACKER_HOST)) trackerRequests.push(request.url());
  });
  // Email baru masuk lewat IMAP IDLE (Kotak masuk). Sambungan IDLE dibuka worker beberapa detik
  // setelah akun dibuat; email yang tiba SEBELUM itu baru diambil sinkron berkala (5 menit) —
  // lihat laporan QA. Tunggu IDLE aktif dulu supaya tes menguji jalur "langsung masuk".
  await expect
    .poll(
      async () =>
        (
          await e2eSql<{ idle: boolean }>(
            'select idle_active as idle from mail_accounts where id = $1',
            [accountId],
          )
        )[0]?.idle,
      { timeout: 60_000, message: 'sambungan IDLE akun aktif' },
    )
    .toBe(true);
  await deliverFakeMail(incomingEmail());

  await openMessage(page);
  const reader = page.getByRole('main');
  await expect(reader.getByText(CUSTOMER.name).first()).toBeVisible();
  await expect(
    page.getByText('Gambar dari luar disembunyikan untuk melindungi privasimu.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tampilkan gambar' })).toBeVisible();
  const body = page.frameLocator(`iframe[title="Isi email: ${SUBJECT}"]`);
  await expect(body.getByText('belum tercatat')).toBeVisible({ timeout: 20_000 });
  await expect(body.getByText('Nomor pelanggan 12345.')).toBeVisible();
  // Gambar luar tidak pernah diminta browser (bukan sekadar disembunyikan).
  expect(trackerRequests).toEqual([]);
  const srcs = await body
    .locator('img')
    .evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''));
  expect(srcs.some((src) => src.includes(TRACKER_HOST))).toBe(false);
});

test('balas dari jendela tulis: toast batal kirim → "Kirim sekarang" → sampai di SMTP tujuan', async ({
  page,
}) => {
  const replyText = `Baik Pak Budi, pembayaran sedang kami cek ${stamp}-kirim.`;
  await openMessage(page);
  await page.getByRole('button', { name: 'Balas', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: `Tulis email: Balas: ${SUBJECT}` });
  await expect(compose).toBeVisible();
  // Kepada = pengirim email (chip bernama, alamat lengkap di judul chip).
  await expect(
    compose.getByRole('list', { name: 'Penerima (Kepada)' }).getByTitle(CUSTOMER.address, {
      exact: false,
    }),
  ).toBeVisible();
  await compose.getByRole('textbox', { name: 'Isi email' }).click();
  await page.keyboard.type(replyText);
  await compose.getByRole('button', { name: 'Kirim', exact: true }).click();

  const toasts = page.getByRole('region', { name: 'Status kirim email' });
  await expect(toasts.getByText(`Email akan dikirim dari ${FAKE_MAIL.address}`)).toBeVisible();
  await expect(
    toasts.getByRole('button', { name: /^Batalkan kirim, sisa \d+ detik$/ }),
  ).toBeVisible();
  await toasts.getByRole('button', { name: 'Kirim sekarang' }).click();
  await expect(toasts.getByText('Email terkirim.')).toBeVisible({ timeout: 30_000 });
  await expect(compose).toBeHidden();

  await expect.poll(async () => (await deliveredTo(`${stamp}-kirim`)).length).toBe(1);
  const [sent] = await deliveredTo(`${stamp}-kirim`);
  expect(sent?.from).toBe(FAKE_MAIL.address);
  expect(sent?.raw).toContain(`In-Reply-To: ${MESSAGE_ID}`);
  expect(sent?.raw).toMatch(new RegExp(`Subject: (Re|RE): ${SUBJECT}`));
});

test('kirim lalu "Batalkan": email tidak terkirim dan draf dibuka lagi', async ({ page }) => {
  const replyText = `Mohon tunggu sebentar ${stamp}-batal.`;
  await openMessage(page);
  await page.getByRole('button', { name: 'Balas', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: `Tulis email: Balas: ${SUBJECT}` });
  await expect(compose).toBeVisible();
  await compose.getByRole('textbox', { name: 'Isi email' }).click();
  await page.keyboard.type(replyText);
  await compose.getByRole('button', { name: 'Kirim', exact: true }).click();

  const toasts = page.getByRole('region', { name: 'Status kirim email' });
  await toasts.getByRole('button', { name: /^Batalkan kirim, sisa \d+ detik$/ }).click();
  // Draf dibuka lagi dengan isinya.
  const reopened = page.getByRole('dialog', { name: /^Tulis email: / });
  await expect(reopened).toBeVisible({ timeout: 15_000 });
  await expect(reopened.getByRole('textbox', { name: 'Isi email' })).toContainText(replyText);
  await expect(toasts.getByText(/Email akan dikirim dari/)).toBeHidden();

  // Lewat masa batal (10 dtk bawaan) + jeda worker: tetap tidak sampai di SMTP.
  await page.waitForTimeout(15_000);
  expect(await deliveredTo(`${stamp}-batal`)).toEqual([]);
  const outbox = await e2eSql<{ status: string }>(
    `select o.status from mail_outbox o where o.account_id = $1 order by o.created_at desc limit 1`,
    [accountId],
  );
  expect(outbox[0]?.status).toBe('canceled');

  // Draf dibuang supaya folder Draf bersih.
  await reopened
    .getByRole('button', { name: 'Buang draf' })
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByRole('dialog', { name: 'Buang draf ini?' })
    .getByRole('button', { name: 'Buang draf' })
    .click();
  await expect(reopened).toBeHidden();
});

test('CS dan Teknisi tanpa akses tidak melihat akun itu', async ({ browser }) => {
  for (const role of ['cs', 'teknisi'] as const) {
    const user = await createUser(role, `email-menu-${stamp}`);
    const watched = await signIn(browser, user, false);
    const { page } = watched;
    watched.allow(`/api/v1/mail/accounts/${accountId}`, 404);
    await openApp(page, '/email');
    if (role === 'cs') {
      // CS boleh menghubungkan akun pribadi: menu Email ada, tetapi isinya keadaan kosong — bukan
      // akun bersama Owner yang tidak dibagikan kepadanya.
      await expect(mainNav(page).getByRole('link', { name: 'Email' })).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Hubungkan akun email pertamamu' }),
      ).toBeVisible();
      await expect(
        page.getByText('Akun bersama hanya bisa dihubungkan Owner atau Admin'),
      ).toBeVisible();
    } else {
      // Teknisi tanpa akun yang bisa dibuka dan tanpa hak akun pribadi: menu Email tidak tampil
      // dan /email dialihkan (mailMenuVisible).
      await expect(page).not.toHaveURL(/\/email/);
      await expect(mainNav(page).getByRole('link', { name: 'Email' })).toHaveCount(0);
    }
    await expect(page.getByRole('region', { name: 'Daftar email' })).toHaveCount(0);
    await expect(page.getByText(ACCOUNT_NAME)).toHaveCount(0);
    await expect(page.getByText(SUBJECT)).toHaveCount(0);
    // Langsung lewat API pun tidak ada (404, bukan 403: keberadaan akun tidak dibocorkan).
    const direct = await page.request.get(`/api/v1/mail/accounts/${accountId}`);
    expect(direct.status()).toBe(404);
    const list = await page.request.get('/api/v1/mail/accounts');
    expect(await list.text()).not.toContain(accountId);
    watched.expectClean();
    await watched.close();
  }
});

test('HP 390 px: daftar dan panel baca menu Email tanpa scroll horizontal', async ({ browser }) => {
  const watched = await openWatchedPage(browser, { hp: true, storageState: OWNER_STATE_PATH });
  const { page } = watched;
  try {
    await openApp(page, '/email');
    await expect(mailRow(page)).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalScroll(page);
    await mailRow(page).click();
    await expect(page.getByRole('heading', { name: SUBJECT })).toBeVisible();
    await expect(
      page
        .frameLocator(`iframe[title="Isi email: ${SUBJECT}"]`)
        .getByText('Nomor pelanggan 12345.'),
    ).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalScroll(page);
    watched.expectClean();
  } finally {
    await watched.close();
  }
});
