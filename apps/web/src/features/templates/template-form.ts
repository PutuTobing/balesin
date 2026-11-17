import {
  TEMPLATE_LIMITS,
  fillTemplateText,
  templateLanguageSchema,
  templateNameSchema,
  templateVariables,
  validateTemplate,
  type MessageTemplate,
  type TemplateButton,
  type TemplateCategory,
  type TemplateContent,
  type TemplateIssue,
  type TemplatePreset,
  type TemplateStatus,
} from '@balesin/shared';
import type { StatusTone } from '../../components/ui/StatusBadge';

/**
 * Logika editor template Meta (Pengaturan → Template): bentuk formulir ↔ `TemplateContent`,
 * pemeriksaan langsung dengan `validateTemplate` dari shared (aturan yang sama dengan server), dan
 * aturan apa yang masih boleh diubah menurut status Meta (docs/KONTRAK-API-TEMPLATE.md).
 */

export type ButtonKind = TemplateButton['type'];
export type HeaderKind = 'none' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export interface ButtonDraft {
  /** Kunci React (bukan bagian dari isi template). */
  key: string;
  type: ButtonKind;
  text: string;
  url: string;
  example: string;
  phoneNumber: string;
}

export interface TemplateDraft {
  channelId: string;
  name: string;
  language: string;
  category: TemplateCategory;
  parameterFormat: 'positional' | 'named';
  headerKind: HeaderKind;
  headerText: string;
  headerExample: string;
  body: string;
  /** Contoh nilai per variabel (kunci `"1"` atau nama). Variabel yang sudah dihapus diabaikan. */
  examples: Record<string, string>;
  footer: string;
  buttons: ButtonDraft[];
  otpSecurity: boolean;
  /** Masa berlaku kode dalam menit sebagai teks isian; kosong = tanpa keterangan masa berlaku. */
  otpExpiry: string;
}

let buttonSeq = 0;
export function newButton(type: ButtonKind): ButtonDraft {
  buttonSeq += 1;
  return {
    key: `tombol-${String(buttonSeq)}`,
    type,
    text: '',
    url: 'https://',
    example: '',
    phoneNumber: '+62',
  };
}

function buttonDraft(button: TemplateButton): ButtonDraft {
  const draft = newButton(button.type);
  switch (button.type) {
    case 'QUICK_REPLY':
      return { ...draft, text: button.text };
    case 'URL':
      return { ...draft, text: button.text, url: button.url, example: button.example ?? '' };
    case 'PHONE_NUMBER':
      return { ...draft, text: button.text, phoneNumber: button.phoneNumber };
    case 'COPY_CODE':
      return { ...draft, example: button.example };
  }
}

export function emptyDraft(channelId: string): TemplateDraft {
  return {
    channelId,
    name: '',
    language: 'id',
    category: 'UTILITY',
    parameterFormat: 'positional',
    headerKind: 'none',
    headerText: '',
    headerExample: '',
    body: '',
    examples: {},
    footer: '',
    buttons: [],
    otpSecurity: true,
    otpExpiry: '',
  };
}

/** Formulir dari template tersimpan (atau preset). */
export function draftFrom(
  source: Pick<MessageTemplate, 'name' | 'language' | 'category' | 'content'> & {
    channelId: string;
  },
): TemplateDraft {
  const { content } = source;
  const header = content.header;
  return {
    channelId: source.channelId,
    name: source.name,
    language: source.language,
    category: source.category,
    parameterFormat: content.parameterFormat,
    headerKind: header ? header.format : 'none',
    headerText: header?.format === 'TEXT' ? header.text : '',
    headerExample: header?.format === 'TEXT' ? (header.example ?? '') : '',
    body: content.body.text,
    examples: { ...content.body.examples },
    footer: content.footer?.text ?? '',
    buttons: content.buttons.map(buttonDraft),
    otpSecurity: content.authentication?.addSecurityRecommendation ?? true,
    otpExpiry:
      content.authentication?.codeExpirationMinutes == null
        ? ''
        : String(content.authentication.codeExpirationMinutes),
  };
}

