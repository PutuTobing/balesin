import {
  EMAIL_TEMPLATE_BUILTIN_VARIABLE_NAMES,
  EMAIL_TEMPLATE_VARIABLE_NAME_PATTERN,
  EMAIL_TEMPLATE_VARIABLES_MAX,
  type EmailTemplate,
  type EmailTemplateContent,
  type EmailTemplateLayout,
  type EmailTemplateSummary,
  type EmailTemplateVariable,
} from '@balesin/shared';
import type { StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import type { FieldErrors } from '../../lib/form';

const c = t.emailTemplates;

/** Sama dengan pemindai server (`packages/core/src/mail/outbound-html.ts`): `{{ nama }}`. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const BUILTINS: readonly string[] = EMAIL_TEMPLATE_BUILTIN_VARIABLE_NAMES;
export const SUBJECT_MAX = 200;

/** Isian editor (semua string; `text`/`footerText` kosong = `null` saat dikirim). */
export interface EmailTemplateDraft {
  name: string;
  slug: string;
  description: string;
  subject: string;
  html: string;
  text: string;
  layout: EmailTemplateLayout;
  footerText: string;
  variables: EmailTemplateVariable[];
}

export interface VariableScan {
  /** Variabel yang harus dideklarasikan (sah, bukan bawaan), urut kemunculan subjek → HTML → teks. */
  used: string[];
  /** Variabel bawaan yang dipakai (`nama_organisasi`, `qris`). */
  builtins: string[];
  /** Penanda `{{…}}` dengan nama tidak sah, per isian tempat ditemukan. */
  invalid: { field: 'subject' | 'html' | 'text'; name: string }[];
}

export function scanVariables(input: {
  subject: string;
  html: string;
  text: string;
}): VariableScan {
  const used: string[] = [];
  const builtins: string[] = [];
  const invalid: VariableScan['invalid'] = [];
  for (const field of ['subject', 'html', 'text'] as const) {
    for (const match of input[field].matchAll(PLACEHOLDER)) {
      const name = match[1] ?? '';
      if (!EMAIL_TEMPLATE_VARIABLE_NAME_PATTERN.test(name)) {
        if (!invalid.some((item) => item.field === field && item.name === name)) {
          invalid.push({ field, name });
        }
        continue;
      }
      const target = BUILTINS.includes(name) ? builtins : used;
      if (!target.includes(name)) target.push(name);
    }
  }
  return { used, builtins, invalid };
}

/** `id_pelanggan` → "Id pelanggan" (label awal; bisa diubah pengguna). */
export function labelFromName(name: string): string {
  const words = name.replace(/_+/g, ' ').trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}`.slice(0, 60) : name;
}

/**
 * Daftar variabel = variabel yang dipakai, persis (aturan server). Label/contoh/wajib yang sudah
 * diisi dipertahankan — juga untuk variabel yang sempat terhapus lalu diketik lagi (`memory`).
 */
export function syncVariables(
  used: readonly string[],
  current: readonly EmailTemplateVariable[],
  memory: ReadonlyMap<string, EmailTemplateVariable> = new Map(),
): EmailTemplateVariable[] {
  const known = new Map(memory);
  for (const variable of current) known.set(variable.name, variable);
  return used.map(
    (name) => known.get(name) ?? { name, label: labelFromName(name), required: true, example: '' },
  );
}

/** Nama → slug (`Tagihan Bulanan` → `tagihan-bulanan`), maks. 64. */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

const EMPTY_CONTENT: EmailTemplateContent = {
  subject: '',
  html: '',
  text: null,
  variables: [],
  layout: 'brand',
  footerText: null,
};

/** Isi yang sedang dikerjakan: draf, bila tidak ada → versi terbit, bila tidak ada → kosong. */
export function workingContent(template: EmailTemplate): EmailTemplateContent {
  return template.draft ?? template.published ?? EMPTY_CONTENT;
}

export function draftFromTemplate(template: EmailTemplate): EmailTemplateDraft {
  const content = workingContent(template);
  return {
    name: template.name,
    slug: template.slug,
    description: template.description ?? '',
    subject: content.subject,
    html: content.html,
    text: content.text ?? '',
    layout: content.layout,
    footerText: content.footerText ?? '',
    variables: content.variables.map((variable) => ({ ...variable })),
  };
}

/** Isi untuk API (`draft` di PATCH, badan pratinjau). */
export function contentFromDraft(draft: EmailTemplateDraft): EmailTemplateContent {
  return {
    subject: draft.subject,
    html: draft.html,
    text: draft.text.trim() ? draft.text : null,
    variables: draft.variables,
    layout: draft.layout,
    footerText: draft.footerText.trim() ? draft.footerText : null,
  };
}

const normalized = (content: EmailTemplateContent) =>
  JSON.stringify({
    subject: content.subject,
    html: content.html,
    text: content.text?.trim() ? content.text : null,
    variables: content.variables.map(({ name, label, required, example }) => ({
      name,
      label,
      required,
      example,
    })),
    layout: content.layout,
    footerText: content.footerText?.trim() ? content.footerText : null,
  });

export function sameContent(a: EmailTemplateContent, b: EmailTemplateContent): boolean {
  return normalized(a) === normalized(b);
}

/** Draf berbeda dari versi terbit (atau belum pernah terbit tapi drafnya berisi). */
export function hasUnpublishedChanges(template: EmailTemplate): boolean {
  if (!template.published) return template.draft !== null;
  return template.draft !== null && !sameContent(template.draft, template.published);
}

/**
 * Pemeriksaan sebelum terbit (cermin aturan server yang bisa diperiksa di peramban). Kunci = nama
 * isian di form. Aturan sanitasi HTML tetap di server (galat 400 per isian).
 */
export function publishIssues(draft: EmailTemplateDraft, scan: VariableScan): FieldErrors {
  const errors: FieldErrors = {};
  const subject = draft.subject.trim();
  if (!subject) errors.subject = c.subjectRequired;
  else if (/[\r\n]/.test(draft.subject)) errors.subject = c.subjectOneLine;
  else if (subject.length > SUBJECT_MAX) errors.subject = c.subjectTooLong;
  if (!draft.html.trim()) errors.html = c.htmlRequired;
  for (const field of ['subject', 'html', 'text'] as const) {
    const names = scan.invalid.filter((item) => item.field === field).map((item) => item.name);
    if (names.length > 0 && !errors[field]) {
      errors[field] = c.invalidVariables(names.map((name) => `{{${name}}}`).join(', '));
    }
  }
  if (scan.used.length > EMAIL_TEMPLATE_VARIABLES_MAX) {
    errors.variables = c.tooManyVariables(EMAIL_TEMPLATE_VARIABLES_MAX);
  }
  return errors;
}

/**
 * Galat server per isian → kunci form: `draft.subject` → `subject`, `draft.variables.2.label` →
 * `variables.2.label`, `name`/`slug`/`description` tetap.
 */
export function fieldKey(serverField: string): string {
  return serverField.startsWith('draft.') ? serverField.slice('draft.'.length) : serverField;
}

export interface TemplateBadge {
  tone: StatusTone;
  label: string;
}

export function templateBadge(
  template: Pick<EmailTemplateSummary, 'archived' | 'publishedVersion'>,
): TemplateBadge {
  if (template.archived) return { tone: 'neutral', label: c.badge.archived };
  if (template.publishedVersion === null) return { tone: 'warning', label: c.badge.unpublished };
  return { tone: 'success', label: c.badge.published(template.publishedVersion) };
}

/** Saringan klien (server juga menyaring `q`, ini untuk ketikan sebelum permintaan selesai). */
export function matchesSearch(template: EmailTemplateSummary, needle: string): boolean {
  const value = needle.trim().toLowerCase();
  if (!value) return true;
  return [template.name, template.slug, template.subject ?? '', template.description ?? '']
    .join('\n')
    .toLowerCase()
    .includes(value);
}
