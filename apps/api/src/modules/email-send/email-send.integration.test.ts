/**
 * Tahap 9.1 — email lewat API (docs/KONTRAK-API-EMAIL-KIRIM.md): contoh kontrak A–H (§12), urutan
 * pemeriksaan tanpa data sampah (R1), idempotensi isi (409), SSRF/allowlist host lampiran, scope &
 * pengirim per key (PATCH berkonfirmasi), alias/replyTo, batas harian key, rem darurat, batal, balas
 * email masuk, template email (terbit berkonfirmasi + tautan/angka baru), riwayat tersamar.
 * Postgres + Redis sungguhan; lampiran URL dari server tiruan di 127.0.0.1.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  auditLogs,
  channels,
  contacts,
  conversations,
  emailOutbound,
  emailOutboundAttachments,
  messages,
  newId,
  organizations,
  outgoingEvents,
} from '@balesin/db';
import {
  API_ROUTES,
  apiKeyResponseSchema,
  apiPath,
  createApiKeyResponseSchema,
  emailOutboundListResponseSchema,
  emailSendResponseSchema,
  emailStatusResponseSchema,
  emailTemplateResponseSchema,
  errorEnvelopeSchema,
  maskEmailAddress,
  publicEmailSendersResponseSchema,
  publicEmailTemplatesResponseSchema,
  securitySummaryResponseSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { and, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const QRIS_VALID =
  '00020101021226680016ID.CO.CONTOH.WWW01189360000000000000010215ID10200000000010303UMI52044899530336054061850005802ID5911TOKO CONTOH6007JAKARTA61051234563045195';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let otherChannelId: string;
let senderId: string;
let fileServer: Server;
let fileBase: string;
let fileRequests = 0;

const api = (
  token: string | null,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  harness.app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

async function createKey(
  overrides: {
    scopes?: ApiKeyScope[];
    senders?: string[];
    hosts?: string[];
    dailySendLimit?: number;
  } = {},
) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: `billing ${newId().slice(-6)}`,
      scopes: overrides.scopes ?? ['email:send'],
      emailSenderIds: overrides.senders ?? [senderId],
      emailAttachmentHosts: overrides.hosts ?? ['127.0.0.1', 'billing.perusahaan.example'],
      ...(overrides.dailySendLimit ? { dailySendLimit: overrides.dailySendLimit } : {}),
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

function emailChannel(id: string, address: string, aliases: string[] = []) {
  return {
    id,
    organizationId,
    type: 'email' as const,
    name: `Billing ${address}`,
    emailAddress: address,
    emailFromName: 'Billing Perusahaan',
    emailImapHost: 'imap.perusahaan.example',
    emailImapPort: 993,
    emailImapSecurity: 'ssl',
    emailImapUsername: 'billing',
    emailImapPasswordEncrypted: 'x',
    emailImapFolder: 'INBOX',
    emailPollIntervalMinutes: 5,
    emailMarkAsRead: false,
    emailSmtpMode: 'custom',
    emailSmtpHost: 'smtp.perusahaan.example',
    emailSmtpPort: 465,
    emailSmtpSecurity: 'ssl',
    emailSmtpUsername: 'billing',
    emailSmtpPasswordEncrypted: 'x',
    emailAliases: aliases,
  };
}

async function publishPreset(presetKey: string): Promise<string> {
  const created = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.emailTemplates.fromPreset, { presetId: presetKey }),
    {},
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(created.statusCode, created.body).toBe(201);
  const template = emailTemplateResponseSchema.parse(created.json()).template;
  const published = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.emailTemplates.publish, { templateId: template.id }),
    { confirmation: await confirmationFor() },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(published.statusCode, published.body).toBe(200);
  return template.id;
}

const countRows = async () => {
  const [emails] = await harness.db
    .select({ total: count() })
    .from(emailOutbound)
    .where(eq(emailOutbound.organizationId, organizationId));
  const [people] = await harness.db
    .select({ total: count() })
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId));
  return { emails: emails?.total ?? 0, contacts: people?.total ?? 0 };
};

const reasonOf = (body: string) => errorEnvelopeSchema.parse(JSON.parse(body)).error.details?.[0];

const TEMPLATE_VARIABLES = {
  nama: 'Budi',
  id_pelanggan: 'PLG-00873',
  periode: 'November 2026',
  total: 'Rp185.000',
  bank_va: 'BRI',
  kode_va: '8808 0000 0000 0001',
  jatuh_tempo: '25 Nov 2026',
};

beforeAll(async () => {
  fileServer = createServer((request, response) => {
    fileRequests += 1;
    if (request.url === '/invoice.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(PDF);
      return;
    }
    if (request.url === '/redirect-luar') {
      response.writeHead(302, { location: 'http://127.0.0.2:9/x.pdf' });
      response.end();
      return;
    }
    if (request.url === '/program.exe') {
      response.writeHead(200);
      response.end(Buffer.from('MZ\x90\x00 program'));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => fileServer.listen(0, '127.0.0.1', resolve));
  fileBase = `http://127.0.0.1:${String((fileServer.address() as AddressInfo).port)}`;

  harness = await createIntegrationHarness({ overrides: { webhookAllowLoopback: true } });
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = '6b1f2c3d-0000-4000-8000-000000000001';
  otherChannelId = newId();
  senderId = `chn_${channelId}`;
  await harness.db
    .insert(channels)
    .values([
      emailChannel(channelId, 'billing@perusahaan.example', [
        'tagihan@perusahaan.example',
        'promo@domainlain.example',
      ]),
      emailChannel(otherChannelId, 'cs@perusahaan.example'),
    ]);
  await publishPreset('tagihan-bulanan');
  await publishPreset('pembayaran-diterima');
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await new Promise<void>((resolve) => fileServer.close(() => resolve()));
});

describe('kontrak §12 A–F', () => {
  it('A: template + QRIS + invoice URL + catat ke Inbox → 202; B: ulangan → 200; C: isi beda → 409', async () => {
    const { secret } = await createKey();
    const body = {
      senderId,
      to: [{ email: 'budi.santoso@contoh.example', name: 'Budi Santoso' }],
      bcc: [{ email: 'arsip@perusahaan.example' }],
      templateId: 'tagihan-bulanan',
      variables: TEMPLATE_VARIABLES,
      qris: { payload: QRIS_VALID },
      attachments: [{ filename: 'Invoice-INV-2611-0873.pdf', url: `${fileBase}/invoice.pdf` }],
      conversation: 'create',
      metadata: { invoice_id: 'INV-2611-0873' },
    };
    const headers = { 'idempotency-key': 'INV-2611-0873' };
    const first = await api(secret, 'POST', API_ROUTES.publicEmail.send, body, headers);
    expect(first.statusCode, first.body).toBe(202);
    const accepted = emailSendResponseSchema.parse(first.json());
    expect(accepted).toMatchObject({
      status: 'queued',
      senderId,
      recipientCount: 2,
      scheduledAt: null,
    });
    expect(accepted.conversationId).not.toBeNull();
    expect(accepted.messageId).not.toBeNull();

    const [row] = await harness.db
      .select()
      .from(emailOutbound)
      .where(eq(emailOutbound.id, accepted.id));
    expect(row).toMatchObject({
      status: 'queued',
      templateVersion: 1,
      metadata: { invoice_id: 'INV-2611-0873' },
      bcc: [{ email: 'arsip@perusahaan.example', name: null }],
    });
    expect(row?.html).toContain('cid:qris');
    // Variabel di-escape & terisi.
    expect(row?.html).toContain('PLG-00873');
    expect(row?.subject).toBe('Tagihan November 2026 — PLG-00873');
    const parts = await harness.db
      .select()
      .from(emailOutboundAttachments)
      .where(eq(emailOutboundAttachments.emailOutboundId, accepted.id));
    expect(parts.map((part) => part.source).sort()).toEqual(['qris', 'url']);
    expect(parts.find((part) => part.source === 'url')).toMatchObject({
      contentType: 'application/pdf',
      sourceHost: '127.0.0.1',
    });
    // Percakapan baru dari key = `resolved`; pesan Inbox `pending` ber-wamid Message-ID.
    const [conversation] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, accepted.conversationId!));
    expect(conversation?.status).toBe('resolved');
    const [message] = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.id, accepted.messageId!));
    expect(message).toMatchObject({ status: 'pending', senderKind: 'bot', direction: 'outbound' });
    expect(message?.wamid).toBe(row?.messageIdHeader);

    const replay = await api(secret, 'POST', API_ROUTES.publicEmail.send, body, headers);
    expect(replay.statusCode).toBe(200);
    expect(emailSendResponseSchema.parse(replay.json()).id).toBe(accepted.id);

    const changed = await api(
      secret,
      'POST',
      API_ROUTES.publicEmail.send,
      { ...body, variables: { ...TEMPLATE_VARIABLES, total: 'Rp190.000' } },
      headers,
    );
    expect(changed.statusCode).toBe(409);
    expect(reasonOf(changed.body)).toMatchObject({
      location: 'headers',
      field: 'Idempotency-Key',
      reason: 'idempotency_key_reused',
    });

    // Status: Bcc ada di status (untuk pemilik), webhook hanya bcc_count.
    const status = await api(
      secret,
      'GET',
      apiPath(API_ROUTES.publicEmail.message, { emailId: accepted.id }),
    );
    expect(status.statusCode).toBe(200);
    expect(emailStatusResponseSchema.parse(status.json()).email).toMatchObject({
      status: 'queued',
      template: { slug: 'tagihan-bulanan', version: 1 },
      idempotencyKey: 'INV-2611-0873',
      bcc: [{ email: 'arsip@perusahaan.example' }],
    });
  });

  it('D: CRC rusak → 400 qris_crc_mismatch tanpa baris baru; format salah → qris_invalid_format', async () => {
    const { secret } = await createKey();
    const before = await countRows();
    const response = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'baru.sekali@contoh.example' }],
      templateId: 'tagihan-bulanan',
      variables: TEMPLATE_VARIABLES,
      qris: { payload: `${QRIS_VALID.slice(0, -4)}5196` },
      conversation: 'create',
    });
    expect(response.statusCode).toBe(400);
    expect(reasonOf(response.body)).toMatchObject({
      location: 'body',
      field: 'qris.payload',
      reason: 'qris_crc_mismatch',
    });
    expect(await countRows()).toEqual(before);
    const format = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'baru.sekali@contoh.example' }],
      subject: 'Tes',
      text: 'Halo',
      qris: { payload: 'BUKAN-QRIS-SAMA-SEKALI-0000' },
    });
    expect(reasonOf(format.body)?.reason).toBe('qris_invalid_format');
  });

  it('E: host lampiran di luar allowlist → 403 tanpa permintaan HTTP; redirect ke host lain juga ditolak', async () => {
    const { secret } = await createKey({ hosts: ['127.0.0.1'] });
    const requests = fileRequests;
    const response = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Invoice',
      text: 'Terlampir.',
      attachments: [{ filename: 'x.pdf', url: 'https://unduh.lain.example/x.pdf' }],
    });
    expect(response.statusCode).toBe(403);
    expect(reasonOf(response.body)?.reason).toBe('attachment_host_not_allowed');
    expect(fileRequests).toBe(requests);

    const redirected = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Invoice',
      text: 'Terlampir.',
      attachments: [{ filename: 'x.pdf', url: `${fileBase}/redirect-luar` }],
    });
    expect(redirected.statusCode).toBe(403);
    expect(reasonOf(redirected.body)?.reason).toBe('attachment_host_not_allowed');

    const blocked = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Invoice',
      text: 'Terlampir.',
      attachments: [{ filename: 'invoice.pdf', url: `${fileBase}/program.exe` }],
    });
    expect(reasonOf(blocked.body)?.reason).toBe('attachment_type_blocked');
    const missing = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Invoice',
      text: 'Terlampir.',
      attachments: [{ filename: 'x.pdf', url: `${fileBase}/tidak-ada.pdf` }],
    });
    expect(reasonOf(missing.body)).toMatchObject({ reason: 'attachment_fetch_failed' });
    expect(reasonOf(missing.body)?.message).toContain('404');
    // Key tanpa allowlist host = lampiran URL selalu ditolak.
    const none = await createKey({ hosts: [] });
    const noHosts = await api(none.secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Invoice',
      text: 'Terlampir.',
      attachments: [{ filename: 'x.pdf', url: `${fileBase}/invoice.pdf` }],
    });
    expect(noHosts.statusCode).toBe(403);
  });

  it('F: HTML luar + gambar inline → 202, skrip dibuang (sanitized), versi teks otomatis', async () => {
    const { secret } = await createKey();
    const response = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Bukti pembayaran PLG-00412',
      html: '<p>Halo Sari,</p><p>Terima kasih, pembayaranmu sudah kami terima.</p><img src="cid:stempel" alt="Lunas"><script>alert(1)</script>',
      attachments: [
        {
          filename: 'stempel.png',
          contentBase64: PNG_1PX.toString('base64'),
          inline: true,
          cid: 'stempel',
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(202);
    const accepted = emailSendResponseSchema.parse(response.json());
    expect(accepted.sanitized).toBe(true);
    const [row] = await harness.db
      .select()
      .from(emailOutbound)
      .where(eq(emailOutbound.id, accepted.id));
    expect(row?.html).not.toContain('<script');
    expect(row?.html).toContain('cid:stempel');
    expect(row?.text).toContain('Halo Sari');
    expect(row?.conversationId).toBeNull();
    // `cid:` yang dirujuk tetapi tidak dikirim → 400 cid_missing.
    const missing = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Bukti',
      html: '<p>Scan</p><img src="cid:qris">',
    });
    expect(reasonOf(missing.body)?.reason).toBe('cid_missing');
  });
});

describe('aturan isian', () => {
  it('penerima, Reply-To, alias Dari, metadata, jadwal, isi, catat Inbox', async () => {
    const { secret } = await createKey();
    const base = { senderId, to: [{ email: 'sari@contoh.example' }], subject: 'Halo', text: 'Isi' };
    const cases: [Record<string, unknown>, string][] = [
      [{ cc: [{ email: 'bukan alamat' }] }, 'recipient_invalid'],
      [
        {
          to: Array.from({ length: 51 }, (_, index) => ({
            email: `orang${String(index)}@contoh.example`,
          })),
        },
        'too_many_recipients',
      ],
      [{ replyTo: 'balas@lain.example' }, 'reply_to_not_allowed'],
      [{ fromAddress: 'promo@domainlain.example' }, 'from_address_not_allowed'],
      [{ fromAddress: 'siapa@perusahaan.example' }, 'from_address_not_allowed'],
      [{ fromName: 'Bank <admin@bank.example>' }, 'from_name_invalid'],
      [{ metadata: { 'kunci tidak sah': 1 } }, 'metadata_invalid'],
      [{ scheduledAt: '2099-01-01T00:00:00Z' }, 'scheduled_at_invalid'],
      [{ templateId: 'tagihan-bulanan' }, 'content_conflict'],
      [{ subject: undefined, text: undefined }, 'content_missing'],
      [
        {
          to: [{ email: 'a@contoh.example' }, { email: 'b@contoh.example' }],
          conversation: 'create',
        },
        'conversation_requires_single_recipient',
      ],
      [{ attachments: [{ filename: 'a.txt' }] }, 'attachment_source_invalid'],
    ];
    for (const [patch, reason] of cases) {
      const response = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
        ...base,
        ...patch,
      });
      expect(response.statusCode, `${reason}: ${response.body}`).toBe(400);
      expect(reasonOf(response.body)?.reason, JSON.stringify(patch)).toBe(reason);
    }
    // Variabel wajib hilang → satu detail per variabel; kunci asing diabaikan.
    const missing = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      templateId: 'tagihan-bulanan',
      variables: { nama: 'Sari', tidak_dikenal: 'x' },
    });
    const details = errorEnvelopeSchema.parse(missing.json()).error.details ?? [];
    expect(details.map((item) => item.field).sort()).toEqual([
      'variables.id_pelanggan',
      'variables.jatuh_tempo',
      'variables.periode',
      'variables.total',
    ]);
    expect(details.every((item) => item.reason === 'template_variable_missing')).toBe(true);

    // Alias se-domain boleh; Reply-To se-domain boleh; dedup Kepada > Cc > Bcc.
    const ok = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      ...base,
      fromAddress: 'Tagihan@Perusahaan.example',
      replyTo: 'cs@perusahaan.example',
      cc: [{ email: 'SARI@contoh.example' }, { email: 'dewi@contoh.example' }],
      bcc: [{ email: 'dewi@contoh.example' }],
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(ok.statusCode, ok.body).toBe(202);
    const accepted = emailSendResponseSchema.parse(ok.json());
    expect(accepted).toMatchObject({ status: 'scheduled', recipientCount: 2 });
    const [row] = await harness.db
      .select()
      .from(emailOutbound)
      .where(eq(emailOutbound.id, accepted.id));
    expect(row).toMatchObject({
      fromAddress: 'tagihan@perusahaan.example',
      replyTo: 'cs@perusahaan.example',
      cc: [{ email: 'dewi@contoh.example', name: null }],
      bcc: [],
    });

    // Batal: scheduled → canceled; kedua kali → 409 not_cancelable.
    const cancel = await api(
      secret,
      'POST',
      apiPath(API_ROUTES.publicEmail.cancel, { emailId: accepted.id }),
    );
    expect(cancel.statusCode).toBe(200);
    expect(emailStatusResponseSchema.parse(cancel.json()).email.status).toBe('canceled');
    const again = await api(
      secret,
      'POST',
      apiPath(API_ROUTES.publicEmail.cancel, { emailId: accepted.id }),
    );
    expect(again.statusCode).toBe(409);
    expect(reasonOf(again.body)?.reason).toBe('not_cancelable');
  });
});

describe('scope, pengirim per key, batas', () => {
  it('scope email:read tidak bisa kirim; key tanpa scope email ditolak; pengirim lain → 403', async () => {
    const reader = await createKey({ scopes: ['email:read'], hosts: [] });
    const send = await api(reader.secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Halo',
      text: 'Isi',
    });
    expect(send.statusCode).toBe(403);
    const senders = await api(reader.secret, 'GET', API_ROUTES.publicEmail.senders);
    expect(senders.statusCode).toBe(200);
    const listed = publicEmailSendersResponseSchema.parse(senders.json()).senders;
    expect(listed).toHaveLength(1);
    // Alias "Dari" = alias se-domain saja.
    expect(listed[0]).toMatchObject({
      id: senderId,
      aliases: ['tagihan@perusahaan.example'],
      bounceTracking: true,
      replyToFixed: false,
      hourlyLimit: 100,
      state: 'ok',
    });
    const templates = await api(reader.secret, 'GET', API_ROUTES.publicEmail.templates);
    const list = publicEmailTemplatesResponseSchema.parse(templates.json()).templates;
    expect(list.map((item) => item.slug).sort()).toEqual([
      'pembayaran-diterima',
      'tagihan-bulanan',
    ]);
    expect(list.find((item) => item.slug === 'tagihan-bulanan')?.hasQrisSlot).toBe(true);
    expect(JSON.stringify(list)).not.toContain('<table');

    // `email:send` tidak membuka rute WhatsApp/percakapan.
    const sender = await createKey();
    const conversationsResponse = await api(
      sender.secret,
      'GET',
      API_ROUTES.publicApi.conversations,
    );
    expect(conversationsResponse.statusCode).toBe(403);

    const other = await api(sender.secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId: `chn_${otherChannelId}`,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Halo',
      text: 'Isi',
    });
    expect(other.statusCode).toBe(403);
    expect(reasonOf(other.body)?.reason).toBe('sender_not_allowed');
    // Akun Email (9B) / ID asal → 403 juga.
    const account = await api(sender.secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId: `acc_${newId()}`,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Halo',
      text: 'Isi',
    });
    expect(account.statusCode).toBe(403);
  });

  it('buat key email wajib pengirim; PATCH wajib konfirmasi, mengganti pengirim & audit api_key.updated', async () => {
    const missing = await call(
      harness.app,
      'POST',
      API_ROUTES.apiKeys.list,
      { name: 'tanpa pengirim', scopes: ['email:send'], confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(missing.statusCode).toBe(400);
    const nonEmail = await call(
      harness.app,
      'POST',
      API_ROUTES.apiKeys.list,
      {
        name: 'salah',
        scopes: ['contacts:read'],
        emailSenderIds: [senderId],
        confirmation: await confirmationFor(),
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(nonEmail.statusCode).toBe(400);

    const { apiKey, secret } = await createKey();
    expect(apiKey.emailSenders).toEqual([
      {
        id: senderId,
        kind: 'channel',
        name: 'Billing billing@perusahaan.example',
        address: 'billing@perusahaan.example',
      },
    ]);
    const path = apiPath(API_ROUTES.apiKeys.key, { apiKeyId: apiKey.id });
    const unconfirmed = await call(
      harness.app,
      'PATCH',
      path,
      { emailSenderIds: [`chn_${otherChannelId}`] },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(unconfirmed.statusCode).toBe(400);
    const updated = await call(
      harness.app,
      'PATCH',
      path,
      {
        emailSenderIds: [`chn_${otherChannelId}`],
        emailAttachmentHosts: ['*.Perusahaan.example'],
        confirmation: await confirmationFor(),
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(updated.statusCode, updated.body).toBe(200);
    expect(apiKeyResponseSchema.parse(updated.json()).apiKey).toMatchObject({
      emailAttachmentHosts: ['*.perusahaan.example'],
      emailSenders: [{ id: `chn_${otherChannelId}` }],
    });
    const blocked = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sari@contoh.example' }],
      subject: 'Halo',
      text: 'Isi',
    });
    expect(blocked.statusCode).toBe(403);
    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, 'api_key.updated')),
      );
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits.at(-1)?.metadata)).toContain('emailSenders');
    const summary = await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
      cookie: owner.cookie,
    });
    const events = securitySummaryResponseSchema.parse(summary.json()).events;
    expect(events.some((event) => event.kind === 'api_key_changed')).toBe(true);
  });

  it('batas harian key (pesan + email) → 429; rem darurat → 423; pengirim nonaktif → 409', async () => {
    const { secret } = await createKey({ dailySendLimit: 1 });
    const body = { senderId, to: [{ email: 'sari@contoh.example' }], subject: 'Halo', text: 'Isi' };
    expect((await api(secret, 'POST', API_ROUTES.publicEmail.send, body)).statusCode).toBe(202);
    const limited = await api(secret, 'POST', API_ROUTES.publicEmail.send, body);
    expect(limited.statusCode).toBe(429);

    const fresh = await createKey();
    await harness.db
      .update(organizations)
      .set({ sendingPausedAt: new Date() })
      .where(eq(organizations.id, organizationId));
    const paused = await api(fresh.secret, 'POST', API_ROUTES.publicEmail.send, body);
    expect(paused.statusCode).toBe(423);
    expect(errorEnvelopeSchema.parse(paused.json()).error.code).toBe('SENDING_PAUSED');
    await harness.db
      .update(organizations)
      .set({ sendingPausedAt: null })
      .where(eq(organizations.id, organizationId));

    await harness.db.update(channels).set({ enabled: false }).where(eq(channels.id, channelId));
    const disabled = await api(fresh.secret, 'POST', API_ROUTES.publicEmail.send, body);
    expect(disabled.statusCode).toBe(409);
    expect(reasonOf(disabled.body)?.reason).toBe('sender_disabled');
    await harness.db.update(channels).set({ enabled: true }).where(eq(channels.id, channelId));
  });
});

describe('balas email masuk (H)', () => {
  it('Kepada = kontak, In-Reply-To = Message-ID email masuk; Cc di luar utas → 400; SPF gagal → 409', async () => {
    const { secret } = await createKey();
    const [contact] = await harness.db
      .insert(contacts)
      .values({
        organizationId,
        channelType: 'email',
        externalUserId: 'budi.santoso@contoh.example',
        email: 'budi.santoso@contoh.example',
      })
      .onConflictDoNothing()
      .returning();
    const contactId =
      contact?.id ??
      (
        await harness.db
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.externalUserId, 'budi.santoso@contoh.example'))
      )[0]!.id;
    const [conversation] = await harness.db
      .insert(conversations)
      .values({
        organizationId,
        contactId,
        channelId,
        status: 'unserved',
        lastMessageAt: new Date(),
        lastInboundAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    const conversationId =
      conversation?.id ??
      (
        await harness.db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.contactId, contactId), eq(conversations.channelId, channelId)),
          )
      )[0]!.id;
    const inbound = async (verification: 'pass' | 'fail', wamid: string) => {
      const [row] = await harness.db
        .insert(messages)
        .values({
          organizationId,
          conversationId,
          contactId,
          channelId,
          direction: 'inbound',
          senderKind: 'customer',
          type: 'text',
          text: 'Sudah saya transfer',
          wamid,
          extras: {
            email: {
              subject: 'Tagihan November 2026',
              inReplyTo: null,
              references: ['awal@perusahaan.example'],
              authWarning: verification === 'fail',
              senderVerification: verification,
              skippedAttachments: 0,
              hasHtml: false,
              to: ['billing@perusahaan.example'],
              cc: ['istri.budi@contoh.example'],
            },
          },
          occurredAt: new Date(),
          receivedAt: new Date(),
        })
        .returning();
      return row!.id;
    };
    const messageId = await inbound('pass', `balasan-${newId()}@contoh.example`);
    const path = apiPath(API_ROUTES.publicEmail.reply, { emailId: messageId });
    const outsider = await api(secret, 'POST', path, {
      subject: 'Re',
      text: 'Terima kasih',
      cc: [{ email: 'orang.lain@contoh.example' }],
    });
    expect(reasonOf(outsider.body)?.reason).toBe('cc_not_in_thread');
    const response = await api(secret, 'POST', path, {
      templateId: 'pembayaran-diterima',
      variables: {
        nama: 'Budi',
        id_pelanggan: 'PLG-00873',
        periode: 'November 2026',
        total: 'Rp185.000',
        tanggal_bayar: '24 Nov 2026',
      },
      cc: [{ email: 'istri.budi@contoh.example' }],
    });
    expect(response.statusCode, response.body).toBe(202);
    const body = response.json<{ id: string; conversationId: string; messageId: string }>();
    expect(body.conversationId).toBe(conversationId);
    const [row] = await harness.db
      .select()
      .from(emailOutbound)
      .where(eq(emailOutbound.id, body.id));
    const [original] = await harness.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row).toMatchObject({
      inReplyTo: original?.wamid,
      references: ['awal@perusahaan.example', original?.wamid],
      to: [{ email: 'budi.santoso@contoh.example', name: null }],
      cc: [{ email: 'istri.budi@contoh.example', name: null }],
      replyToMessageId: messageId,
    });
    // Status percakapan tidak diubah.
    const [after] = await harness.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(after?.status).toBe('unserved');

    const spoofed = await inbound('fail', `palsu-${newId()}@contoh.example`);
    const denied = await api(
      secret,
      'POST',
      apiPath(API_ROUTES.publicEmail.reply, { emailId: spoofed }),
      {
        text: 'Halo',
      },
    );
    expect(denied.statusCode).toBe(409);
    expect(reasonOf(denied.body)?.reason).toBe('sender_verification_failed');
    // Pesan bukan email masuk / di luar pengirim key → 404.
    expect(
      (
        await api(secret, 'POST', apiPath(API_ROUTES.publicEmail.reply, { emailId: newId() }), {
          text: 'x',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('template email & riwayat', () => {
  it('terbit wajib konfirmasi; tautan/angka baru → email_template_risky; HTML berskrip → 400', async () => {
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.emailTemplates.list,
      {
        name: 'Promo',
        slug: 'promo-uji',
        draft: {
          subject: 'Halo {{nama}}',
          html: '<p>Halo {{nama}}</p>',
          variables: [{ name: 'nama', label: 'Nama', required: true, example: 'Budi' }],
          layout: 'brand',
        },
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(created.statusCode, created.body).toBe(201);
    const template = emailTemplateResponseSchema.parse(created.json()).template;
    const publishPath = apiPath(API_ROUTES.emailTemplates.publish, { templateId: template.id });
    expect(
      (await call(harness.app, 'POST', publishPath, {}, { cookie: owner.cookie, csrf: owner.csrf }))
        .statusCode,
    ).toBe(400);
    const first = await call(
      harness.app,
      'POST',
      publishPath,
      { confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(first.statusCode, first.body).toBe(200);
    const templatePath = apiPath(API_ROUTES.emailTemplates.template, { templateId: template.id });
    await call(
      harness.app,
      'PATCH',
      templatePath,
      {
        draft: {
          subject: 'Halo {{nama}}',
          html: '<p>Halo {{nama}}, transfer ke 1234567890123 lewat https://bayar.contoh.example</p>',
          variables: [{ name: 'nama', label: 'Nama', required: true, example: 'Budi' }],
          layout: 'brand',
        },
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    const risky = await call(
      harness.app,
      'POST',
      publishPath,
      { confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(risky.statusCode).toBe(200);
    expect(emailTemplateResponseSchema.parse(risky.json()).template.publishedVersion).toBe(2);
    const summary = await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
      cookie: owner.cookie,
    });
    expect(
      securitySummaryResponseSchema
        .parse(summary.json())
        .events.some((event) => event.kind === 'email_template_risky'),
    ).toBe(true);
    // Slug terkunci setelah terbit; skrip → 400 saat terbit (draf tetap tersimpan apa adanya).
    const slug = await call(
      harness.app,
      'PATCH',
      templatePath,
      { slug: 'promo-baru' },
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(slug.statusCode).toBe(400);
    await call(
      harness.app,
      'PATCH',
      templatePath,
      {
        draft: {
          subject: 'Halo',
          html: '<p>Halo</p><script>alert(1)</script>',
          variables: [],
          layout: 'none',
        },
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    const forbidden = await call(
      harness.app,
      'POST',
      publishPath,
      { confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(forbidden.statusCode).toBe(400);
    // Variabel di atribut selain href → 400.
    await call(
      harness.app,
      'PATCH',
      templatePath,
      {
        draft: {
          subject: 'Halo',
          html: '<p title="{{nama}}">Halo</p>',
          variables: [{ name: 'nama', label: 'Nama', required: true, example: 'Budi' }],
          layout: 'none',
        },
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(
      (
        await call(
          harness.app,
          'POST',
          publishPath,
          { confirmation: await confirmationFor() },
          { cookie: owner.cookie, csrf: owner.csrf },
        )
      ).statusCode,
    ).toBe(400);
  });

  it('kirim tes selalu ke alamat akun sendiri; riwayat API menyamarkan penerima', async () => {
    const [template] = await harness.db
      .select({ id: emailOutbound.templateId })
      .from(emailOutbound)
      .where(eq(emailOutbound.organizationId, organizationId))
      .limit(1);
    const test = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.emailTemplates.test, { templateId: template!.id! }),
      { senderId, which: 'published' },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(test.statusCode, test.body).toBe(202);
    const email = test.json<{
      email: { to: { email: string }[]; subject: string; source: string };
    }>().email;
    expect(email.to).toEqual([
      expect.objectContaining({ email: owner.session.user.email.toLowerCase() }),
    ]);
    expect(email.subject.startsWith('[Tes] ')).toBe(true);
    expect(email.source).toBe('test');

    const history = await call(harness.app, 'GET', API_ROUTES.emailOutbound.list, undefined, {
      cookie: owner.cookie,
    });
    expect(history.statusCode).toBe(200);
    const emails = emailOutboundListResponseSchema.parse(history.json()).emails;
    expect(emails.length).toBeGreaterThan(0);
    const all = JSON.stringify(emails);
    expect(all).not.toContain('budi.santoso@contoh.example');
    expect(all).not.toContain('arsip@perusahaan.example');
    expect(all).toContain('bu***@co***.example');
  });
});

describe('hapus kontak (UU PDP) × email API', () => {
  it('isi dipangkas, penerima disamarkan, lampiran & outbox dibuang, antrean dibatalkan; baris tetap ada', async () => {
    const { secret } = await createKey();
    const address = `pdp-${newId().slice(-8)}@contoh.example`;
    const created = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: address, name: 'Rina Pelanggan' }],
      subject: 'Tagihan Rina',
      html: '<p>Halo Rina, VA 8808000000000001</p>',
      attachments: [{ filename: 'Invoice-Rina.pdf', contentBase64: PDF.toString('base64') }],
      conversation: 'create',
      metadata: { pelanggan: 'Rina' },
    });
    expect(created.statusCode, created.body).toBe(202);
    const first = emailSendResponseSchema.parse(created.json());
    // Email lain tanpa catat Inbox, alamat itu di Cc (tetap ikut disamarkan).
    const copy = await api(secret, 'POST', API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'orang.lain@contoh.example' }],
      cc: [{ email: address }],
      subject: 'Tembusan Rina',
      text: 'Halo',
    });
    const second = emailSendResponseSchema.parse(copy.json());
    const [message] = await harness.db
      .select({ contactId: messages.contactId })
      .from(messages)
      .where(eq(messages.id, first.messageId!));
    const before = await countRows();

    const response = await call(
      harness.app,
      'DELETE',
      apiPath(API_ROUTES.inbox.contact, { contactId: message!.contactId }),
      { confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(response.statusCode, response.body).toBe(200);

    const rows = await harness.db
      .select()
      .from(emailOutbound)
      .where(inArray(emailOutbound.id, [first.id, second.id]));
    expect(rows).toHaveLength(2);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(address);
    expect(dump).not.toContain('Rina');
    expect(dump).not.toContain('8808000000000001');
    for (const row of rows) {
      expect(row).toMatchObject({
        subject: '(dihapus)',
        html: null,
        text: null,
        metadata: null,
        contactId: null,
        status: 'canceled',
      });
      expect(row.bodyPurgedAt).not.toBeNull();
    }
    expect(rows.find((row) => row.id === first.id)?.to).toEqual([
      { email: maskEmailAddress(address), name: null },
    ]);
    const parts = await harness.db
      .select()
      .from(emailOutboundAttachments)
      .where(eq(emailOutboundAttachments.emailOutboundId, first.id));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ storageKey: null, filename: 'lampiran-dihapus' });
    const events = await harness.db
      .select()
      .from(outgoingEvents)
      .where(inArray(outgoingEvents.emailOutboundId, [first.id, second.id]));
    expect(events).toHaveLength(0);
    // Hitungan email tetap (batas harian & laporan tidak berubah); hanya kontaknya yang hilang.
    const after = await countRows();
    expect(after.emails).toBe(before.emails);
    expect(after.contacts).toBe(before.contacts - 1);
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, 'contact.deleted')),
      );
    expect(audit?.metadata).toMatchObject({ emailOutbound: 2 });
    // Status lewat API tetap bisa dibaca (tanpa data pribadi).
    const status = await api(
      secret,
      'GET',
      apiPath(API_ROUTES.publicEmail.message, { emailId: first.id }),
    );
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.json())).not.toContain(address);
  });
});
