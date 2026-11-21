import {
  channelNameSchema,
  createWhatsAppChannelRequestSchema,
  metaAccessTokenSchema,
  metaAppSecretSchema,
  phoneNumberIdSchema,
  wabaIdSchema,
  type ChannelTestResult,
  type ChannelWebhookResponse,
  type CreateChannelRequest,
  type ErrorDetail,
  type WhatsAppChannel,
} from '@balesin/shared';
import type { z } from 'zod';
import type { FieldErrors } from '../../lib/form';

/**
 * Wizard Tambah nomor (docs/SETUP-META.md, 9 langkah; alur di docs/KONTRAK-API-CHANNEL.md).
 * Server tidak menyimpan langkah wizard: urutan, isian, dan hasil tes hanya di memori komponen.
 * Token System User dan App Secret TIDAK PERNAH ditulis ke storage atau cache Query, dan dikosongkan
 * begitu channel tersimpan.
 */
export const WIZARD_STEPS = [
  'business',
  'app',
  'number',
  'ids',
  'token',
  'secret',
  'webhook',
  'test',
  'billing',
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Langkah terakhir yang berisi isian; "Lanjut" di sini = simpan channel (+ konfirmasi identitas). */
export const SAVE_STEP = WIZARD_STEPS.indexOf('secret');
/** Langkah pertama setelah channel tersimpan. */
export const AFTER_SAVE_STEP = WIZARD_STEPS.indexOf('webhook');

export interface WizardValues {
  name: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
}

export type WizardField = keyof WizardValues;

export const emptyWizardValues: WizardValues = {
  name: '',
  phoneNumberId: '',
  wabaId: '',
  accessToken: '',
  appSecret: '',
};

export interface CreatedChannel {
  channel: WhatsAppChannel;
  webhook: ChannelWebhookResponse;
}

export interface WizardState {
  /** Indeks langkah sekarang. */
  step: number;
  /** Indeks langkah terjauh yang sudah dicapai (langkah sebelumnya bisa diklik). */
  furthest: number;
  values: WizardValues;
  errors: FieldErrors;
  /** Error server yang tidak menempel di isian tertentu (ditampilkan di langkah simpan). */
  failure: unknown;
  created: CreatedChannel | null;
  testResult: ChannelTestResult | null;
}

export const initialWizardState: WizardState = {
  step: 0,
  furthest: 0,
  values: emptyWizardValues,
  errors: {},
  failure: null,
  created: null,
  testResult: null,
};

/** Isian per langkah, dengan skema yang sama dengan server. */
const STEP_FIELDS: Partial<Record<WizardStep, readonly [WizardField, z.ZodType][]>> = {
  ids: [
    ['name', channelNameSchema],
    ['phoneNumberId', phoneNumberIdSchema],
    ['wabaId', wabaIdSchema],
  ],
  token: [['accessToken', metaAccessTokenSchema]],
  secret: [['appSecret', metaAppSecretSchema]],
};

/** Langkah tempat sebuah isian berada (untuk error dari server). */
export function stepOfField(field: string): number | null {
  for (const [step, fields] of Object.entries(STEP_FIELDS)) {
    if (fields.some(([name]) => name === field)) return WIZARD_STEPS.indexOf(step as WizardStep);
  }
  return null;
}

/** Validasi isian satu langkah; kosong = boleh lanjut. */
export function validateStep(step: number, values: WizardValues): FieldErrors {
  const fields = STEP_FIELDS[WIZARD_STEPS[step] ?? 'business'] ?? [];
  const errors: FieldErrors = {};
  for (const [name, schema] of fields) {
    const result = schema.safeParse(values[name]);
    if (!result.success) errors[name] = result.error.issues[0]?.message ?? '';
  }
  return errors;
}

/** Validasi semua isian; mengembalikan error + langkah pertama yang salah. */
export function validateAll(values: WizardValues): { errors: FieldErrors; step: number | null } {
  const errors: FieldErrors = {};
  let first: number | null = null;
  for (const step of ['ids', 'token', 'secret'] as const) {
    const index = WIZARD_STEPS.indexOf(step);
    const stepErrors = validateStep(index, values);
    if (Object.keys(stepErrors).length > 0) {
      Object.assign(errors, stepErrors);
      first ??= index;
    }
  }
  return { errors, step: first };
}

/** Body `POST /settings/channels` tanpa konfirmasi (spasi tepi dibuang oleh skema). */
export function toCreateRequest(values: WizardValues): CreateChannelRequest {
  return createWhatsAppChannelRequestSchema.parse({ type: 'whatsapp', ...values });
}

/**
 * Error isian dari server (400 per isian, 409 Phone Number ID sudah jadi channel lain) → error
 * per isian + langkah tempat isian pertama yang salah. `null` = bukan error isian wizard.
 */
export function mapServerFieldErrors(
  details: readonly ErrorDetail[],
): { errors: FieldErrors; step: number } | null {
  const errors: FieldErrors = {};
  let step: number | null = null;
  for (const detail of details) {
    const index = stepOfField(detail.field);
    if (index === null) continue;
    errors[detail.field] ??= detail.message;
    step = step === null ? index : Math.min(step, index);
  }
  return step === null ? null : { errors, step };
}

/**
 * Langkah yang bisa dibuka lewat daftar langkah: yang sudah dicapai, kecuali langkah isian
 * setelah channel tersimpan (isiannya sudah dikirim; diubah dari halaman nomor).
 */
export function canOpenStep(state: WizardState, step: number): boolean {
  if (step === state.step || step > state.furthest) return false;
  if (state.created && step < AFTER_SAVE_STEP) return false;
  return true;
}

/** Ada isian yang akan hilang bila wizard ditinggalkan sebelum tersimpan. */
export function hasUnsavedInput(state: WizardState): boolean {
  if (state.created) return false;
  const { values } = state;
  return [
    values.name,
    values.phoneNumberId,
    values.wabaId,
    values.accessToken,
    values.appSecret,
  ].some((value) => value.trim() !== '');
}
