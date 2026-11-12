import { normalizeEmail, USER_ROLES } from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { closeDb, createDb, pingDb, type Database } from './client';
import { PG_ERROR_CODES, isPgError } from './errors';
import { newId } from './ids';
import { auditLogs, organizations, userSessions, users } from './schema';
import {
  insertOrganization,
  insertUser,
  insertUserSession,
  pgErrorOf,
  uniqueSuffix,
} from './testing';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: Database;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test' });
});

afterAll(async () => {
  await closeDb(db);
});

describe('klien database', () => {
  it('pingDb berhasil terhadap Postgres yang hidup', async () => {
    await expect(pingDb(db)).resolves.toBeUndefined();
  });

  it('pingDb gagal bila Postgres tidak bisa dihubungi', async () => {
    const unreachable = createDb('postgres://balesin:sandi@127.0.0.1:1/balesin_test');
    await expect(pingDb(unreachable)).rejects.toThrow();
    await closeDb(unreachable);
  });
});

describe('ID dan waktu', () => {
  it('ID dibuat di aplikasi sebagai UUIDv7 yang berurutan menurut waktu', async () => {
    const first = await insertOrganization(db);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await insertOrganization(db);

    expect(first.id).toMatch(UUID_V7);
    expect(second.id).toMatch(UUID_V7);
    expect(second.id > first.id).toBe(true);
    expect(newId()).toMatch(UUID_V7);
  });

  it('created_at dan updated_at terisi otomatis; updated_at maju saat baris diubah', async () => {
    const organization = await insertOrganization(db);
    expect(organization.createdAt).toBeInstanceOf(Date);
    expect(organization.updatedAt.getTime()).toBe(organization.createdAt.getTime());
    expect(organization.timezone).toBe('Asia/Jakarta');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const [updated] = await db
      .update(organizations)
      .set({ name: 'Nama Baru' })
      .where(eq(organizations.id, organization.id))
      .returning();

    expect(updated?.name).toBe('Nama Baru');
    expect(updated?.createdAt.getTime()).toBe(organization.createdAt.getTime());
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(organization.updatedAt.getTime());
  });
});

describe('users', () => {
  it('email unik per organisasi', async () => {
    const organization = await insertOrganization(db);
    const email = `budi-${uniqueSuffix()}@contoh.test`;
    await insertUser(db, organization.id, { email });

    const error = await pgErrorOf(insertUser(db, organization.id, { email }));

    expect(error.code).toBe(PG_ERROR_CODES.uniqueViolation);
    expect(error.constraint).toBe('users_organization_id_email_unique');
  });

  it('email yang sama boleh dipakai di organisasi lain', async () => {
    const email = `sama-${uniqueSuffix()}@contoh.test`;
    const first = await insertOrganization(db);
    const second = await insertOrganization(db);

    await insertUser(db, first.id, { email });
    await expect(insertUser(db, second.id, { email })).resolves.toMatchObject({ email });
  });

  it('keunikan email tidak peduli huruf besar/kecil', async () => {
    const organization = await insertOrganization(db);
    const suffix = uniqueSuffix();
    await insertUser(db, organization.id, { email: `budi-${suffix}@contoh.test` });

    // Bentuk tidak baku ditolak database...
    for (const email of [`Budi-${suffix}@Contoh.TEST`, ` budi-${suffix}@contoh.test `]) {
      const error = await pgErrorOf(insertUser(db, organization.id, { email }));
      expect(error.code).toBe(PG_ERROR_CODES.checkViolation);
      expect(error.constraint).toBe('users_email_normalized');
    }

    // ...dan setelah dibakukan, bentrok dengan email yang sudah ada.
    const duplicate = insertUser(db, organization.id, {
      email: normalizeEmail(` Budi-${suffix}@Contoh.TEST `),
    });
    expect((await pgErrorOf(duplicate)).code).toBe(PG_ERROR_CODES.uniqueViolation);
  });

  it('menerima kelima peran dan menolak peran lain', async () => {
    const organization = await insertOrganization(db);
    for (const role of USER_ROLES) {
      await expect(insertUser(db, organization.id, { role })).resolves.toMatchObject({ role });
    }

    const invalid = db.execute(sql`
      insert into users (id, organization_id, email, name, password_hash, role)
      values (${newId()}, ${organization.id}, ${`x-${uniqueSuffix()}@contoh.test`}, 'X', 'hash', 'superadmin')
    `);
    expect((await pgErrorOf(invalid)).code).toBe(PG_ERROR_CODES.invalidTextRepresentation);
  });

  it('organisasi harus ada (foreign key)', async () => {
    const error = await pgErrorOf(insertUser(db, newId()));

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
    expect(error.constraint).toBe('users_organization_id_organizations_id_fk');
  });

  it('kolom wajib tidak boleh kosong', async () => {
    const organization = await insertOrganization(db);
    const missingPassword = db.execute(sql`
      insert into users (id, organization_id, email, name, role)
      values (${newId()}, ${organization.id}, ${`y-${uniqueSuffix()}@contoh.test`}, 'Y', 'cs')
    `);

    const error = await pgErrorOf(missingPassword);
    expect(error.code).toBe(PG_ERROR_CODES.notNullViolation);
    expect(error.column).toBe('password_hash');
  });

  it('organisasi yang masih punya pengguna tidak bisa dihapus', async () => {
    const organization = await insertOrganization(db);
    await insertUser(db, organization.id);

    const error = await pgErrorOf(
      db.delete(organizations).where(eq(organizations.id, organization.id)),
    );
    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
  });

  it('isPgError mengenali error yang dibungkus Drizzle', async () => {
    const organization = await insertOrganization(db);
    const email = `cek-${uniqueSuffix()}@contoh.test`;
    await insertUser(db, organization.id, { email });

    const failure = await insertUser(db, organization.id, { email }).catch(
      (error: unknown) => error,
    );

    expect(isPgError(failure, PG_ERROR_CODES.uniqueViolation)).toBe(true);
    expect(
      isPgError(failure, PG_ERROR_CODES.uniqueViolation, 'users_organization_id_email_unique'),
    ).toBe(true);
    expect(isPgError(failure, PG_ERROR_CODES.uniqueViolation, 'constraint_lain')).toBe(false);
    expect(isPgError(failure, PG_ERROR_CODES.foreignKeyViolation)).toBe(false);
    expect(isPgError(new Error('biasa'), PG_ERROR_CODES.uniqueViolation)).toBe(false);
  });
});

