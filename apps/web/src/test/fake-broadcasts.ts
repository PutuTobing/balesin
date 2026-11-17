import type {
  BroadcastCampaign,
  BroadcastImportReport,
  BroadcastReport,
  BroadcastSettings,
} from '@balesin/shared';
import { DEFAULT_BROADCAST_SETTINGS } from '@balesin/shared';
import { FAKE_CHANNEL_ID } from './fake-inbox';

let seq = 0;
const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const RINA = { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' };
export const AGUS = { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0002', name: 'Agus Saputra' };

/** Kampanye tiruan (bentuk = `broadcastCampaignSchema`). Bawaan: draf dengan template, tanpa penerima. */
export function fakeBroadcast(overrides: Partial<BroadcastCampaign> = {}): BroadcastCampaign {
  seq += 1;
  const now = new Date().toISOString();
  return {
    id: uuid('b7000000', seq),
    name: `Pengingat tagihan ${String(seq)}`,
    status: 'draft',
    channel: { id: FAKE_CHANNEL_ID, name: 'CS Utama' },
    template: {
      id: '7e000000-0000-4000-8000-000000000901',
      name: 'tagihan_bulanan',
      language: 'id',
      category: 'UTILITY',
      status: 'APPROVED',
    },
    source: null,
    columns: [],
    phoneColumn: null,
    mapping: { body: {}, header: null, buttons: {} },
    scheduledAt: null,
    ratePerSecond: 5,
    dedupe: { hours: 24, scope: 'template' },
    autoTag: null,
    counts: {
      sourceRows: 0,
      rejectedRows: 0,
      recipients: 0,
      pending: 0,
      queued: 0,
      skipped: 0,
      cancelled: 0,
    },
    approval: {
      required: false,
      threshold: 50,
      requestedAt: null,
      decidedAt: null,
      decidedBy: null,
      rejectionReason: null,
    },
    estimate: null,
    pause: null,
    waiting: null,
    createdBy: RINA,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

export function withRecipients(
  campaign: BroadcastCampaign,
  recipients: number,
  columns = ['nomor', 'nama', 'bulan'],
): BroadcastCampaign {
  return {
    ...campaign,
    columns,
    phoneColumn: columns[0] ?? null,
    source: { kind: 'upload', label: 'pelanggan.csv', importedAt: new Date().toISOString() },
    counts: {
      ...campaign.counts,
      sourceRows: recipients + 1,
      rejectedRows: 1,
      recipients,
      pending: recipients,
    },
  };
}

export function fakeImportReport(
  overrides: Partial<BroadcastImportReport> = {},
): BroadcastImportReport {
  return {
    sourceRows: 4,
    recipients: 3,
    rejectedRows: 1,
    issues: [{ row: 4, issue: 'phone_invalid' }],
    issueCounts: {
      phone_missing: 0,
      phone_invalid: 1,
      phone_scientific: 0,
      duplicate: 0,
      value_too_long: 0,
    },
    columns: ['nomor', 'nama', 'bulan'],
    phoneColumn: 'nomor',
    ...overrides,
  };
}

export function fakeReport(overrides: Partial<BroadcastReport> = {}): BroadcastReport {
  return {
    broadcastId: uuid('b7000000', 1),
    status: 'running',
    recipients: 100,
    rejectedRows: 2,
    pending: 40,
    skipped: 3,
    skippedByReason: {
      recently_sent: 3,
      missing_variable: 0,
      invalid_variable: 0,
      contact_unavailable: 0,
    },
    cancelled: 0,
    sending: 2,
    sent: 10,
    delivered: 25,
    read: 15,
    failed: 5,
    failures: [
      {
        reason: 'delivery_failed',
        errorCode: 131026,
        message: 'Pesan tidak bisa diantar.',
        count: 5,
      },
    ],
    replied: 4,
    cost: { currency: 'IDR', billable: 40, total: 14_520 },
    estimate: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

export function fakeBroadcastSettings(
  overrides: Partial<BroadcastSettings> = {},
): BroadcastSettings {
  return { ...DEFAULT_BROADCAST_SETTINGS, updatedAt: null, updatedBy: null, ...overrides };
}
