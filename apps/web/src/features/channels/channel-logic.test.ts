import { describe, expect, it } from 'vitest';
import { fakeChannel } from '../../test/fake-api';
import { addBlockedReason, channelStatusView, isChannelId, qualityView } from './channel-status';
import { credentialChanges, validateCredentialChanges } from './credentials-form';
import {
  hasProfileChanges,
  profileChanges,
  profileFieldErrors,
  profileFormFrom,
  profileNeedsConfirmation,
  validateProfileChanges,
  verticalOptions,
} from './profile-form';
import {
  AFTER_SAVE_STEP,
  SAVE_STEP,
  WIZARD_STEPS,
  canOpenStep,
  emptyWizardValues,
  hasUnsavedInput,
  initialWizardState,
  mapServerFieldErrors,
  toCreateRequest,
  validateAll,
  validateStep,
} from './wizard-state';

const IDS = WIZARD_STEPS.indexOf('ids');
const TOKEN = WIZARD_STEPS.indexOf('token');
const VALID = {
  name: 'CS Utama',
  phoneNumberId: ' 106540352242922 ',
  wabaId: '102290129340398',
  accessToken: `EAAG${'x'.repeat(40)}\n`,
  appSecret: '9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a91',
};

describe('status & kualitas channel', () => {
  it('Nonaktif mengalahkan status koneksi', () => {
    expect(channelStatusView({ enabled: false, status: 'connected' })).toEqual({
      tone: 'neutral',
      label: 'Nonaktif',
    });
    expect(channelStatusView({ enabled: true, status: 'failed' })).toEqual({
      tone: 'danger',
      label: 'Koneksi gagal',
    });
    expect(channelStatusView({ enabled: true, status: 'untested' }).label).toBe('Belum dites');
  });

  it('kualitas: GREEN Tinggi hijau, YELLOW Sedang kuning, RED Rendah merah, lainnya netral', () => {
    expect(qualityView('GREEN')).toEqual({ tone: 'success', label: 'Tinggi' });
    expect(qualityView('YELLOW')).toEqual({ tone: 'warning', label: 'Sedang' });
    expect(qualityView('RED')).toEqual({ tone: 'danger', label: 'Rendah' });
    expect(qualityView('UNKNOWN')).toEqual({ tone: 'neutral', label: 'Belum dinilai' });
    expect(qualityView(null).tone).toBe('neutral');
    expect(qualityView('PURPLE')).toEqual({ tone: 'neutral', label: 'PURPLE' });
  });

  it('tambah nomor ditolak tanpa kunci enkripsi atau saat batas tercapai', () => {
    const base = { channels: [], canStoreSecrets: true, maxChannels: 2 };
    expect(addBlockedReason(base)).toBeNull();
    expect(addBlockedReason({ ...base, canStoreSecrets: false })).toBe('noMasterKey');
    expect(addBlockedReason({ ...base, channels: [fakeChannel(), fakeChannel()] })).toBe('limit');
  });

  it('hanya UUID yang dianggap ID channel', () => {
    expect(isChannelId('6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01')).toBe(true);
    expect(isChannelId('tambah')).toBe(false);
    expect(isChannelId('../../auth/me')).toBe(false);
  });
});

describe('wizard tambah nomor', () => {
  it('validasi per langkah memakai skema server (pesan Indonesia)', () => {
    expect(validateStep(0, emptyWizardValues)).toEqual({});
    const errors = validateStep(IDS, { ...emptyWizardValues, phoneNumberId: '1065-4035' });
    expect(errors.name).toBe('Nama channel wajib diisi.');
    expect(errors.phoneNumberId).toMatch(/hanya berisi angka/);
    expect(errors.wabaId).toBe('WhatsApp Business Account ID wajib diisi.');
    expect(
      validateStep(TOKEN, { ...emptyWizardValues, accessToken: 'pendek' }).accessToken,
    ).toMatch(/terlalu pendek/);
  });

  it('validasi semua isian menunjuk langkah pertama yang salah', () => {
    expect(validateAll(VALID)).toEqual({ errors: {}, step: null });
    const result = validateAll({ ...VALID, accessToken: '' });
    expect(result.step).toBe(TOKEN);
    expect(Object.keys(result.errors)).toEqual(['accessToken']);
  });

  it('spasi tepi dan baris baru hasil tempel dibuang sebelum dikirim', () => {
    expect(toCreateRequest(VALID)).toEqual({
      type: 'whatsapp',
      name: 'CS Utama',
      phoneNumberId: '106540352242922',
      wabaId: '102290129340398',
      accessToken: `EAAG${'x'.repeat(40)}`,
      appSecret: VALID.appSecret,
    });
  });

  it('error isian dari server dipetakan ke langkahnya; konfirmasi identitas tidak', () => {
    expect(
      mapServerFieldErrors([
        { location: 'body', field: 'appSecret', message: 'App Secret salah.' },
        { location: 'body', field: 'phoneNumberId', message: 'Sudah dipakai channel lain.' },
      ]),
    ).toEqual({
      step: IDS,
      errors: { appSecret: 'App Secret salah.', phoneNumberId: 'Sudah dipakai channel lain.' },
    });
    expect(
      mapServerFieldErrors([{ location: 'body', field: 'confirmation.password', message: 'x' }]),
    ).toBeNull();
  });

  it('setelah tersimpan, langkah isian tidak bisa dibuka lagi dan tidak ada yang hilang', () => {
    const state = { ...initialWizardState, step: AFTER_SAVE_STEP + 1, furthest: 8 };
    expect(canOpenStep(state, IDS)).toBe(true);
    const saved = { ...state, created: {} as never };
    expect(canOpenStep(saved, IDS)).toBe(false);
    expect(canOpenStep(saved, AFTER_SAVE_STEP)).toBe(true);
    expect(canOpenStep(saved, 8)).toBe(true);
    expect(canOpenStep(state, state.step)).toBe(false);
    expect(hasUnsavedInput({ ...state, values: VALID })).toBe(true);
    expect(hasUnsavedInput({ ...saved, values: VALID })).toBe(false);
    expect(hasUnsavedInput(initialWizardState)).toBe(false);
    expect(SAVE_STEP).toBe(WIZARD_STEPS.indexOf('secret'));
  });
});

