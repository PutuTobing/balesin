import { randomInt } from 'node:crypto';
import { request, type APIRequestContext } from '@playwright/test';
import { E2E_API_URL, MAILPIT_API_URL } from '../stack/env';
import { FAKE_IMAP, deliverFakeEmail, fakeChannelsInfo } from '../stack/fake-channels-data';
import { expect, openApp, test } from './fixtures';
import { confirmAsOwner } from './identitas';
import { conversationRow, ownerApi, signIn, type OwnerApi } from './inbox-bantu';
import { createUser, e2eSql, userId } from './pengguna';

/**
 * Tahap 9.0 (Channel Email di Inbox) + tes kontrak ringan 9.1 (API kirim email) melawan stack E2E:
 * IMAP TIRUAN (`stack/fake-channels-server.ts`) untuk email masuk, Mailpit untuk email keluar (SMTP
 * `system` = Pengaturan → Email pengirim yang diatur `email-pengirim.spec.ts`).
 *
 * Proyek `berurutan` (satu per satu): kotak masuk IMAP tiruan hanya SATU dan dipakai bersama semua
 * channel Email organisasi, jadi selama tes ini channel Email lain (mis. dari `channel-lain.spec.ts`)
 * dinonaktifkan supaya email tiruan tidak ikut diambil channel lain, lalu diaktifkan lagi. Akses per
 * channel mengubah pengaturan channel yang dilihat CS.
 */

const CONNECTIONS = '/api/v1/settings/channel-connections';

interface EmailChannelView {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  mailbox?: { lastPolledAt: string | null };
}

