/**
 * Simpan `Blob` hasil `fetch` (ekspor CSV) lewat tautan unduhan sementara. Tidak membuka tab baru
 * dan tidak menaruh token di URL; URL objek dicabut setelah browser memulai unduhan.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** Nama berkas dari `Content-Disposition` server, atau cadangan. Hanya nama aman (tanpa path). */
export function fileNameFrom(headers: Headers, fallback: string): string {
  const disposition = headers.get('content-disposition') ?? '';
  const match = /filename="([^"/\\]+)"/.exec(disposition);
  return match?.[1] ?? fallback;
}

/** Tanggal perangkat `YYYYMMDD` untuk nama berkas. */
export function fileDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}
