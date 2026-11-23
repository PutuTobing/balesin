/**
 * Halaman peringatan tautan menipu (`/email/tautan?ke=&tampil=`, kontrak §8 `link_mismatch`). Halaman
 * ini bisa dibuka lewat tautan rakitan siapa pun, jadi nilai pencarian = data tak tepercaya.
 */
export interface MailLinkWarningSearch {
  ke?: string;
  tampil?: string;
}

export function parseMailLinkWarningSearch(search: Record<string, unknown>): MailLinkWarningSearch {
  const text = (value: unknown) =>
    typeof value === 'string' && value.length <= 4096 ? value : undefined;
  const ke = text(search.ke);
  const tampil = text(search.tampil);
  return { ...(ke !== undefined ? { ke } : {}), ...(tampil !== undefined ? { tampil } : {}) };
}

/**
 * Tujuan yang boleh ditawarkan: HANYA `http:`/`https:` — `javascript:`/`data:`/`file:`/`blob:` dsb.
 * tidak pernah menjadi `href`.
 */
export function safeLinkTarget(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
