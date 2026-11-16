import { API_KEY_SCOPES, PERMISSIONS, type ApiKeyScope, type Permission } from '@balesin/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Deklarasi akses per rute — BAWAAN TOLAK (SECURITY.md §2, temuan N1 review Fase 0).
 *
 * Setiap rute WAJIB menyatakan siapa yang boleh memanggilnya lewat `config.access`:
 *
 *   app.get(path, { config: { access: PUBLIC }, schema: {...} }, handler)
 *   app.put(path, { config: { access: requirePermission('settings.email.manage') }, ... }, handler)
 *   app.get(path, { config: { access: AUTHENTICATED }, ... }, handler)   // "cukup sesi"
 *
 * Izin diambil dari matriks di `@balesin/shared` (`permissions.ts`, PRD §4) — TIDAK ADA
 * pemeriksaan peran langsung di rute. `AUTHENTICATED` ("cukup sesi") hanya untuk data milik
 * pengguna itu sendiri (profil, 2FA sendiri, sesi sendiri). Setiap rute terdaftar juga harus punya
 * entri di tes matriks `rbac-matrix.integration.test.ts` — rute baru tanpa entri membuat tes gagal.
 *
 * Dua lapis:
 *  1. Saat start: aplikasi MENOLAK siap (`ready`/`listen` gagal) bila ada rute tanpa deklarasi
 *     akses atau tanpa skema respons — lihat `enforceRouteDeclarations`.
 *  2. Saat permintaan datang: hook `onRequest` root (`modules/auth/auth.hook.ts`) menolak rute
 *     yang tidak punya deklarasi dan menegakkan deklarasi yang ada.
 */
export type RouteAccess =
  /** Tanpa sesi: health, setup, login, branding halaman masuk. Daftarnya dijaga tes. */
  | { readonly kind: 'public' }
  /**
   * "Cukup sesi": siapa pun yang sudah masuk dengan sesi PENUH, untuk data milik dirinya sendiri.
   * `allowTwoFactorEnrollment: true` = juga sesi terbatas Owner/Admin/Supervisor yang belum
   * mengaktifkan 2FA (lihat `AUTHENTICATED_OR_ENROLLING`).
   */
  | { readonly kind: 'authenticated'; readonly allowTwoFactorEnrollment?: boolean }
  /** Sesi penuh + izin dari matriks (`ROLE_PERMISSIONS`). Cakupan diperiksa handler/service. */
  | { readonly kind: 'permission'; readonly permission: Permission }
  /**
   * API publik (Fase 3): `Authorization: Bearer blsn_live_…`, TANPA cookie/CSRF. `scope` = scope API
   * key yang dibutuhkan (`null` hanya untuk rute pelengkap 405 = key sah apa pun). `credential`
   * `x-api-key` = lapisan kompatibel MobiChat (`/api/public/*`, `/api/bot/*`): key dibaca dari header
   * `X-API-Key`, bukan `Authorization: Bearer` (tanpa = Bearer).
   */
  | {
      readonly kind: 'apiKey';
      readonly scope: ApiKeyScope | null;
      readonly credential?: ApiKeyCredential;
    };

/** Cara API key dikirim: `Authorization: Bearer` (API v1) atau `X-API-Key` (kompatibel MobiChat). */
export type ApiKeyCredential = 'bearer' | 'x-api-key';

export const PUBLIC: RouteAccess = { kind: 'public' };
export const AUTHENTICATED: RouteAccess = { kind: 'authenticated' };

/**
 * Sesi penuh ATAU sesi terbatas "wajib mendaftar 2FA" (SECURITY.md §1: 2FA wajib untuk
 * Owner/Admin/Supervisor). HANYA untuk rute yang dibutuhkan supaya pengguna bisa menyelesaikan
 * pendaftaran: status & pendaftaran 2FA, `GET /auth/me`, dan `POST /auth/logout`. Semua rute lain
 * (termasuk `requirePermission`) menolak sesi terbatas dengan 403 `TWO_FACTOR_ENROLLMENT_REQUIRED`.
 */
