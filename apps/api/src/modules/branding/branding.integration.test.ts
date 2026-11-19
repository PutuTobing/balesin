/**
 * Pengaturan → Merek (Fase 7 white-label): ubah nama aplikasi, warna utama, nama maskot, logo
 * (unggah/hapus) + ikon PWA/favicon dari logo. Izin `organization.manage` (Owner), CSRF, audit,
 * dan `GET /branding` publik ikut berubah tanpa data sensitif.
 */
import { deflateSync } from 'node:zlib';

import { auditLogs, organizationLogoIcons, organizationLogos, organizations } from '@balesin/db';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  BRAND_ICONS,
  apiPath,
  brandingResponseSchema,
  brandingSettingsResponseSchema,
  securitySummaryResponseSchema,
} from '@balesin/shared';
import { sha256Hex } from '@balesin/core';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agent, send, setupWorld, type Fase5World } from '../../testing/crm-fixtures';
import { call, createIntegrationHarness, type IntegrationHarness } from '../../testing/integration';

let harness: IntegrationHarness;
let world: Fase5World;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  world = await setupWorld(harness);
});
afterAll(async () => {
  await harness?.close();
});

const ROUTE = API_ROUTES.settings.branding;

async function logoPng(color: string, width = 240, height = 120): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();
}

function upload(data: Buffer, contentType = 'image/png') {
  return { contentType, dataBase64: data.toString('base64') };
}

async function publicBranding() {
  const response = await call(harness.app, 'GET', API_ROUTES.branding.get);
  expect(response.statusCode).toBe(200);
  return brandingResponseSchema.parse(response.json());
}

async function brandingAudits() {
  return harness.db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, world.organizationId),
        eq(auditLogs.action, AUDIT_ACTIONS.brandingUpdated),
      ),
    );
}

