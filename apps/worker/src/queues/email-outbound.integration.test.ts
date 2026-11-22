/**
 * Tahap 9.1 — worker `email-outbound` + sambungan email masuk (docs/KONTRAK-API-EMAIL-KIRIM.md §4–6):
 * kirim sungguhan ke Mailpit (Bcc TIDAK di header, `Auto-Submitted`, Message-ID), batas per jam,
 * rem darurat & tertahan > 24 jam, login ditolak → `blocked` (audit + alarm + email Owner),
 * pembatasan laju 4.7.x → `throttled`, key dicabut → `sender_not_allowed`, penerima ditolak →
 * `failed` (+ status pesan Inbox), bounce DSN → `bounced` + `email.bounced`, balasan →
 * `email.replied` (tanpa isi). Postgres + Mailpit sungguhan.
 */
import { randomBytes } from 'node:crypto';

import {
  createLogger,
  createMediaStore,
  createSecretBox,
  Secret,
  sealChannelConnectionSecret,
  type ApiMailResult,
  type SecurityNoticeAdminEmailPayload,
} from '@balesin/core';
import { TEST_MAIL, capturedMailFor } from '@balesin/core/testing';
import {
  alarmEvents,
  apiKeyEmailSenders,
  apiKeys,
  auditLogs,
  channels,
  closeDb,
  contacts,
  conversations,
  createDb,
  emailOutbound,
  emailSenderSettings,
  messages,
  newId,
  organizations,
  outgoingEvents,
  webhookEndpoints,
  type Database,
  type NewEmailOutboundRow,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { processEmailBounce, recordEmailApiReplies } from '../inbound/email-api-events';
import { processEmailOutboundTick, type EmailOutboundDeps } from './email-outbound';
import { buildEventBody } from './webhooks-out';

let db: Database;
const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-email-outbound', level: 'silent' });
const notices: SecurityNoticeAdminEmailPayload[] = [];

const MAILPIT_API = (
  process.env.MAILPIT_API_URL_TEST?.trim() || `http://${TEST_MAIL.host}:8025`
).replace(/\/+$/, '');

interface Fixture {
  organizationId: string;
  channelId: string;
  apiKeyId: string;
  ownerId: string;
}

/** Organisasi buatan tes ini — outbox-nya dibersihkan setelah tiap tes (DB tes dipakai bersama). */
const createdOrganizations: string[] = [];

async function fixture(smtp: 'mailpit' | 'dummy' = 'dummy'): Promise<Fixture> {
  const organization = await insertOrganization(db);
  createdOrganizations.push(organization.id);
  const owner = await insertUser(db, organization.id, { role: 'owner' });
  const channelId = newId();
  const address = `billing-${channelId.slice(-8)}@perusahaan.example`;
  await db.insert(channels).values({
    id: channelId,
    organizationId: organization.id,
    type: 'email',
    name: 'Billing',
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
    emailSmtpHost: smtp === 'mailpit' ? TEST_MAIL.host : 'smtp.perusahaan.example',
    emailSmtpPort: smtp === 'mailpit' ? TEST_MAIL.smtpPort : 465,
    emailSmtpSecurity: smtp === 'mailpit' ? 'none' : 'ssl',
    emailSmtpUsername: TEST_MAIL.username,
    emailSmtpPasswordEncrypted: sealChannelConnectionSecret(
      secretBox,
      { id: channelId, organizationId: organization.id },
      'emailSmtpPassword',
      TEST_MAIL.password,
    ),
  });
  const [key] = await db
    .insert(apiKeys)
    .values({
      organizationId: organization.id,
      name: 'Aplikasi billing',
      lookupKey: randomBytes(8).toString('hex'),
      secretHash: randomBytes(32).toString('hex'),
      scopes: ['email:send'],
      createdByUserId: owner.id,
    })
    .returning();
  await db.insert(apiKeyEmailSenders).values({
    organizationId: organization.id,
    apiKeyId: key!.id,
    senderKind: 'channel',
    channelId,
  });
  await db.insert(webhookEndpoints).values({
    organizationId: organization.id,
    url: 'https://n8n.contoh.example/hook',
    events: ['email.sent', 'email.failed', 'email.bounced', 'email.replied', 'message.status'],
    secretEncrypted: 'v1.x.y',
  });
  return { organizationId: organization.id, channelId, apiKeyId: key!.id, ownerId: owner.id };
}

async function insertEmail(
  f: Fixture,
  overrides: Partial<NewEmailOutboundRow> = {},
): Promise<string> {
  const [channel] = await db.select().from(channels).where(eq(channels.id, f.channelId));
  const [row] = await db
    .insert(emailOutbound)
    .values({
      organizationId: f.organizationId,
      source: 'api',
      apiKeyId: f.apiKeyId,
      senderKind: 'channel',
      channelId: f.channelId,
      fromAddress: channel!.emailAddress!,
      fromName: 'Billing Perusahaan',
      to: [{ email: `budi-${newId().slice(-8)}@contoh.example`, name: 'Budi Santoso' }],
      cc: [],
      bcc: [{ email: 'arsip.rahasia@perusahaan.example', name: null }],
      recipientCount: 2,
      subject: 'Tagihan November 2026',
      html: '<p>Halo Budi</p>',
      text: 'Halo Budi',
      metadata: { invoice_id: 'INV-2611-0873' },
      messageIdHeader: `${newId()}@perusahaan.example`,
      status: 'queued',
      nextAttemptAt: new Date(Date.now() - 1000),
      ...overrides,
    })
    .returning({ id: emailOutbound.id });
  return row!.id;
}

const deps = (
  overrides: Partial<EmailOutboundDeps> & { result?: ApiMailResult } = {},
): EmailOutboundDeps => ({
  db,
  secretBox,
  store: createMediaStore(`${process.cwd()}/.tmp-media-email-outbound`),
  smtp: {
    allowedPorts: [25, 465, 587, 2525, TEST_MAIL.smtpPort],
    plaintextLogin: 'allow',
    fallback: null,
    timeouts: { totalMs: 10_000 },
  },
  logger,
  notifyOwner: (payload) => {
    notices.push(payload);
    return Promise.resolve();
  },
  ...(overrides.result ? { send: () => Promise.resolve(overrides.result!) } : {}),
  ...overrides,
});

const rowOf = async (id: string) =>
  (await db.select().from(emailOutbound).where(eq(emailOutbound.id, id)))[0]!;

const eventsOf = async (organizationId: string) =>
  db.select().from(outgoingEvents).where(eq(outgoingEvents.organizationId, organizationId));

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-email-outbound' });
}, 30_000);

