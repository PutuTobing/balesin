/**
 * Review keamanan 9A bagian 2 — PUTARAN 2 (docs/security-reviews/2026-11-23-fase9a-2.md, bagian
 * "Putaran 2"). Postgres sungguhan + media store di direktori sementara; tanpa sambungan keluar.
 *
 * `it` = regresi. `it.fails` = temuan terbuka (asersi = perilaku yang DIHARAPKAN; gagal sekarang).
 * Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLogger,
  createMediaStore,
  createSecretBox,
  Secret,
  sealMailAccountSecret,
  type MediaStore,
} from '@balesin/core';
import {
  closeDb,
  createDb,
  mailAccounts,
  mailRemoteImageCache,
  newId,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { and, count, eq, lte } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runMailCacheRetention, type MailJobDeps } from '../queues/mail';

const secretBox = createSecretBox(new Secret(randomBytes(32)));
const logger = createLogger({ service: 'tes-review-9a2-p2', level: 'silent' });

let db: Database;
let mediaDir: string;
let store: MediaStore;

async function seedAccount() {
  const organization = await insertOrganization(db);
  await insertUser(db, organization.id, { role: 'owner' });
  const id = newId();
  await db.insert(mailAccounts).values({
    id,
    organizationId: organization.id,
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: 'cs@contoh.test',
    fromName: 'Tim CS',
    color: 'tagBlue',
    imapHost: 'imap.contoh.test',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: 'cs@contoh.test',
    imapPasswordEncrypted: sealMailAccountSecret(
      secretBox,
      { id, organizationId: organization.id },
      'imapPassword',
      'rahasia-imap-review-9a2-p2',
    ),
    smtpHost: 'imap.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    syncState: 'paused',
  });
  return { organizationId: organization.id, accountId: id };
}

beforeAll(async () => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-review-9a2-p2' });
  mediaDir = await mkdtemp(join(tmpdir(), 'balesin-review-9a2-p2-'));
  store = createMediaStore(mediaDir);
});

afterAll(async () => {
  await closeDb(db);
  await rm(mediaDir, { recursive: true, force: true });
});

describe('P2-S8 — cache proksi gambar: retensi tidak mengejar laju pengisian', () => {
  // Kuota 1 GB/organisasi (`rememberImage`) hanya menghitung baris BELUM kedaluwarsa; retensi
  // (`runMailCacheRetention`, sekali per 24 jam) menghapus maks. 5.000 baris kedaluwarsa per jalan
  // untuk SEMUA organisasi. Satu pengguna boleh 300 gambar/menit (≈ 432.000 entri unik/hari, mis.
  // 1×1 piksel ber-URL unik dari server IMAP milik CS) → baris & berkas kedaluwarsa menumpuk tanpa
  // batas di disk media store (bersama media WhatsApp) — juga dari pemakaian wajar.
  it('satu jalan retensi menghapus SEMUA cache gambar kedaluwarsa (backlog > 5.000 tidak tersisa)', async () => {
    const seed = await seedAccount();
    const expiresAt = new Date(Date.now() - 60_000);
    const rows = Array.from({ length: 6_000 }, () => ({
      organizationId: seed.organizationId,
      accountId: seed.accountId,
      urlHash: randomBytes(32).toString('hex'),
      // Baris saja: berkas yang tidak ada diabaikan saat dihapus (`store.remove` → catch).
      storageKey: `mail/${newId()}`,
      contentType: 'image/gif',
      sizeBytes: 43,
      expiresAt,
    }));
    for (let start = 0; start < rows.length; start += 1_000) {
      await db.insert(mailRemoteImageCache).values(rows.slice(start, start + 1_000));
    }
    await runMailCacheRetention({ db, store, logger } as unknown as MailJobDeps);
    const [left] = await db
      .select({ value: count() })
      .from(mailRemoteImageCache)
      .where(
        and(
          eq(mailRemoteImageCache.organizationId, seed.organizationId),
          lte(mailRemoteImageCache.expiresAt, new Date()),
        ),
      );
    expect(left?.value ?? 0).toBe(0);
  }, 120_000);

  it('retensi menghapus berkas cache kedaluwarsa; entri yang masih berlaku tidak disentuh', async () => {
    const seed = await seedAccount();
    const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
    const stale = await store.save('mail', gif);
    const fresh = await store.save('mail', gif);
    const base = {
      organizationId: seed.organizationId,
      accountId: seed.accountId,
      contentType: 'image/gif',
      sizeBytes: gif.length,
    };
    await db.insert(mailRemoteImageCache).values([
      {
        ...base,
        urlHash: randomBytes(32).toString('hex'),
        storageKey: stale.storageKey,
        expiresAt: new Date(Date.now() - 1_000),
      },
      {
        ...base,
        urlHash: randomBytes(32).toString('hex'),
        storageKey: fresh.storageKey,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ]);
    await runMailCacheRetention({ db, store, logger } as unknown as MailJobDeps);
    const left = await db
      .select({ storageKey: mailRemoteImageCache.storageKey })
      .from(mailRemoteImageCache)
      .where(eq(mailRemoteImageCache.organizationId, seed.organizationId));
    expect(left.map((row) => row.storageKey)).toEqual([fresh.storageKey]);
    expect(await store.open(stale.storageKey)).toBeNull();
    const kept = await store.open(fresh.storageKey);
    kept?.stream.destroy();
    expect(kept?.sizeBytes).toBe(gif.length);
  });
});
