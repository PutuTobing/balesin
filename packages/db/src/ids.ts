import { v7 as uuidv7 } from 'uuid';

/**
 * ID baru untuk semua tabel: UUIDv7, dibuat di aplikasi (bukan di database).
 * UUIDv7 berurutan menurut waktu, jadi indeks primary key tetap rapat dan ID bisa
 * diurutkan kronologis.
 */
export function newId(): string {
  return uuidv7();
}
