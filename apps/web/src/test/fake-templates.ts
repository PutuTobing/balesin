import type { MessageTemplate, TemplatePreset } from '@balesin/shared';
import { FAKE_CHANNEL_ID } from './fake-inbox';

let seq = 0;
const uuid = (n: number) => `7e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Template Meta tiruan (bentuk = `messageTemplateSchema`). Bawaan: tagihan disetujui. */
export function fakeTemplate(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  seq += 1;
  const now = new Date().toISOString();
  return {
    id: uuid(seq),
    channelId: FAKE_CHANNEL_ID,
    wabaId: '100000000000999',
    metaTemplateId: `9${String(seq).padStart(14, '0')}`,
    name: `tagihan_bulanan_${String(seq)}`,
    language: 'id',
    category: 'UTILITY',
    status: 'APPROVED',
    rejectedReason: null,
    qualityScore: 'GREEN',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, tagihan bulan {{2}} sudah terbit. Terima kasih.',
        examples: { '1': 'Budi', '2': 'November' },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
    source: 'balesin',
    presetKey: null,
    localChanges: false,
    lastSyncedAt: null,
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function fakeOtpTemplate(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return fakeTemplate({
    name: 'kode_verifikasi',
    category: 'AUTHENTICATION',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: { text: '*{{1}}* adalah kode verifikasi Anda.', examples: {} },
      footer: null,
      buttons: [{ type: 'COPY_CODE', example: '123456' }],
      authentication: { addSecurityRecommendation: true, codeExpirationMinutes: 10 },
    },
    ...overrides,
  });
}

export function fakePreset(overrides: Partial<TemplatePreset> = {}): TemplatePreset {
  return {
    key: 'isp_gangguan_jaringan',
    industry: 'isp',
    title: 'Info gangguan jaringan',
    description: 'Dikirim saat ada gangguan di area pelanggan.',
    name: 'gangguan_jaringan',
    language: 'id',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, saat ini ada gangguan jaringan di area {{2}}. Tim kami sedang menanganinya.',
        examples: { '1': 'Budi', '2': 'Way Halim' },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
    ...overrides,
  };
}