afterEach(async () => {
  if (createdOrganizations.length === 0) return;
  // Tes lain di DB bersama memeriksa outbox kosong: jangan tinggalkan kejadian `email.*`.
  await db
    .delete(outgoingEvents)
    .where(inArray(outgoingEvents.organizationId, createdOrganizations.splice(0)));
});

afterAll(async () => {
  if (db) await closeDb(db);
}, 30_000);

describe('kirim lewat SMTP sungguhan', () => {
  it('Bcc hanya di amplop (tidak ada header Bcc), Auto-Submitted, Message-ID; status sent + email.sent', async () => {
    const f = await fixture('mailpit');
    const id = await insertEmail(f);
    const result = await processEmailOutboundTick(deps());
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const row = await rowOf(id);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
    const recipient = row.to[0]!.email;
    let mails = await capturedMailFor(recipient);
    for (let i = 0; i < 20 && mails.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      mails = await capturedMailFor(recipient);
    }
    expect(mails).toHaveLength(1);
    const raw = await (await fetch(`${MAILPIT_API}/api/v1/message/${mails[0]!.id}/raw`)).text();
    const headers = raw.split(/\r?\n\r?\n/)[0] ?? '';
    // Mailpit sendiri menambahkan `Bcc:` (dari amplop) + `Return-Path`/`Received` DI ATAS header
    // kiriman kita — itu bukti alamat Bcc ikut di amplop. Header buatan kita (setelah blok
    // `Received:` milik Mailpit) tidak boleh memuat Bcc.
    const lines = headers.split(/\r?\n/);
    const receivedAt = lines.findIndex((line) => /^Received:/i.test(line));
    let ours = receivedAt + 1;
    while (ours < lines.length && /^\s/.test(lines[ours] ?? '')) ours += 1;
    const ownHeaders = lines.slice(ours).join('\n');
    expect(lines.slice(0, receivedAt).join('\n')).toContain('arsip.rahasia@perusahaan.example');
    expect(ownHeaders).not.toMatch(/^bcc:/im);
    expect(ownHeaders).not.toContain('arsip.rahasia');
    expect(ownHeaders).toMatch(/^Auto-Submitted: auto-generated/im);
    expect(headers).toContain(`<${row.messageIdHeader}>`);

    const events = await eventsOf(f.organizationId);
    const sent = events.find((event) => event.type === 'email.sent');
    expect(sent?.emailOutboundId).toBe(id);
    const body = await buildEventBody(db, sent!);
    const email = (body?.data as { email: Record<string, unknown> }).email;
    expect(email).toMatchObject({
      status: 'sent',
      bcc_count: 1,
      metadata: { invoice_id: 'INV-2611-0873' },
      api_key: { id: f.apiKeyId, name: 'Aplikasi billing' },
    });
    expect(JSON.stringify(body)).not.toContain('arsip.rahasia');
  });
});