export function draftFromPreset(preset: TemplatePreset, channelId: string): TemplateDraft {
  return draftFrom({ ...preset, channelId });
}

/** Variabel isi pesan (urut kemunculan). */
export function bodyVariables(draft: Pick<TemplateDraft, 'body'>): string[] {
  return templateVariables(draft.body);
}

export function headerVariable(draft: Pick<TemplateDraft, 'headerKind' | 'headerText'>) {
  return draft.headerKind === 'TEXT' ? (templateVariables(draft.headerText)[0] ?? null) : null;
}

/** Variabel berikut yang disisipkan tombol "Tambah variabel". */
export function nextVariable(draft: Pick<TemplateDraft, 'body' | 'parameterFormat'>): string {
  const used = bodyVariables(draft);
  if (draft.parameterFormat === 'positional') {
    const numbers = used.map(Number).filter((value) => Number.isInteger(value) && value > 0);
    return String(numbers.length === 0 ? 1 : Math.max(...numbers) + 1);
  }
  let index = used.length + 1;
  while (used.includes(`variabel_${String(index)}`)) index += 1;
  return `variabel_${String(index)}`;
}

function expiryMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : Number.NaN;
}

function buttonContent(button: ButtonDraft): TemplateButton {
  switch (button.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: button.text.trim() };
    case 'URL': {
      const url = button.url.trim();
      return {
        type: 'URL',
        text: button.text.trim(),
        url,
        ...(templateVariables(url).length > 0 ? { example: button.example.trim() } : {}),
      };
    }
    case 'PHONE_NUMBER':
      return {
        type: 'PHONE_NUMBER',
        text: button.text.trim(),
        phoneNumber: button.phoneNumber.replace(/[\s-]/g, ''),
      };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', example: button.example.trim() };
  }
}

/** Isi template dari formulir. Template OTP: hanya pengaturan kode (isi dibuat Meta). */
export function contentFrom(draft: TemplateDraft): TemplateContent {
  if (draft.category === 'AUTHENTICATION') {
    const minutes = expiryMinutes(draft.otpExpiry);
    return {
      parameterFormat: 'positional',
      header: null,
      // Isi template OTP dibuat Meta; teks yang sudah disinkron dipertahankan apa adanya.
      body: { text: draft.body, examples: {} },
      footer: null,
      buttons: [],
      authentication: {
        addSecurityRecommendation: draft.otpSecurity,
        codeExpirationMinutes: minutes === null || Number.isNaN(minutes) ? null : minutes,
      },
    };
  }
  const variables = bodyVariables(draft);
  const examples: Record<string, string> = {};
  for (const name of variables) examples[name] = (draft.examples[name] ?? '').trim();
  const header =
    draft.headerKind === 'none'
      ? null
      : draft.headerKind === 'TEXT'
        ? {
            format: 'TEXT' as const,
            text: draft.headerText,
            ...(headerVariable(draft) ? { example: draft.headerExample.trim() } : {}),
          }
        : { format: draft.headerKind };
  return {
    parameterFormat: draft.parameterFormat,
    header,
    body: { text: draft.body, examples },
    footer: draft.footer.trim() ? { text: draft.footer.trim() } : null,
    buttons: draft.buttons.map(buttonContent),
    authentication: null,
  };
}

/**
 * Semua masalah sebelum diajukan: nama & bahasa (skema shared), panjang isian, lalu
 * `validateTemplate` (aturan Meta yang bisa dipastikan tanpa Meta). Kosong = siap diajukan.
 */
