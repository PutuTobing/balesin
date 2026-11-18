import {
  contactAttributeKeySchema,
  type AttributeDefinition,
  type ContactImportMapping,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import type { FieldErrors } from '../../lib/form';

const c = t.contacts;

/** Nilai pilihan "Atribut baru…" (kunci ditulis sendiri). */
export const CUSTOM_KEY = '__baru__';

export interface ImportAttributeRow {
  id: number;
  column: string;
  /** Kunci definisi, `CUSTOM_KEY`, atau kosong. */
  key: string;
  customKey: string;
}

/** Isian layar pemetaan (kolom kosong = tidak diimpor). */
export interface ImportFields {
  phone: string;
  name: string;
  email: string;
  notes: string;
  tags: string;
  attributes: ImportAttributeRow[];
  nextId: number;
}

const normalize = (value: string) =>
  value
    .toLocaleLowerCase('id-ID')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const GUESSES: Record<'phone' | 'name' | 'email' | 'notes' | 'tags', RegExp> = {
  phone:
    /^(no|nomor|nomer|hp|no hp|nomor hp|telp|telepon|phone|whatsapp|wa|no wa|nomor wa|handphone|mobile|msisdn)( .*)?$/,
  name: /^(nama|name|nama pelanggan|nama lengkap|customer|pelanggan|full name)$/,
  email: /^(e ?mail|surel|alamat email)$/,
  notes: /^(catatan|notes?|keterangan|ket)$/,
  tags: /^(tags?|label|labels|kategori)$/,
};

/**
 * Tebakan awal dari judul kolom (nomor, nama, email, catatan, tag) + kolom yang judulnya sama dengan
 * label/kunci atribut berdefinisi. Pengguna tetap memeriksa sebelum mengimpor.
 */
export function guessImportMapping(
  columns: readonly string[],
  definitions: readonly AttributeDefinition[],
): ImportFields {
  const used = new Set<string>();
  const find = (pattern: RegExp) => {
    const column = columns.find((item) => !used.has(item) && pattern.test(normalize(item)));
    if (column) used.add(column);
    return column ?? '';
  };
  const phone = find(GUESSES.phone);
  const name = find(GUESSES.name);
  const email = find(GUESSES.email);
  const notes = find(GUESSES.notes);
  const tags = find(GUESSES.tags);
  const attributes: ImportAttributeRow[] = [];
  for (const definition of definitions) {
    const column = columns.find(
      (item) =>
        !used.has(item) &&
        (normalize(item) === normalize(definition.key) ||
          normalize(item) === normalize(definition.label)),
    );
    if (!column) continue;
    used.add(column);
    attributes.push({ id: attributes.length, column, key: definition.key, customKey: '' });
  }
  return { phone, name, email, notes, tags, attributes, nextId: attributes.length };
}

/**
 * Isian → `mapping` API. Galat lokal memakai nama isian yang sama dengan server (`phoneColumn`,
 * `attributes.<i>.key`) supaya tampil di tempat yang sama.
 */
export function buildImportMapping(
  fields: ImportFields,
  columns: readonly string[],
):
  | { ok: true; mapping: Omit<ContactImportMapping, 'mode' | 'dryRun' | 'confirmation'> }
  | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const known = new Set(columns);
  if (!fields.phone || !known.has(fields.phone)) errors.phoneColumn = c.mappingNeedsPhone;
  const taken = new Map<string, string>();
  const claim = (column: string, field: string) => {
    if (!column) return;
    if (taken.has(column)) errors[field] = c.columnTwice;
    else taken.set(column, field);
  };
  claim(fields.phone, 'phoneColumn');
  claim(fields.name, 'nameColumn');
  claim(fields.email, 'emailColumn');
  claim(fields.notes, 'notesColumn');
  claim(fields.tags, 'tagsColumn');
  const attributes: { column: string; key: string }[] = [];
  fields.attributes.forEach((row, index) => {
    const prefix = `attributes.${String(index)}`;
    if (!row.column) {
      errors[`${prefix}.column`] = c.attributeColumnMissing;
      return;
    }
    claim(row.column, `${prefix}.column`);
    const raw = row.key === CUSTOM_KEY ? row.customKey : row.key;
    const parsed = contactAttributeKeySchema.safeParse(raw);
    if (!raw.trim()) {
      errors[`${prefix}.key`] = c.attributeKeyMissing;
    } else if (!parsed.success) {
      errors[`${prefix}.key`] = parsed.error.issues[0]?.message ?? c.attributeKeyMissing;
    } else {
      attributes.push({ column: row.column, key: parsed.data });
    }
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    mapping: {
      phoneColumn: fields.phone,
      nameColumn: fields.name || null,
      emailColumn: fields.email || null,
      notesColumn: fields.notes || null,
      tagsColumn: fields.tags || null,
      attributes,
    },
  };
}
