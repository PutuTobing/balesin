import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

import { newId } from '../ids';

/** Primary key UUIDv7 yang dibuat di aplikasi. */
export const idColumn = () => uuid('id').primaryKey().$defaultFn(newId);

/** Semua waktu disimpan sebagai `timestamptz` (titik waktu absolut, bukan jam dinding). */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAtColumn = () => timestamptz('created_at').notNull().defaultNow();

/** Diperbarui otomatis oleh Drizzle pada setiap `update` (memakai jam database). */
export const updatedAtColumn = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`);