describe('Pengaturan → Merek', () => {
  it('Owner: baca bawaan, ubah nama/warna/maskot, audit nilai lama & baru; simpan ulang tanpa audit', async () => {
    const initial = await send(world, world.owner, 'GET', ROUTE);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(brandingSettingsResponseSchema.parse(initial.json()).branding).toEqual({
      productName: null,
      primaryColor: null,
      primaryTextColor: null,
      mascotName: null,
      logo: null,
      defaults: { productName: 'Balesin', mascotName: 'Kak Sky' },
    });

    const body = { productName: 'Layanan Maju', primaryColor: '#FFD400', mascotName: 'Kak Rina' };
    const updated = await send(world, world.owner, 'PATCH', ROUTE, body);
    expect(updated.statusCode, updated.body).toBe(200);
    expect(brandingSettingsResponseSchema.parse(updated.json()).branding).toMatchObject({
      productName: 'Layanan Maju',
      primaryColor: '#ffd400',
      // Kuning terang → teks gelap di atasnya.
      primaryTextColor: '#14202e',
      mascotName: 'Kak Rina',
    });

    expect(await publicBranding()).toMatchObject({
      productName: 'Layanan Maju',
      primaryColor: '#ffd400',
      mascotName: 'Kak Rina',
      logoUrl: null,
      icons: null,
    });

    const [audit] = await brandingAudits();
    expect(audit).toMatchObject({
      actorUserId: world.owner.userId,
      targetType: 'organization',
      targetId: world.organizationId,
      metadata: {
        changedFields: ['productName', 'primaryColor', 'mascotName'],
        productName: { previous: null, next: 'Layanan Maju' },
        primaryColor: { previous: null, next: '#ffd400' },
        mascotName: { previous: null, next: 'Kak Rina' },
      },
    });

    // Isian sama → 200 tanpa audit baru.
    expect((await send(world, world.owner, 'PATCH', ROUTE, body)).statusCode).toBe(200);
    expect(await brandingAudits()).toHaveLength(1);

    // null = kembali ke bawaan.
    const reset = await send(world, world.owner, 'PATCH', ROUTE, {
      productName: null,
      primaryColor: null,
      mascotName: null,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await publicBranding()).toMatchObject({
      productName: 'Balesin',
      primaryColor: null,
      mascotName: 'Kak Sky',
    });
  });

  it('validasi: warna tak terbaca, format warna, merek Meta, body kosong → 400 per field', async () => {
    const cases: [unknown, string, string][] = [
      [{ primaryColor: '#7d7d7d' }, 'primaryColor', 'sulit dibaca'],
      [{ primaryColor: 'biru' }, 'primaryColor', 'heksadesimal'],
      [{ productName: 'WhatsApp Kita' }, 'productName', 'merek dagang Meta'],
      [{ mascotName: 'K' }, 'mascotName', 'minimal 2'],
      [{}, '', 'Tidak ada perubahan'],
    ];
    for (const [body, field, message] of cases) {
      const response = await send(world, world.owner, 'PATCH', ROUTE, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.body, JSON.stringify(body)).toContain(message);
      if (field) expect(response.body).toContain(`"field":"${field}"`);
    }
    expect(await brandingAudits()).toHaveLength(0);
  });

  it('izin: hanya Owner (Admin/Supervisor/CS/Teknisi 403), tanpa sesi 401, tanpa CSRF ditolak', async () => {
    for (const role of ['admin', 'supervisor', 'cs', 'teknisi'] as const) {
      const member = await agent(world, role, `Anggota ${role}`);
      expect((await send(world, member, 'GET', ROUTE)).statusCode, role).toBe(403);
      expect(
        (await send(world, member, 'PATCH', ROUTE, { productName: 'Diambil Alih' })).statusCode,
        role,
      ).toBe(403);
    }
    expect(
      (await call(harness.app, 'PATCH', ROUTE, { productName: 'Tanpa Sesi' })).statusCode,
    ).toBe(401);
    const withoutCsrf = await call(
      harness.app,
      'PATCH',
      ROUTE,
      { productName: 'Tanpa CSRF' },
      { cookie: world.owner.cookie },
    );
    expect(withoutCsrf.statusCode).toBe(403);

    const [organization] = await harness.db
      .select({ productName: organizations.productName })
      .from(organizations)
      .where(eq(organizations.id, world.organizationId));
    expect(organization?.productName).toBeNull();
    expect(await brandingAudits()).toHaveLength(0);
  });

  it('logo: unggah → logo & ikon 192/512/maskable/favicon publik; ganti; hapus → ikon ikut hilang', async () => {
    const first = await logoPng('#0b5394');
    const uploaded = await send(world, world.owner, 'PATCH', ROUTE, { logo: upload(first) });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const settings = brandingSettingsResponseSchema.parse(uploaded.json()).branding;
    expect(settings.logo).toMatchObject({ contentType: 'image/png' });
    expect(settings.logo?.byteSize).toBeGreaterThan(0);

    const branding = await publicBranding();
    expect(branding.logoUrl).toBe(settings.logo?.url);
    expect(branding.icons).not.toBeNull();
    const icons = branding.icons!;
    // Ikon bawaan produk TIDAK ikut: manifest hanya ikon dari logo.
    expect(icons.manifest.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '192x192 maskable',
      '512x512 maskable',
    ]);
    for (const icon of icons.manifest) {
      expect(icon.src).toMatch(/^\/api\/v1\/branding\/icons\/[a-z0-9-]+\.png\?v=[0-9a-f]{12}-\d+$/);
    }

    for (const [src, size] of [
      [icons.favicon, 32],
      [icons.appleTouchIcon, 180],
      ...icons.manifest.map((icon) => [icon.src, Number(icon.sizes.split('x')[0])] as const),
    ] as const) {
      const response = await call(harness.app, 'GET', src);
      expect(response.statusCode, src).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const meta = await sharp(response.rawPayload).metadata();
      expect([meta.format, meta.width, meta.height], src).toEqual(['png', size, size]);
    }

    // Nama berkas di luar daftar → 404 (tidak ada akses berkas sembarang).
    for (const file of ['logo.png', '..%2F..%2Fetc%2Fpasswd', 'icon-1024.png']) {
      const response = await call(harness.app, 'GET', `/api/v1/branding/icons/${file}`);
      expect(response.statusCode, file).toBe(404);
    }

    // Ganti logo → URL versi berubah, ikon lama tidak tersisa.
    const second = await logoPng('#7a1f1f', 100, 100);
    expect(
      (await send(world, world.owner, 'PATCH', ROUTE, { logo: upload(second) })).statusCode,
    ).toBe(200);
    const replaced = await publicBranding();
    expect(replaced.logoUrl).not.toBe(branding.logoUrl);
    const storedIcons = await harness.db
      .select({ logoSha256: organizationLogoIcons.logoSha256 })
      .from(organizationLogoIcons)
      .where(eq(organizationLogoIcons.organizationId, world.organizationId));
    expect(storedIcons).toHaveLength(BRAND_ICONS.length);
    expect(new Set(storedIcons.map((row) => row.logoSha256)).size).toBe(1);

    // Hapus logo → logo & ikon 404, GET /branding kembali tanpa ikon.
    const removed = await send(world, world.owner, 'PATCH', ROUTE, { logo: null });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(brandingSettingsResponseSchema.parse(removed.json()).branding.logo).toBeNull();
    const afterRemoval = await publicBranding();
    expect(afterRemoval).toMatchObject({ logoUrl: null, icons: null });
    expect((await call(harness.app, 'GET', API_ROUTES.branding.logo)).statusCode).toBe(404);
    expect(
      (await call(harness.app, 'GET', apiPath(API_ROUTES.branding.icon, { file: 'icon-192.png' })))
        .statusCode,
    ).toBe(404);
    expect(
      await harness.db
        .select()
        .from(organizationLogoIcons)
        .where(eq(organizationLogoIcons.organizationId, world.organizationId)),
    ).toHaveLength(0);

    // Audit: unggah, ganti, hapus — tanpa isi berkas.
    const audits = await brandingAudits();
    expect(audits.map((row) => (row.metadata as { logo: { action: string } }).logo.action)).toEqual(
      ['uploaded', 'uploaded', 'removed'],
    );
    expect(JSON.stringify(audits)).not.toContain(first.toString('base64').slice(0, 40));
    // Menghapus logo yang sudah tidak ada = tidak ada perubahan, tanpa audit.
    expect((await send(world, world.owner, 'PATCH', ROUTE, { logo: null })).statusCode).toBe(200);
    expect(await brandingAudits()).toHaveLength(3);
  });

  it('logo ditolak: SVG, isi tidak cocok jenisnya, gambar rusak, dimensi raksasa — tanpa perubahan', async () => {
    const png = await logoPng('#0b5394');
    const cases: [unknown, string][] = [
      [{ contentType: 'image/svg+xml', dataBase64: 'PHN2Zy8+' }, 'PNG, JPG, atau WebP'],
      [
        {
          contentType: 'image/png',
          dataBase64: Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
        },
        'SVG tidak diterima',
      ],
      [upload(png, 'image/jpeg'), 'tidak cocok dengan jenisnya'],
      [upload(png.subarray(0, 60)), 'rusak atau tidak bisa dibaca'],
    ];
    for (const [logo, message] of cases) {
      const response = await send(world, world.owner, 'PATCH', ROUTE, { logo });
      expect(response.statusCode, message).toBe(400);
      expect(response.body, message).toContain(message);
    }
    expect(
      await harness.db
        .select()
        .from(organizationLogos)
        .where(eq(organizationLogos.organizationId, world.organizationId)),
    ).toHaveLength(0);
    expect(await brandingAudits()).toHaveLength(0);
  });

  it('logo lama tanpa ikon (sebelum fitur ini) → ikon dibuat sekali saat pertama diminta', async () => {
    const png = await logoPng('#0b5394');
    expect((await send(world, world.owner, 'PATCH', ROUTE, { logo: upload(png) })).statusCode).toBe(
      200,
    );
    await harness.db
      .delete(organizationLogoIcons)
      .where(eq(organizationLogoIcons.organizationId, world.organizationId));

    const icons = (await publicBranding()).icons!;
    const response = await call(harness.app, 'GET', icons.manifest[1]!.src);
    expect(response.statusCode).toBe(200);
    expect((await sharp(response.rawPayload).metadata()).width).toBe(512);
    expect(
      await harness.db
        .select()
        .from(organizationLogoIcons)
        .where(eq(organizationLogoIcons.organizationId, world.organizationId)),
    ).toHaveLength(BRAND_ICONS.length);
  });
});

