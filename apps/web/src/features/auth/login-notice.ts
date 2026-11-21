/**
 * Pesan sekali tampil untuk halaman masuk ("sesi berakhir", "sudah keluar", "password sudah
 * diganti"). Disimpan di memori (bukan di URL) supaya tidak muncul lagi saat halaman dimuat ulang
 * atau dibagikan.
 */
export type LoginNotice = 'session-ended' | 'logged-out' | 'password-reset';

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

/**
 * Email yang sudah diketik di halaman masuk, dibawa ke "Lupa password?" (dan sebaliknya) supaya
 * tidak perlu diketik ulang. Memori saja: tidak di URL (alamat email tidak boleh masuk log/riwayat).
 */
let handoffEmail = '';

export function setHandoffEmail(email: string): void {
  handoffEmail = email.trim();
}

/** Baca tanpa menghapus (aman dipanggil dua kali oleh StrictMode); hapus lewat `clearHandoffEmail`. */
export function peekHandoffEmail(): string {
  return handoffEmail;
}

export function clearHandoffEmail(): void {
  handoffEmail = '';
}
