import {
  brandColorTextColor,
  updateBrandingRequestSchema,
  type BrandingSettings,
  type UpdateBrandingRequest,
} from '@balesin/shared';
import { color } from '@balesin/shared/design-tokens';
import { zodFieldErrors, type FieldErrors } from '../../lib/form';
import type { LogoDraft } from '../../lib/logo-file';

/** Logo di form: tetap, diganti berkas baru, atau dihapus saat disimpan. */
export type LogoChoice = { kind: 'keep' } | { kind: 'new'; draft: LogoDraft } | { kind: 'remove' };

export interface BrandingDraft {
  productName: string;
  mascotName: string;
  primaryColor: string;
  logo: LogoChoice;
}

export function draftFrom(settings: BrandingSettings): BrandingDraft {
  return {
    productName: settings.productName ?? '',
    mascotName: settings.mascotName ?? '',
    primaryColor: settings.primaryColor ?? '',
    logo: { kind: 'keep' },
  };
}

const HEX = /^#[0-9a-f]{6}$/;

export function normalizeColor(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Body `PATCH /settings/branding` dari isian yang BERUBAH saja (yang tidak dikirim = tetap; kosong
 * = `null` = kembali ke bawaan), divalidasi dengan skema bersama. `empty` = tidak ada perubahan.
 */
export function buildBrandingUpdate(
  settings: BrandingSettings,
  draft: BrandingDraft,
):
  | { ok: true; empty: true }
  | { ok: true; empty: false; body: UpdateBrandingRequest }
  | { ok: false; errors: FieldErrors } {
  const body: Record<string, unknown> = {};
  const productName = draft.productName.trim();
  if (productName !== (settings.productName ?? '')) body.productName = productName || null;
  const mascotName = draft.mascotName.trim();
  if (mascotName !== (settings.mascotName ?? '')) body.mascotName = mascotName || null;
  const primaryColor = normalizeColor(draft.primaryColor);
  if (primaryColor !== (settings.primaryColor ?? '')) body.primaryColor = primaryColor || null;
  if (draft.logo.kind === 'new') {
    body.logo = {
      contentType: draft.logo.draft.contentType,
      dataBase64: draft.logo.draft.dataBase64,
    };
  } else if (draft.logo.kind === 'remove' && settings.logo) {
    body.logo = null;
  }
  if (Object.keys(body).length === 0) return { ok: true, empty: true };
  const parsed = updateBrandingRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error) };
  return { ok: true, empty: false, body: parsed.data };
}

/**
 * Warna untuk pratinjau: warna isian bila sah dan ada teks yang terbaca di atasnya, selain itu
 * warna bawaan tema terang. `lowContrast` = kode sah tetapi teks putih maupun gelap sulit dibaca.
 */
export function previewColors(value: string): {
  primary: string;
  onPrimary: string;
  custom: boolean;
  lowContrast: boolean;
} {
  const hex = normalizeColor(value);
  const text = HEX.test(hex) ? brandColorTextColor(hex) : null;
  if (HEX.test(hex) && text)
    return { primary: hex, onPrimary: text, custom: true, lowContrast: false };
  return {
    primary: color.light.primary.toLowerCase(),
    onPrimary: color.light.onPrimary.toLowerCase(),
    custom: false,
    lowContrast: HEX.test(hex) && text === null,
  };
}
