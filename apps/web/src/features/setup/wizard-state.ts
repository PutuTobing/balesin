import {
  DEFAULT_TIME_ZONE,
  completeSetupRequestSchema,
  productNameSchema,
  setupOrganizationSchema,
  setupOwnerSchema,
  setupTokenSchema,
  type CompleteSetupRequest,
  type EmailTestResult,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import type { ApiError } from '../../lib/api/client';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import type { LogoDraft } from '../../lib/logo-file';
import {
  emailFormFingerprint,
  emptyEmailForm,
  toEmailInput,
  type EmailFormValues,
} from '../email-settings/email-form';

/**
 * Keadaan wizard setup (docs/KONTRAK-API-AUTH.md, "Alur wizard"). Semua isian disimpan di
 * memori komponen saja: password dan token TIDAK PERNAH ditulis ke localStorage/sessionStorage.
 * Maju-mundur antarlangkah tidak menghapus isian.
 */
export const SETUP_STEPS = [
  'token',
  'organization',
  'owner',
  'branding',
  'email',
  'summary',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Langkah yang boleh dilewati (ditandai "Opsional"). */
export const OPTIONAL_STEPS: ReadonlySet<SetupStep> = new Set(['branding', 'email']);

export type { LogoDraft };

export interface WizardState {
  step: SetupStep;
  /** Indeks langkah terjauh yang sudah dicapai (langkah sebelumnya bisa diklik). */
  furthest: number;
  setupToken: string;
  tokenFromLink: boolean;
  tokenVerified: boolean;
  organization: { name: string; timezone: string };
  owner: { name: string; email: string; password: string; repeat: string };
  /**
   * Warna utama sengaja tidak ada di wizard (DECISIONS 2026-11-13): belum diterapkan ke tema,
   * jadi tidak boleh dijanjikan. Isiannya kembali bersama fitur tema organisasi.
   */
  branding: { productName: string; logo: LogoDraft | null };
  email: {
    skipped: boolean;
    values: EmailFormValues;
    /** Tes koneksi terakhir yang berhasil, beserta sidik isian saat dites. */
    lastConnectionTest: { fingerprint: string; result: EmailTestResult } | null;
  };
  /** Error per isian, kunci lengkap (mis. `owner.password`, `email.port`). */
  errors: FieldErrors;
  /** Pesan umum untuk langkah sekarang (mis. batas permintaan). */
  banner: string | null;
}

export function initialWizardState(token: string | null): WizardState {
  return {
    step: 'token',
    furthest: 0,
    setupToken: token ?? '',
    tokenFromLink: token !== null,
    tokenVerified: false,
    organization: { name: '', timezone: DEFAULT_TIME_ZONE },
    owner: { name: '', email: '', password: '', repeat: '' },
    branding: { productName: '', logo: null },
    email: { skipped: false, values: emptyEmailForm, lastConnectionTest: null },
    errors: {},
    banner: null,
  };
}

export type WizardAction =
  | { type: 'goto'; step: SetupStep }
  | { type: 'patch'; patch: Partial<Omit<WizardState, 'step' | 'furthest'>> }
  | { type: 'fail'; step: SetupStep; errors: FieldErrors; banner: string | null };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'goto': {
      const index = SETUP_STEPS.indexOf(action.step);
      return {
        ...state,
        step: action.step,
        furthest: Math.max(state.furthest, index),
        errors: {},
        banner: null,
      };
    }
    case 'patch':
      return { ...state, ...action.patch };
    case 'fail':
      return {
        ...state,
        step: action.step,
        furthest: Math.max(state.furthest, SETUP_STEPS.indexOf(action.step)),
        errors: action.errors,
        banner: action.banner,
      };
  }
}

export function stepIndex(step: SetupStep): number {
  return SETUP_STEPS.indexOf(step);
}

export function nextStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.min(stepIndex(step) + 1, SETUP_STEPS.length - 1)] ?? 'summary';
}

export function previousStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.max(stepIndex(step) - 1, 0)] ?? 'token';
}

// ── Validasi per langkah (skema dari @balesin/shared) ────────────────────────

export function validateToken(state: WizardState): FieldErrors {
  const parsed = setupTokenSchema.safeParse(state.setupToken);
  return parsed.success ? {} : zodFieldErrors(parsed.error, 'setupToken');
}

