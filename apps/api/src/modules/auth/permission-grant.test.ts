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
  it('all: kondisi `true` (tetap digabung dengan organization_id oleh repo)', () => {
    const query = render(scopeCondition(grant('all'), { holder: conversations.assigneeUserId }));
    expect(query.sql).toBe('true');
    expect(query.params).toEqual([]);
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
    const unknown = { ...grant('all'), scope: 'department' } as unknown as PermissionGrant;
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
