import { useMatch } from '@tanstack/react-router';

/** Layar induk di HP (layar bertumpuk): menentukan tujuan tombol kembali. */
export type PageParent = 'more';

/**
 * Keterangan halaman yang sudah diketahui dari rute, sebelum isinya dimuat. Ditulis satu
 * kali di `staticData.page` rute (app/router.ts) dan dipakai bersama oleh `Page` dan
 * `PageSkeleton`, sehingga header saat memuat sama persis dengan header layar jadi.
 */
export interface PageMeta {
  title: string;
  parent?: PageParent;
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    page?: PageMeta;
  }
}

/** Keterangan halaman dari rute yang sedang dirender (bisa kosong, mis. rute pengalih). */
export function usePageMeta(): PageMeta | undefined {
  return useMatch({ strict: false, select: (match) => match.staticData.page });
}