interface MailpitAddress {
  Address: string;
  Name: string;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

interface MailpitDetail {
  ID: string;
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Cc: MailpitAddress[] | null;
  Bcc: MailpitAddress[] | null;
  ReplyTo: MailpitAddress[] | null;
  HTML: string;
  Text: string;
  Inline: { ContentID: string; ContentType: string; FileName: string }[];
}

async function mailpit<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_API_URL}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path} menjawab ${response.status}`);
  return (await response.json()) as T;
}

/** Email di Mailpit yang subjeknya memuat `text` (unik per run), terbaru dulu. */
async function mailsWithSubject(text: string): Promise<MailpitSummary[]> {
  const query = encodeURIComponent(`subject:"${text}"`);
  return (await mailpit<{ messages: MailpitSummary[] }>(`/api/v1/search?query=${query}`)).messages;
}

/** Header yang ditambahkan Mailpit (server penerima) di atas header pengirim. */
const RECEIVER_HEADERS = new Set(['bcc', 'return-path', 'received']);

/**
 * Bagian email mentah yang berasal dari pengirim: header teratas yang ditambahkan Mailpit saat
 * menerima (`Bcc`, `Return-Path`, `Received`) dibuang sampai header pertama milik pengirim.
 */
function sentPart(raw: string): { headerNames: string[]; text: string } {
  const lines = raw.split(/\r?\n/);
  let start = 0;
  while (start < lines.length) {
    const name = /^([A-Za-z0-9-]+):/.exec(lines[start] ?? '')?.[1]?.toLowerCase();
    if (!name || !RECEIVER_HEADERS.has(name)) break;
    start += 1;
    while (/^[ \t]/.test(lines[start] ?? '')) start += 1; // baris lanjutan (header terlipat)
  }
  const rest = lines.slice(start);
  const blank = rest.indexOf('');
  const headerNames = rest
    .slice(0, blank === -1 ? rest.length : blank)
    .map((line) => /^([A-Za-z0-9-]+):/.exec(line)?.[1]?.toLowerCase())
    .filter((name): name is string => name !== undefined);
  return { headerNames, text: rest.join('\n') };
}

const addresses = (list: MailpitAddress[] | null | undefined) =>
  (list ?? []).map((item) => item.Address.toLowerCase());

async function ownerGet<T>(owner: OwnerApi, path: string): Promise<T> {
  const response = await owner.api.get(path);
  if (!response.ok())
    throw new Error(`GET ${path} (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function ownerPost<T>(owner: OwnerApi, path: string, data?: unknown): Promise<T> {
  const response = await owner.api.post(path, {
    headers: { 'x-csrf-token': owner.csrf },
    ...(data === undefined ? {} : { data }),
  });
  if (!response.ok()) {
    throw new Error(`POST ${path} (${response.status()}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * Nonaktifkan channel Email organisasi yang sedang aktif (kotak masuk tiruan dipakai bersama);
 * mengembalikan ID-nya untuk diaktifkan lagi.
 */
async function pauseOtherEmailChannels(owner: OwnerApi): Promise<string[]> {
  const { channels } = await ownerGet<{ channels: EmailChannelView[] }>(owner, CONNECTIONS);
  const active = channels.filter((channel) => channel.type === 'email' && channel.enabled);
  for (const channel of active) await ownerPost(owner, `${CONNECTIONS}/${channel.id}/disable`);
  return active.map((channel) => channel.id);
}

/** Channel Email baru (IMAP tiruan, SMTP sistem = Mailpit) + tunggu putaran pertama worker. */
async function createEmailChannel(
  owner: OwnerApi,
  { name, address, aliases }: { name: string; address: string; aliases: string[] },
): Promise<string> {
  const { imapPort } = await fakeChannelsInfo();
  const { channel } = await ownerPost<{ channel: EmailChannelView }>(owner, CONNECTIONS, {
    type: 'email',
    name,
    emailAddress: address,
    fromName: 'CS Maju Jaya',
    imap: {
      host: FAKE_IMAP.host,
      port: imapPort,
      security: FAKE_IMAP.security,
      username: FAKE_IMAP.username,
      password: FAKE_IMAP.password,
      folder: FAKE_IMAP.folder,
    },
    pollIntervalMinutes: 1,
    smtp: { mode: 'system' },
    aliases,
    confirmation: owner.confirm(),
  });
  // Putaran pertama hanya mencatat posisi kotak masuk (email lama dilewati): tunggu itu dulu.
  await expect
    .poll(
      async () =>
        (await ownerGet<{ channel: EmailChannelView }>(owner, `${CONNECTIONS}/${channel.id}`))
          .channel.mailbox?.lastPolledAt ?? null,
      { timeout: 150_000, intervals: [3_000], message: 'putaran pertama kotak masuk' },
    )
    .not.toBeNull();
  return channel.id;
}

async function conversationOf(channelId: string): Promise<string> {
  let id = '';
  await expect
    .poll(
      async () => {
        const rows = await e2eSql<{ id: string }>(
          'select id from conversations where channel_id = $1 order by created_at desc limit 1',
          [channelId],
        );
        id = rows[0]?.id ?? '';
        return id;
      },
      { timeout: 150_000, intervals: [3_000], message: 'percakapan email dibuat worker' },
    )
    .not.toBe('');
  return id;
}

test('Email 9.0: Kepada/Cc & "Dikirim ke", Balas semua + Bcc ke Mailpit, izin alamat baru, akses per channel', async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  const suffix = String(randomInt(10_000, 99_999));
  const channelName = `Email Cc E2E ${suffix}`;
  const channelAddress = `cs-cc-${suffix}@majujaya.test`;
  const alias = `tagihan-${suffix}@majujaya.test`;
  const customerName = `Rudi Cc ${suffix}`;
  const customer = `rudi.cc${suffix}@pelanggan.test`;
  const colleague = `andi.cc${suffix}@pelanggan.test`;
  const archive = `arsip.cc${suffix}@arsip.test`;
  const stranger = `baru.cc${suffix}@lain.test`;
  const subject = `Tagihan ganda Cc ${suffix}`;

  const owner = await ownerApi();
  const paused = await pauseOtherEmailChannels(owner);
  let channelId = '';
  try {
    const { department } = await ownerPost<{ department: { id: string; name: string } }>(
      owner,
      '/api/v1/settings/departments',
      { name: `Tagihan Cc ${suffix}` },
    );
    channelId = await createEmailChannel(owner, {
      name: channelName,
      address: channelAddress,
      aliases: [alias],
    });

    // Email masuk ke ALIAS dengan Cc rekan pelanggan; pengirim terverifikasi oleh server penerima
    // tepercaya (authserv-id = host IMAP), jadi alamat Cc-nya dianggap "sudah ada di utas".
    await deliverFakeEmail(
      [
        `Authentication-Results: ${FAKE_IMAP.host}; dmarc=pass header.from=pelanggan.test`,
        `Delivered-To: ${alias}`,
        `From: "${customerName}" <${customer}>`,
        `To: ${alias}`,
        `Cc: "Andi" <${colleague}>`,
        `Subject: ${subject}`,
        `Message-ID: <e2e-cc-${suffix}@pelanggan.test>`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Tagihan bulan ini tertagih dua kali, mohon dicek.',
        '',
      ].join('\r\n'),
    );
    const conversationId = await conversationOf(channelId);

    // ── Owner (desktop): kepala email masuk ────────────────────────────────────────────────
    await openApp(page, `/inbox?chat=${conversationId}`);
    const room = page.getByRole('region', { name: 'Ruang chat' });
    await expect(room.getByText('Tagihan bulan ini tertagih dua kali, mohon dicek.')).toBeVisible();
    const recipients = room.locator('dl[aria-label="Penerima email"]').first();
    await expect(recipients).toBeVisible();
    await expect(recipients.locator('dt', { hasText: 'Kepada' })).toBeVisible();
    await expect(recipients).toContainText(alias);
    await expect(recipients.locator('dt', { hasText: /^Cc$/ })).toBeVisible();
    await expect(recipients).toContainText(colleague);
    await expect(room.getByText('Dikirim ke', { exact: false }).first()).toContainText(alias);

    // ── Owner: Balas semua (Cc rekan) + Bcc alamat baru → Mailpit ──────────────────────────
    const claim = room.getByRole('button', { name: 'Ambil chat' });
    if (await claim.isVisible()) await claim.click();
    await room.getByRole('button', { name: /^Balas semua/ }).click();
    const ccField = room.getByRole('textbox', { name: 'Alamat Cc', exact: true });
    await expect(ccField).toBeVisible();
    // Balas semua: Cc = penerima email masuk terakhir tanpa alamat/alias channel & pengirim.
    await expect(room.getByRole('list', { name: 'Alamat Cc' })).toContainText(colleague);
    await expect(room.getByRole('list', { name: 'Alamat Cc' })).not.toContainText(alias);
    const bccField = room.getByRole('textbox', { name: 'Alamat Bcc', exact: true });
    await bccField.fill(archive);
    await bccField.press('Enter');
    await expect(room.getByRole('list', { name: 'Alamat Bcc' })).toContainText(archive);
    await expect(room.getByText('Satu alamat baru di utas ini.', { exact: false })).toBeVisible();
    const reply = `Sudah kami koreksi, maaf ya ${suffix}.`;
    await room.getByRole('textbox', { name: 'Tulis balasan' }).fill(reply);
    await room.getByRole('button', { name: 'Kirim', exact: true }).click();
    await expect(room.getByText(reply)).toBeVisible();

    let mailId = '';
    await expect
      .poll(
        async () => {
          mailId = (await mailsWithSubject(subject))[0]?.ID ?? '';
          return mailId;
        },
        { timeout: 90_000, intervals: [2_000], message: 'balasan tiba di Mailpit' },
      )
      .not.toBe('');
    const mail = await mailpit<MailpitDetail>(`/api/v1/message/${mailId}`);
    expect(mail.Subject).toBe(`Re: ${subject}`);
    expect(addresses(mail.To)).toEqual([customer]);
    expect(addresses(mail.Cc)).toEqual([colleague]);
    // Bcc hanya amplop SMTP: Mailpit mencatatnya sebagai penerima amplop di luar header.
    expect(addresses(mail.Bcc)).toEqual([archive]);
    expect(addresses(mail.ReplyTo)).toContain(channelAddress);
    // MIME yang DIKIRIM Balesin tidak memuat Bcc. Mailpit sendiri menyisipkan `Bcc:` (penerima
    // amplop), `Return-Path:`, dan `Received:` di ATAS header pengirim saat menerima — buang dulu.
    const raw = await (await fetch(`${MAILPIT_API_URL}/api/v1/message/${mailId}/raw`)).text();
    const sent = sentPart(raw);
    expect(sent.headerNames).toContain('from');
    expect(sent.headerNames).not.toContain('bcc');
    expect(sent.text.toLowerCase()).not.toContain(archive);

    // ── CS (HP): menambah alamat BARU = butuh izin memulai percakapan → ditolak ────────────
    const cs = await createUser('cs', 'email-cc');
    const csId = await userId(cs.email);
    await e2eSql(
      `update conversations set assignee_user_id = $1, status = 'served' where id = $2`,
      [csId, conversationId],
    );
    const csPage = await signIn(browser, cs, true);
    try {
      const sendPath = `/api/v1/conversations/${conversationId}/messages`;
      csPage.allow(sendPath, 403);
      await csPage.page.goto(`/inbox?chat=${conversationId}`);
      const csRoom = csPage.page.getByRole('region', { name: 'Ruang chat' });
      await expect(csRoom.getByText(reply)).toBeVisible();
      await csRoom.getByRole('button', { name: 'Tambah Cc atau Bcc' }).click();
      const csCc = csRoom.getByRole('textbox', { name: 'Alamat Cc', exact: true });
      await csCc.fill(stranger);
      await csCc.press('Enter');
      await expect(csRoom.getByText('Alamat baru butuh izin memulai percakapan')).toBeVisible();
      await csRoom.getByRole('textbox', { name: 'Tulis balasan' }).fill('Kami tembuskan ke tim.');
      await csRoom.getByRole('button', { name: 'Kirim', exact: true }).click();
      await expect(
        csRoom.getByText('Ada alamat Cc/Bcc yang belum pernah ada di utas email ini.', {
          exact: false,
        }),
      ).toBeVisible();
      const denied = await e2eSql<{ count: string }>(
        `select count(*)::text as count from audit_logs
         where action = 'auth.access.denied' and actor_user_id = $1`,
        [csId],
      );
      expect(Number(denied[0]?.count ?? 0)).toBeGreaterThan(0);

      // ── Akses per channel: Owner membatasi ke departemen lain → CS tidak melihat apa pun ──
      await csPage.page.goto('/inbox');
      const csSearch = csPage.page.getByRole('searchbox', { name: 'Cari chat' });
      await csSearch.fill(customerName);
      await expect(conversationRow(csPage.page, customerName).first()).toBeVisible();

      await openApp(page, `/pengaturan/channel/lain/${channelId}`);
      const accessCard = page.getByRole('region', { name: 'Akses tim' });
      await accessCard
        .getByRole('radio', { name: /Hanya departemen atau pengguna tertentu/ })
        .click();
      await accessCard.getByRole('checkbox', { name: new RegExp(department.name) }).check();
      await accessCard.getByRole('button', { name: 'Simpan akses' }).click();
      // Mempersempit tidak butuh konfirmasi; percakapan yang dipegang CS kembali ke antrian.
      await expect(
        accessCard.getByText(
          /^Akses tim disimpan\..*1 percakapan yang dipegang anggota tanpa akses dikembalikan ke antrian\.$/,
        ),
      ).toBeVisible();

      // Real-time (resync): baris hilang dari daftar CS tanpa muat ulang.
      await expect(conversationRow(csPage.page, customerName)).toHaveCount(0, { timeout: 20_000 });
      // Cari ulang & URL langsung = tidak ditemukan.
      await csPage.page.reload();
      await csSearch.fill(customerName);
      await expect(
        csPage.page.getByRole('heading', { name: new RegExp(`Tidak ketemu chat untuk`) }),
      ).toBeVisible();
      for (const path of [
        `/api/v1/conversations/${conversationId}`,
        `/api/v1/conversations/${conversationId}/messages`,
        `/api/v1/conversations/${conversationId}/notes`,
        `/api/v1/conversations/${conversationId}/events`,
        `/api/v1/conversations/${conversationId}/read`,
      ]) {
        csPage.allow(path, 404);
      }
      await csPage.page.goto(`/inbox?chat=${conversationId}`);
      await expect(
        csPage.page.getByRole('heading', { name: 'Chat tidak ditemukan' }),
      ).toBeVisible();
      await expect(csPage.page.getByText(reply)).toHaveCount(0);

      // ── Kembali ke "Semua tim" (melonggarkan) = konfirmasi identitas ──────────────────────
      await accessCard.getByRole('radio', { name: /Semua tim/ }).click();
      await accessCard.getByRole('button', { name: 'Simpan akses' }).click();
      await confirmAsOwner(page, 'Konfirmasi perluas akses', 'Simpan akses');
      await expect(accessCard.getByText(/^Akses tim disimpan\./)).toBeVisible();

      await csPage.page.goto('/inbox');
      await expect(async () => {
        await csSearch.fill('');
        await csSearch.fill(customerName);
        await expect(conversationRow(csPage.page, customerName).first()).toBeVisible({
          timeout: 5_000,
        });
      }).toPass({ timeout: 30_000 });

      // Tembusan yang ditolak tidak pernah terkirim.
      expect(await mailsWithSubject(stranger)).toEqual([]);
      const strangerMail = await mailpit<{ messages: MailpitSummary[] }>(
        `/api/v1/search?query=${encodeURIComponent(`to:"${stranger}"`)}`,
      );
      expect(strangerMail.messages).toEqual([]);
      csPage.expectClean();
    } finally {
      await csPage.close();
    }
  } finally {
    if (channelId) await ownerPost(owner, `${CONNECTIONS}/${channelId}/disable`).catch(() => {});
    for (const id of paused) await ownerPost(owner, `${CONNECTIONS}/${id}/enable`).catch(() => {});
    await owner.api.dispose();
  }
});

/** Payload QRIS contoh kontrak (§12 A, CRC `5195` valid). Data fiktif. */
const QRIS_PAYLOAD =
  '00020101021226680016ID.CO.CONTOH.WWW01189360000000000000010215ID10200000000010303UMI52044899530336054061850005802ID5911TOKO CONTOH6007JAKARTA61051234563045195';

test('API 9.1: key email:send terbatas ke channel Email, template preset + QRIS → Mailpit; Idempotency-Key tidak dobel', async () => {
  test.setTimeout(300_000);
  const suffix = String(randomInt(10_000, 99_999));
  const owner = await ownerApi();
  const paused = await pauseOtherEmailChannels(owner);
  let channelId = '';
  let publicApi: APIRequestContext | null = null;
  try {
    channelId = await createEmailChannel(owner, {
      name: `Email API E2E ${suffix}`,
      address: `billing-${suffix}@majujaya.test`,
      aliases: [],
    });
    // Template dari preset ISP, lalu diterbitkan (konfirmasi identitas).
    const slug = `tagihan-e2e-${suffix}`;
    const { template } = await ownerPost<{ template: { id: string; slug: string } }>(
      owner,
      '/api/v1/settings/email-templates/presets/tagihan-bulanan',
      { name: `Tagihan E2E ${suffix}`, slug },
    );
    await ownerPost(owner, `/api/v1/settings/email-templates/${template.id}/publish`, {
      confirmation: owner.confirm(),
    });
    const senderId = `chn_${channelId}`;
    const { secret, apiKey } = await ownerPost<{ secret: string; apiKey: { id: string } }>(
      owner,
      '/api/v1/settings/api-keys',
      {
        name: `Billing E2E ${suffix}`,
        scopes: ['email:send'],
        emailSenderIds: [senderId],
        confirmation: owner.confirm(),
      },
    );
    expect(apiKey.id).toBeTruthy();

    publicApi = await request.newContext({
      baseURL: E2E_API_URL,
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { authorization: `Bearer ${secret}` },
    });
    const senders = (await (await publicApi.get('/api/v1/public/email/senders')).json()) as {
      senders: { id: string }[];
    };
    expect(senders.senders.map((sender) => sender.id)).toEqual([senderId]);

    const recipient = `budi.api${suffix}@pelanggan.test`;
    const body = {
      senderId,
      to: [{ email: recipient, name: 'Budi Santoso' }],
      templateId: slug,
      variables: {
        nama: 'Budi',
        id_pelanggan: `PLG-${suffix}`,
        periode: 'November 2026',
        total: 'Rp185.000',
        jatuh_tempo: '25 Nov 2026',
      },
      qris: { payload: QRIS_PAYLOAD },
      metadata: { invoice_id: `INV-${suffix}` },
    };
    const headers = { 'idempotency-key': `INV-${suffix}` };
    const first = await publicApi.post('/api/v1/public/email/send', { data: body, headers });
    expect(first.status(), await first.text()).toBe(202);
    const created = (await first.json()) as { id: string; status: string };
    expect(created.status).toBe('queued');

    // Pengirim di luar daftar key → 403 (tanpa membuat email).
    const otherSender = await publicApi.post('/api/v1/public/email/send', {
      data: { ...body, senderId: 'chn_00000000-0000-4000-8000-000000000001' },
    });
    expect(otherSender.status()).toBe(403);

    // Ulangan persis dengan kunci sama → 200, ID sama.
    const again = await publicApi.post('/api/v1/public/email/send', { data: body, headers });
    expect(again.status()).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(created.id);
    // Kunci sama, isi beda → 409.
    const conflict = await publicApi.post('/api/v1/public/email/send', {
      data: { ...body, variables: { ...body.variables, total: 'Rp200.000' } },
      headers,
    });
    expect(conflict.status()).toBe(409);

    const subjectText = `PLG-${suffix}`;
    await expect
      .poll(async () => (await mailsWithSubject(subjectText)).length, {
        timeout: 90_000,
        intervals: [2_000],
        message: 'email API tiba di Mailpit',
      })
      .toBe(1);
    const [summary] = await mailsWithSubject(subjectText);
    const mail = await mailpit<MailpitDetail>(`/api/v1/message/${summary!.ID}`);
    expect(addresses(mail.To)).toEqual([recipient]);
    expect(mail.Subject).toContain('November 2026');
    expect(mail.HTML).toContain('cid:qris');
    const qr = mail.Inline.find((part) => part.ContentID.replace(/[<>]/g, '') === 'qris');
    expect(qr?.ContentType).toBe('image/png');
    // Payload QRIS tidak pernah tertulis di isi email (hanya gambar).
    expect(mail.HTML).not.toContain(QRIS_PAYLOAD);

    const status = await publicApi.get(`/api/v1/public/email/messages/${created.id}`);
    expect(status.ok()).toBe(true);
    const statusBody = (await status.json()) as {
      email: { status: string; metadata?: Record<string, unknown> };
    };
    expect(['sent', 'delivered']).toContain(statusBody.email.status);
    expect(statusBody.email.metadata).toEqual({ invoice_id: `INV-${suffix}` });

    // Tunggu sebentar: tetap satu email (worker tidak mengirim ulang ulangan idempoten).
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect((await mailsWithSubject(subjectText)).length).toBe(1);
  } finally {
    await publicApi?.dispose();
    if (channelId) await ownerPost(owner, `${CONNECTIONS}/${channelId}/disable`).catch(() => {});
    for (const id of paused) await ownerPost(owner, `${CONNECTIONS}/${id}/enable`).catch(() => {});
    await owner.api.dispose();
  }
});
