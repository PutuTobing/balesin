# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Image produksi Balesin — satu Dockerfile, tiga target:
#
#   docker build -f deploy/docker/Dockerfile --target api    -t balesin-api .
#   docker build -f deploy/docker/Dockerfile --target worker -t balesin-worker .
#   docker build -f deploy/docker/Dockerfile --target web    -t balesin-web .
#
# Multi-arsitektur (rilis): docker buildx build --platform linux/amd64,linux/arm64 …
#   Stage build (tsup, vite) berjalan di platform MESIN BUILD ($BUILDPLATFORM) karena hasilnya
#   JavaScript/berkas statis yang sama untuk semua arsitektur — tanpa emulasi QEMU yang lambat.
#   node_modules produksi (stage prod-deps) dipasang di platform TARGET, supaya biner native prebuilt
#   (sharp/libvips, @node-rs/argon2, msgpackr-extract) yang dipilih pnpm = linuxmusl-<arsitektur target>.
#
# Konteks build = akar repo (.dockerignore membuang docs/, assets/, .env, node_modules, dist).
# Prinsip: multi-stage (alat build tidak ikut image akhir), berjalan sebagai pengguna non-root,
# versi base image dikunci (diperbarui sengaja lewat Dependabot/PR), berkas aplikasi milik root
# dan hanya-baca bagi proses. Tag base image ditulis langsung di FROM (bukan ARG) supaya Dependabot
# bisa mengusulkan pembaruannya. Base image dipin `tag@sha256:<digest indeks multi-arsitektur>`
# (audit akhir A3): tag yang ditimpa di registry tidak ikut terpasang diam-diam; Dependabot
# memperbarui tag + digest bersamaan. Ambil digest: `docker buildx imagetools inspect <image:tag>`.

# ── Manifest workspace saja: lapisan dependency ter-cache selama lockfile tetap ────────────────
FROM scratch AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json /repo/
COPY apps/api/package.json /repo/apps/api/
COPY apps/worker/package.json /repo/apps/worker/
COPY apps/web/package.json /repo/apps/web/
COPY packages/core/package.json /repo/packages/core/
COPY packages/db/package.json /repo/packages/db/
COPY packages/shared/package.json /repo/packages/shared/
COPY e2e/package.json /repo/e2e/

# ── Dasar: Node + pnpm (versi sama dengan packageManager di package.json) ──────────────────────
# Dua salinan identik: satu di platform mesin build, satu di platform target.
FROM --platform=$BUILDPLATFORM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base-build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.18.0
WORKDIR /repo

FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base-target
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.18.0
WORKDIR /repo

# ── Dependency build (termasuk devDependencies), platform mesin build ─────────────────────────
FROM base-build AS deps
COPY --from=manifests /repo/ ./
# sharing=locked: stage deps (mesin build) dan prod-deps (target) bisa jalan bersamaan.
RUN --mount=type=cache,id=balesin-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile \
      --filter "@balesin/api..." --filter "@balesin/worker..." --filter "@balesin/web..."

# ── Build semua aplikasi (JS/berkas statis, tidak bergantung arsitektur) ───────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
# Source map dan metafile tsup tidak ikut image produksi (review Fase 7 Info 5).
RUN pnpm --filter @balesin/api --filter @balesin/worker --filter @balesin/web build \
 && rm -f apps/api/dist/*.map apps/worker/dist/*.map apps/*/dist/metafile-esm.json \
 && ! find apps/web/dist -name '*.map' | grep -q .