export function validateOrganization(state: WizardState): FieldErrors {
  const parsed = setupOrganizationSchema.safeParse(state.organization);
  return parsed.success ? {} : zodFieldErrors(parsed.error, 'organization');
}

export function validateOwner(state: WizardState): FieldErrors {
  const { repeat, ...owner } = state.owner;
  const parsed = setupOwnerSchema.safeParse(owner);
  const errors = parsed.success ? {} : zodFieldErrors(parsed.error, 'owner');
  if (!errors['owner.password']) {
    if (repeat === '') errors['owner.repeat'] = t.form.repeatRequired;
    else if (repeat !== owner.password) errors['owner.repeat'] = t.form.passwordsDiffer;
  }
  return errors;
}

export function validateBranding(state: WizardState): FieldErrors {
  const errors: FieldErrors = {};
  const { productName } = state.branding;
  if (productName.trim() !== '') {
    const parsed = productNameSchema.safeParse(productName);
    if (!parsed.success)
      Object.assign(errors, zodFieldErrors(parsed.error, 'branding.productName'));
  }
  return errors;
}

export function validateEmail(state: WizardState): FieldErrors {
  if (state.email.skipped) return {};
  const result = toEmailInput(state.email.values);
  if (result.ok) return {};
  return Object.fromEntries(
    Object.entries(result.errors).map(([key, message]) => [`email.${key}`, message]),
  );
}

/** Hasil tes koneksi masih berlaku untuk isian sekarang? */
export function emailConnectionVerified(state: WizardState): boolean {
  const test = state.email.lastConnectionTest;
  return (
    test !== null && test.result.ok && test.fingerprint === emailFormFingerprint(state.email.values)
  );
}

// ── Kirim ───────────────────────────────────────────────────────────────────

/** Body `POST /setup/complete` dari isian wizard. */
export function buildCompleteRequest(
  state: WizardState,
  canStoreSecrets: boolean,
): CompleteSetupRequest {
  const { repeat: _repeat, ...owner } = state.owner;
  const { productName, logo } = state.branding;
  const branding = {
    productName: productName.trim() === '' ? null : productName,
    logo: logo ? { contentType: logo.contentType, dataBase64: logo.dataBase64 } : null,
  };
  const hasBranding = Object.values(branding).some((value) => value !== null);
  const emailInput =
    !canStoreSecrets || state.email.skipped ? null : toEmailInput(state.email.values);

  return completeSetupRequestSchema.parse({
    setupToken: state.setupToken,
    owner,
    organization: state.organization,
    ...(hasBranding ? { branding } : {}),
    email: emailInput?.ok ? emailInput.input : null,
  });
}

/** Langkah tempat sebuah isian berada, dari awalan field error server. */
export function stepForField(field: string): SetupStep {
  if (field === 'setupToken') return 'token';
  const head = field.split('.')[0];
  switch (head) {
    case 'organization':
      return 'organization';
    case 'owner':
      return 'owner';
    case 'branding':
      return 'branding';
    case 'email':
      return 'email';
    default:
      return 'summary';
  }
}

export type CompleteFailure =
  | { kind: 'conflict' }
  | { kind: 'step'; step: SetupStep; errors: FieldErrors; banner: string | null };

/**
 * Error dari `POST /setup/complete` → langkah yang harus dibuka + pesan per isian.
 * 409 = setup sudah selesai (layar khusus). 403 = token salah (langkah Token). 400 = buka
 * langkah PALING AWAL yang punya isian bermasalah. Lainnya (429/503/500) tetap di Ringkasan.
 */
export function mapCompleteError(error: ApiError): CompleteFailure {
  if (error.status === 409) return { kind: 'conflict' };
  if (error.status === 403 && error.code === 'FORBIDDEN') {
    return { kind: 'step', step: 'token', errors: { setupToken: error.message }, banner: null };
  }
  if (error.code === 'VALIDATION_ERROR' && error.details.length > 0) {
    const errors = apiFieldErrors(error.details);
    const steps = Object.keys(errors).map(stepForField);
    const step = steps.reduce<SetupStep>(
      (earliest, candidate) => (stepIndex(candidate) < stepIndex(earliest) ? candidate : earliest),
      'summary',
    );
    return { kind: 'step', step, errors, banner: step === 'summary' ? error.message : null };
  }
  return { kind: 'step', step: 'summary', errors: {}, banner: error.message };
}
