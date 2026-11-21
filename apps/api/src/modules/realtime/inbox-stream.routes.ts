import { AppError } from '@balesin/core';
// Augmentasi tipe `websocket: true` dan handler (socket, request).
import type {} from '@fastify/websocket';
import { API_ROUTES } from '@balesin/shared';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';

import { clientInfo } from '../../http/client-info';
import { requirePermission } from '../../http/route-access';
import { fetchSiteOf } from '../auth/access-denied';
import { requireAuth } from '../auth/auth.hook';
import type { InboxStreamHub } from './inbox-stream';

export interface InboxStreamRoutesOptions {
  hub: InboxStreamHub;
  appOrigin: string;
}

/**
 * `GET /api/v1/inbox/stream` — WebSocket inbox real-time (docs/KONTRAK-API-INBOX.md "Real-time").
 *
 * Penolakan terjadi SEBELUM upgrade (jawaban HTTP biasa):
 *  - tanpa sesi / sesi tidak sah → 401 (hook auth, cookie sesi — tidak ada token di URL);
 *  - peran tanpa `inbox.view` / sesi terbatas 2FA → 403 (hook auth);
 *  - `Origin` bukan origin aplikasi (wajib ada — browser selalu mengirimnya pada WebSocket) → 403
 *    `FORBIDDEN` + audit `auth.csrf.rejected` (pembajakan WebSocket lintas situs; review akhir
 *    Fase 1 F.5/R1);
 *  - koneksi pengguna ini sudah mencapai batas → 429 `RATE_LIMITED`.
 * Permintaan HTTP biasa (tanpa `Upgrade: websocket`) yang lolos hook auth dijawab 404 oleh plugin
 * TANPA pemeriksaan Origin/audit (review real-time R1).
 */
export const inboxStreamRoutes: FastifyPluginCallback<InboxStreamRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { hub, appOrigin } = options;

  async function guard(request: FastifyRequest): Promise<void> {
    // R1 (review real-time): GET biasa (navigasi tautan/bookmark — tanpa `Origin`) bukan upaya
    // WebSocket. Tidak diperiksa/diaudit di sini; plugin menjawabnya 404. Hanya permintaan upgrade
    // yang wajib Origin aplikasi (dan diaudit bila tidak), supaya audit `auth.csrf.rejected` tidak
    // bisa dibanjiri tautan dari situs lain.
    const upgrade = request.headers.upgrade;
    if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return;
    const auth = requireAuth(request);
    const { origin } = request.headers;
    if (origin !== appOrigin) {
      await request.server.csrfRejections.record({
        session: auth,
        reason: 'origin',
        method: request.method,
        route: request.routeOptions.url ?? '',
        origin,
        fetchSite: fetchSiteOf(request),
        client: clientInfo(request),
      });
      throw new AppError('FORBIDDEN', {
        message: 'Koneksi dari asal ini tidak diizinkan. Buka aplikasi dari alamat resminya.',
      });
    }
    if (!hub.canConnect(auth.user.id)) {
      throw new AppError('RATE_LIMITED', {
        message: 'Terlalu banyak tab atau perangkat terhubung. Tutup sebagian lalu muat ulang.',
      });
    }
  }

  app.get(
    API_ROUTES.inbox.stream,
    {
      websocket: true,
      config: { access: requirePermission('inbox.view'), rawResponse: true },
      preValidation: guard,
    },
    (socket, request) => {
      const auth = requireAuth(request);
      hub.register(socket, {
        userId: auth.user.id,
        organizationId: auth.organizationId,
        role: auth.user.role,
        sessionTokenHash: auth.sessionTokenHash,
      });
    },
  );

  done();
};
