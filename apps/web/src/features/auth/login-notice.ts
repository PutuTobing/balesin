/**
 * Pesan sekali tampil untuk halaman masuk ("sesi berakhir", "sudah keluar"). Disimpan di
 * memori (bukan di URL) supaya tidak muncul lagi saat halaman dimuat ulang atau dibagikan.
 */
export type LoginNotice = 'session-ended' | 'logged-out';

let pending: LoginNotice | null = null;

export function setLoginNotice(notice: LoginNotice | null): void {
  pending = notice;
}

/** Baca tanpa menghapus (aman dipanggil dua kali oleh StrictMode). */
export function peekLoginNotice(): LoginNotice | null {
  return pending;
}

export function clearLoginNotice(): void {
  pending = null;
}
