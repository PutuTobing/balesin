/**
 * Review keamanan tahap 9.1 — API kirim email untuk n8n/billing
 * (docs/security-reviews/2026-11-22-fase9-1.md).
 *
 * `it` = regresi (perilaku yang sudah benar). `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN;
 * gagal sekarang). Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 * Postgres + Redis sungguhan; SMTP tidak dipanggil (email hanya diantrekan).
 */
import { channels, emailOutbound, newId } from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  createApiKeyResponseSchema,
  emailAttachmentHostAllowed,
  emailTemplateResponseSchema,
  errorEnvelopeSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let senderId: string;

const api = (token: string, url: string, body: unknown) =>
  harness.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

async function createKey(overrides: { scopes?: ApiKeyScope[]; dailySendLimit?: number } = {}) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: `review ${newId().slice(-6)}`,
      scopes: overrides.scopes ?? ['email:send'],
      emailSenderIds: [senderId],
      ...(overrides.dailySendLimit ? { dailySendLimit: overrides.dailySendLimit } : {}),
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

const reasonOf = (body: string) => errorEnvelopeSchema.parse(JSON.parse(body)).error.details?.[0];

beforeAll(async () => {
  harness = await createIntegrationHarness();
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = newId();
  senderId = `chn_${channelId}`;
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'email',
    name: 'Billing',
    emailAddress: 'billing@review91.example',
    emailFromName: 'Billing',
    emailImapHost: 'imap.review91.example',
    emailImapPort: 993,
    emailImapSecurity: 'ssl',
    emailImapUsername: 'billing',
    emailImapPasswordEncrypted: 'x',
    emailImapFolder: 'INBOX',
    emailPollIntervalMinutes: 5,
    emailMarkAsRead: false,
    emailSmtpMode: 'custom',
    emailSmtpHost: 'smtp.review91.example',
    emailSmtpPort: 465,
    emailSmtpSecurity: 'ssl',
    emailSmtpUsername: 'billing',
    emailSmtpPasswordEncrypted: 'x',
    emailAliases: [],
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('S1 (Tinggi) — ReDoS sanitasi HTML keluar lewat POST /public/email/send', () => {
  it('HTML ~2,5 KB dengan href "{{" + spasi tidak menahan api > 1 dtk', async () => {
    const { secret } = await createKey();
    const started = performance.now();
    const response = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'pelanggan@contoh.example' }],
      subject: 'Tagihan',
      html: `<p>Halo</p><a href="{{${' '.repeat(2_500)}x">bayar</a>`,
    });
    const took = performance.now() - started;
    // Selama celah ada, event loop api beku beberapa detik (dan berpuluh menit untuk 20 KB).
    expect(response.statusCode).toBe(202);
    expect(took).toBeLessThan(1_000);
  }, 120_000);
});

describe('Putaran 2 S3 (Tinggi) — sarang tag dalam lewat POST /public/email/send', () => {
  // sanitize-html super-linear terhadap kedalaman tag: render (2×) + sanitasi profil masuk di
  // `persist` (conversation: "create"). 40.000 `<div>` (~200 KB) ≈ 5–8 dtk event loop beku; 512 KB ≈
  // ±40 dtk, dan bisa diulang beruntun. Perbaikan boleh menolak (400) atau memproses cepat.
  it('HTML 40.000 <div> bersarang dijawab < 2 dtk (202 atau 400)', async () => {
    const { secret } = await createKey();
    const started = performance.now();
    const response = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sarang@contoh.example' }],
      subject: 'Tagihan',
      html: '<div>'.repeat(40_000),
      conversation: 'create',
    });
    const took = performance.now() - started;
    expect([202, 400]).toContain(response.statusCode);
    expect(took).toBeLessThan(2_000);
  }, 180_000);
});

