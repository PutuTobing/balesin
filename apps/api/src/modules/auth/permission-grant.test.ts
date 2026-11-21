import { and, eq, sql } from 'drizzle-orm';
import { PgDialect, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { assertWithinScope, scopeCondition, type PermissionGrant } from './permission-grant';

/** Tabel contoh (bukan tabel sungguhan) untuk melihat SQL yang dihasilkan. */
const conversations = pgTable('contoh_percakapan', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  assigneeUserId: uuid('assignee_user_id'),
  subject: text('subject'),
});

const dialect = new PgDialect();
const render = (condition: ReturnType<typeof scopeCondition>) => dialect.sqlToQuery(condition);

const USER = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-0000000000b1';
const grant = (scope: PermissionGrant['scope']): PermissionGrant => ({
  permission: 'inbox.view',
  scope,
  userId: USER,
  organizationId: ORG,
});

describe('scopeCondition (filter daftar bercakupan)', () => {
  it('all pada izin tanpa penyempitan departemen: kondisi `true`', () => {
    const query = render(
      scopeCondition(
        { ...grant('all'), permission: 'contacts.view' },
        { holder: conversations.assigneeUserId },
      ),
    );
    expect(query.sql).toBe('true');
    expect(query.params).toEqual([]);
  });

  it('all pada izin percakapan/tiket (Fase 5): bebas KECUALI pengguna Supervisor/CS bertanda departemen', () => {
    const query = render(
      scopeCondition(grant('all'), {
        holder: conversations.assigneeUserId,
        department: sql`contoh_percakapan.department_id`,
      }),
    );
    expect(query.sql).toBe(
      `(not exists (select 1 from "users" where "users"."organization_id" = $1 and "users"."id" = $2 and "users"."department_restricted" and "users"."role" in ('supervisor', 'cs')) or ("contoh_percakapan"."assignee_user_id" = $3 or contoh_percakapan.department_id in (select "department_members"."department_id" from "department_members" where "department_members"."organization_id" = $4 and "department_members"."user_id" = $5)))`,
    );
    expect(query.params).toEqual([ORG, USER, USER, ORG, USER]);
  });

  it('department: pemegang langsung, tiket tertaut, atau departemen pengguna — tanpa jalan keluar', () => {
    const query = render(
      scopeCondition(grant('department'), {
        holder: conversations.assigneeUserId,
        linkedTicketHolder: (userId) =>
          sql`exists (select 1 from contoh_tiket where a = ${userId})`,
      }),
    );
    expect(query.sql).toBe(
      '("contoh_percakapan"."assignee_user_id" = $1 or exists (select 1 from contoh_tiket where a = $2))',
    );
  });

  it('assigned tanpa tiket: hanya pemegang langsung = pengguna itu', () => {
    const query = render(
      scopeCondition(grant('assigned'), { holder: conversations.assigneeUserId }),
    );
    expect(query.sql).toBe('"contoh_percakapan"."assignee_user_id" = $1');
    expect(query.params).toEqual([USER]);
  });

  it('assigned + tiket tertaut: pemegang langsung ATAU kondisi tiket untuk pengguna yang sama', () => {
    const query = render(
      scopeCondition(grant('assigned'), {
        holder: conversations.assigneeUserId,
        linkedTicketHolder: (userId) =>
          sql`exists (select 1 from contoh_tiket where contoh_tiket.assignee_user_id = ${userId})`,
      }),
    );
    expect(query.sql).toBe(
      '("contoh_percakapan"."assignee_user_id" = $1 or exists (select 1 from contoh_tiket where contoh_tiket.assignee_user_id = $2))',
    );
    expect(query.params).toEqual([USER, USER]);
  });

  it('own: hanya pemegang langsung; kondisi tiket tertaut TIDAK dipakai', () => {
    const query = render(
      scopeCondition(grant('own'), {
        holder: conversations.assigneeUserId,
        linkedTicketHolder: () => sql`true`,
      }),
    );
    expect(query.sql).toBe('"contoh_percakapan"."assignee_user_id" = $1');
  });

  it('pemegang jamak lewat fungsi; bisa digabung dengan filter organisasi', () => {
    const condition = and(
      eq(conversations.organizationId, ORG),
      scopeCondition(grant('assigned'), {
        holder: (userId) => sql`exists (select 1 from contoh_peserta where user_id = ${userId})`,
      }),
    );
    if (!condition) throw new Error('kondisi kosong');
    const query = dialect.sqlToQuery(condition);
    expect(query.sql).toBe(
      '("contoh_percakapan"."organization_id" = $1 and exists (select 1 from contoh_peserta where user_id = $2))',
    );
    expect(query.params).toEqual([ORG, USER]);
  });

  it('cakupan asing (lolos dari tipe) ditolak, tidak pernah menjadi "tanpa filter"', () => {
    const unknown = { ...grant('all'), scope: 'regional' } as unknown as PermissionGrant;
    expect(() => scopeCondition(unknown, { holder: conversations.assigneeUserId })).toThrow(
      'Cakupan izin tidak dikenal',
    );
  });
});

describe('assertWithinScope', () => {
  it('di luar cakupan → 404 NOT_FOUND; di dalam → lolos', () => {
    expect(() => assertWithinScope(grant('assigned'), { holderUserIds: [USER] })).not.toThrow();
    expect(() => assertWithinScope(grant('assigned'), { holderUserIds: [] })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }) as Error,
    );
  });
});
