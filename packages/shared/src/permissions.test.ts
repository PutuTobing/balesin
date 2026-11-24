import { describe, expect, it } from 'vitest';

import { meResponseSchema } from './auth';
import { INVITE_PERMISSIONS } from './invitations';
import {
  DEPARTMENT_SCOPED_PERMISSIONS,
  effectivePermissionScope,
  hasPermission,
  isWithinScope,
  PERMISSION_LABELS,
  PERMISSION_SCOPE_LABELS,
  PERMISSIONS,
  permissionScope,
  permissionsForRole,
  ROLE_PERMISSIONS,
  rolesWithPermission,
  SCOPED_PERMISSIONS,
  type Permission,
  type PermissionScope,
} from './permissions';
import { USER_ROLES, type UserRole } from './roles';

/**
 * Salinan TERTULIS matriks PRD §4 (+ keputusan RBAC Fase 1 butir 5). Sengaja ditulis ulang, bukan
 * dibaca dari `MATRIX`: mengubah izin peran mana pun harus mengubah dua tempat, dan diff tes ini
 * yang dibaca `security` saat review.
 *
 * Kolom: Owner, Admin, Supervisor, CS, Teknisi. `-` = tidak boleh.
 */
const EXPECTED: Record<Permission, string> = {
  'organization.manage': 'all  -        -    -    -',
  'backup.manage': 'all  -        -    -    -',
  'channels.manage': 'all  all      -    -    -',
  'settings.email.manage': 'all  all      -    -    -',
  'settings.workspace.manage': 'all  all      -    -    -',
  'sending.limits.manage': 'all  all      -    -    -',
  'api_keys.manage': 'all  all      -    -    -',
  'integrations.manage': 'all  all      -    -    -',
  'team.invite': 'all  all      -    -    -',
  'team.manage': 'all  all      -    -    -',
  'audit.view': 'all  all      -    -    -',
  'broadcast.send': 'all  all      all  -    -',
  'broadcast.approve': 'all  all      -    -    -',
  'sending.resume': 'all  all      -    -    -',
  'templates.manage': 'all  all      all  -    -',
  'quick_replies.manage': 'all  all      all  -    -',
  'inbox.view': 'all  all      all  all  assigned',
  'inbox.reply': 'all  all      all  all  assigned',
  'inbox.initiate': 'all  all      all  -    -',
  'inbox.assign': 'all  all      all  all  -',
  'inbox.notes.moderate': 'all  all      -    -    -',
  'contacts.view': 'all  all      all  all  assigned',
  'contacts.manage': 'all  all      all  all  -',
  'contacts.export': 'all  all      all  -    -',
  'contacts.delete': 'all  all      -    -    -',
  'tickets.manage': 'all  all      all  all  own',
  'tickets.configure': 'all  all      all  -    -',
  'reports.view': 'all  all      all  own  own',
  // Fase 9 (Email): hak nyata per akun (`resolveMailAccess`), izin hanya pintu masuk.
  'mail.accounts.manage': 'all  all      -    -    -',
  'mail.view': 'all  all      all  all  all',
  'mail.send': 'all  all      all  all  all',
  'mail.private.own': 'all  all      all  all  -',
};

function expectedScope(permission: Permission, role: UserRole): PermissionScope | null {
  const cells = EXPECTED[permission].split(/\s+/);
  const cell = cells[USER_ROLES.indexOf(role)];
  return cell === '-' || cell === undefined ? null : (cell as PermissionScope);
}