# node_modules produksi per aplikasi (tanpa devDependencies), dalam folder mandiri, dipasang di
# platform TARGET. Hanya manifest yang disalin: kode @balesin/* sudah di-bundle tsup (stage build),
# jadi folder paket workspace di /out tidak perlu sumbernya.
FROM base-target AS prod-deps
COPY --from=manifests /repo/ ./
RUN --mount=type=cache,id=balesin-pnpm,target=/pnpm/store,sharing=locked \
    pnpm --filter @balesin/api deploy --prod --legacy /out/api \
 && pnpm --filter @balesin/worker deploy --prod --legacy /out/worker \
 && rm -rf /out/*/node_modules/@balesin /out/*/node_modules/.pnpm/node_modules/@balesin \
           /out/*/node_modules/.pnpm/@balesin+* \
 # Penjaga: biner native sharp harus untuk arsitektur & libc target (bukan mesin build).
 && arch="$(node -p process.arch)" \
 && test -d "/out/api/node_modules/.pnpm/@img+sharp-linuxmusl-$arch@"* \
 && test -z "$(find /out -maxdepth 4 -name '@img+sharp-*' ! -name "@img+sharp-linuxmusl-$arch@*" ! -name "@img+sharp-libvips-linuxmusl-$arch@*" -print -quit)"

# ── Pemberitahuan lisensi pihak ketiga (audit akhir A5) ──────────────────────────────────────
# Dependensi produksi api + worker + web untuk SEMUA arsitektur rilis (linux, x64 + arm64, musl)
# dipasang tanpa skrip install, hanya untuk dibaca lisensinya. Hasilnya satu berkas yang identik di
# setiap image (/app/THIRD-PARTY-NOTICES) dan aset rilis THIRD-PARTY-NOTICES.txt — memuat teks
# LGPL-3.0/GPL-3.0 dan sumber libvips (biner native sharp). Gagal bila ada lisensi terlarang.
FROM base-build AS notices
COPY --from=manifests /repo/ ./
# supportedArchitectures (bukan flag --cpu install): `pnpm licenses list` juga membacanya, jadi paket
# native kedua arsitektur ikut terdaftar. Hanya salinan pnpm-workspace.yaml di stage ini yang diubah.
RUN --mount=type=cache,id=balesin-pnpm,target=/pnpm/store,sharing=locked \
    printf '\nsupportedArchitectures:\n  os: [linux]\n  cpu: [x64, arm64]\n  libc: [musl]\n' \
      >>pnpm-workspace.yaml \
 && pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter "@balesin/api..." --filter "@balesin/worker..." --filter "@balesin/web..."
COPY deploy/docker/third-party-notices.mjs /notices/
COPY deploy/docker/licenses /notices/licenses
# Penjaga: teks LGPL ikut, dan biner libvips kedua arsitektur tercantum.
RUN pnpm licenses list --prod --json \
      --filter @balesin/api --filter @balesin/worker --filter @balesin/web >/tmp/licenses.json \
 && mkdir -p /out \
 && node /notices/third-party-notices.mjs /tmp/licenses.json /out/THIRD-PARTY-NOTICES \
 && grep -q 'GNU LESSER GENERAL PUBLIC LICENSE' /out/THIRD-PARTY-NOTICES \
 && grep -q '^@img/sharp-libvips-linuxmusl-x64@' /out/THIRD-PARTY-NOTICES \
 && grep -q '^@img/sharp-libvips-linuxmusl-arm64@' /out/THIRD-PARTY-NOTICES

# ── Runtime Node bersama ──────────────────────────────────────────────────────────────────────
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS node-runtime
# tini: PID 1 yang meneruskan sinyal (SIGTERM → shutdown rapi) dan memanen proses zombie.
# Manajer paket bawaan image node (npm/npx, corepack, yarn) dibuang: runtime, healthcheck, migrasi,
# dan CLI `balesin` hanya memanggil `node`/`sh`/`tar`. Mengurangi permukaan serangan dan CVE npm
# bawaan image yang dilaporkan Trivy (audit akhir A3, tindak lanjut).
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && ! command -v npm \
 && ! command -v npx \
 && ! command -v corepack \
 && ! command -v yarn \
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
COPY --from=notices /out/THIRD-PARTY-NOTICES /app/THIRD-PARTY-NOTICES
ENV API_HOST=0.0.0.0 \
    API_PORT=3000 \
    MIGRATIONS_DIR=/app/migrations
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

# ── worker: antrian BullMQ ────────────────────────────────────────────────────────────────────
FROM node-runtime AS worker
COPY --from=prod-deps /out/worker /app
COPY --from=build /repo/apps/worker/dist /app/dist
COPY deploy/docker/worker-healthcheck.mjs /app/healthcheck.mjs
COPY --from=notices /out/THIRD-PARTY-NOTICES /app/THIRD-PARTY-NOTICES
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "dist/index.js"]

# ── web: berkas statis PWA + gateway (proxy ke api) ───────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS web
USER root
# Perbaikan keamanan sebelum image upstream dirilis ulang (gerbang CVE Trivy, audit akhir A3):
#  - nginx (+ modul bawaan image) ≥ 1.30.7 (CVE-2026-113425, -121810, -123007, -123633) dari repo
#    resmi nginx.org SAJA (--repositories-file /dev/null) supaya tidak tertukar dengan build nginx
#    Alpine; tanda tangan paket diverifikasi kunci nginx_signing.rsa.pub bawaan image.
#  - brotli-libs ≥ 1.2.1-r0 (CVE-2026-111497) dan paket Alpine lain yang tertinggal (curl, expat,
#    libxml2, libxslt, musl, zlib — CVE HIGH) lewat `apk upgrade` dari Alpine main. Dijalankan
#    SEBELUM langkah nginx.org: saat itu world masih mengunci `nginx=<versi base>`, jadi paket nginx
#    tidak mungkin tertukar dengan build Alpine.
# Versi terpasang dicetak dan build GAGAL bila masih di bawah versi perbaikan. Menjadi no-op saat
# base image (PR Dependabot) sudah memuat versi tsb.; hapus langkah ini setelah itu.
# Base image mengunci `nginx=<versi>` di /etc/apk/world, jadi nginx dinaikkan dengan
# `apk add 'paket>=versi'` (`apk upgrade` diam-diam tidak menaikkan paket terkunci).
RUN set -eu \
 && nginx_fix=1.30.7 \
 && brotli_fix=1.2.1-r0 \
 && apk upgrade --no-cache \
 && alpine="v$(cut -d. -f1,2 /etc/alpine-release)" \
 && nginx_pkgs="$(apk info | grep -E '^nginx(-module-[a-z0-9-]+)?$' | grep -v -- '-dbg$' \
      | sed "s/\$/>=$nginx_fix/" | tr '\n' ' ')" \
 && apk add --no-cache --repositories-file /dev/null \
      --repository "https://nginx.org/packages/alpine/$alpine/main" $nginx_pkgs \
 && apk add --no-cache "brotli-libs>=$brotli_fix" \
 && atleast() { v="$(apk info -e -v "$1" | sed "s/^$1-//")"; echo "terpasang: $1 $v (minimal $2)"; \
      [ -n "$v" ] && [ "$(apk version -t "$v" "$2")" != "<" ]; } \
 && atleast nginx "$nginx_fix" \
 && atleast brotli-libs "$brotli_fix" \
 && for pkg in $(apk info | grep -E '^nginx-module-' | grep -v -- '-dbg$'); do \
      atleast "$pkg" "$nginx_fix"; done \
 && nginx -v \
 # Konfigurasi bawaan image (dan salinan .apk-new dari upgrade) dibuang: hanya nginx.conf
 # Balesin yang berlaku.
 && rm -f /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/*.apk-new /etc/nginx/*.apk-new \
 && test -z "$(find /etc/nginx -name '*.apk-new' -print -quit)"
USER 101
COPY deploy/docker/gateway/nginx.conf /etc/nginx/nginx.conf
COPY deploy/docker/gateway/security-headers.conf /etc/nginx/balesin/security-headers.conf
COPY deploy/docker/gateway/proxy-api.conf /etc/nginx/balesin/proxy-api.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# Di luar root web (tidak disajikan gateway), sama dengan image api/worker.
COPY --from=notices /out/THIRD-PARTY-NOTICES /app/THIRD-PARTY-NOTICES
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/gateway-health"]
