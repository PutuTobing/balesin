import { installation, organizations, users, type DbExecutor } from '@balesin/db';
import { eq, sql } from 'drizzle-orm';

/** Organisasi pemilik instalasi ini (v1: satu instalasi = satu organisasi). */
export interface InstallationOrganization {
  id: string;
  name: string;
  timezone: string;
  productName: string | null;
  brandColor: string | null;
  mascotName: string | null;
}

/**
 * Organisasi instalasi, atau `undefined` bila wizard setup belum selesai. Inilah cara
 * permintaan TANPA sesi (login, branding halaman masuk) mengetahui `organization_id` yang
 * dipakai untuk memfilter query berikutnya.
 */
export async function findInstallationOrganization(
  db: DbExecutor,
): Promise<InstallationOrganization | undefined> {
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      timezone: organizations.timezone,
      productName: organizations.productName,
      brandColor: organizations.brandColor,
      mascotName: organizations.mascotName,
    })
    .from(installation)
    .innerJoin(organizations, eq(organizations.id, installation.organizationId))
    .limit(1);
  return row;
}

/**
 * `true` bila setup sudah pernah selesai: ada baris `installation` ATAU sudah ada Owner di
 * organisasi mana pun. Pemeriksaan Owner sengaja lintas organisasi — ini satu-satunya
 * pertanyaan tingkat instalasi ("bolehkah wizard setup jalan?").
 */
export async function isSetupCompleted(db: DbExecutor): Promise<boolean> {
  const result = await db.execute<{ completed: boolean }>(sql`
    select (
      exists (select 1 from ${installation})
      or exists (select 1 from ${users} where ${users.role} = 'owner')
    ) as completed
  `);
  return result.rows[0]?.completed === true;
}