describe('S3 diperbaiki — html_too_complex (400) cepat di semua jalur API, HTML wajar tetap jalan', () => {
  const deep512 = '<div>'.repeat(Math.floor((512 * 1024) / 5));

  it('POST /public/email/send: HTML 512 KB bersarang → 400 html_too_complex < 2 dtk, tanpa baris email', async () => {
    const { secret } = await createKey();
    const before = await harness.db
      .select({ id: emailOutbound.id })
      .from(emailOutbound)
      .where(eq(emailOutbound.organizationId, organizationId));
    const started = performance.now();
    const response = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'sarang@contoh.example' }],
      subject: 'Tagihan',
      html: deep512,
      conversation: 'create',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(response.statusCode).toBe(400);
    expect(reasonOf(response.body)).toMatchObject({ field: 'html', reason: 'html_too_complex' });
    expect(reasonOf(response.body)?.message).toContain('terlalu rumit');
    const after = await harness.db
      .select({ id: emailOutbound.id })
      .from(emailOutbound)
      .where(eq(emailOutbound.organizationId, organizationId));
    expect(after).toHaveLength(before.length);
  }, 60_000);

  it('POST /public/email/send: 20.001 tag datar → 400 html_too_complex', async () => {
    const { secret } = await createKey();
    const response = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'datar@contoh.example' }],
      subject: 'Tagihan',
      html: '<b>x</b>'.repeat(20_001),
    });
    expect(response.statusCode).toBe(400);
    expect(reasonOf(response.body)?.reason).toBe('html_too_complex');
  });

  it('POST /public/email/send: sarang 150 tingkat + catat Inbox → 202 (di dalam batas)', async () => {
    const { secret } = await createKey();
    const response = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'wajar@contoh.example' }],
      subject: 'Tagihan',
      html: `${'<div>'.repeat(150)}Tagihan bulan ini${'</div>'.repeat(150)}`,
      conversation: 'create',
    });
    expect(response.statusCode, response.body).toBe(202);
  });

  it('pratinjau & terbit template: HTML 512 KB bersarang → 400 html_too_complex < 2 dtk', async () => {
    const session = { cookie: owner.cookie, csrf: owner.csrf };
    let started = performance.now();
    const preview = await call(
      harness.app,
      'POST',
      API_ROUTES.emailTemplates.preview,
      { subject: 'Tagihan', html: deep512, layout: 'brand' },
      session,
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(preview.statusCode).toBe(400);
    expect(reasonOf(preview.body)?.reason).toBe('html_too_complex');

    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.emailTemplates.list,
      {
        name: 'Sarang',
        slug: 'sarang-s3',
        draft: { subject: 'Tagihan', html: deep512, variables: [], layout: 'brand' },
      },
      session,
    );
    expect(created.statusCode, created.body).toBe(201);
    const template = emailTemplateResponseSchema.parse(created.json()).template;
    started = performance.now();
    const published = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.emailTemplates.publish, { templateId: template.id }),
      { confirmation: await confirmationFor() },
      session,
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(published.statusCode).toBe(400);
    expect(reasonOf(published.body)).toMatchObject({
      field: 'draft.html',
      reason: 'html_too_complex',
    });
  }, 60_000);
});

describe('Putaran 3 S4 (Sedang) — amplifikasi variabel template lewat pratinjau', () => {
  // Supervisor+ (templates.manage): pratinjau menerima `values` ≤ 1.000 karakter per variabel dan
  // menyisipkannya di setiap {{a}} tanpa batas ukuran hasil. 3.000 {{a}} × 1.000 "&" ≈ 15 juta
  // karakter; 50.000 {{a}} = api kehabisan heap. Perbaikan boleh menolak (400) atau membatasi.
  it.fails(
    'pratinjau 3.000 {{a}} × nilai 1.000 "&" dijawab < 2 dtk',
    async () => {
      const started = performance.now();
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.emailTemplates.preview,
        {
          subject: 'Tagihan',
          html: '<p>' + '{{a}}'.repeat(3_000) + '</p>',
          layout: 'brand',
          values: { a: '&'.repeat(1_000) },
        },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
      expect([200, 400]).toContain(response.statusCode);
      expect(performance.now() - started).toBeLessThan(2_000);
    },
    120_000,
  );
});

describe('R2b (Rendah) — lampiran Office format lama (CFB) ditolak', () => {
  it.each(['surat.doc', 'data.xls', 'slide.ppt'])(
    '%s → 400 attachment_type_blocked',
    async (filename) => {
      const { secret } = await createKey();
      const cfb = Buffer.alloc(1_024);
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb);
      const response = await api(secret, API_ROUTES.publicEmail.send, {
        senderId,
        to: [{ email: 'lampiran@contoh.example' }],
        subject: 'Dokumen',
        text: 'Terlampir.',
        attachments: [{ filename, contentBase64: cfb.toString('base64') }],
      });
      expect(response.statusCode).toBe(400);
      expect(reasonOf(response.body)?.reason).toBe('attachment_type_blocked');
    },
  );
});