describe('matriks izin', () => {
  it('setiap izin punya baris di tabel tertulis, dan sebaliknya', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(USER_ROLES)('peran %s: cakupan setiap izin persis seperti tabel', (role) => {
    for (const permission of PERMISSIONS) {
      expect(permissionScope(role, permission), `${role} × ${permission}`).toBe(
        expectedScope(permission, role),
      );
    }
  });

  it('nama izin unik dan berbentuk domain.aksi', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it('Owner memegang semua izin dengan cakupan penuh', () => {
    for (const permission of PERMISSIONS) {
      expect(permissionScope('owner', permission), permission).toBe('all');
    }
  });

  it('wewenang tidak pernah bertambah ke peran yang lebih rendah (Owner ⊇ Admin ⊇ Supervisor ⊇ CS)', () => {
    const rank: Record<PermissionScope, number> = { own: 1, assigned: 2, department: 3, all: 4 };
    const ladder: UserRole[] = ['owner', 'admin', 'supervisor', 'cs'];
    for (const permission of PERMISSIONS) {
      for (let i = 1; i < ladder.length; i += 1) {
        const higher = permissionScope(ladder[i - 1] as UserRole, permission);
        const lower = permissionScope(ladder[i] as UserRole, permission);
        if (lower === null) continue;
        expect(higher, `${ladder[i - 1]} vs ${ladder[i]} × ${permission}`).not.toBeNull();
        expect(rank[higher as PermissionScope]).toBeGreaterThanOrEqual(rank[lower]);
      }
    }
  });

  it('hanya izin bercakupan yang boleh punya cakupan terbatas', () => {
    for (const role of USER_ROLES) {
      for (const permission of PERMISSIONS) {
        const scope = permissionScope(role, permission);
        if (scope !== null && scope !== 'all') {
          expect(SCOPED_PERMISSIONS as readonly string[], `${role} × ${permission}`).toContain(
            permission,
          );
        }
      }
    }
  });

  it('SECURITY.md §5: CS dan Teknisi tidak bisa broadcast; persetujuan hanya Owner/Admin', () => {
    expect(rolesWithPermission('broadcast.send')).toEqual(['owner', 'admin', 'supervisor']);
    expect(rolesWithPermission('broadcast.approve')).toEqual(['owner', 'admin']);
    expect(rolesWithPermission('sending.resume')).toEqual(['owner', 'admin']);
    expect(rolesWithPermission('sending.limits.manage')).toEqual(['owner', 'admin']);
    // Memulai percakapan ke nomor baru (kirim template ke nomor tanpa percakapan) = setara
    // broadcast satu per satu; CS/Teknisi hanya membalas percakapan yang sudah ada (review S2).
    expect(rolesWithPermission('inbox.initiate')).toEqual(['owner', 'admin', 'supervisor']);
    expect(hasPermission('cs', 'inbox.reply')).toBe(true);
  });

  it('SECURITY.md §2: Teknisi hanya percakapan yang di-assign/terkait tiketnya', () => {
    expect(permissionScope('teknisi', 'inbox.view')).toBe('assigned');
    expect(permissionScope('teknisi', 'inbox.reply')).toBe('assigned');
    expect(hasPermission('teknisi', 'inbox.assign')).toBe(false);
    expect(rolesWithPermission('inbox.view', { fullScopeOnly: true })).toEqual([
      'owner',
      'admin',
      'supervisor',
      'cs',
    ]);
  });

  it('Fase 9: akun email bersama hanya dikelola Owner/Admin; Teknisi tidak menghubungkan akun pribadi', () => {
    expect(rolesWithPermission('mail.accounts.manage')).toEqual(['owner', 'admin']);
    expect(rolesWithPermission('mail.private.own')).toEqual(['owner', 'admin', 'supervisor', 'cs']);
    // `mail.view`/`mail.send` hanya pintu: tanpa hak per akun tidak ada yang terbuka.
    expect(rolesWithPermission('mail.view')).toEqual([...USER_ROLES]);
  });

  it('peran yang bisa mengundang = peran dengan izin team.invite (dua tabel tidak boleh menyimpang)', () => {
    for (const role of USER_ROLES) {
      expect(INVITE_PERMISSIONS[role].length > 0, role).toBe(hasPermission(role, 'team.invite'));
    }
  });

  it('kunci prototipe / nilai asing bukan izin (review R2)', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      for (const role of USER_ROLES) {
        expect(hasPermission(role, key as Permission), `${role} × ${key}`).toBe(false);
        expect(permissionScope(role, key as Permission), `${role} × ${key}`).toBeNull();
      }
      expect(hasPermission(key as UserRole, 'inbox.view'), key).toBe(false);
    }
    expect(Object.getPrototypeOf(ROLE_PERMISSIONS.cs)).toBeNull();
  });

  it('permissionsForRole berurutan seperti PERMISSIONS dan tidak bisa diubah dari luar', () => {
    expect(permissionsForRole('teknisi')).toEqual([
      'inbox.view',
      'inbox.reply',
      'contacts.view',
      'tickets.manage',
      'reports.view',
      'mail.view',
      'mail.send',
    ]);
    expect(permissionsForRole('owner')).toEqual([...PERMISSIONS]);
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ROLE_PERMISSIONS.cs)).toBe(true);
  });

  it('setiap izin dan cakupan punya label bahasa Indonesia', () => {
    for (const permission of PERMISSIONS) expect(PERMISSION_LABELS[permission]).toBeTruthy();
    expect(Object.keys(PERMISSION_SCOPE_LABELS).sort()).toEqual([
      'all',
      'assigned',
      'department',
      'own',
    ]);
  });
});

