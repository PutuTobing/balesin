import type { ErrorDetail } from '@balesin/shared';
import type { z } from 'zod';

/** Pesan error per isian; kunci = path bertitik (mis. `owner.password`). */
export type FieldErrors = Record<string, string>;

/** Issue Zod → pesan pertama per isian. */
export function zodFieldErrors(error: z.ZodError, prefix = ''): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = joinPath(prefix, issue.path.map(String).join('.'));
    errors[key] ??= issue.message;
  }
  return errors;
}

/**
 * Detail error validasi dari API → pesan per isian. `stripPrefix` membuang awalan
 * (mis. `settings.`) supaya kuncinya sama dengan nama isian di form.
 */
export function apiFieldErrors(details: readonly ErrorDetail[], stripPrefix = ''): FieldErrors {
  const errors: FieldErrors = {};
  for (const detail of details) {
    let key = detail.field;
    if (stripPrefix && key.startsWith(stripPrefix)) key = key.slice(stripPrefix.length);
    errors[key] ??= detail.message;
  }
  return errors;
}

/** Ambil error yang kuncinya berawalan `prefix.` lalu buang awalannya. */
export function scopeErrors(errors: FieldErrors, prefix: string): FieldErrors {
  const scoped: FieldErrors = {};
  const head = `${prefix}.`;
  for (const [key, message] of Object.entries(errors)) {
    if (key.startsWith(head)) scoped[key.slice(head.length)] = message;
    else if (key === prefix) scoped[''] = message;
  }
  return scoped;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  return path ? `${prefix}.${path}` : prefix;
}

/** Id elemen pesan untuk `aria-describedby`. */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined || undefined;
}
