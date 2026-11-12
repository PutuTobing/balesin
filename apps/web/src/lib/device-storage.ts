/**
 * Preferensi per perangkat di localStorage. Semua akses dibungkus try/catch: penyimpanan
 * bisa diblokir (mode privat, kebijakan browser) dan aplikasi harus tetap jalan.
 * Hanya untuk preferensi tampilan; data pengguna dan rahasia tidak pernah disimpan di sini.
 */
const PREFIX = 'balesin.';

export function deviceKey(name: string): string {
  return `${PREFIX}${name}`;
}

export function readDeviceValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` menghapus nilai. Mengembalikan false bila penyimpanan menolak. */
export function writeDeviceValue(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readDeviceFlag(key: string, fallback: boolean): boolean {
  const value = readDeviceValue(key);
  if (value === '1') return true;
  if (value === '0') return false;
  return fallback;
}

export function writeDeviceFlag(key: string, value: boolean): void {
  writeDeviceValue(key, value ? '1' : '0');
}
