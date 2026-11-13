import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { estimatePasswordStrength } from './password-strength';
import { readSetupTokenFromHash } from './setup-token';
import {
  buildCompleteRequest,
  initialWizardState,
  mapCompleteError,
  stepForField,
  validateBranding,
  validateEmail,
  validateOrganization,
  validateOwner,
  wizardReducer,
  type WizardState,
} from './wizard-state';

const TOKEN = 'token-setup-yang-panjang-1234567890';

function filled(): WizardState {
  return {
    ...initialWizardState(TOKEN),
    organization: { name: 'PT Maju Jaya', timezone: 'Asia/Makassar' },
    owner: {
      name: 'Rina Kartika',
      email: 'Rina@MajuJaya.co.id',
      password: 'Kopi-Senja-Tenang-42',
      repeat: 'Kopi-Senja-Tenang-42',
    },
  };
}

const error = (status: number, code: string, details: { field: string; message: string }[] = []) =>
  new ApiError({ status, code, message: `pesan ${code}`, details });

describe('pemetaan error /setup/complete ke langkah', () => {
  it.each([
    ['setupToken', 'token'],
    ['organization.name', 'organization'],
    ['owner.password', 'owner'],
    ['branding.logo', 'branding'],
    ['email.port', 'email'],
    ['', 'summary'],
  ])('%s → %s', (field, step) => {
    expect(stepForField(field)).toBe(step);
  });

  it('400: membuka langkah PALING AWAL yang bermasalah, dengan pesan per isian', () => {
    const result = mapCompleteError(
      error(400, 'VALIDATION_ERROR', [
        { field: 'email.port', message: 'Port tidak didukung.' },
        { field: 'owner.password', message: 'Password terlalu umum.' },
      ]),
    );
    expect(result).toEqual({
      kind: 'step',
      step: 'owner',
      errors: { 'email.port': 'Port tidak didukung.', 'owner.password': 'Password terlalu umum.' },
      banner: null,
    });
  });

  it('403 token salah → langkah Token; 409 → setup sudah selesai; lainnya tetap di Ringkasan', () => {
    expect(mapCompleteError(error(403, 'FORBIDDEN'))).toMatchObject({
      kind: 'step',
      step: 'token',
      errors: { setupToken: 'pesan FORBIDDEN' },
    });
    expect(mapCompleteError(error(409, 'CONFLICT'))).toEqual({ kind: 'conflict' });
    expect(mapCompleteError(error(503, 'SERVICE_UNAVAILABLE'))).toEqual({
      kind: 'step',
      step: 'summary',
      errors: {},
      banner: 'pesan SERVICE_UNAVAILABLE',
    });
  });
});

describe('validasi per langkah (skema bersama)', () => {
  it('organisasi wajib bernama', () => {
    expect(validateOrganization(initialWizardState(null))).toEqual({
      'organization.name': 'Nama perusahaan wajib diisi.',
    });
  });

  it('Owner: password minimal 10 karakter dan ulangan harus sama', () => {
    const state = filled();
    expect(validateOwner(state)).toEqual({});
    expect(
      validateOwner({ ...state, owner: { ...state.owner, password: 'pendek', repeat: 'pendek' } }),
    ).toEqual({ 'owner.password': 'Password minimal 10 karakter.' });
    expect(validateOwner({ ...state, owner: { ...state.owner, repeat: 'lain' } })).toEqual({
      'owner.repeat': 'Password tidak sama. Ketik ulang password yang sama.',
    });
  });

  it('branding opsional; warna harus heksadesimal 6 digit', () => {
    const state = filled();
    expect(validateBranding(state)).toEqual({});
    expect(
      validateBranding({ ...state, branding: { ...state.branding, primaryColor: 'biru' } }),
    ).toHaveProperty('branding.primaryColor');
  });

  it('email yang dilewati tidak divalidasi; yang diisi butuh password bila ada username', () => {
    const state = filled();
    expect(validateEmail({ ...state, email: { ...state.email, skipped: true } })).toEqual({});
    const errors = validateEmail({
      ...state,
      email: {
        ...state.email,
        values: {
          ...state.email.values,
          fromName: 'CS',
          fromAddress: 'cs@majujaya.co.id',
          host: 'mail.majujaya.co.id',
          username: 'cs@majujaya.co.id',
        },
      },
    });
    expect(errors).toEqual({ 'email.password': 'Password wajib diisi.' });
  });
});

describe('body /setup/complete', () => {
  it('tanpa branding dan email bila dilewati; email dibakukan', () => {
    const state = { ...filled(), email: { ...filled().email, skipped: true } };
    const body = buildCompleteRequest(state, true);
    expect(body).toEqual({
      setupToken: TOKEN,
      owner: {
        name: 'Rina Kartika',
        email: 'rina@majujaya.co.id',
        password: 'Kopi-Senja-Tenang-42',
      },
      organization: { name: 'PT Maju Jaya', timezone: 'Asia/Makassar' },
      email: null,
    });
    expect(JSON.stringify(body)).not.toContain('repeat');
  });

  it('branding terisi sebagian: yang kosong dikirim null', () => {
    const state = filled();
    const body = buildCompleteRequest(
      { ...state, branding: { productName: 'CS Maju', primaryColor: '#1B3557', logo: null } },
      true,
    );
    expect(body.branding).toEqual({ productName: 'CS Maju', primaryColor: '#1b3557', logo: null });
  });

  it('server tanpa master key: email tidak pernah dikirim', () => {
    const state = filled();
    const body = buildCompleteRequest(state, false);
    expect(body.email).toBeNull();
  });
});

describe('reducer wizard', () => {
  it('maju-mundur tidak menghapus isian dan mengingat langkah terjauh', () => {
    let state = filled();
    state = wizardReducer(state, { type: 'goto', step: 'branding' });
    state = wizardReducer(state, { type: 'goto', step: 'organization' });
    expect(state.furthest).toBe(3);
    expect(state.owner.password).toBe('Kopi-Senja-Tenang-42');
    state = wizardReducer(state, {
      type: 'fail',
      step: 'owner',
      errors: { 'owner.email': 'x' },
      banner: null,
    });
    expect(state.step).toBe('owner');
    expect(state.errors).toEqual({ 'owner.email': 'x' });
    expect(wizardReducer(state, { type: 'goto', step: 'branding' }).errors).toEqual({});
  });
});

describe('token dari fragment alamat', () => {
  it('membaca #token=… dan mengabaikan fragment lain', () => {
    expect(readSetupTokenFromHash('#token=abc123')).toBe('abc123');
    expect(readSetupTokenFromHash('#token=%20abc%20')).toBe('abc');
    expect(readSetupTokenFromHash('#bagian')).toBeNull();
    expect(readSetupTokenFromHash('')).toBeNull();
  });
});

describe('perkiraan kekuatan password', () => {
  it('panjang adalah faktor utama; pengulangan menurunkan nilai', () => {
    expect(estimatePasswordStrength('abc')).toEqual({ level: 0, missing: 7 });
    expect(estimatePasswordStrength('kopisenja1').level).toBe(1);
    expect(estimatePasswordStrength('kopi senja tenang').level).toBe(2);
    expect(estimatePasswordStrength('Kopi-Senja-Tenang-42').level).toBe(3);
    expect(estimatePasswordStrength('aaaaaaaaaaaaaaaa').level).toBe(1);
  });
});
