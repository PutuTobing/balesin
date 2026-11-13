import { organizationLogos, type Database } from '@balesin/db';
import {
  API_ROUTES,
  DEFAULT_PRODUCT_NAME,
  brandingResponseSchema,
  type BrandingResponse,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { handleNotFound } from '../../http/error-handler';
import { PUBLIC } from '../../http/route-access';
import { findInstallationOrganization } from '../installation/installation.repo';

export interface BrandingRoutesOptions {
  db: Database;
}

const LOGO_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Branding white-label untuk halaman yang tampil SEBELUM masuk (halaman masuk, wizard setup).
 * Publik, jadi hanya memuat nama, warna, dan logo — hal yang memang terlihat di halaman masuk.
 *
 * - `GET /branding`       nama produk, nama organisasi, warna utama, alamat logo
 * - `GET /branding/logo`  berkas logo (gambar raster yang sudah diperiksa saat diunggah)
 */
export const brandingRoutes: FastifyPluginCallbackZod<BrandingRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { db } = options;

  app.get(
    API_ROUTES.branding.get,
    { config: { access: PUBLIC }, schema: { response: { 200: brandingResponseSchema } } },
    async (_request, reply) => {
      const organization = await findInstallationOrganization(db);
      if (!organization) {
        const defaults: BrandingResponse = {
          productName: DEFAULT_PRODUCT_NAME,
          organizationName: null,
          primaryColor: null,
          logoUrl: null,
        };
        return reply.send(defaults);
      }

      const [logo] = await db
        .select({ sha256: organizationLogos.sha256 })
        .from(organizationLogos)
        .where(eq(organizationLogos.organizationId, organization.id))
        .limit(1);

      return reply.send({
        productName: organization.productName ?? DEFAULT_PRODUCT_NAME,
        organizationName: organization.name,
        primaryColor: organization.brandColor,
        // Parameter versi berubah saat logo diganti, jadi berkasnya boleh di-cache lama.
        logoUrl: logo ? `${API_ROUTES.branding.logo}?v=${logo.sha256.slice(0, 12)}` : null,
      });
    },
  );

  app.get(
    API_ROUTES.branding.logo,
    {
      // Isi biner: tidak lewat skema respons JSON.
      config: { access: PUBLIC, rawResponse: true },
      schema: { querystring: z.object({ v: z.string().max(64).optional() }) },
    },
    async (request, reply) => {
      const organization = await findInstallationOrganization(db);
      const [logo] = organization
        ? await db
            .select()
            .from(organizationLogos)
            .where(eq(organizationLogos.organizationId, organization.id))
            .limit(1)
        : [];
      if (!logo) return handleNotFound(request, reply);

      const etag = `"${logo.sha256}"`;
      void reply.headers({
        etag,
        // Logo tampil di halaman masuk: boleh di-cache browser. Alamat ber-`?v=` tidak pernah
        // berubah isinya; tanpa itu cache-nya pendek.
        'cache-control': request.query.v
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
        'content-disposition': `inline; filename="logo.${LOGO_EXTENSIONS[logo.contentType] ?? 'bin'}"`,
      });
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();

      // Tipe berasal dari pemeriksaan isi saat unggah; `nosniff` (helmet) mencegah browser menebak ulang.
      return reply.type(logo.contentType).send(logo.data);
    },
  );

  done();
};
