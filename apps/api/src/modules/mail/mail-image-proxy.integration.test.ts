/**
 * Perbaikan review keamanan 9A bagian 2 (S5, R8, R9, R11, S7 api): cache proksi gambar luar 24 jam,
 * batas unduhan bersamaan per proses, UA umum, gambar otomatis hanya untuk pengirim terverifikasi,
 * rem hapus permanen harian + audit pindah massal, tolak dini kuota cache lampiran. Postgres + Redis
 * sungguhan; unduhan gambar luar DITIRU (tidak ada sambungan keluar).
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { RemoteFileRequest, RemoteFileResult } from '@balesin/core';
import {
  auditLogs,
  mailAttachments,
  mailFolders,
  mailMessageBodies,
  mailMessages,
  mailAccounts,
  mailRemoteImageAllow,
  mailRemoteImageCache,
} from '@balesin/db';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  MAIL_DELETE_PERMANENT_DAILY_MAX,
  MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_ENTRIES,
  apiPath,
  mailMessageViewResponseSchema,
} from '@balesin/shared';
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
const fetches: RemoteFileRequest[] = [];
let fetchRemote: (request: RemoteFileRequest) => Promise<RemoteFileResult>;
const pngResult = (): RemoteFileResult => ({
  ok: true,
  body: PNG,
  contentType: 'image/png',
  finalUrl: new URL('https://cdn.mitra.test/a.png'),
});

async function seedMessage(
  options: {
    verification?: 'pass' | 'fail' | 'unverified';
    images?: number;
    role?: 'inbox' | 'trash';
  } = {},
) {
  const [account] = await harness.db
    .insert(mailAccounts)
    .values({
      organizationId,
      kind: 'shared',
      provider: 'cpanel',
      displayName: 'CS',
      emailAddress: `cs-${randomBytes(3).toString('hex')}@majujaya.test`,
      fromName: 'Tim CS',
      color: 'tagBlue',
      imapHost: 'mail.majujaya.test',
      imapPort: 993,
      imapSecurity: 'ssl',
      imapUsername: 'cs',
      imapPasswordEncrypted: 'v1.x.y',
      smtpHost: 'mail.majujaya.test',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      syncState: 'ready',
    })
    .returning();
  if (!account) throw new Error('akun');
  const role = options.role ?? 'inbox';
  const [folder] = await harness.db
    .insert(mailFolders)
    .values({
      organizationId,
      accountId: account.id,
      path: role === 'inbox' ? 'INBOX' : 'Trash',
      name: role === 'inbox' ? 'Kotak masuk' : 'Sampah',
      delimiter: '.',
      role,
      roleSource: 'special_use',
    })
    .returning();
  if (!folder) throw new Error('folder');
  const images = options.images ?? 1;
  const [message] = await harness.db
    .insert(mailMessages)
    .values({
      organizationId,
      accountId: account.id,
      folderId: folder.id,
      folderRole: role,
      uid: Math.floor(Math.random() * 1_000_000) + 1,
      uidvalidity: 1,
      fromAddress: 'promo@mitra.test',
      fromName: 'Mitra',
      to: [{ address: 'cs@majujaya.test', name: null }],
      subject: 'Promo',
      snippet: 'Cuplikan',
      receivedAt: new Date(),
      bodyState: 'ready',
      senderVerification: options.verification ?? 'pass',
    })
    .returning();
  if (!message) throw new Error('pesan');
  await harness.db.insert(mailMessageBodies).values({
    messageId: message.id,
    organizationId,
    text: 'Halo',
    htmlSanitized: '<p><img src="balesin-remote:0"></p>',
    remoteImages: Array.from(
      { length: images },
      (_, i) => `https://cdn.mitra.test/${String(i)}.png`,
    ),
    rawHeaders: 'From: promo@mitra.test',
  });
  return { account, folder, message };
}

async function view(signed: SignedIn, messageId: string, images: 'auto' | 'show' = 'show') {
  const response = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.mail.messageView, { messageId }),
    { images },
    signed,
  );
  expect(response.statusCode, response.body).toBe(200);
  return mailMessageViewResponseSchema.parse(response.json());
}
const get = (url: string) => call(harness.app, 'GET', url);

beforeAll(async () => {
  harness = await createIntegrationHarness({
    mailQueue: {
      sync: () => Promise.resolve(),
      purge: () => Promise.resolve(),
      fetchBody: () => Promise.resolve(),
      fetchAttachment: () => Promise.resolve(),
      action: () => Promise.resolve(),
    },
    overrides: {
      mail: {
        fetchRemote: (request) => {
          fetches.push(request);
          return fetchRemote(request);
        },
      },
    },
  });
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  fetches.length = 0;
  fetchRemote = () => Promise.resolve(pngResult());
});

afterAll(async () => {
  await harness?.close();
});

describe('S5/R8 — cache proksi gambar luar', () => {
  it('buka ulang (token baru) tidak mengunduh lagi; UA umum + kepala raster diperiksa', async () => {
    const { message, account } = await seedMessage();
    const first = await view(owner, message.id);
    const a = await get(`${first.url}/images/0`);
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toBe('image/png');
    expect(a.rawPayload.equals(PNG)).toBe(true);
    const second = await view(owner, message.id);
    const b = await get(`${second.url}/images/0`);
    expect(b.statusCode).toBe(200);
    expect(b.rawPayload.equals(PNG)).toBe(true);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.userAgent).toMatch(/^Mozilla\/5\.0/);
    expect(fetches[0]?.userAgent).not.toMatch(/balesin/i);
    expect(fetches[0]?.acceptHead?.accept(PNG.subarray(0, 12))).toBe(true);
    expect(fetches[0]?.acceptHead?.accept(Buffer.from('<html><body>'))).toBe(false);
    const rows = await harness.db
      .select()
      .from(mailRemoteImageCache)
      .where(eq(mailRemoteImageCache.accountId, account.id));
    expect(rows).toHaveLength(1);
    // Kunci = hash, bukan URL mentah.
    expect(rows[0]?.urlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cache kedaluwarsa (> 24 jam) → diunduh ulang', async () => {
    const { message } = await seedMessage();
    const issued = await view(owner, message.id);
    expect((await get(`${issued.url}/images/0`)).statusCode).toBe(200);
    await harness.db.update(mailRemoteImageCache).set({ expiresAt: new Date(Date.now() - 1_000) });
    expect((await get(`${issued.url}/images/0`)).statusCode).toBe(200);
    expect(fetches).toHaveLength(2);
  });

  it('bukan raster (kepala ditolak) → 415 GIF kosong, tidak di-cache', async () => {
    const { message } = await seedMessage();
    fetchRemote = () => Promise.resolve({ ok: false, error: 'content_rejected', httpStatus: 200 });
    const issued = await view(owner, message.id);
    const response = await get(`${issued.url}/images/0`);
    expect(response.statusCode).toBe(415);
    expect(response.headers['content-type']).toBe('image/gif');
    expect(await harness.db.select().from(mailRemoteImageCache)).toHaveLength(0);
  });

  it('P2-S8: baris KEDALUWARSA ikut kuota byte → gambar tetap tampil, tidak disimpan', async () => {
    const { message, account } = await seedMessage();
    // 205 × 5 MB kedaluwarsa (belum dipangkas retensi) ≥ 1 GB.
    await harness.db.insert(mailRemoteImageCache).values(
      Array.from({ length: 205 }, () => ({
        organizationId,
        accountId: account.id,
        urlHash: randomBytes(32).toString('hex'),
        storageKey: `mail/${randomUUID()}`,
        contentType: 'image/png',
        sizeBytes: 5 * 1024 * 1024,
        expiresAt: new Date(Date.now() - 60_000),
      })),
    );
    const issued = await view(owner, message.id);
    const response = await get(`${issued.url}/images/0`);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(PNG)).toBe(true);
    const [row] = await harness.db
      .select({ value: count() })
      .from(mailRemoteImageCache)
      .where(gt(mailRemoteImageCache.expiresAt, new Date()));
    expect(row?.value).toBe(0);
  });

  it(`P2-S8: ${String(MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_ENTRIES)} entri per organisasi → disajikan tanpa disimpan`, async () => {
    const { message, account } = await seedMessage();
    // Entri kecil (43 byte → dihitung 4 KB) yang masih berlaku: 200.000 × 4 KB < 1 GB, jadi yang
    // menahan adalah batas JUMLAH entri.
    await harness.db.execute(sql`
      insert into mail_remote_image_cache
        (id, organization_id, account_id, url_hash, storage_key, content_type, size_bytes, expires_at)
      select gen_random_uuid(), ${organizationId}::uuid, ${account.id}::uuid,
        encode(sha256(convert_to(g::text, 'UTF8')), 'hex'), 'mail/' || gen_random_uuid(),
        'image/gif', 43, now() + interval '1 hour'
      from generate_series(1, ${MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_ENTRIES}::int) as g`);
    const issued = await view(owner, message.id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await get(`${issued.url}/images/0`);
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(PNG)).toBe(true);
    }
    // Tidak di-cache → setiap buka mengunduh lagi (rem S5 per pengguna tetap berlaku).
    expect(fetches).toHaveLength(2);
    const [row] = await harness.db
      .select({ value: count() })
      .from(mailRemoteImageCache)
      .where(eq(mailRemoteImageCache.organizationId, organizationId));
    expect(row?.value).toBe(MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_ENTRIES);
  }, 60_000);

  it('unduhan bersamaan lewat batas → 429 GIF kosong seketika (tidak diantre)', async () => {
    const { message } = await seedMessage({ images: 20 });
    const issued = await view(owner, message.id);
    let inFlight = 0;
    let peak = 0;
    fetchRemote = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight -= 1;
      return pngResult();
    };
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => get(`${issued.url}/images/${String(index)}`)),
    );
    expect(peak).toBeLessThanOrEqual(8);
    const busy = responses.filter((response) => response.statusCode === 429);
    expect(busy.length).toBeGreaterThan(0);
    for (const response of busy) {
      expect(response.headers['content-type']).toBe('image/gif');
      expect(response.headers['retry-after']).toBe('2');
    }
  });
});

describe('R9 — gambar otomatis hanya untuk pengirim terverifikasi', () => {
  it('pengirim di daftar "selalu": pass → tampil; unverified/fail → tetap diblokir', async () => {
    await harness.db.insert(mailRemoteImageAllow).values({
      organizationId,
      userId: owner.session.user.id,
      senderAddress: 'promo@mitra.test',
    });
    for (const [verification, shown] of [
      ['pass', true],
      ['unverified', false],
      ['fail', false],
    ] as const) {
      const { message } = await seedMessage({ verification });
      const issued = await view(owner, message.id, 'auto');
      expect(issued.remoteImages.shown, verification).toBe(shown);
    }
  });
});

describe('R11 — rem hapus permanen & audit pindah massal', () => {
  it('pindah ke Sampah ≥ 10 email sekali minta → audit mail.messages.moved (tanpa subjek)', async () => {
    const seeded = await seedMessage();
    const ids = [seeded.message.id];
    for (let index = 0; index < 11; index += 1) {
      const [row] = await harness.db
        .insert(mailMessages)
        .values({
          organizationId,
          accountId: seeded.account.id,
          folderId: seeded.folder.id,
          folderRole: 'inbox',
          uid: 2_000_000 + index,
          uidvalidity: 1,
          fromAddress: 'a@mitra.test',
          subject: 'Rahasia',
          receivedAt: new Date(),
        })
        .returning();
      if (row) ids.push(row.id);
    }
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.messageActions,
      { messageIds: ids, action: 'trash' },
      owner,
    );
    expect(response.statusCode, response.body).toBe(200);
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.mailMessagesMoved),
        ),
      );
    expect(audit?.metadata).toMatchObject({ action: 'trash', count: 12 });
    expect(JSON.stringify(audit?.metadata)).not.toContain('Rahasia');
  });

  it(`hapus permanen > ${String(MAIL_DELETE_PERMANENT_DAILY_MAX)} email/24 jam per pengguna → 429 + audit`, async () => {
    const { message } = await seedMessage({ role: 'trash' });
    await harness.db.insert(auditLogs).values({
      organizationId,
      actorUserId: owner.session.user.id,
      action: AUDIT_ACTIONS.mailMessagesDeletedPermanently,
      targetType: 'mail_account',
      metadata: { count: MAIL_DELETE_PERMANENT_DAILY_MAX },
    });
    const response = await call(
      harness.app,
      'POST',
      API_ROUTES.mail.messageActions,
      { messageIds: [message.id], action: 'delete_permanently' },
      owner,
    );
    expect(response.statusCode).toBe(429);
    const [row] = await harness.db
      .select({ pending: mailMessages.pendingAction })
      .from(mailMessages)
      .where(eq(mailMessages.id, message.id));
    expect(row?.pending).toBeNull();
    const limits = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.mailMessagesDeleteLimitReached));
    expect(limits).toHaveLength(1);
  });

  it('P2-R13: hapus permanen PARALEL tidak menembus batas 500/24 jam', async () => {
    const seeded = await seedMessage({ role: 'trash' });
    const extra = await harness.db
      .insert(mailMessages)
      .values(
        Array.from({ length: 49 }, (_, index) => ({
          organizationId,
          accountId: seeded.account.id,
          folderId: seeded.folder.id,
          folderRole: 'trash' as const,
          uid: 4_000_000 + index,
          uidvalidity: 1,
          receivedAt: new Date(),
        })),
      )
      .returning({ id: mailMessages.id });
    const ids = [seeded.message.id, ...extra.map((row) => row.id)];
    await harness.db.insert(auditLogs).values({
      organizationId,
      actorUserId: owner.session.user.id,
      action: AUDIT_ACTIONS.mailMessagesDeletedPermanently,
      targetType: 'mail_account',
      metadata: { count: MAIL_DELETE_PERMANENT_DAILY_MAX - 20 },
    });
    // 5 permintaan bersamaan × 10 email; sisa jatah 20 → tepat 2 yang boleh lolos.
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        call(
          harness.app,
          'POST',
          API_ROUTES.mail.messageActions,
          { messageIds: ids.slice(index * 10, index * 10 + 10), action: 'delete_permanently' },
          owner,
        ),
      ),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 200, 429, 429, 429]);
    const deleted = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.mailMessagesDeletedPermanently),
        ),
      );
    const total = deleted.reduce(
      (sum, row) => sum + Number((row.metadata as { count?: number } | null)?.count ?? 0),
      0,
    );
    expect(total).toBe(MAIL_DELETE_PERMANENT_DAILY_MAX);
    const pending = await harness.db
      .select({ value: count() })
      .from(mailMessages)
      .where(and(inArray(mailMessages.id, ids), eq(mailMessages.pendingAction, 'delete')));
    expect(pending[0]?.value).toBe(20);
  }, 30_000);
});

describe('S7 (api) — kuota cache lampiran dicek sebelum mengantre', () => {
  it('akun dengan cache 20 GB → 409 cache_full, tidak diantre', async () => {
    const { message } = await seedMessage();
    await harness.db.insert(mailAttachments).values(
      Array.from({ length: 10 }, (_, index) => ({
        organizationId,
        messageId: message.id,
        partId: `9.${String(index + 1)}`,
        sizeBytes: 2_000_000_000,
        storageKey: `mail/palsu-${randomBytes(6).toString('hex')}`,
      })),
    );
    const [pdf] = await harness.db
      .insert(mailAttachments)
      .values({
        organizationId,
        messageId: message.id,
        partId: '2',
        filename: 'a.pdf',
        sizeBytes: 1_000,
      })
      .returning();
    const response = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.mail.attachment, { attachmentId: pdf?.id ?? '' }),
      undefined,
      owner,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { details: [expect.objectContaining({ reason: 'cache_full' })] },
    });
  });
});

describe('R10 (sebagian) — rem pengambilan baru dari server email per pengguna', () => {
  it('email ke-61 yang isinya belum di cache dalam semenit → 429 (tidak mengantre LOGIN IMAP lagi)', async () => {
    const { account, folder } = await seedMessage();
    const rows = await harness.db
      .insert(mailMessages)
      .values(
        Array.from({ length: 61 }, (_, index) => ({
          organizationId,
          accountId: account.id,
          folderId: folder.id,
          folderRole: 'inbox' as const,
          uid: 3_000_000 + index,
          uidvalidity: 1,
          receivedAt: new Date(),
        })),
      )
      .returning({ id: mailMessages.id });
    const statuses: number[] = [];
    for (const row of rows) {
      const response = await call(
        harness.app,
        'GET',
        apiPath(API_ROUTES.mail.message, { messageId: row.id }),
        undefined,
        owner,
      );
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  }, 60_000);
});