export const AUTHENTICATED_OR_ENROLLING: RouteAccess = {
  kind: 'authenticated',
  allowTwoFactorEnrollment: true,
};

/** `true` bila rute ini boleh dipakai sesi terbatas yang wajib mendaftar 2FA. */
export function allowsTwoFactorEnrollment(access: RouteAccess): boolean {
  return access.kind === 'authenticated' && access.allowTwoFactorEnrollment === true;
}

/**
 * Rute ini butuh izin `permission` (PRD §4). Peran tanpa izin itu → 403 `FORBIDDEN` + audit
 * `auth.access.denied`. Peran dengan cakupan terbatas (mis. Teknisi `inbox.view` = `assigned`)
 * LOLOS di sini; handler wajib menyaring data lewat `permissionGrant` (`modules/auth/permission-grant.ts`).
 */
export function requirePermission(permission: Permission): RouteAccess {
  return { kind: 'permission', permission };
}

/** Rute API publik yang butuh scope API key ini (lihat `modules/api-keys/api-key-auth.ts`). */
export function requireApiKeyScope(scope: ApiKeyScope): RouteAccess {
  return { kind: 'apiKey', scope };
}

/** Rute kompatibel MobiChat: API key di header `X-API-Key` dengan scope ini. */
export function requireMobichatApiKeyScope(scope: ApiKeyScope): RouteAccess {
  return { kind: 'apiKey', scope, credential: 'x-api-key' };
}

/** Satu rute terdaftar beserta aksesnya — untuk tes matriks peran × endpoint. */
export interface RouteDeclaration {
  method: string;
  url: string;
  access: RouteAccess;
  /** Rute pelengkap 405 (`http/method-not-allowed.ts`), bukan rute modul. */
  methodNotAllowed: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Wajib di setiap rute. */
    access?: RouteAccess;
    /**
     * `true` = rute ini sengaja tidak punya skema respons (isi biner, atau selalu menjawab
     * lewat amplop error). Tanpa ini, rute tanpa skema respons membuat aplikasi menolak start.
     */
    rawResponse?: boolean;
    /**
     * `true` = rute GET ini punya EFEK SAMPING (menulis audit, memakai jatah, mengunduh data
     * pribadi) sehingga wajib header `X-CSRF-Token` walau metodenya "aman", dan permintaan dengan
     * `Sec-Fetch-Site` selain `same-origin` atau `Origin` asing ditolak 403 `CSRF_INVALID`.
     * Cookie sesi `SameSite=Lax` ikut terkirim pada navigasi tingkat atas dari situs lain, jadi
     * tanpa penanda ini tautan di mana pun bisa memicu rutenya (review butir 6 R3). WAJIB untuk
     * setiap GET yang menulis data/memakai jatah (mis. ekspor audit; nanti ekspor kontak, unduh
     * media). Web memanggilnya lewat `fetch` dengan header CSRF, bukan dengan membuka URL-nya.
     */
    requireCsrf?: boolean;
    /** Dipasang `http/method-not-allowed.ts` pada rute pelengkap 405. Jangan dipakai modul. */
    methodNotAllowed?: boolean;
  }
  interface FastifyInstance {
    /** Semua rute terdaftar beserta aksesnya (diisi `enforceRouteDeclarations`). */
    routeDeclarations: readonly RouteDeclaration[];
  }
}

interface RouteDefinition {
  method: string | string[];
  url: string;
  config?: {
    access?: RouteAccess;
    rawResponse?: boolean;
    requireCsrf?: boolean;
    methodNotAllowed?: boolean;
  };
  schema?: { response?: unknown };
}

