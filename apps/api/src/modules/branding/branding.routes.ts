import {
  API_ROUTES,
  brandIconFileSchema,
  brandingResponseSchema,
  brandingSettingsResponseSchema,
  errorEnvelopeSchema,
  updateBrandingRequestSchema,
} from '@balesin/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { handleNotFound } from '../../http/error-handler';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { PUBLIC, requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { BrandingService } from './branding.service';

export interface BrandingRoutesOptions {
  branding: BrandingService;
  limiter: RateLimiter;
}

const LOGO_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Mengolah logo memakan CPU: dibatasi per pengguna. */
export const BRANDING_WRITE_RULE: RateLimitRule = {
  name: 'merek-ubah',
  limit: 20,
  windowSeconds: 60 * 10,
};
const limitMessage = (wait: string) =>
  `Terlalu banyak perubahan merek dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

const versionQuery = z.object({ v: z.string().max(64).optional() });

/**
 * Mengirim berkas gambar tersimpan (logo/ikon). Tipe berasal dari pemeriksaan isi saat unggah atau
 * dari server sendiri (ikon PNG); `nosniff` (helmet) mencegah browser menebak ulang.
 */
function sendImage(
  request: FastifyRequest<{ Querystring: z.infer<typeof versionQuery> }>,
  reply: FastifyReply,
  file: { contentType: string; data: Buffer; etag: string; filename: string },
) {
  const etag = `"${file.etag}"`;
  void reply.headers({
    etag,
    // Tampil di halaman masuk: boleh di-cache browser. Alamat ber-`?v=` tidak pernah berubah
    // isinya; tanpa itu cache-nya pendek.
    'cache-control': request.query.v
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300',
    'content-disposition': `inline; filename="${file.filename}"`,
  });
  if (request.headers['if-none-match'] === etag) return reply.status(304).send();
  return reply.type(file.contentType).send(file.data);
}

/**
 * Branding white-label.
 *
 * Publik (halaman masuk, wizard setup, manifest PWA — sebelum ada sesi), hanya hal yang memang
 * tampil di halaman masuk:
 * - `GET /branding`              nama produk & organisasi, warna, nama maskot, alamat logo & ikon
 * - `GET /branding/logo`         berkas logo (gambar raster yang sudah diperiksa saat diunggah)
 * - `GET /branding/icons/:file`  ikon PNG yang dibuat server dari logo
 *
 * Pengaturan → Merek (`organization.manage` = Owner; tulis lewat hook CSRF):
 * - `GET /settings/branding`, `PATCH /settings/branding`
 */
export const brandingRoutes: FastifyPluginCallbackZod<BrandingRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { branding, limiter } = options;
  const MANAGE = requirePermission('organization.manage');

  app.get(
    API_ROUTES.branding.get,
    { config: { access: PUBLIC }, schema: { response: { 200: brandingResponseSchema } } },
    async (_request, reply) => reply.send(await branding.publicBranding()),
  );

  app.get(
    API_ROUTES.branding.logo,
    {
      // Isi biner: tidak lewat skema respons JSON.
      config: { access: PUBLIC, rawResponse: true },
      schema: { querystring: versionQuery },
    },
    async (request, reply) => {
      const logo = await branding.logo();
      if (!logo) return handleNotFound(request, reply);
      return sendImage(request, reply, {
        contentType: logo.contentType,
        data: logo.data,
        etag: logo.sha256,
        filename: `logo.${LOGO_EXTENSIONS[logo.contentType] ?? 'bin'}`,
      });
    },
  );

  app.get(
    API_ROUTES.branding.icon,
    {
      config: { access: PUBLIC, rawResponse: true },
      schema: { params: z.object({ file: z.string().max(64) }), querystring: versionQuery },
    },
    async (request, reply) => {
      const file = brandIconFileSchema.safeParse(request.params.file);
      if (!file.success) return handleNotFound(request, reply);
      const icon = await branding.icon(file.data, request.log);
      if (!icon) return handleNotFound(request, reply);
      return sendImage(request, reply, {
        contentType: 'image/png',
        data: icon.data,
        etag: `${icon.sha256.slice(0, 32)}-${file.data}`,
        filename: file.data,
      });
    },
  );

  app.get(
    API_ROUTES.settings.branding,
    {
      config: { access: MANAGE },
      schema: { response: { 200: brandingSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      branding: await branding.settings(requireAuth(request).organizationId),
    }),
  );

  app.patch(
    API_ROUTES.settings.branding,
    {
      config: { access: MANAGE },
      schema: {
        body: updateBrandingRequestSchema,
        response: { 200: brandingSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, BRANDING_WRITE_RULE, auth.user.id, limitMessage);
      return {
        branding: await branding.update(auth, request.body, {
          client: clientInfo(request),
          log: request.log,
        }),
      };
    },
  );

  done();
};
