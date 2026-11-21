import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPE_LABELS,
  AUDIT_TARGET_TYPES,
  SECURITY_EVENT_KINDS,
  SECURITY_EVENT_LABELS,
  SECURITY_EVENT_SEVERITY,
  auditActionLabel,
  auditLogListQuerySchema,
} from './audit';
import { INVITE_PERMISSIONS } from './invitations';
import { hasPermission } from './permissions';
import { USER_ROLES } from './roles';
import {
  MANAGE_PERMISSIONS,
  assignableRoles,
  canManageRole,
  changeUserRoleRequestSchema,
  identityConfirmationSchema,
} from './team';

describe('matriks kelola pengguna', () => {
  it('hanya pemegang team.manage yang bisa mengelola siapa pun', () => {
    for (const role of USER_ROLES) {
      expect(MANAGE_PERMISSIONS[role].length > 0, role).toBe(hasPermission(role, 'team.manage'));
    }
  });

  it('Owner mengelola semua peran; Admin tidak Owner dan tidak Admin', () => {
    for (const target of USER_ROLES) expect(canManageRole('owner', target)).toBe(true);
    expect(canManageRole('admin', 'owner')).toBe(false);
    expect(canManageRole('admin', 'admin')).toBe(false);
    for (const target of ['supervisor', 'cs', 'teknisi'] as const) {
      expect(canManageRole('admin', target)).toBe(true);
    }
    for (const actor of ['supervisor', 'cs', 'teknisi'] as const) {
      for (const target of USER_ROLES) expect(canManageRole(actor, target)).toBe(false);
    }
  });

  it('peran yang bisa diberikan = peran yang bisa diundang; Owner tidak pernah', () => {
    for (const role of USER_ROLES) {
      expect(assignableRoles(role)).toEqual(INVITE_PERMISSIONS[role]);
      expect(assignableRoles(role)).not.toContain('owner');
      // Tidak ada yang bisa memberi peran yang tidak bisa ia kelola sesudahnya.
      for (const assigned of assignableRoles(role)) {
        expect(canManageRole(role, assigned)).toBe(true);
      }
    }
    expect(
      changeUserRoleRequestSchema.safeParse({ role: 'owner', password: 'abcdefghij' }).success,
    ).toBe(false);
  });

  it('konfirmasi identitas: password wajib, kode dibakukan', () => {
    expect(identityConfirmationSchema.safeParse({}).success).toBe(false);
    expect(identityConfirmationSchema.parse({ password: 'x', code: '123 456' }).code).toBe(
      '123456',
    );
    expect(identityConfirmationSchema.safeParse({ password: 'x', code: 'abc' }).success).toBe(
      false,
    );
  });
});

describe('aksi & kejadian audit', () => {
  it('setiap aksi punya label bahasa Indonesia; nama unik', () => {
    expect(new Set(AUDIT_ACTION_NAMES).size).toBe(Object.keys(AUDIT_ACTIONS).length);
    expect(Object.keys(AUDIT_ACTION_LABELS).sort()).toEqual([...AUDIT_ACTION_NAMES].sort());
    for (const label of Object.values(AUDIT_ACTION_LABELS)) {
      expect(label).not.toMatch(/\bAnda\b|TODO|Lorem/);
    }
    expect(auditActionLabel('auth.logout')).toBe('Keluar');
    expect(auditActionLabel('aksi.masa.depan')).toBe('aksi.masa.depan');
    expect(auditActionLabel('toString')).toBe('toString');
  });

  it('jenis target dan kejadian keamanan lengkap', () => {
    expect(Object.keys(AUDIT_TARGET_TYPE_LABELS).sort()).toEqual([...AUDIT_TARGET_TYPES].sort());
    for (const kind of SECURITY_EVENT_KINDS) {
      expect(SECURITY_EVENT_LABELS[kind]).toBeTruthy();
      expect(['warning', 'info']).toContain(SECURITY_EVENT_SEVERITY[kind]);
    }
  });

  it('saringan daftar: rentang terbalik, batas halaman, dan aksi tak dikenal ditolak', () => {
    expect(
      auditLogListQuerySchema.safeParse({
        from: '2026-11-14T00:00:00.000Z',
        to: '2026-11-13T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(auditLogListQuerySchema.parse({ limit: '25' }).limit).toBe(25);
    expect(auditLogListQuerySchema.safeParse({ action: 'drop table' }).success).toBe(false);
  });
});
