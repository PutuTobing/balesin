/**
 * Dokumen untuk `<iframe sandbox="" srcdoc>` pratinjau template email. HTML email dari server
 * sudah di-escape dan tanpa skrip; ini lapisan tambahan di sisi web:
 *
 *  - iframe ber-`sandbox=""` (tanpa `allow-scripts`, tanpa `allow-same-origin`): skrip apa pun
 *    tidak jalan, dokumennya ber-origin buram (tidak bisa membaca cookie/DOM aplikasi);
 *  - `<meta http-equiv="Content-Security-Policy">` di dalam dokumen: hanya gaya inline dan gambar
 *    `data:` (logo) yang boleh dimuat — tidak ada permintaan jaringan dari pratinjau (piksel
 *    pelacak, font luar), tidak ada form;
 *  - `<base target="_blank">`: tautan contoh di email (tombol "Terima undangan" dst.) membuka tab
 *    baru, yang DITOLAK sandbox (tanpa `allow-popups`). Jadi tautan contoh tidak bisa membuka apa
 *    pun, termasuk aplikasi ini di dalam bingkai.
 *
 * CSP gabungan: kebijakan di dalam dokumen hanya bisa MEMPERKETAT kebijakan halaman induk yang
 * diwarisi `srcdoc` (bukan melonggarkan) — lihat catatan CSP di docs/KONTRAK-API-AUTH.md.
 */
const PREVIEW_HEAD =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; ' +
  "style-src 'unsafe-inline'; form-action 'none'\">" +
  '<base target="_blank">';

export function emailPreviewDocument(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${PREVIEW_HEAD}${html.slice(at)}`;
  }
  return `<!doctype html><html><head>${PREVIEW_HEAD}</head><body>${html}</body></html>`;
}

/** Atribut `sandbox` pratinjau: kosong = semua pembatasan aktif. */
export const EMAIL_PREVIEW_SANDBOX = '';
