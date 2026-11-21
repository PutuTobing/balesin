import {
  organizationLogoIcons,
  organizationLogos,
  organizations,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  API_ROUTES,
  BRAND_ICONS,
  BRAND_MANIFEST_ICON_FILES,
  DEFAULT_MASCOT_NAME,
  DEFAULT_PRODUCT_NAME,
  apiPath,
  brandColorTextColor,
  type BrandIconFile,
  type BrandIcons,
  type ParsedBrandingResponse,
  type BrandingSettings,
  type LogoContentType,
  type UpdateBrandingRequest,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { findInstallationOrganization } from '../installation/installation.repo';
import { riskyAdditions } from '../quick-replies/quick-replies.service';
import { renderStoredLogoIcons, type RenderedIcon } from './icons';
import { prepareLogoUpload } from './logo';

/**
 * Merek white-label (PRD §3.8, docs/KONTRAK-API-AUTH.md "Branding"):
 *  - publik: `GET /branding` (+ berkas logo & ikon) untuk halaman sebelum masuk;
 *  - Pengaturan → Merek: baca & ubah nama aplikasi, warna utama, nama maskot, logo
 *    (`organization.manage` = Owner). Setiap perubahan diaudit.
 */

/**
 * Versi cara membuat ikon. Ikut di parameter `?v=` alamat ikon (di-cache `immutable`), jadi
 * NAIKKAN bila `icons.ts` mengubah hasil gambarnya — dan hapus baris `organization_logo_icons`
 * lewat migrasi supaya dibuat ulang.
 */
export const ICON_RENDER_VERSION = 1;

/** Potongan sha256 logo di parameter versi alamat logo/ikon. */
function versionOf(sha256: string): string {
  return sha256.slice(0, 12);
}

export function logoUrlFor(sha256: string): string {
  return `${API_ROUTES.branding.logo}?v=${versionOf(sha256)}`;
}

export function iconUrlFor(file: BrandIconFile, sha256: string): string {
  return `${apiPath(API_ROUTES.branding.icon, { file })}?v=${versionOf(sha256)}-${ICON_RENDER_VERSION}`;
}

export function brandIconsFor(sha256: string): BrandIcons {
  const manifestFiles = new Set<BrandIconFile>(BRAND_MANIFEST_ICON_FILES);
  return {
    favicon: iconUrlFor('favicon-32.png', sha256),
    appleTouchIcon: iconUrlFor('apple-touch-icon.png', sha256),
    manifest: BRAND_ICONS.filter((icon) => manifestFiles.has(icon.file)).map((icon) => ({
      src: iconUrlFor(icon.file, sha256),
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png' as const,
      purpose: icon.purpose,
    })),
  };
}

export interface StoredLogo {
  contentType: LogoContentType;
  data: Buffer;
  sha256: string;
}

export interface StoredIcon {
  data: Buffer;
  sha256: string;
}

export interface BrandingService {
  /** `GET /branding` (publik). */
  publicBranding(): Promise<ParsedBrandingResponse>;
  /** Berkas logo instalasi, atau `undefined` bila belum ada. */
  logo(): Promise<StoredLogo | undefined>;
  /**
   * Ikon dari logo instalasi. Logo yang diunggah sebelum fitur ini (atau ikon basi) dibuatkan
   * ikonnya sekali lalu disimpan; gagal → `undefined` (dan tidak dicoba lagi untuk logo yang sama
   * selama proses hidup, supaya permintaan publik tidak bisa memaksa dekode berulang).
   */
  icon(file: BrandIconFile, log: FastifyBaseLogger): Promise<StoredIcon | undefined>;
  /** `GET /settings/branding`. */
  settings(organizationId: string): Promise<BrandingSettings>;
  /** `PATCH /settings/branding`. */
  update(
    auth: AuthContext,
    input: UpdateBrandingRequest,
    context: { client: ClientInfo; log: FastifyBaseLogger },
  ): Promise<BrandingSettings>;
}

export interface BrandingServiceDeps {
  db: Database;
}

/** Menyimpan logo + ikonnya (menimpa yang lama) di dalam transaksi pemanggil. */
export async function storeLogo(
  tx: DbExecutor,
  organizationId: string,
  logo: StoredLogo & { icons: RenderedIcon[] },
): Promise<void> {
  const values = {
    contentType: logo.contentType,
    data: logo.data,
    byteSize: logo.data.length,
    sha256: logo.sha256,
  };
  await tx
    .insert(organizationLogos)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({
      target: organizationLogos.organizationId,
      set: { ...values, updatedAt: new Date() },
    });
  await storeIcons(tx, organizationId, logo.sha256, logo.icons);
}

async function storeIcons(
  tx: DbExecutor,
  organizationId: string,
  logoSha256: string,
  icons: RenderedIcon[],
): Promise<void> {
  await tx
    .delete(organizationLogoIcons)
    .where(eq(organizationLogoIcons.organizationId, organizationId));
  if (icons.length === 0) return;
  await tx.insert(organizationLogoIcons).values(
    icons.map((icon) => ({
      organizationId,
      file: icon.file,
      logoSha256,
      data: icon.data,
      byteSize: icon.data.length,
    })),
  );
}

type ChangedField = 'productName' | 'primaryColor' | 'mascotName' | 'logo';

export function createBrandingService(deps: BrandingServiceDeps): BrandingService {
  const { db } = deps;
  /** Pembuatan ikon yang sedang/sudah berjalan per logo (sha256) — termasuk yang gagal. */
  const iconBackfills = new Map<string, Promise<boolean>>();

  async function logoMeta(executor: DbExecutor, organizationId: string) {
    const [row] = await executor
      .select({
        sha256: organizationLogos.sha256,
        contentType: organizationLogos.contentType,
        byteSize: organizationLogos.byteSize,
        updatedAt: organizationLogos.updatedAt,
      })
      .from(organizationLogos)
      .where(eq(organizationLogos.organizationId, organizationId))
      .limit(1);
    return row;
  }

  async function settingsOf(executor: DbExecutor, organizationId: string) {
    const [row] = await executor
      .select({
        productName: organizations.productName,
        brandColor: organizations.brandColor,
        mascotName: organizations.mascotName,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!row) throw new Error('Organisasi tidak ditemukan');
    const logo = await logoMeta(executor, organizationId);
    const settings: BrandingSettings = {
      productName: row.productName,
      primaryColor: row.brandColor,
      primaryTextColor: row.brandColor ? brandColorTextColor(row.brandColor) : null,
      mascotName: row.mascotName,
      logo: logo
        ? {
            url: logoUrlFor(logo.sha256),
            contentType: logo.contentType as LogoContentType,
            byteSize: logo.byteSize,
            updatedAt: logo.updatedAt.toISOString(),
          }
        : null,
      defaults: { productName: DEFAULT_PRODUCT_NAME, mascotName: DEFAULT_MASCOT_NAME },
    };
    return settings;
  }

  /** Membuat & menyimpan ikon logo `sha256` milik organisasi. `true` bila berhasil. */
  function backfillIcons(
    organizationId: string,
    sha256: string,
    log: FastifyBaseLogger,
  ): Promise<boolean> {
    const key = `${organizationId}:${sha256}`;
    const running = iconBackfills.get(key);
    if (running) return running;
    const task = (async () => {
      const [logo] = await db
        .select({
          data: organizationLogos.data,
          sha256: organizationLogos.sha256,
          contentType: organizationLogos.contentType,
        })
        .from(organizationLogos)
        .where(eq(organizationLogos.organizationId, organizationId))
        .limit(1);
      if (logo?.sha256 !== sha256) return false;
      // Rantai pemeriksaan yang sama dengan unggahan (format = sniffing, sisi ≤ 4096), di slot dekode.
      const icons = await renderStoredLogoIcons(logo.data, logo.contentType as LogoContentType);
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ sha256: organizationLogos.sha256 })
          .from(organizationLogos)
          .where(eq(organizationLogos.organizationId, organizationId))
          .for('update');
        // Logo diganti di tengah jalan: ikonnya sudah disimpan oleh yang mengganti.
        if (current?.sha256 !== sha256) return;
        await storeIcons(tx, organizationId, sha256, icons);
      });
      return true;
    })().catch((error: unknown) => {
      // Hanya jenis galat — isi berkas tidak pernah dicatat.
      log.warn(
        { organizationId, err: error instanceof Error ? error.name : 'unknown' },
        'Ikon dari logo organisasi gagal dibuat; ikon bawaan produk yang dipakai',
      );
      return false;
    });
    iconBackfills.set(key, task);
    return task;
  }

  async function findIcon(organizationId: string, file: BrandIconFile, sha256: string) {
    const [row] = await db
      .select({ data: organizationLogoIcons.data })
      .from(organizationLogoIcons)
      .where(
        and(
          eq(organizationLogoIcons.organizationId, organizationId),
          eq(organizationLogoIcons.file, file),
          eq(organizationLogoIcons.logoSha256, sha256),
        ),
      )
      .limit(1);
    return row;
  }

  return {
    async publicBranding() {
      const organization = await findInstallationOrganization(db);
      if (!organization) {
        return {
          productName: DEFAULT_PRODUCT_NAME,
          organizationName: null,
          primaryColor: null,
          logoUrl: null,
          mascotName: DEFAULT_MASCOT_NAME,
          icons: null,
        };
      }
      const logo = await logoMeta(db, organization.id);
      return {
        productName: organization.productName ?? DEFAULT_PRODUCT_NAME,
        organizationName: organization.name,
        primaryColor: organization.brandColor,
        // Parameter versi berubah saat logo diganti, jadi berkasnya boleh di-cache lama.
        logoUrl: logo ? logoUrlFor(logo.sha256) : null,
        mascotName: organization.mascotName ?? DEFAULT_MASCOT_NAME,
        icons: logo ? brandIconsFor(logo.sha256) : null,
      };
    },

    async logo() {
      const organization = await findInstallationOrganization(db);
      if (!organization) return undefined;
      const [row] = await db
        .select({
          contentType: organizationLogos.contentType,
          data: organizationLogos.data,
          sha256: organizationLogos.sha256,
        })
        .from(organizationLogos)
        .where(eq(organizationLogos.organizationId, organization.id))
        .limit(1);
      return row ? { ...row, contentType: row.contentType as LogoContentType } : undefined;
    },

    async icon(file, log) {
      const organization = await findInstallationOrganization(db);
      if (!organization) return undefined;
      const logo = await logoMeta(db, organization.id);
      if (!logo) return undefined;
      let row = await findIcon(organization.id, file, logo.sha256);
      if (!row && (await backfillIcons(organization.id, logo.sha256, log))) {
        row = await findIcon(organization.id, file, logo.sha256);
      }
      return row ? { data: row.data, sha256: logo.sha256 } : undefined;
    },

    settings: (organizationId) => settingsOf(db, organizationId),

    async update(auth, input, context) {
      // Mengolah gambar memakan CPU → di luar transaksi.
      const upload = input.logo ? await prepareLogoUpload(input.logo, 'logo') : undefined;

      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'organization.manage', context.log);
        const [current] = await tx
          .select({
            productName: organizations.productName,
            brandColor: organizations.brandColor,
            mascotName: organizations.mascotName,
          })
          .from(organizations)
          .where(eq(organizations.id, auth.organizationId))
          .for('update');
        if (!current) throw new Error('Organisasi tidak ditemukan');
        const currentLogo = await logoMeta(tx, auth.organizationId);

        const changed: ChangedField[] = [];
        const metadata: Record<string, unknown> = {};
        const set: Partial<typeof organizations.$inferInsert> = {};
        if (input.productName !== undefined && input.productName !== current.productName) {
          changed.push('productName');
          set.productName = input.productName;
          metadata.productName = { previous: current.productName, next: input.productName };
        }
        if (input.primaryColor !== undefined && input.primaryColor !== current.brandColor) {
          changed.push('primaryColor');
          set.brandColor = input.primaryColor;
          metadata.primaryColor = { previous: current.brandColor, next: input.primaryColor };
        }
        if (input.mascotName !== undefined && input.mascotName !== current.mascotName) {
          changed.push('mascotName');
          set.mascotName = input.mascotName;
          metadata.mascotName = { previous: current.mascotName, next: input.mascotName };
        }
        if (upload && upload.sha256 !== currentLogo?.sha256) {
          changed.push('logo');
          metadata.logo = {
            action: 'uploaded',
            contentType: upload.contentType,
            byteSize: upload.data.length,
            width: upload.width,
            height: upload.height,
            sha256: upload.sha256,
            replaced: currentLogo !== undefined,
          };
        } else if (input.logo === null && currentLogo) {
          changed.push('logo');
          metadata.logo = { action: 'removed', previousSha256: currentLogo.sha256 };
        }

        // Tidak ada yang berubah (mis. menyimpan ulang isian yang sama) → tanpa audit.
        if (changed.length === 0) return settingsOf(tx, auth.organizationId);

        // Nama baru yang memuat tautan/angka panjang = teks ajakan di email sistem → kejadian keamanan
        // `branding_changed` tingkat `warning` (review merek B2; konfirmasi identitas sengaja tidak
        // diwajibkan, lihat DECISIONS).
        let addedLinks = 0;
        let addedNumbers = 0;
        for (const [previous, next] of [
          [current.productName, set.productName],
          [current.mascotName, set.mascotName],
        ] as const) {
          if (!next) continue;
          const added = riskyAdditions(previous ?? '', next);
          addedLinks += added.links;
          addedNumbers += added.numbers;
        }
        if (addedLinks > 0 || addedNumbers > 0) {
          Object.assign(metadata, { risky: true, addedLinks, addedNumbers });
        }

        if (Object.keys(set).length > 0) {
          await tx.update(organizations).set(set).where(eq(organizations.id, auth.organizationId));
        }
        if (changed.includes('logo')) {
          if (upload) {
            await storeLogo(tx, auth.organizationId, upload);
          } else {
            // Ikon ikut terhapus (FK cascade).
            await tx
              .delete(organizationLogos)
              .where(eq(organizationLogos.organizationId, auth.organizationId));
          }
        }

        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.brandingUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          metadata: { changedFields: changed, actorRole: auth.user.role, ...metadata },
          client: context.client,
        });
        return settingsOf(tx, auth.organizationId);
      });
    },
  };
}