/** Jaga-jaga untuk nilai yang lolos dari pemeriksaan tipe (mis. `as` atau JavaScript polos). */
function isKnownAccess(access: RouteAccess): boolean {
  switch (access.kind) {
    case 'public':
    case 'authenticated':
      return true;
    case 'permission':
      return (PERMISSIONS as readonly string[]).includes(access.permission);
    case 'apiKey':
      return access.scope === null || (API_KEY_SCOPES as readonly string[]).includes(access.scope);
    default:
      return false;
  }
}

function hasResponseSchema(route: RouteDefinition): boolean {
  const response = route.schema?.response;
  return typeof response === 'object' && response !== null && Object.keys(response).length > 0;
}

/**
 * Memeriksa setiap rute yang didaftarkan: wajib menyatakan akses dan wajib punya skema respons.
 * Pelanggaran dikumpulkan, lalu aplikasi GAGAL saat `ready()`/`listen()` dengan daftar lengkapnya
 * — proses tidak pernah mulai melayani permintaan dengan rute yang lupa dideklarasikan.
 *
 * Skema respons wajib supaya kolom di luar kontrak (`password_hash`, `token_hash`, …) tidak
 * mungkin ikut terkirim: Zod membuang semua kunci yang tidak ada di skema.
 *
 * (Sengaja tidak melempar langsung di hook `onRoute`: lemparan sinkron di dalam plugin Fastify
 * menjadi galat tak tertangani, bukan kegagalan start yang rapi.)
 *
 * Panggil setelah plugin CORS (rute `OPTIONS *` miliknya didaftarkan lebih dulu, jadi tidak ikut
 * diperiksa) dan sebelum rute pertama aplikasi. Rute apa pun yang memuat OPTIONS sesudahnya ditolak. Mengembalikan daftar (hidup) semua rute yang lolos pemeriksaan.
 */
export function enforceRouteDeclarations(
  app: Pick<FastifyInstance, 'addHook'>,
): readonly RouteDeclaration[] {
  const declarations: RouteDeclaration[] = [];
  const problems: string[] = [];

  app.addHook('onRoute', (route: RouteDefinition) => {
    const methods = [route.method].flat().map((method) => method.toUpperCase());
    const label = `${methods.join('/')} ${route.url}`;
    // OPTIONS milik plugin CORS (`OPTIONS *`, didaftarkan SEBELUM penjaga ini) tidak pernah sampai
    // ke sini. Rute aplikasi yang menerima OPTIONS ditolak: hook auth melewati OPTIONS (preflight),
    // jadi handlernya hanya terlindung perilaku plugin pihak ketiga (review RBAC, Info 1).
    if (methods.includes('OPTIONS')) {
      problems.push(
        `${label} menerima OPTIONS: rute aplikasi tidak boleh menangani OPTIONS (preflight milik CORS)`,
      );
      return;
    }

    const access = route.config?.access;
    if (!access) {
      problems.push(
        `${label} belum menyatakan akses: tambahkan config.access (requirePermission(...), AUTHENTICATED untuk data milik sendiri, atau PUBLIC)`,
      );
      return;
    }
    if (!isKnownAccess(access)) {
      problems.push(`${label} menyatakan akses yang tidak dikenal (izin harus ada di PERMISSIONS)`);
      return;
    }
    if (!route.config?.rawResponse && !hasResponseSchema(route)) {
      problems.push(
        `${label} belum punya skema respons: tambahkan schema.response, atau config.rawResponse untuk isi biner`,
      );
      return;
    }
    const methodNotAllowed = route.config?.methodNotAllowed === true;
    for (const method of methods) {
      declarations.push({ method, url: route.url, access, methodNotAllowed });
    }
  });

  app.addHook('onReady', (done) => {
    if (problems.length === 0) return done();
    done(
      new Error(
        `Aplikasi tidak bisa start: ${problems.length} rute belum lengkap deklarasinya.\n` +
          problems.map((problem) => `  - ${problem}`).join('\n'),
      ),
    );
  });

  return declarations;
}
