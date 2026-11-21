/** Perangkat seluler dari teks perangkat server ("Chrome di Android", "Safari di iOS"). */
export function isMobileDevice(device: string): boolean {
  return /android|ios|iphone|ipad/i.test(device);
}

/** `id` tombol "Keluarkan" sebuah sesi (fokus kembali ke sana setelah gagal). */
export const revokeSessionButtonId = (id: string) => `keluarkan-sesi-${id}`;