export function draftIssues(draft: TemplateDraft): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const name = templateNameSchema.safeParse(draft.name);
  if (!name.success) {
    issues.push({ field: 'name', message: name.error.issues[0]?.message ?? '' });
  }
  const language = templateLanguageSchema.safeParse(draft.language);
  if (!language.success) {
    issues.push({ field: 'language', message: language.error.issues[0]?.message ?? '' });
  }
  if (draft.category === 'AUTHENTICATION') {
    const minutes = expiryMinutes(draft.otpExpiry);
    if (minutes !== null && (Number.isNaN(minutes) || minutes < 1 || minutes > 90)) {
      issues.push({
        field: 'authentication.codeExpirationMinutes',
        message: 'Masa berlaku kode 1–90 menit, atau kosongkan.',
      });
    }
  } else {
    if (draft.body.length > TEMPLATE_LIMITS.body) {
      issues.push({ field: 'body.text', message: 'Isi pesan maksimal 1.024 karakter.' });
    }
    if (
      draft.headerKind === 'IMAGE' ||
      draft.headerKind === 'VIDEO' ||
      draft.headerKind === 'DOCUMENT'
    ) {
      issues.push({
        field: 'header',
        message:
          'Judul gambar, video, atau dokumen belum bisa diajukan dari aplikasi ini. Buat di WhatsApp Manager, lalu tekan Sinkron.',
      });
    }
    draft.buttons.forEach((button, index) => {
      if (
        button.type === 'PHONE_NUMBER' &&
        !/^\+[1-9]\d{6,14}$/.test(button.phoneNumber.replace(/[\s-]/g, ''))
      ) {
        issues.push({
          field: `buttons.${String(index)}.phoneNumber`,
          message: 'Nomor telepon harus format internasional, contoh +628123456789.',
        });
      }
      if (button.type === 'COPY_CODE' && button.example.trim() === '') {
        issues.push({
          field: `buttons.${String(index)}.example`,
          message: 'Contoh kode wajib diisi (maks. 15 karakter).',
        });
      }
    });
  }
  issues.push(...validateTemplate(draft.category, contentFrom(draft)));
  return issues;
}

/** Pesan pertama per field (`content.` dari server dibuang supaya sama dengan field lokal). */
export function issueMap(issues: readonly TemplateIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.field.replace(/^content\./, '');
    map[field] ??= issue.message;
  }
  return map;
}

/** Template dengan judul media dibuat/diubah di WhatsApp Manager (butuh unggahan contoh Meta). */
export function hasMediaHeader(content: TemplateContent): boolean {
  return content.header !== null && content.header.format !== 'TEXT';
}

export interface Editability {
  /** Isi boleh diubah (PATCH tidak 409). */
  content: boolean;
  /** Nama & bahasa: tetap setelah diajukan ke Meta. */
  identity: boolean;
  /** Kategori: tetap setelah disetujui. */
  category: boolean;
  /** Alasan bila isi tidak bisa diubah. */
  lockedReason: 'review' | 'deleting' | 'deleted' | 'media' | null;
}

export function editability(template: MessageTemplate | null): Editability {
  if (!template) return { content: true, identity: true, category: true, lockedReason: null };
  const lockedReason =
    template.status === 'PENDING' || template.status === 'IN_APPEAL'
      ? 'review'
      : template.status === 'PENDING_DELETION'
        ? 'deleting'
        : template.status === 'DELETED'
          ? 'deleted'
          : hasMediaHeader(template.content)
            ? 'media'
            : null;
  const content = lockedReason === null;
  return {
    content,
    identity: content && template.metaTemplateId === null,
    category: content && template.status !== 'APPROVED',
    lockedReason,
  };
}

/** Boleh diajukan (lagi): draf, ditolak, atau ada perubahan lokal yang belum diajukan. */
export function canSubmit(template: MessageTemplate): boolean {
  if (editability(template).lockedReason !== null) return false;
  return template.status === 'DRAFT' || template.status === 'REJECTED' || template.localChanges;
}

export function statusTone(status: TemplateStatus): StatusTone {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'PENDING':
    case 'IN_APPEAL':
    case 'PENDING_DELETION':
      return 'warning';
    case 'REJECTED':
    case 'PAUSED':
    case 'DISABLED':
    case 'LIMIT_EXCEEDED':
      return 'danger';
    case 'DRAFT':
    case 'DELETED':
    case 'ARCHIVED':
      return 'neutral';
  }
}

/** Isi gelembung pratinjau: variabel diganti contoh nilainya (yang belum diisi tetap `{{x}}`). */
export function previewText(text: string, values: Readonly<Record<string, string>>): string {
  const filled: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value.trim()) filled[key] = value;
  }
  return fillTemplateText(text, filled);
}
