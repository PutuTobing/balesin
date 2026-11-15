import {
  BUSINESS_PROFILE_CONFIRMED_FIELDS,
  BUSINESS_VERTICALS,
  BUSINESS_VERTICAL_LABELS,
  updateBusinessProfileRequestSchema,
  type BusinessProfile,
  type ErrorDetail,
  type UpdateBusinessProfileRequest,
} from '@balesin/shared';
import type { FieldErrors } from '../../lib/form';

/**
 * Form profil bisnis (docs/KONTRAK-API-CHANNEL.md "Profil bisnis"). Hanya isian yang berubah yang
 * dikirim; `""`/`[]` = kosongkan di Meta. Isian yang tampil sebagai teks/tautan ke pelanggan
 * (`BUSINESS_PROFILE_CONFIRMED_FIELDS`) wajib konfirmasi identitas; kategori saja tidak.
 */
export interface ProfileFormValues {
  about: string;
  address: string;
  description: string;
  email: string;
  website1: string;
  website2: string;
  vertical: string;
}

export function profileFormFrom(profile: BusinessProfile): ProfileFormValues {
  return {
    about: profile.about ?? '',
    address: profile.address ?? '',
    description: profile.description ?? '',
    email: profile.email ?? '',
    website1: profile.websites[0] ?? '',
    website2: profile.websites[1] ?? '',
    vertical: profile.vertical ?? '',
  };
}

function websitesOf(values: ProfileFormValues): string[] {
  return [values.website1, values.website2].map((site) => site.trim()).filter(Boolean);
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** Isian yang berubah dibanding profil dari Meta (spasi tepi diabaikan). */
export function profileChanges(
  values: ProfileFormValues,
  profile: BusinessProfile,
): UpdateBusinessProfileRequest {
  const changes: UpdateBusinessProfileRequest = {};
  for (const field of ['about', 'address', 'description', 'email'] as const) {
    if (values[field].trim() !== (profile[field] ?? '').trim()) changes[field] = values[field];
  }
  const websites = websitesOf(values);
  if (!sameList(websites, profile.websites)) changes.websites = websites;
  if (values.vertical !== (profile.vertical ?? '')) {
    changes.vertical = values.vertical as UpdateBusinessProfileRequest['vertical'];
  }
  return changes;
}

export function hasProfileChanges(changes: UpdateBusinessProfileRequest): boolean {
  return Object.keys(changes).length > 0;
}

/** Perubahan selain kategori → wajib konfirmasi identitas (semua peran, Owner juga). */
export function profileNeedsConfirmation(changes: UpdateBusinessProfileRequest): boolean {
  return BUSINESS_PROFILE_CONFIRMED_FIELDS.some((field) => changes[field] !== undefined);
}

/** Path isian server/Zod (`websites.1`) → nama isian form (`website2`). */
function formField(path: string): string {
  if (path === 'websites' || path === 'websites.0') return 'website1';
  if (path === 'websites.1') return 'website2';
  return path;
}

/** Validasi dengan skema yang sama dengan server. */
export function validateProfileChanges(changes: UpdateBusinessProfileRequest): FieldErrors {
  const result = updateBusinessProfileRequestSchema.safeParse(changes);
  if (result.success) return {};
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    errors[formField(issue.path.map(String).join('.'))] ??= issue.message;
  }
  return errors;
}

/** Error 400 per isian dari server → error per isian form (konfirmasi identitas tidak termasuk). */
export function profileFieldErrors(details: readonly ErrorDetail[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const detail of details) {
    if (detail.field.startsWith('confirmation.')) continue;
    errors[formField(detail.field)] ??= detail.message;
  }
  return errors;
}

/**
 * Pilihan kategori: "Belum dipilih", lalu kategori Meta berlabel Indonesia urut abjad. Nilai dari
 * Meta yang belum dikenal tetap jadi pilihan (tampil apa adanya) supaya tidak hilang diam-diam.
 */
export function verticalOptions(
  current: string,
  labels: { none: string; unknown: (value: string) => string },
): { value: string; label: string }[] {
  const known = [...BUSINESS_VERTICALS]
    .map((value) => ({ value, label: BUSINESS_VERTICAL_LABELS[value] }))
    .sort((a, b) => a.label.localeCompare(b.label, 'id-ID'));
  const unknown =
    current !== '' && !(BUSINESS_VERTICALS as readonly string[]).includes(current)
      ? [{ value: current, label: labels.unknown(current) }]
      : [];
  return [{ value: '', label: labels.none }, ...unknown, ...known];
}
