import type { UserRole } from '@balesin/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Deklarasi akses per rute — BAWAAN TOLAK (SECURITY.md §2, temuan N1 review Fase 0).
 *
 * Setiap rute WAJIB menyatakan siapa yang boleh memanggilnya lewat `config.access`:
 *
 *   app.get(path, { config: { access: PUBLIC }, schema: {...} }, handler)
 *   app.put(path, { config: { access: allowRoles('owner', 'admin') }, schema: {...} }, handler)
 *
 * Dua lapis:
 *  1. Saat start: aplikasi MENOLAK siap (`ready`/`listen` gagal) bila ada rute tanpa deklarasi
 *     akses atau tanpa skema respons — lihat `enforceRouteDeclarations`.
 *  2. Saat permintaan datang: hook `onRequest` root (`modules/auth/auth.hook.ts`) menolak rute
 *     yang tidak punya deklarasi dan menegakkan deklarasi yang ada.
 */
export type RouteAccess =
  /** Tanpa sesi: health, setup, login, branding halaman masuk. */
  | { readonly kind: 'public' }
  /** Siapa pun yang sudah masuk. */
  | { readonly kind: 'authenticated' }
  /** Hanya peran tertentu (matriks PRD §4). */
  | { readonly kind: 'roles'; readonly roles: readonly UserRole[] };

export const PUBLIC: RouteAccess = { kind: 'public' };
export const AUTHENTICATED: RouteAccess = { kind: 'authenticated' };

export function allowRoles(...roles: [UserRole, ...UserRole[]]): RouteAccess {
  return { kind: 'roles', roles };
}

/** Satu rute terdaftar beserta aksesnya — untuk tes matriks peran × endpoint. */
export interface RouteDeclaration {
  method: string;
  url: string;
  access: RouteAccess;
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
  }
  interface FastifyInstance {
    /** Semua rute terdaftar beserta aksesnya (diisi `enforceRouteDeclarations`). */
    routeDeclarations: readonly RouteDeclaration[];
  }
}

interface RouteDefinition {
  method: string | string[];
  url: string;
  config?: { access?: RouteAccess; rawResponse?: boolean };
  schema?: { response?: unknown };
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
 * Panggil setelah plugin CORS (rute `OPTIONS *` miliknya tidak ikut diperiksa) dan sebelum
 * rute pertama aplikasi. Mengembalikan daftar (hidup) semua rute yang lolos pemeriksaan.
 */
export function enforceRouteDeclarations(
  app: Pick<FastifyInstance, 'addHook'>,
): readonly RouteDeclaration[] {
  const declarations: RouteDeclaration[] = [];
  const problems: string[] = [];

  app.addHook('onRoute', (route: RouteDefinition) => {
    const methods = [route.method].flat().map((method) => method.toUpperCase());
    // Preflight CORS: tidak membawa kredensial dan tidak menjalankan handler aplikasi.
    if (methods.every((method) => method === 'OPTIONS')) return;

    const label = `${methods.join('/')} ${route.url}`;
    const access = route.config?.access;
    if (!access) {
      problems.push(
        `${label} belum menyatakan akses: tambahkan config.access (PUBLIC, AUTHENTICATED, atau allowRoles(...))`,
      );
      return;
    }
    if (!route.config?.rawResponse && !hasResponseSchema(route)) {
      problems.push(
        `${label} belum punya skema respons: tambahkan schema.response, atau config.rawResponse untuk isi biner`,
      );
      return;
    }
    for (const method of methods) declarations.push({ method, url: route.url, access });
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