describe('isWithinScope', () => {
  const me = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  const dept = '00000000-0000-4000-8000-0000000000d1';
  const otherDept = '00000000-0000-4000-8000-0000000000d2';

  it('department: departemen sendiri, dipegang langsung, atau lewat tiket — selain itu tidak', () => {
    expect(isWithinScope('department', me, { holderUserIds: [], departmentId: dept }, [dept])).toBe(
      true,
    );
    expect(
      isWithinScope('department', me, { holderUserIds: [], departmentId: otherDept }, [dept]),
    ).toBe(false);
    expect(isWithinScope('department', me, { holderUserIds: [], departmentId: null }, [dept])).toBe(
      false,
    );
    expect(isWithinScope('department', me, { holderUserIds: [me], departmentId: null }, [])).toBe(
      true,
    );
    expect(
      isWithinScope('department', me, { holderUserIds: [other], linkedTicketHolderUserIds: [me] }),
    ).toBe(true);
    expect(isWithinScope('department', me, { holderUserIds: [other] })).toBe(false);
    // S1: tiket yang ia pegang tidak membuka percakapan departemen LAIN.
    expect(
      isWithinScope(
        'department',
        me,
        { holderUserIds: [other], linkedTicketHolderUserIds: [me], departmentId: otherDept },
        [dept],
      ),
    ).toBe(false);
  });

  it('effectivePermissionScope: hanya `all` pada izin departemen yang disempitkan', () => {
    const restricted = { departmentRestricted: true };
    const free = { departmentRestricted: false };
    expect(effectivePermissionScope('cs', 'inbox.view', restricted)).toBe('department');
    expect(effectivePermissionScope('cs', 'inbox.view', free)).toBe('all');
    expect(effectivePermissionScope('cs', 'tickets.manage', restricted)).toBe('department');
    expect(effectivePermissionScope('supervisor', 'inbox.assign', restricted)).toBe('department');
    // Kontak & izin tanpa cakupan tidak disempitkan; Teknisi tetap `assigned`/`own`.
    expect(effectivePermissionScope('cs', 'contacts.view', restricted)).toBe('all');
    expect(effectivePermissionScope('admin', 'channels.manage', restricted)).toBe('all');
    // Owner/Admin selalu penuh walau tandanya tertinggal (mis. setelah naik peran).
    expect(effectivePermissionScope('admin', 'inbox.view', restricted)).toBe('all');
    expect(effectivePermissionScope('owner', 'tickets.manage', restricted)).toBe('all');
    expect(effectivePermissionScope('teknisi', 'inbox.view', restricted)).toBe('assigned');
    expect(effectivePermissionScope('teknisi', 'tickets.manage', restricted)).toBe('own');
    expect(effectivePermissionScope('cs', 'broadcast.send', restricted)).toBeNull();
    for (const permission of DEPARTMENT_SCOPED_PERMISSIONS) {
      // Semua izin yang disempitkan adalah izin berdata: Owner memegangnya dengan cakupan `all`.
      expect(permissionScope('owner', permission)).toBe('all');
    }
  });

  it('all: selalu boleh', () => {
    expect(isWithinScope('all', me, { holderUserIds: [] })).toBe(true);
  });

  it('assigned: dipegang langsung ATAU lewat tiket yang menautnya', () => {
    expect(isWithinScope('assigned', me, { holderUserIds: [me] })).toBe(true);
    expect(
      isWithinScope('assigned', me, { holderUserIds: [other], linkedTicketHolderUserIds: [me] }),
    ).toBe(true);
    expect(isWithinScope('assigned', me, { holderUserIds: [other] })).toBe(false);
    expect(isWithinScope('assigned', me, { holderUserIds: [] })).toBe(false);
  });

  it('own: hanya yang dipegang langsung (tiket orang lain yang menaut tidak dihitung)', () => {
    expect(isWithinScope('own', me, { holderUserIds: [me] })).toBe(true);
    expect(
      isWithinScope('own', me, { holderUserIds: [other], linkedTicketHolderUserIds: [me] }),
    ).toBe(false);
  });
});

describe('respons sesi membawa izin', () => {
  const session = {
    status: 'authenticated',
    user: { id: '00000000-0000-4000-8000-000000000001', name: 'A', email: 'a@b.test', role: 'cs' },
    organization: {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'O',
      timezone: 'Asia/Jakarta',
    },
    csrfToken: 'x',
    session: {
      idleExpiresAt: '2026-11-14T00:00:00.000Z',
      absoluteExpiresAt: '2026-12-14T00:00:00.000Z',
    },
  };

  it('daftar izin dipertahankan; izin tak dikenal ditolak', () => {
    const permissions = permissionsForRole('cs');
    expect(meResponseSchema.parse({ ...session, permissions }).permissions).toEqual(permissions);
    expect(() => meResponseSchema.parse({ ...session, permissions: ['superuser'] })).toThrow();
  });

  it('klien lama tanpa field izin tetap lolos (tambahan, bukan perubahan bentuk)', () => {
    expect(meResponseSchema.parse(session).permissions).toBeUndefined();
  });
});
