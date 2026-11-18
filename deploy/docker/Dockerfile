# syntax=docker/dockerfile:1.7
#
# Image produksi Balesin — satu Dockerfile, tiga target:
#
#   docker build -f deploy/docker/Dockerfile --target api    -t balesin-api .
#   docker build -f deploy/docker/Dockerfile --target worker -t balesin-worker .
#   docker build -f deploy/docker/Dockerfile --target web    -t balesin-web .
#
# Konteks build = akar repo (.dockerignore membuang docs/, assets/, .env, node_modules, dist).
# Prinsip: multi-stage (alat build tidak ikut image akhir), berjalan sebagai pengguna non-root,
# versi base image dikunci (diperbarui sengaja lewat Dependabot/PR), berkas aplikasi milik root
# dan hanya-baca bagi proses. Tag base image ditulis langsung di FROM (bukan ARG) supaya Dependabot
# bisa mengusulkan pembaruannya.

# ── Dasar: Node + pnpm (versi sama dengan packageManager di package.json) ──────────────────────
FROM node:22.23.5-alpine3.24 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.18.0
WORKDIR /repo

# ── Dependency: hanya manifest dulu supaya lapisan ini ter-cache selama lockfile tetap ─────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=balesin-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter "@balesin/api..." --filter "@balesin/worker..." --filter "@balesin/web..."

# ── Build semua aplikasi ───────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @balesin/api --filter @balesin/worker --filter @balesin/web build

# node_modules produksi per aplikasi (tanpa devDependencies), dalam folder mandiri.
FROM build AS prod-deps
RUN --mount=type=cache,id=balesin-pnpm,target=/pnpm/store \
    pnpm --filter @balesin/api deploy --prod --legacy /out/api \
 && pnpm --filter @balesin/worker deploy --prod --legacy /out/worker \
 # Kode @balesin/* sudah di-bundle tsup; salinan sumber TypeScript-nya tidak perlu ikut.
 && rm -rf /out/*/src /out/*/dist /out/*/node_modules/@balesin \
           /out/*/tsconfig.json /out/*/tsup.config.ts /out/*/vitest.config.ts \
           /out/*/node_modules/.pnpm/node_modules/@balesin

# ── Runtime Node bersama ──────────────────────────────────────────────────────────────────────
FROM node:22.23.5-alpine3.24 AS node-runtime
# tini: PID 1 yang meneruskan sinyal (SIGTERM → shutdown rapi) dan memanen proses zombie.
RUN apk add --no-cache tini \
 && mkdir -p /data/media \
 && chown node:node /data/media \
 && chmod 0700 /data/media
ENV NODE_ENV=production \
    MEDIA_DIR=/data/media
WORKDIR /app
USER node
ENTRYPOINT ["/sbin/tini", "--"]

# ── api: REST + WebSocket + migrasi + perintah pemulihan ──────────────────────────────────────
FROM node-runtime AS api
COPY --from=prod-deps /out/api /app
COPY --from=build /repo/apps/api/dist /app/dist
COPY --from=build /repo/packages/db/drizzle /app/migrations
ENV API_HOST=0.0.0.0 \
    API_PORT=3000 \
    MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ── worker: antrian BullMQ ────────────────────────────────────────────────────────────────────
FROM node-runtime AS worker
COPY --from=prod-deps /out/worker /app
COPY --from=build /repo/apps/worker/dist /app/dist
COPY deploy/docker/worker-healthcheck.mjs /app/healthcheck.mjs
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ── web: berkas statis PWA + gateway (proxy ke api) ───────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24 AS web
# Konfigurasi bawaan image dibuang: hanya nginx.conf Balesin yang berlaku.
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
USER 101
COPY deploy/docker/gateway/nginx.conf /etc/nginx/nginx.conf
COPY deploy/docker/gateway/security-headers.conf /etc/nginx/balesin/security-headers.conf
COPY deploy/docker/gateway/proxy-api.conf /etc/nginx/balesin/proxy-api.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/gateway-health"]