describe('ganti kredensial', () => {
  const channel = fakeChannel();
  const unchanged = {
    phoneNumberId: channel.phoneNumberId,
    wabaId: channel.wabaId,
    accessToken: '',
    appSecret: '',
  };

  it('hanya isian yang berubah yang dikirim; rahasia kosong = tetap', () => {
    expect(credentialChanges(unchanged, channel)).toEqual({});
    expect(
      credentialChanges({ ...unchanged, phoneNumberId: ` ${channel.phoneNumberId} ` }, channel),
    ).toEqual({});
    expect(credentialChanges({ ...unchanged, accessToken: 'tokenbaru' }, channel)).toEqual({
      accessToken: 'tokenbaru',
    });
    expect(credentialChanges({ ...unchanged, wabaId: '99999' }, channel)).toEqual({
      wabaId: '99999',
    });
  });

  it('isian yang berubah divalidasi dengan skema server', () => {
    expect(validateCredentialChanges({ appSecret: 'bukan rahasia!' }).appSecret).toMatch(
      /huruf dan angka/,
    );
    expect(validateCredentialChanges({ wabaId: '102290129340399' })).toEqual({});
  });
});

describe('profil bisnis', () => {
  const profile = {
    about: 'Internet cepat.',
    address: null,
    description: 'Deskripsi',
    email: 'cs@majujaya.co.id',
    websites: ['https://majujaya.co.id'],
    vertical: 'PROF_SERVICES',
  };

  it('perubahan dihitung per isian; mengosongkan dikirim sebagai "" / []', () => {
    const form = profileFormFrom(profile);
    expect(hasProfileChanges(profileChanges(form, profile))).toBe(false);
    expect(profileChanges({ ...form, website1: '', email: '' }, profile)).toEqual({
      websites: [],
      email: '',
    });
    expect(profileChanges({ ...form, website2: 'https://majujaya.co.id/promo' }, profile)).toEqual({
      websites: ['https://majujaya.co.id', 'https://majujaya.co.id/promo'],
    });
  });

  it('hanya kategori yang boleh tanpa konfirmasi identitas', () => {
    expect(profileNeedsConfirmation({ vertical: 'RETAIL' })).toBe(false);
    for (const change of [
      { about: 'Baru' },
      { address: '' },
      { description: 'x' },
      { email: 'a@b.co' },
      { websites: [] },
    ]) {
      expect(profileNeedsConfirmation(change)).toBe(true);
    }
  });

  it('error validasi & error server dipetakan ke isian form (website ke-2)', () => {
    expect(validateProfileChanges({ websites: ['https://ok.co.id', 'ftp://salah'] })).toEqual({
      website2: expect.stringMatching(/https:\/\//) as string,
    });
    expect(validateProfileChanges({ about: '' }).about).toBe('Tentang tidak boleh kosong.');
    expect(
      profileFieldErrors([
        { location: 'body', field: 'websites.0', message: 'Salah.' },
        { location: 'body', field: 'confirmation.code', message: 'Kode salah.' },
      ]),
    ).toEqual({ website1: 'Salah.' });
  });

  it('pilihan kategori berlabel Indonesia; nilai Meta tak dikenal tetap ada', () => {
    const labels = { none: 'Belum dipilih', unknown: (value: string) => `${value} (dari Meta)` };
    const options = verticalOptions('PROF_SERVICES', labels);
    expect(options[0]).toEqual({ value: '', label: 'Belum dipilih' });
    expect(options).toContainEqual({ value: 'PROF_SERVICES', label: 'Layanan profesional' });
    expect(verticalOptions('SPACE_TRAVEL', labels)[1]).toEqual({
      value: 'SPACE_TRAVEL',
      label: 'SPACE_TRAVEL (dari Meta)',
    });
  });
});
