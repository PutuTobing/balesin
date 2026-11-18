import {
  validateAttributeValues,
  type AttributeDefinition,
  type AttributeValueIssue,
} from '@balesin/shared';
import type { FieldErrors } from '../../lib/form';

/** Nilai atribut berdefinisi per kunci (ejaan kunci definisi). */
export type AttributeValues = Record<string, string>;

const fold = (key: string) => key.toLocaleLowerCase('id-ID');

/** Nilai tersimpan → isian per definisi (kunci tanpa beda huruf). Sisanya = atribut bebas. */
export function splitAttributes(
  definitions: readonly AttributeDefinition[],
  stored: readonly { key: string; value: string }[],
): { defined: AttributeValues; free: { key: string; value: string }[] } {
  const byKey = new Map(definitions.map((item) => [fold(item.key), item]));
  const defined: AttributeValues = {};
  const free: { key: string; value: string }[] = [];
  for (const item of stored) {
    const definition = byKey.get(fold(item.key));
    if (definition) defined[definition.key] = item.value;
    else free.push(item);
  }
  return { defined, free };
}

/**
 * Gabungkan isian berdefinisi + atribut bebas lalu periksa dengan aturan yang SAMA dengan server
 * (`validateAttributeValues`, wajib ditegakkan). Isian kosong tidak dikirim (= tidak diisi).
 */
export function collectAttributes(
  definitions: readonly AttributeDefinition[],
  defined: AttributeValues,
  free: readonly { key: string; value: string }[],
): { ok: true; values: { key: string; value: string }[] } | { ok: false; errors: FieldErrors } {
  const values = [
    ...definitions
      .filter((item) => (defined[item.key] ?? '').trim() !== '')
      .map((item) => ({ key: item.key, value: defined[item.key] ?? '' })),
    ...free,
  ];
  const result = validateAttributeValues(definitions, values, { enforceRequired: true });
  if (result.ok) return { ok: true, values: result.values };
  return { ok: false, errors: attributeIssueErrors(result.issues) };
}

/** Isu validasi → galat isian `attributes.<kunci>` (sama dengan `details[].field` server). */
export function attributeIssueErrors(issues: readonly AttributeValueIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) errors[`attributes.${issue.key}`] ??= issue.message;
  return errors;
}

/** Galat server `attributes.<kunci>` dicocokkan tanpa beda huruf ke kunci definisi. */
export function attributeError(errors: FieldErrors, key: string): string | undefined {
  const wanted = `attributes.${fold(key)}`;
  for (const [field, message] of Object.entries(errors)) {
    if (fold(field) === wanted) return message;
  }
  return undefined;
}

/** Nilai untuk ditampilkan: tanggal `YYYY-MM-DD` → "31 Des 2026", angka → format Indonesia. */
export function displayAttributeValue(
  definition: AttributeDefinition | undefined,
  value: string,
): string {
  if (definition?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(date);
    }
  }
  if (definition?.type === 'number' && /^-?\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number.toLocaleString('id-ID', { maximumFractionDigits: 6 });
    }
  }
  return value;
}