describe('penahan & kegagalan', () => {
  it('batas per jam pengirim: yang melebihi ditahan sampai email tertua genap 1 jam', async () => {
    const f = await fixture();
    await db.insert(emailSenderSettings).values({
      organizationId: f.organizationId,
      senderKind: 'channel',
      channelId: f.channelId,
      hourlyLimit: 1,
    });
    const first = await insertEmail(f, { createdAt: new Date(Date.now() - 2000) });
    const second = await insertEmail(f);
    await processEmailOutboundTick(deps({ result: { ok: true, rejected: [] } }));
    expect((await rowOf(first)).status).toBe('sent');
    const held = await rowOf(second);
    expect(held.status).toBe('queued');
    expect(held.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
  });

  it('rem darurat menahan (queued); tertahan > 24 jam → sending_paused_expired', async () => {
    const f = await fixture();
    await db
      .update(organizations)
      .set({ sendingPausedAt: new Date() })
      .where(eq(organizations.id, f.organizationId));
    const fresh = await insertEmail(f);
    const stale = await insertEmail(f, { createdAt: new Date(Date.now() - 25 * 3600_000) });
    await processEmailOutboundTick(deps({ result: { ok: true, rejected: [] } }));
    expect((await rowOf(fresh)).status).toBe('queued');
    expect(await rowOf(stale)).toMatchObject({
      status: 'failed',
      failureReason: 'sending_paused_expired',
    });
    expect((await eventsOf(f.organizationId)).some((event) => event.type === 'email.failed')).toBe(
      true,
    );
  });

  it('login SMTP ditolak → pengirim blocked + audit + alarm + email Owner; email tetap antre', async () => {
    const f = await fixture();
    const id = await insertEmail(f);
    notices.length = 0;
    await processEmailOutboundTick(
      deps({ result: { ok: false, kind: 'auth', smtpCode: 535, code: 'auth_failed' } }),
    );
    expect((await rowOf(id)).status).toBe('queued');
    const [settings] = await db
      .select()
      .from(emailSenderSettings)
      .where(eq(emailSenderSettings.channelId, f.channelId));
    expect(settings).toMatchObject({ state: 'blocked', blockedReason: 'smtp_auth_failed' });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, f.organizationId),
          eq(auditLogs.action, 'settings.email_sender.blocked'),
        ),
      );
    expect(audit?.metadata).toMatchObject({ reason: 'smtp_auth_failed' });
    const [alarm] = await db
      .select()
      .from(alarmEvents)
      .where(eq(alarmEvents.organizationId, f.organizationId));
    expect(alarm?.kind).toBe('email_sender_blocked');
    expect(notices.some((notice) => notice.event === 'email_sender_blocked')).toBe(true);
    // Putaran berikut: pengirim blocked → ditahan tanpa mencoba SMTP lagi.
    let attempted = false;
    await processEmailOutboundTick(
      deps({
        send: () => {
          attempted = true;
          return Promise.resolve({ ok: true, rejected: [] });
        },
      }),
    );
    expect(attempted).toBe(false);
  });

  it('421 4.7.x → pengirim throttled + email dicoba lagi; key dicabut → sender_not_allowed', async () => {
    const f = await fixture();
    const id = await insertEmail(f);
    await processEmailOutboundTick(
      deps({ result: { ok: false, kind: 'throttled', smtpCode: 421, code: 'unknown' } }),
    );
    const row = await rowOf(id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    const [settings] = await db
      .select()
      .from(emailSenderSettings)
      .where(eq(emailSenderSettings.channelId, f.channelId));
    expect(settings?.state).toBe('throttled');
    expect(settings?.throttleStreak).toBe(1);

    const revoked = await fixture();
    const other = await insertEmail(revoked);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, revoked.apiKeyId));
    await processEmailOutboundTick(deps({ result: { ok: true, rejected: [] } }));
    expect(await rowOf(other)).toMatchObject({
      status: 'failed',
      failureReason: 'sender_not_allowed',
    });
  });

  it('semua penerima ditolak → failed recipient_rejected; pesan Inbox ikut failed (tidak bisa dikirim ulang)', async () => {
    const f = await fixture();
    const [contact] = await db
      .insert(contacts)
      .values({
        organizationId: f.organizationId,
        channelType: 'email',
        externalUserId: `budi-${newId().slice(-6)}@contoh.example`,
      })
      .returning();
    const [conversation] = await db
      .insert(conversations)
      .values({
        organizationId: f.organizationId,
        contactId: contact!.id,
        channelId: f.channelId,
        status: 'resolved',
        resolvedAt: new Date(),
        lastMessageAt: new Date(),
      })
      .returning();
    const [message] = await db
      .insert(messages)
      .values({
        organizationId: f.organizationId,
        conversationId: conversation!.id,
        contactId: contact!.id,
        channelId: f.channelId,
        direction: 'outbound',
        senderKind: 'bot',
        apiKeyId: f.apiKeyId,
        type: 'text',
        status: 'pending',
        text: 'Halo',
        occurredAt: new Date(),
      })
      .returning();
    const id = await insertEmail(f, {
      conversationId: conversation!.id,
      contactId: contact!.id,
      messageId: message!.id,
    });
    await processEmailOutboundTick(
      deps({ result: { ok: false, kind: 'recipients_rejected', smtpCode: 550, code: 'x' } }),
    );
    expect(await rowOf(id)).toMatchObject({
      status: 'failed',
      failureReason: 'recipient_rejected',
      smtpCode: 550,
    });
    const [after] = await db.select().from(messages).where(eq(messages.id, message!.id));
    expect(after).toMatchObject({ status: 'failed', failureReason: 'email_api_failed' });
  });
});

