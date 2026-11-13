import { LOGO_MAX_BYTES } from '@balesin/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { closeDb, createDb, type Database } from './client';
import { PG_ERROR_CODES } from './errors';
import {
  auditLogs,
  emailSettings,
  installation,
  organizationLogos,
  organizations,
  users,
  type NewEmailSettings,
} from './schema';
import {
  createTemporaryDatabase,
  insertOrganization,
  insertUser,
  pgErrorOf,
  type TemporaryDatabase,
} from './testing';

/**
 * Tabel dan kolom Fase 1 (setup, login, email pengirim). Memakai database sementara SENDIRI:
 * `installation` hanya boleh punya satu baris, jadi tidak bisa berbagi database dengan berkas
 * tes lain yang berjalan paralel.
 */
let database: TemporaryDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTemporaryDatabase(inject('testDatabaseBaseUrl'));
  db = createDb(database.url, { applicationName: 'balesin-test-fase1' });
});

afterAll(async () => {
  await closeDb(db);
  await database.drop();
});

function emailSettingsRow(organizationId: string): NewEmailSettings {
  return {
    organizationId,
    fromName: 'Balesin Contoh',
    fromAddress: 'cs@contoh.test',
    host: 'mail.contoh.test',
    port: 465,
    security: 'ssl',
    username: 'cs@contoh.test',
    passwordEncrypted: 'v1.nonce.sandi',
    passwordTail: 'abcd',
  };
}

describe('installation — setup hanya bisa selesai sekali', () => {
  it('menolak baris kedua, nilai singleton selain true, dan dua insert bersamaan', async () => {
    const first = await insertOrganization(db);
    const second = await insertOrganization(db);

    const notTrue = await pgErrorOf(
      db.insert(installation).values({ singleton: false, organizationId: first.id }),
    );
    expect(notTrue.code).toBe(PG_ERROR_CODES.checkViolation);
    expect(notTrue.constraint).toBe('installation_singleton');

    // Dua setup bersamaan: tepat satu yang menang.
    const results = await Promise.allSettled([
      db.insert(installation).values({ organizationId: first.id }),
      db.insert(installation).values({ organizationId: second.id }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const again = await pgErrorOf(db.insert(installation).values({ organizationId: second.id }));
    expect(again.code).toBe(PG_ERROR_CODES.uniqueViolation);
    expect(await db.select().from(installation)).toHaveLength(1);
  });

  it('organisasi milik instalasi tidak bisa dihapus', async () => {
    const [row] = await db.select().from(installation);
    if (!row) throw new Error('baris installation belum ada');

    const error = await pgErrorOf(
      db.delete(organizations).where(eq(organizations.id, row.organizationId)),
    );

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
  });
});

describe('organizations — branding', () => {
  it('warna utama harus #rrggbb huruf kecil; kosong diterima', async () => {
    const ok = await insertOrganization(db, {
      brandColor: '#1b3557',
      productName: 'Balesin Contoh',
    });
    const empty = await insertOrganization(db);

    expect(ok.brandColor).toBe('#1b3557');
    expect(empty).toMatchObject({ brandColor: null, productName: null });
    for (const brandColor of ['#1B3557', '1b3557', '#fff', 'red', '#1b3557; drop']) {
      const error = await pgErrorOf(
        db.insert(organizations).values({ name: 'Organisasi Warna Salah', brandColor }),
      );
      expect(error.constraint, brandColor).toBe('organizations_brand_color_hex');
    }
  });
});

describe('users — kunci akun', () => {
  it('pengguna baru tidak terkunci dan belum pernah masuk', async () => {
    const user = await insertUser(db, (await insertOrganization(db)).id);

    expect(user).toMatchObject({ lockedUntil: null, lastLoginAt: null });
  });
});

describe('email_settings', () => {
  it('satu pengaturan per organisasi', async () => {
    const organization = await insertOrganization(db);
    await db.insert(emailSettings).values(emailSettingsRow(organization.id));

    const error = await pgErrorOf(
      db.insert(emailSettings).values(emailSettingsRow(organization.id)),
    );

    expect(error.code).toBe(PG_ERROR_CODES.uniqueViolation);
    expect(error.constraint).toBe('email_settings_organization_id_unique');
  });

  it('username dan password selalu berpasangan', async () => {
    const organization = await insertOrganization(db);
    const base = emailSettingsRow(organization.id);

    const withoutPassword = await pgErrorOf(
      db.insert(emailSettings).values({ ...base, passwordEncrypted: null }),
    );
    const withoutUsername = await pgErrorOf(
      db.insert(emailSettings).values({ ...base, username: null }),
    );
    await db
      .insert(emailSettings)
      .values({ ...base, username: null, passwordEncrypted: null, passwordTail: null });

    expect(withoutPassword.constraint).toBe('email_settings_credentials_paired');
    expect(withoutUsername.constraint).toBe('email_settings_credentials_paired');
  });

  it('menolak port di luar rentang, alamat pengirim tidak baku, dan keamanan tak dikenal', async () => {
    const organization = await insertOrganization(db);
    const base = emailSettingsRow(organization.id);

    const port = await pgErrorOf(db.insert(emailSettings).values({ ...base, port: 70_000 }));
    const address = await pgErrorOf(
      db.insert(emailSettings).values({ ...base, fromAddress: 'CS@Contoh.test' }),
    );
    const security = await pgErrorOf(
      db.execute(
        sql`insert into email_settings (id, organization_id, from_name, from_address, host, port, security)
            values (gen_random_uuid(), ${organization.id}, 'x', 'x@contoh.test', 'h', 25, 'tls13')`,
      ),
    );

    expect(port.constraint).toBe('email_settings_port_range');
    expect(address.constraint).toBe('email_settings_from_address_normalized');
    expect(security.code).toBe(PG_ERROR_CODES.invalidTextRepresentation);
  });

  it('hasil tes terakhir harus lengkap (status, kode, waktu)', async () => {
    const organization = await insertOrganization(db);
    const base = emailSettingsRow(organization.id);

    const partial = await pgErrorOf(db.insert(emailSettings).values({ ...base, lastTestOk: true }));
    await db.insert(emailSettings).values({
      ...base,
      lastTestOk: false,
      lastTestCode: 'auth_failed',
      lastTestedAt: new Date(),
    });

    expect(partial.constraint).toBe('email_settings_last_test_complete');
  });

  it('pengubah terakhir harus dari organisasi yang sama', async () => {
    const organization = await insertOrganization(db);
    const outsider = await insertUser(db, (await insertOrganization(db)).id);

    const error = await pgErrorOf(
      db
        .insert(emailSettings)
        .values({ ...emailSettingsRow(organization.id), updatedByUserId: outsider.id }),
    );

    expect(error.code).toBe(PG_ERROR_CODES.foreignKeyViolation);
    expect(error.constraint).toBe('email_settings_organization_id_updated_by_user_id_fk');
  });
});

describe('organization_logos', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('menyimpan dan membaca kembali isi biner apa adanya', async () => {
    const organization = await insertOrganization(db);
    await db.insert(organizationLogos).values({
      organizationId: organization.id,
      contentType: 'image/png',
      data: png,
      byteSize: png.length,
      sha256: 'a'.repeat(64),
    });

    const [row] = await db
      .select()
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, organization.id));

    expect(Buffer.isBuffer(row?.data)).toBe(true);
    expect(row?.data.equals(png)).toBe(true);
  });

  it('menolak SVG, ukuran yang tidak cocok dengan isinya, dan berkas terlalu besar', async () => {
    const organization = await insertOrganization(db);
    const base = { organizationId: organization.id, sha256: 'b'.repeat(64) };
    const tooLarge = Buffer.alloc(LOGO_MAX_BYTES + 1, 1);

    const svg = await pgErrorOf(
      db
        .insert(organizationLogos)
        .values({ ...base, contentType: 'image/svg+xml', data: png, byteSize: png.length }),
    );
    const wrongSize = await pgErrorOf(
      db
        .insert(organizationLogos)
        .values({ ...base, contentType: 'image/png', data: png, byteSize: png.length + 1 }),
    );
    const large = await pgErrorOf(
      db
        .insert(organizationLogos)
        .values({ ...base, contentType: 'image/png', data: tooLarge, byteSize: tooLarge.length }),
    );

    expect(svg.constraint).toBe('organization_logos_content_type');
    expect(wrongSize.constraint).toBe('organization_logos_byte_size');
    expect(large.constraint).toBe('organization_logos_byte_size');
  });
});