/** PNG kecil yang mengaku berdimensi `width`×`height` (header sah, isi terpotong). */
function claimedPng(width: number, height: number): Buffer {
  const crc32 = (buffer: Buffer) => {
    let crc = ~0;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(4096))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('review keamanan merek (perbaikan B1, B2, B5, Info)', () => {
  it('B1: isi ulang ikon logo lama memakai rantai pemeriksaan yang sama (format & dimensi) → 404, bukan didekode', async () => {
    const cases: [string, Buffer, string][] = [
      ['isi PNG tersimpan sebagai WebP', await logoPng('#0b5394'), 'image/webp'],
      ['sisi melebihi batas', claimedPng(1, 5_000), 'image/png'],
    ];
    for (const [name, data, contentType] of cases) {
      await harness.db
        .insert(organizationLogos)
        .values({
          organizationId: world.organizationId,
          contentType,
          data,
          byteSize: data.length,
          sha256: sha256Hex(data),
        })
        .onConflictDoUpdate({
          target: organizationLogos.organizationId,
          set: { contentType, data, byteSize: data.length, sha256: sha256Hex(data) },
        });
      const src = (await publicBranding()).icons!.manifest[0]!.src;
      expect((await call(harness.app, 'GET', src)).statusCode, name).toBe(404);
      expect(
        await harness.db
          .select()
          .from(organizationLogoIcons)
          .where(eq(organizationLogoIcons.organizationId, world.organizationId)),
        name,
      ).toHaveLength(0);
    }
  });

  it('B2: perubahan merek = kejadian keamanan; nama bertautan/nomor panjang → warning', async () => {
    const summary = async () =>
      securitySummaryResponseSchema.parse(
        (await send(world, world.owner, 'GET', API_ROUTES.audit.securitySummary)).json(),
      );

    expect(
      (await send(world, world.owner, 'PATCH', ROUTE, { primaryColor: '#0b5394' })).statusCode,
    ).toBe(200);
    let events = (await summary()).events.filter((event) => event.kind === 'branding_changed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      severity: 'info',
      details: { changedFields: '["primaryColor"]', actorRole: 'owner' },
    });

    const risky = await send(world, world.owner, 'PATCH', ROUTE, {
      productName: 'Hub 0812 3456 7890',
      mascotName: 'Kak bit.ly/abc',
    });
    expect(risky.statusCode, risky.body).toBe(200);
    const after = await summary();
    expect(after.counts.branding_changed).toBe(2);
    events = after.events.filter((event) => event.kind === 'branding_changed');
    expect(events[0]).toMatchObject({
      severity: 'warning',
      details: { addedLinks: 1, addedNumbers: 1, actorRole: 'owner' },
    });
    expect(after.latestWarningAt).not.toBeNull();
  });

  it('B5: logo disimpan tanpa EXIF/ICC/XMP dan tanpa data sisipan; ETag ikon memuat versi render', async () => {
    const jpeg = await sharp({
      create: { width: 120, height: 60, channels: 3, background: '#123456' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'Lokasi rahasia' } })
      .withIccProfile('p3')
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>')
      .toBuffer();
    const withTrailer = Buffer.concat([jpeg, Buffer.from('<svg onload="alert(1)"/>')]);
    const response = await send(world, world.owner, 'PATCH', ROUTE, {
      logo: upload(withTrailer, 'image/jpeg'),
    });
    expect(response.statusCode, response.body).toBe(200);

    const branding = await publicBranding();
    const logo = await call(harness.app, 'GET', branding.logoUrl!);
    expect(logo.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(logo.rawPayload).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    // Orientasi EXIF sudah diterapkan (diputar 90°), bukan dibuang.
    expect([meta.width, meta.height]).toEqual([60, 120]);
    expect(logo.rawPayload.includes(Buffer.from('<svg'))).toBe(false);

    const icon = await call(harness.app, 'GET', branding.icons!.favicon);
    expect(String(icon.headers.etag)).toMatch(/-favicon-32\.png-r\d+"$/);
  });
});