describe('bounce & balasan', () => {
  it('DSN RFC 3464 → bounces + status bounced + email.bounced; DSN Message-ID asing diabaikan', async () => {
    const f = await fixture();
    const id = await insertEmail(f, {
      status: 'sent',
      sentAt: new Date(),
      bcc: [],
      recipientCount: 1,
    });
    const row = await rowOf(id);
    const recipient = row.to[0]!.email;
    const dsn = [
      'From: Mail Delivery System <MAILER-DAEMON@mx.contoh.example>',
      'To: billing@perusahaan.example',
      'Subject: Undelivered Mail Returned to Sender',
      `Message-ID: <dsn-${newId()}@mx.contoh.example>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="BATAS"',
      '',
      '--BATAS',
      'Content-Type: text/plain',
      '',
      'Pesan tidak bisa diantar.',
      '--BATAS',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.contoh.example',
      '',
      `Final-Recipient: rfc822; ${recipient}`,
      'Action: failed',
      'Status: 5.1.1',
      '',
      '--BATAS',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: <${row.messageIdHeader}>`,
      'Subject: Tagihan November 2026',
      '',
      '--BATAS--',
      '',
    ].join('\r\n');
    const matched = await processEmailBounce(
      db,
      { id: f.channelId, organizationId: f.organizationId },
      Buffer.from(dsn),
      new Date(),
      logger,
    );
    expect(matched).toBe(1);
    const bounced = await rowOf(id);
    expect(bounced.status).toBe('bounced');
    expect(bounced.bounces).toEqual([
      expect.objectContaining({ recipient, status: '5.1.1', action: 'failed' }),
    ]);
    const event = (await eventsOf(f.organizationId)).find((item) => item.type === 'email.bounced');
    const body = await buildEventBody(db, event!);
    expect(body?.data).toMatchObject({ bounce: { recipients: [{ recipient, status: '5.1.1' }] } });
    // Channel lain (organisasi lain) dengan Message-ID sama tidak tersentuh.
    const other = await fixture();
    expect(
      await processEmailBounce(
        db,
        { id: other.channelId, organizationId: other.organizationId },
        Buffer.from(dsn),
        new Date(),
        logger,
      ),
    ).toBe(0);
  });

  it('balasan pelanggan → replied_at + email.replied (data.reply tanpa isi)', async () => {
    const f = await fixture();
    const id = await insertEmail(f, { status: 'sent', sentAt: new Date() });
    const row = await rowOf(id);
    const [contact] = await db
      .insert(contacts)
      .values({
        organizationId: f.organizationId,
        channelType: 'email',
        externalUserId: row.to[0]!.email,
      })
      .returning();
    const [conversation] = await db
      .insert(conversations)
      .values({
        organizationId: f.organizationId,
        contactId: contact!.id,
        channelId: f.channelId,
        status: 'unserved',
        lastMessageAt: new Date(),
      })
      .returning();
    const [reply] = await db
      .insert(messages)
      .values({
        organizationId: f.organizationId,
        conversationId: conversation!.id,
        contactId: contact!.id,
        channelId: f.channelId,
        direction: 'inbound',
        senderKind: 'customer',
        type: 'text',
        text: 'Rahasia isi balasan',
        extras: {
          email: {
            subject: 'Re: Tagihan',
            inReplyTo: row.messageIdHeader,
            references: [],
            authWarning: false,
            senderVerification: 'pass',
            skippedAttachments: 0,
            hasHtml: false,
          },
        },
        occurredAt: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    await db.transaction((tx) =>
      recordEmailApiReplies(tx, {
        organizationId: f.organizationId,
        channelId: f.channelId,
        messageId: reply!.id,
        conversationId: conversation!.id,
        contactId: contact!.id,
        inReplyTo: row.messageIdHeader,
        references: [],
        at: new Date(),
      }),
    );
    expect((await rowOf(id)).repliedAt).not.toBeNull();
    const event = (await eventsOf(f.organizationId)).find((item) => item.type === 'email.replied');
    const body = await buildEventBody(db, event!);
    expect(body?.data).toMatchObject({
      email: { id },
      reply: {
        message_id: reply!.id,
        conversation_id: conversation!.id,
        from: row.to[0]!.email,
        sender_verification: 'pass',
      },
    });
    expect(JSON.stringify(body)).not.toContain('Rahasia isi balasan');
  });
});
