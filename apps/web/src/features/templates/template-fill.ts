import {
  templateVariables,
  urlButtonHasVariable,
  type MessageTemplate,
  type TemplateSendParameters,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';

/**
 * Isian saat MENGIRIM template disetujui (composer, sesi habis, percakapan baru): variabel apa yang
 * wajib diisi, pemeriksaan nilai menurut aturan Meta (sama dengan server: tanpa karakter kontrol,
 * tanpa > 4 spasi berturut-turut), dan bentuk `parameters` untuk API. Kunci galat = `field` server
 * (`parameters.body.1`, `parameters.header.text`, …) supaya galat 400 server jatuh di isian yang sama.
 */

export type MediaFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export interface FillSpec {
  /** Template OTP: satu isian kode (`body.1`), tombol salin kode memakai kode yang sama. */
  otp: boolean;
  headerVariable: string | null;
  headerMedia: MediaFormat | null;
  body: string[];
  buttons: { index: number; kind: 'URL' | 'COPY_CODE'; text: string }[];
}

export interface FillValues {
  header: string;
  body: Record<string, string>;
  buttons: Record<string, string>;
}

export const emptyFill = (): FillValues => ({ header: '', body: {}, buttons: {} });

export function fillSpec(template: MessageTemplate): FillSpec {
  const { content } = template;
  if (template.category === 'AUTHENTICATION') {
    return { otp: true, headerVariable: null, headerMedia: null, body: ['1'], buttons: [] };
  }
  const header = content.header;
  const buttons: FillSpec['buttons'] = [];
  content.buttons.forEach((button, index) => {
    if (button.type === 'URL' && urlButtonHasVariable(button.url)) {
      buttons.push({ index, kind: 'URL', text: button.text });
    } else if (button.type === 'COPY_CODE') {
      buttons.push({ index, kind: 'COPY_CODE', text: '' });
    }
  });
  return {
    otp: false,
    headerVariable: header?.format === 'TEXT' ? (templateVariables(header.text)[0] ?? null) : null,
    headerMedia: header && header.format !== 'TEXT' ? header.format : null,
    body: templateVariables(content.body.text),
    buttons,
  };
}

const s = t.inbox.templateSend;

function valueProblem(value: string | undefined): string | null {
  const text = value?.trim() ?? '';
  if (text === '') return s.required;
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) || / {5,}/.test(text)) return s.singleLine;
  return null;
}

/** Galat per isian (kosong = siap dikirim). `hasMedia`: berkas judul sudah dipilih. */
export function fillErrors(
  spec: FillSpec,
  values: FillValues,
  hasMedia: boolean,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const check = (field: string, value: string | undefined) => {
    const problem = valueProblem(value);
    if (problem) errors[field] = problem;
  };
  if (spec.headerVariable) check('parameters.header.text', values.header);
  if (spec.headerMedia && !hasMedia) errors['parameters.header.mediaId'] = s.mediaRequired;
  for (const name of spec.body) check(`parameters.body.${name}`, values.body[name]);
  for (const button of spec.buttons) {
    check(`parameters.buttons.${String(button.index)}`, values.buttons[String(button.index)]);
  }
  return errors;
}

export function fillParameters(
  spec: FillSpec,
  values: FillValues,
  mediaId?: string,
): TemplateSendParameters {
  const body: Record<string, string> = {};
  for (const name of spec.body) body[name] = (values.body[name] ?? '').trim();
  const buttons: Record<string, string> = {};
  for (const button of spec.buttons) {
    buttons[String(button.index)] = (values.buttons[String(button.index)] ?? '').trim();
  }
  const header =
    spec.headerVariable || mediaId
      ? {
          ...(spec.headerVariable ? { text: values.header.trim() } : {}),
          ...(mediaId ? { mediaId } : {}),
        }
      : undefined;
  return { ...(header ? { header } : {}), body, buttons };
}

/** Jenis berkas yang diterima untuk judul media (sama dengan lampiran chat). */
export const MEDIA_ACCEPT: Record<MediaFormat, string> = {
  IMAGE: 'image/jpeg,image/png',
  VIDEO: 'video/mp4,video/3gpp',
  DOCUMENT:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};

/** Galat 400 server per isian (`parameters.body.1`, …) → peta galat isian template. */
export function parameterErrors(error: unknown): Record<string, string> | null {
  if (!isApiError(error) || error.details.length === 0) return null;
  const errors: Record<string, string> = {};
  for (const detail of error.details) {
    if (detail.field.startsWith('parameters.')) errors[detail.field] ??= detail.message;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/** Nomor tujuan yang masuk akal sebelum dikirim (server tetap menormalkan & memeriksa). */
export function looksLikePhone(value: string): boolean {
  const digits = value.replace(/[\s().-]/g, '');
  return /^(\+?62|0)\d{7,13}$/.test(digits) || /^\+[1-9]\d{7,14}$/.test(digits);
}
