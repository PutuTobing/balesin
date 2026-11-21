export interface LoginSearch {
  /** Path internal tujuan setelah masuk. Divalidasi lagi dengan `safeRedirectTarget`. */
  redirect?: string;
}

/**
 * Parameter URL halaman masuk. Kunci `redirect` selalu dikembalikan (walau `undefined`)
 * karena router menggabungkan hasil ini di atas parameter mentah.
 */
export function parseLoginSearch(search: Record<string, unknown>): LoginSearch {
  const value = search.redirect;
  return { redirect: typeof value === 'string' && value.length <= 2048 ? value : undefined };
}