describe('user_sessions', () => {
  it('menyimpan hash token, IP, user agent, dan kedua batas kedaluwarsa', async () => {
    const user = await insertUser(db, (await insertOrganization(db)).id);
    const session = await insertUserSession(db, user, {
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (tes)',
    });

    expect(session.id).toMatch(UUID_V7);
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.ipAddress).toBe('203.0.113.7');
    expect(session.userAgent).toBe('Mozilla/5.0 (tes)');
    expect(session.revokedAt).toBeNull();
    expect(session.lastSeenAt).toBeInstanceOf(Date);
    expect(session.idleExpiresAt.getTime()).toBeLessThan(session.absoluteExpiresAt.getTime());
  });

  it('hash token unik', async () => {
    const user = await insertUser(db, (await insertOrganization(db)).id);
    const session = await insertUserSession(db, user);

    const error = await pgErrorOf(insertUserSession(db, user, { tokenHash: session.tokenHash }));

    expect(error.code).toBe(PG_ERROR_CODES.uniqueViolation);
    expect(error.constraint).toBe('user_sessions_token_hash_unique');
  });

  it('kedaluwarsa idle tidak boleh melewati kedaluwarsa absolut', async () => {
    const user = await insertUser(db, (await insertOrganization(db)).id);
    const now = Date.now();

    const error = await pgErrorOf(
      insertUserSession(db, user, {
        idleExpiresAt: new Date(now + 2 * 60 * 60 * 1000),
        absoluteExpiresAt: new Date(now + 60 * 60 * 1000),
      }),
    );

    expect(error.code).toBe(PG_ERROR_CODES.checkViolation);
    expect(error.constraint).toBe('user_sessions_idle_within_absolute');
  });

  it('pengguna harus ada, dan alamat IP harus valid', async () => {
    const organization = await insertOrganization(db);
    const user = await insertUser(db, organization.id);

    const unknownUser = insertUserSession(db, { id: newId(), organizationId: organization.id });
    expect((await pgErrorOf(unknownUser)).code).toBe(PG_ERROR_CODES.foreignKeyViolation);

    const badIp = insertUserSession(db, user, { ipAddress: 'bukan-ip' });
    expect((await pgErrorOf(badIp)).code).toBe(PG_ERROR_CODES.invalidTextRepresentation);
  });

  it('menghapus pengguna ikut menghapus sesinya', async () => {
    const user = await insertUser(db, (await insertOrganization(db)).id);
    await insertUserSession(db, user);
    await insertUserSession(db, user);

    await db.delete(users).where(eq(users.id, user.id));

    const remaining = await db.select().from(userSessions).where(eq(userSessions.userId, user.id));
    expect(remaining).toEqual([]);
  });
});

describe('audit_logs', () => {
  it('mencatat aksi dengan atau tanpa pelaku; metadata bawaan objek kosong', async () => {
    const organization = await insertOrganization(db);
    const user = await insertUser(db, organization.id, { role: 'owner' });

    const [byUser] = await db
      .insert(auditLogs)
      .values({
        organizationId: organization.id,
        actorUserId: user.id,
        action: 'user.invite',
        targetType: 'user',
        targetId: newId(),
        metadata: { role: 'cs' },
        ipAddress: '2001:db8::1',
      })
      .returning();
    const [bySystem] = await db
      .insert(auditLogs)
      .values({ organizationId: organization.id, action: 'auth.login.failed' })
      .returning();

    expect(byUser).toMatchObject({ actorUserId: user.id, metadata: { role: 'cs' } });
    expect(byUser?.ipAddress).toBe('2001:db8::1');
    expect(byUser?.id).toMatch(UUID_V7);
    expect(bySystem).toMatchObject({ actorUserId: null, metadata: {}, targetType: null });
    expect(bySystem?.createdAt).toBeInstanceOf(Date);
  });

  it('pengguna yang punya jejak audit tidak bisa dihapus', async () => {
    const organization = await insertOrganization(db);
    const user = await insertUser(db, organization.id);
    await db
      .insert(auditLogs)
      .values({ organizationId: organization.id, actorUserId: user.id, action: 'auth.login' });

    const error = await pgErrorOf(db.delete(users).where(eq(users.id, user.id)));

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
    expect(error.constraint).toBe('audit_logs_organization_id_actor_user_id_fk');
  });

  it('organisasi harus ada', async () => {
    const error = await pgErrorOf(
      db.insert(auditLogs).values({ organizationId: newId(), action: 'x' }),
    );
    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
  });
});