describe('audit_logs — hanya-tambah di tingkat database', () => {
  it('baris audit tidak bisa diubah, dihapus, atau dikosongkan', async () => {
    const organization = await insertOrganization(db);
    const [row] = await db
      .insert(auditLogs)
      .values({ organizationId: organization.id, action: 'auth.login.success' })
      .returning();
    if (!row) throw new Error('baris audit tidak tersimpan');

    const update = await pgErrorOf(
      db.update(auditLogs).set({ action: 'dipalsukan' }).where(eq(auditLogs.id, row.id)),
    );
    const remove = await pgErrorOf(db.delete(auditLogs).where(eq(auditLogs.id, row.id)));
    const truncate = await pgErrorOf(db.execute(sql`truncate table audit_logs`));
    const cascade = await pgErrorOf(db.execute(sql`truncate table organizations cascade`));

    for (const error of [update, remove, truncate, cascade]) {
      expect(error.code).toBe(PG_ERROR_CODES.restrictViolation);
    }
    const [unchanged] = await db.select().from(auditLogs).where(eq(auditLogs.id, row.id));
    expect(unchanged?.action).toBe('auth.login.success');
  });

  it('menambah baris tetap bisa, dan pengguna berjejak audit tetap ada', async () => {
    const organization = await insertOrganization(db);
    const user = await insertUser(db, organization.id);

    await db
      .insert(auditLogs)
      .values({ organizationId: organization.id, actorUserId: user.id, action: 'auth.logout' });

    const [stillThere] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stillThere?.id).toBe(user.id);
  });
});

// Paling akhir: mengosongkan seluruh database berkas ini.
describe('TemporaryDatabase.reset (alat bantu tes)', () => {
  it('mengosongkan semua tabel termasuk audit_logs, lalu trigger hanya-tambah aktif kembali', async () => {
    const organization = await insertOrganization(db);
    await db.insert(auditLogs).values({ organizationId: organization.id, action: 'auth.logout' });

    await database.reset();

    for (const table of [organizations, users, installation, emailSettings, auditLogs]) {
      expect(await db.select().from(table)).toEqual([]);
    }
    // Struktur dan riwayat migrasi tetap ada.
    const migrations = await db.execute(
      sql`select count(*)::int as total from drizzle.__drizzle_migrations`,
    );
    expect(migrations.rows[0]?.total).toBeGreaterThanOrEqual(3);

    const again = await insertOrganization(db);
    await db.insert(auditLogs).values({ organizationId: again.id, action: 'auth.logout' });
    const truncate = await pgErrorOf(db.execute(sql`truncate table audit_logs`));
    expect(truncate.code).toBe(PG_ERROR_CODES.restrictViolation);
  });
});
