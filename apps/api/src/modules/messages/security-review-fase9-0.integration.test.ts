/**
 * Review keamanan tahap 9.0 — Cc/Bcc channel Email & akses per channel
 * (docs/security-reviews/2026-11-22-fase9-0-backend.md).
 *
 * `it` = regresi (perilaku yang sudah benar). `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN;
 * gagal sekarang). Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 * Postgres + Redis sungguhan; SMTP tidak dipanggil.
 */
import { randomUUID } from 'node:crypto';

import {
  channels,
  contacts,
  conversations,
  messages,
  newId,
  organizations,
  type MessageExtras,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath } from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-uji-review-fase9-0-01';
const CHANNEL_ADDRESS = 'cs@majujaya.test';

let harness: IntegrationHarness;
let owner: SignedIn;
let cs: SignedIn;
let organizationId: string;
let emailChannelId: string;
const hasher = createPasswordHasher();
let sequence = 0;

/** Sepuluh alamat "korban" yang dicantumkan PENYERANG di header Cc email masuk. */
const VICTIMS = Array.from({ length: 10 }, (_, index) => `korban${String(index)}@target.test`);

/**
 * Percakapan Email milik CS + satu email masuk. `cc` = header Cc email masuk (dikendalikan
 * pengirim luar); `senderVerification` = hasil verifikasi pengirim email masuk itu.
 */
async function emailConversation(inbound: {
  cc: string[];
  senderVerification: 'pass' | 'fail' | 'unverified';
}) {
  sequence += 1;
  const customer = `penyerang${String(sequence)}@luar.test`;
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'email',
      externalUserId: customer,
      channelHandle: customer,
    })
    .returning();
  const at = new Date();
  const [conversation] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId: emailChannelId,
      status: 'served',
      assigneeUserId: cs.session.user.id,
      lastMessageAt: at,
      lastInboundAt: at,
    })
    .returning();
  const extras: MessageExtras = {
    email: {
      subject: 'Halo',
      inReplyTo: null,
      references: [],
      authWarning: inbound.senderVerification === 'fail',
      senderVerification: inbound.senderVerification,
      skippedAttachments: 0,
      hasHtml: false,
      to: [CHANNEL_ADDRESS],
      cc: inbound.cc,
      replyAll: inbound.cc,
    },
  };
  await harness.db.insert(messages).values({
    organizationId,
    conversationId: conversation!.id,
    contactId: contact!.id,
    channelId: emailChannelId,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    rawType: 'email',
    wamid: `${randomUUID()}@luar.test`,
    text: 'Tolong balas semua ya.',
    extras,
    emailRecipient: CHANNEL_ADDRESS,
    occurredAt: at,
    receivedAt: at,
  });
  return { id: conversation!.id };
}

const reply = (cc: string[]) => ({
  type: 'text' as const,
  clientMessageId: randomUUID(),
  text: 'Promo spesial, klik tautan ini.',
  cc,
});

function sendAs(signed: SignedIn, conversationId: string, body: unknown) {
  return call(harness.app, 'POST', apiPath(API_ROUTES.inbox.messages, { conversationId }), body, {
    cookie: signed.cookie,
    csrf: signed.csrf,
  });
}

async function outboundRows(conversationId: string) {
  return harness.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));
}

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  emailChannelId = newId();
  await harness.db.insert(channels).values({
    id: emailChannelId,
    organizationId,
    type: 'email',
    name: 'CS Email',
    emailAddress: CHANNEL_ADDRESS,
    emailAliases: [],
    emailFromName: 'CS Maju Jaya',
    emailImapHost: 'imap.majujaya.test',
    emailImapPort: 993,
    emailImapSecurity: 'ssl',
    emailImapUsername: 'cs',
    emailImapPasswordEncrypted: 'x',
    emailImapFolder: 'INBOX',
    emailPollIntervalMinutes: 5,
    emailMarkAsRead: false,
    emailSmtpMode: 'system',
  });
  const user = await insertUser(harness.db, organizationId, {
    role: 'cs',
    email: `cs.${newId().slice(-6)}@review.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  cs = await login(harness.app, { email: user.email, password: PASSWORD });
});
afterAll(async () => {
  await harness?.close();
});

describe('S1 — Cc "sudah ada di utas" dari header email masuk yang dikendalikan pengirim luar', () => {
  it('regresi: alamat baru yang TIDAK ada di header mana pun tetap 403 untuk CS', async () => {
    const thread = await emailConversation({ cc: [], senderVerification: 'pass' });
    const response = await sendAs(cs, thread.id, reply(['orang.lain@target.test']));
    expect(response.statusCode, response.body).toBe(403);
  });

  it('S1a: penerima Cc/Bcc ikut dihitung batas kirim harian per pengguna (1 balasan + 10 Cc ≠ 1 pesan)', async () => {
    // Batas harian CS = 3 pesan. Penyerang mengirim satu email dengan Cc 10 alamat korban, lalu
    // akun CS yang dibobol "Balas semua": hari ini 11 alamat dijangkau dengan SATU unit batas.
    await harness.db
      .update(organizations)
      .set({ sendDailyLimitPerUser: 3 })
      .where(eq(organizations.id, organizationId));
    const thread = await emailConversation({ cc: VICTIMS, senderVerification: 'pass' });
    const response = await sendAs(cs, thread.id, reply(VICTIMS));
    expect(response.statusCode, response.body).toBe(429);
    expect(await outboundRows(thread.id)).toHaveLength(0);
  });

  it('S1b: Kepada/Cc email masuk yang GAGAL verifikasi pengirim tidak "menghalalkan" Cc tanpa inbox.initiate', async () => {
    // Pengirim dipalsukan (DMARC gagal): header Cc-nya tidak boleh menjadi daftar izin Cc CS.
    const thread = await emailConversation({ cc: VICTIMS, senderVerification: 'fail' });
    const response = await sendAs(cs, thread.id, reply(VICTIMS));
    expect(response.statusCode, response.body).toBe(403);
    expect(await outboundRows(thread.id)).toHaveLength(0);
  });
});
