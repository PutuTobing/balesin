import { readTokenFromFragment } from '@balesin/shared';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useLayoutEffect, useState } from 'react';

/**
 * Token sekali pakai dari tautan email (`/undangan#token=…`, `/atur-ulang-password#token=…`,
 * `/verifikasi-email#token=…`; docs/KONTRAK-API-AUTH.md "Tautan email bertoken").
 *
 * 1. Token dibaca dari fragment saat halaman dibuka, lalu hanya disimpan di state komponen ini
 *    (memori): tidak di URL, storage, cache Query, atau pesan error.
 * 2. Fragment langsung dibuang dari alamat dan dari entri riwayat browser (`replace`, bukan
 *    entri baru), jadi tombol Back / riwayat / tab yang dipulihkan tidak menyimpan token.
 * 3. Tautan lain dibuka di tab yang sama selagi halaman ini terbuka (hanya fragment yang berubah,
 *    jadi dokumen tidak dimuat ulang): token baru menggantikan yang lama. Pemanggil memakai token
 *    sebagai `key` supaya layar dimulai dari awal untuk tautan baru.
 *
 * Lewat riwayat router (bukan `window.history.replaceState` langsung) supaya router tetap selaras
 * dengan alamat; di browser hasilnya sama dengan `history.replaceState(…, location.pathname)`.
 */
export function useLinkToken(): string | null {
  const router = useRouter();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [token, setToken] = useState(() => readTokenFromFragment(router.history.location.hash));

  // Fragment baru dengan token lain (navigasi di dokumen yang sama): simpan saat render.
  const incoming = hash ? readTokenFromFragment(hash) : null;
  if (incoming !== null && incoming !== token) setToken(incoming);

  useLayoutEffect(() => {
    const location = router.history.location;
    if (location.hash) router.history.replace(location.pathname + location.search, location.state);
  }, [router, hash]);

  return token;
}