describe('S2 (Sedang) — batas kirim email API dihitung per email, bukan per penerima', () => {
  it('key dailySendLimit 3: satu email ke 3 penerima (Kepada+Cc+Bcc) menghabiskan jatah → kirim berikutnya 429', async () => {
    const { secret } = await createKey({ dailySendLimit: 3 });
    const first = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'a@contoh.example' }],
      cc: [{ email: 'b@contoh.example' }],
      bcc: [{ email: 'c@contoh.example' }],
      subject: 'Tagihan',
      text: 'Isi',
    });
    expect(first.statusCode, first.body).toBe(202);
    const second = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'd@contoh.example' }],
      subject: 'Tagihan',
      text: 'Isi',
    });
    // Pola Review 9.0 S1 (Inbox): hitungan + penerima > batas → 429. Sekarang 202 (1 email = 1).
    expect(second.statusCode).toBe(429);
  });

  it('satu email boleh 50 penerima tetapi email ke-2 dengan 50 penerima melewati dailySendLimit 60 → 429', async () => {
    const { secret } = await createKey({ dailySendLimit: 60 });
    const fifty = (prefix: string) =>
      Array.from({ length: 49 }, (_, index) => ({
        email: `${prefix}${String(index)}@x.example`,
      }));
    const send = (prefix: string) =>
      api(secret, API_ROUTES.publicEmail.send, {
        senderId,
        to: [{ email: `${prefix}to@x.example` }],
        bcc: fifty(prefix),
        subject: 'Promo',
        text: 'Isi',
      });
    expect((await send('a')).statusCode).toBe(202);
    expect((await send('b')).statusCode).toBe(429);
  });
});

describe('regresi 9.1 (sudah benar)', () => {
  it('wildcard host lampiran: semua tingkat subdomain, bukan induk, bukan akhiran mirip', () => {
    const patterns = ['*.billing.example', 'cdn.example'];
    expect(emailAttachmentHostAllowed('a.billing.example', patterns)).toBe(true);
    expect(emailAttachmentHostAllowed('x.y.billing.example', patterns)).toBe(true);
    expect(emailAttachmentHostAllowed('A.BILLING.EXAMPLE.', patterns)).toBe(true);
    expect(emailAttachmentHostAllowed('billing.example', patterns)).toBe(false);
    expect(emailAttachmentHostAllowed('evilbilling.example', patterns)).toBe(false);
    expect(emailAttachmentHostAllowed('billing.example.evil.test', patterns)).toBe(false);
    expect(emailAttachmentHostAllowed('cdn.example.evil.test', patterns)).toBe(false);
    expect(emailAttachmentHostAllowed('sub.cdn.example', patterns)).toBe(false);
  });

  it('header injection: subjek/nama pengirim/nama penerima ber-CRLF → 400, tidak ada baris email', async () => {
    const { secret } = await createKey();
    const base = { senderId, to: [{ email: 'p@contoh.example' }], subject: 'Halo', text: 'Isi' };
    const before = await harness.db
      .select({ id: emailOutbound.id })
      .from(emailOutbound)
      .where(eq(emailOutbound.organizationId, organizationId));

    const subject = await api(secret, API_ROUTES.publicEmail.send, {
      ...base,
      subject: 'Halo\r\nBcc: korban@luar.example',
    });
    expect(subject.statusCode).toBe(400);
    expect(reasonOf(subject.body)?.reason).toBe('subject_invalid');

    const fromName = await api(secret, API_ROUTES.publicEmail.send, {
      ...base,
      fromName: 'Billing\r\nBcc: korban@luar.example',
    });
    expect(fromName.statusCode).toBe(400);

    const recipientName = await api(secret, API_ROUTES.publicEmail.send, {
      ...base,
      to: [{ email: 'p@contoh.example', name: 'Budi\nBcc: korban@luar.example' }],
    });
    expect(recipientName.statusCode).toBe(400);

    const address = await api(secret, API_ROUTES.publicEmail.send, {
      ...base,
      to: [{ email: 'p@contoh.example\r\nBcc: korban@luar.example' }],
    });
    expect(address.statusCode).toBe(400);

    const after = await harness.db
      .select({ id: emailOutbound.id })
      .from(emailOutbound)
      .where(eq(emailOutbound.organizationId, organizationId));
    expect(after.length).toBe(before.length);
  });

  it('key email:read saja tidak bisa kirim (403)', async () => {
    const { secret } = await createKey({ scopes: ['email:read'] });
    const send = await api(secret, API_ROUTES.publicEmail.send, {
      senderId,
      to: [{ email: 'p@contoh.example' }],
      subject: 'Halo',
      text: 'Isi',
    });
    expect(send.statusCode).toBe(403);
  });
});
