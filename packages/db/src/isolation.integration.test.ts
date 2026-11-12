import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { closeDb, createDb, type Database } from './client';
import { PG_ERROR_CODES } from './errors';
import { auditLogs, userSessions, users } from './schema';
import { insertOrganization, insertUser, insertUserSession, pgErrorOf } from './testing';

let db: Database;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test' });
});

afterAll(async () => {
  await closeDb(db);
});

/** Dua organisasi, masing-masing dengan satu pengguna, satu sesi, dan satu audit log. */
async function seedTwoOrganizations() {
  const orgA = await insertOrganization(db, { name: 'Organisasi A' });
  const orgB = await insertOrganization(db, { name: 'Organisasi B' });
  const userA = await insertUser(db, orgA.id, { name: 'Pengguna A' });
  const userB = await insertUser(db, orgB.id, { name: 'Pengguna B' });
  const sessionA = await insertUserSession(db, userA);
  const sessionB = await insertUserSession(db, userB);
  await db.insert(auditLogs).values([
    { organizationId: orgA.id, actorUserId: userA.id, action: 'auth.login' },
    { organizationId: orgB.id, actorUserId: userB.id, action: 'auth.login' },
  ]);
  return { orgA, orgB, userA, userB, sessionA, sessionB };
}

describe('isolasi organization_id', () => {
  it('query yang difilter organization_id hanya melihat data organisasinya sendiri', async () => {
    const { orgA, orgB, userA, userB, sessionA, sessionB } = await seedTwoOrganizations();

    const usersOfA = await db.select().from(users).where(eq(users.organizationId, orgA.id));
    const sessionsOfA = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.organizationId, orgA.id));
    const logsOfB = await db.select().from(auditLogs).where(eq(auditLogs.organizationId, orgB.id));

    expect(usersOfA.map((user) => user.id)).toEqual([userA.id]);
    expect(sessionsOfA.map((session) => session.id)).toEqual([sessionA.id]);
    expect(logsOfB.map((log) => log.actorUserId)).toEqual([userB.id]);
    expect(sessionsOfA.map((session) => session.id)).not.toContain(sessionB.id);
  });

  it('ID milik organisasi lain tidak ditemukan bila filter organization_id dipasang', async () => {
    const { orgA, userB, sessionB } = await seedTwoOrganizations();

    const foreignUser = await db
      .select()
      .from(users)
      .where(and(eq(users.organizationId, orgA.id), eq(users.id, userB.id)));
    const revoked = await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.organizationId, orgA.id), eq(userSessions.id, sessionB.id)))
      .returning();
    const [untouched] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, sessionB.id));

    expect(foreignUser).toEqual([]);
    expect(revoked).toEqual([]);
    expect(untouched?.revokedAt).toBeNull();
  });

  it('sesi tidak bisa merujuk pengguna dari organisasi lain', async () => {
    const { orgB, userA } = await seedTwoOrganizations();

    const error = await pgErrorOf(insertUserSession(db, { id: userA.id, organizationId: orgB.id }));

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
    expect(error.constraint).toBe('user_sessions_organization_id_user_id_fk');
  });

  it('audit log tidak bisa memakai pelaku dari organisasi lain', async () => {
    const { orgB, userA } = await seedTwoOrganizations();

    const error = await pgErrorOf(
      db
        .insert(auditLogs)
        .values({ organizationId: orgB.id, actorUserId: userA.id, action: 'user.update' }),
    );

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
    expect(error.constraint).toBe('audit_logs_organization_id_actor_user_id_fk');
  });

  it('pengguna tidak bisa dipindah ke organisasi lain selagi punya sesi atau jejak audit', async () => {
    const { orgB, userA } = await seedTwoOrganizations();

    const error = await pgErrorOf(
      db.update(users).set({ organizationId: orgB.id }).where(eq(users.id, userA.id)),
    );

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
  });

  it('sesi tidak bisa dipindah ke organisasi lain', async () => {
    const { orgB, sessionA } = await seedTwoOrganizations();

    const error = await pgErrorOf(
      db
        .update(userSessions)
        .set({ organizationId: orgB.id })
        .where(eq(userSessions.id, sessionA.id)),
    );

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
  });
});
