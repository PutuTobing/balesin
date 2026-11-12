import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as drizzleKit from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MIGRATIONS_FOLDER } from './migrator';
import * as schema from './schema';

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

/** Snapshot skema buatan drizzle-kit; di sini cukup diketahui punya `id`. */
interface Snapshot {
  id: string;
}

// Tipe bawaan `drizzle-kit/api` tidak bisa di-resolve (dibangun untuk zod v3), jadi dua fungsi
// yang dipakai diberi tipe sendiri di sini.
const { generateDrizzleJson, generateMigration } = drizzleKit as unknown as {
  generateDrizzleJson: (imports: Record<string, unknown>, previousId?: string) => Snapshot;
  generateMigration: (previous: Snapshot, current: Snapshot) => Promise<string[]>;
};

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(DEFAULT_MIGRATIONS_FOLDER, ...segments), 'utf8')) as T;
}

/**
 * Penjaga aturan "perubahan skema selalu lewat migrasi": bila `src/schema` diubah tanpa
 * menjalankan `pnpm db:generate`, tes ini gagal dan menampilkan SQL yang belum dibuat.
 */
describe('skema dan migrasi sinkron', () => {
  it('tidak ada perubahan skema yang belum dibuatkan migrasinya', async () => {
    const latest = readJson<Journal>('meta', '_journal.json').entries.at(-1);
    if (!latest) throw new Error('Belum ada migrasi sama sekali.');

    const applied = readJson<Snapshot>(
      'meta',
      `${String(latest.idx).padStart(4, '0')}_snapshot.json`,
    );
    const current = generateDrizzleJson(schema, applied.id);

    const pendingSql = await generateMigration(applied, current);

    expect(pendingSql, 'jalankan `pnpm db:generate` lalu commit berkas migrasinya').toEqual([]);
  });

  it('setiap migrasi di jurnal punya berkas SQL-nya', () => {
    const { entries } = readJson<Journal>('meta', '_journal.json');

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8');
      expect(sql.trim().length, entry.tag).toBeGreaterThan(0);
    }
  });
});
