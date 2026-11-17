import { z } from 'zod';

import { isoDateTimeSchema } from './fields';
import { tagRefSchema } from './tags';
import { TEMPLATE_CATEGORIES } from './templates';
import { userRoleSchema } from './roles';

/**
 * Laporan & CSAT (Fase 5, docs/KONTRAK-API-LAPORAN.md).
 *
 * Laporan kinerja (waktu respons pertama, tunggu, resolusi; per agen, per bot, per tag; tren harian &
 * per jam; bot vs manusia; CSAT) dan biaya pesan Meta per bulan. Izin `reports.view` (PRD §4): cakupan
 * `all` (Owner/Admin/Supervisor) = seluruh organisasi; `own` (CS/Teknisi) = kinerja DIRINYA saja (tanpa
 * ringkasan organisasi, bot, tag, tren, maupun biaya).
 */

export const REPORT_ROUTES = {
  /** GET `?from&to&channelId` — laporan kinerja. */
  performance: '/api/v1/reports/performance',
  /** GET `?month&channelId` — biaya pesan Meta (cakupan `all`). */
  costs: '/api/v1/reports/costs',
  /** GET (CSRF) `?kind&from&to|month` — ekspor CSV. */
  exportCsv: '/api/v1/reports/export',
  /** GET/PUT — pengaturan CSAT (`settings.workspace.manage`). */
  csatSettings: '/api/v1/settings/csat',
} as const;

/** Rentang laporan maksimal (hari). */
export const REPORT_MAX_DAYS = 92;
/** Kuota percakapan layanan gratis per nomor per bulan (konteks biaya Meta, perkiraan). */
export const META_FREE_SERVICE_CONVERSATIONS = 1_000;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal berformat YYYY-MM-DD.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Tanggal tidak valid.');

export const reportRangeQuerySchema = z
  .object({
    /** Tanggal awal (zona waktu organisasi), termasuk. */
    from: dateSchema,
    /** Tanggal akhir (zona waktu organisasi), termasuk. */
    to: dateSchema,
    channelId: z.uuid().optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: 'Tanggal awal harus sebelum tanggal akhir.',
    path: ['to'],
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <
      REPORT_MAX_DAYS,
    { message: `Rentang laporan maksimal ${String(REPORT_MAX_DAYS)} hari.`, path: ['to'] },
  );
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;

export const durationStatsSchema = z.object({
  count: z.number().int().nonnegative(),
  averageSeconds: z.number().nullable(),
  medianSeconds: z.number().nullable(),
  p90Seconds: z.number().nullable(),
});
export type DurationStats = z.infer<typeof durationStatsSchema>;

export const csatStatsSchema = z.object({
  /** Survei terkirim. */
  sent: z.number().int().nonnegative(),
  responses: z.number().int().nonnegative(),
  average: z.number().nullable(),
  /** Jumlah per skor 1–5. */
  distribution: z.record(z.enum(['1', '2', '3', '4', '5']), z.number().int().nonnegative()),
  /** Persen survei yang dijawab (0–100), `null` bila belum ada yang terkirim. */
  responseRate: z.number().nullable(),
});
export type CsatStats = z.infer<typeof csatStatsSchema>;

export const agentPerformanceSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), role: userRoleSchema }),
  /** Percakapan (dibuat dalam rentang) yang ia balas minimal sekali. */
  conversationsHandled: z.number().int().nonnegative(),
  /** Percakapan yang ia tandai selesai dalam rentang. */
  resolved: z.number().int().nonnegative(),
  messagesSent: z.number().int().nonnegative(),
  /** Waktu respons pertama untuk percakapan yang balasan agen pertamanya darinya. */
  firstResponse: durationStatsSchema,
  csat: csatStatsSchema,
});
export type AgentPerformance = z.infer<typeof agentPerformanceSchema>;

export const reportPerformanceSchema = z.object({
  range: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
  scope: z.enum(['all', 'own']),
  /** `null` untuk cakupan `own`. */
  summary: z
    .object({
      conversations: z.number().int().nonnegative(),
      /** Dibuka pesan pelanggan (bukan dimulai tim/broadcast). */
      customerInitiated: z.number().int().nonnegative(),
      resolved: z.number().int().nonnegative(),
      /** Selesai tanpa balasan agen, dengan balasan bot. */
      resolvedByBotOnly: z.number().int().nonnegative(),
      /** Dibalas agen manusia minimal sekali. */
      handledByHuman: z.number().int().nonnegative(),
      /** Diserahkan bot ke tim. */
      handoffs: z.number().int().nonnegative(),
      firstResponse: durationStatsSchema,
      wait: durationStatsSchema,
      resolution: durationStatsSchema,
    })
    .nullable(),
  trends: z
    .object({
      daily: z.array(
        z.object({
          date: z.string(),
          conversations: z.number().int().nonnegative(),
          resolved: z.number().int().nonnegative(),
          averageFirstResponseSeconds: z.number().nullable(),
        }),
      ),
      /** Percakapan baru per jam (0–23, zona organisasi) sepanjang rentang. */
      hourly: z.array(
        z.object({ hour: z.number().int(), conversations: z.number().int().nonnegative() }),
      ),
    })
    .nullable(),
  agents: z.array(agentPerformanceSchema),
  bots: z
    .array(
      z.object({
        apiKey: z.object({ id: z.uuid(), name: z.string() }),
        messagesSent: z.number().int().nonnegative(),
        conversations: z.number().int().nonnegative(),
        handoffs: z.number().int().nonnegative(),
      }),
    )
    .nullable(),
  tags: z
    .array(
      z.object({
        tag: tagRefSchema,
        conversations: z.number().int().nonnegative(),
        resolved: z.number().int().nonnegative(),
        resolution: durationStatsSchema,
      }),
    )
    .nullable(),
  /** Cakupan `own`: hanya survei percakapan miliknya. */
  csat: csatStatsSchema,
});
export type ReportPerformance = z.infer<typeof reportPerformanceSchema>;
export const reportPerformanceResponseSchema = z.object({ report: reportPerformanceSchema });

// ── Biaya pesan Meta ────────────────────────────────────────────────────────

export const reportCostsQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Bulan berformat YYYY-MM.'),
  channelId: z.uuid().optional(),
});

const categoryCostSchema = z.object({
  /** Pesan template terkirim (semua status selain gagal/tertunda). */
  sent: z.number().int().nonnegative(),
  /** Diterima pelanggan = ditagih Meta (delivered/read/played). */
  billable: z.number().int().nonnegative(),
  /** UTILITY dalam jendela layanan terbuka = gratis. */
  free: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});

export const channelCostSchema = z.object({
  channel: z.object({ id: z.uuid(), name: z.string() }),
  /** Percakapan layanan (balasan non-template; satu per kontak per 24 jam) dalam bulan itu. */
  serviceConversations: z.number().int().nonnegative(),
  freeQuota: z.number().int().nonnegative(),
  freeRemaining: z.number().int().nonnegative(),
  billableService: z.number().int().nonnegative(),
  serviceCost: z.number().nonnegative(),
  templates: z.record(z.enum(TEMPLATE_CATEGORIES), categoryCostSchema),
  total: z.number().nonnegative(),
});
export type ChannelCost = z.infer<typeof channelCostSchema>;

export const reportCostsSchema = z.object({
  month: z.string(),
  timezone: z.string(),
  currency: z.string(),
  /** Sumber tarif (Pengaturan → Batas kirim → Tarif) — selalu PERKIRAAN. */
  rateSource: z.string(),
  channels: z.array(channelCostSchema),
  total: z.number().nonnegative(),
  /** Pesan ditagih yang nomor negaranya belum punya tarif (biayanya tidak dihitung). */
  unknownRate: z.number().int().nonnegative(),
  computedAt: isoDateTimeSchema,
});
export type ReportCosts = z.infer<typeof reportCostsSchema>;
export const reportCostsResponseSchema = z.object({ costs: reportCostsSchema });

export const REPORT_EXPORT_KINDS = ['agents', 'daily', 'tags', 'bots', 'costs', 'csat'] as const;
export const reportExportQuerySchema = z.object({
  kind: z.enum(REPORT_EXPORT_KINDS),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  channelId: z.uuid().optional(),
});
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

// ── CSAT ────────────────────────────────────────────────────────────────────

const LINK = /(https?:\/\/|www\.)/i;
const csatText = (label: string, max: number) =>
  z
    .string({ error: `${label} wajib diisi.` })
    .trim()
    .min(1, `${label} wajib diisi.`)
    .max(max, `${label} maksimal ${String(max)} karakter.`)
    .refine((value) => !value.includes('\u0000'), `${label} memuat karakter yang tidak didukung.`)
    // Teks dikirim otomatis ke SEMUA pelanggan: tautan dilarang (cegah phishing lewat akun dibobol).
    .refine((value) => !LINK.test(value), `${label} tidak boleh memuat tautan.`);

export const CSAT_SCORE_LABELS: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  5: 'Sangat puas',
  4: 'Puas',
  3: 'Biasa saja',
  2: 'Kurang puas',
  1: 'Tidak puas',
};

export const csatSettingsValuesSchema = z.object({
  /** Bawaan MATI: survei otomatis dikirim ke pelanggan hanya setelah diaktifkan. */
  enabled: z.boolean(),
  /** Isi pesan survei (daftar pilihan 1–5). */
  question: csatText('Pertanyaan', 300),
  /** Pesan terima kasih setelah pelanggan menilai (mengundang saran sebagai komentar). */
  thanks: csatText('Ucapan terima kasih', 300),
  /** Kontak yang sudah disurvei dalam sekian jam terakhir tidak disurvei lagi. */
  minIntervalHours: z.number().int().min(1, 'Minimal 1 jam.').max(720, 'Maksimal 720 jam.'),
});
export type CsatSettingsValues = z.infer<typeof csatSettingsValuesSchema>;

export const DEFAULT_CSAT_SETTINGS: CsatSettingsValues = {
  enabled: false,
  question: 'Bagaimana pelayanan kami hari ini? Pilih nilai 1–5 ya.',
  thanks: 'Terima kasih atas penilaianmu! Bila ada saran, tulis saja di sini.',
  minIntervalHours: 24,
};

export const csatSettingsSchema = csatSettingsValuesSchema.extend({
  updatedAt: isoDateTimeSchema.nullable(),
});
export type CsatSettings = z.infer<typeof csatSettingsSchema>;
export const csatSettingsResponseSchema = z.object({ csat: csatSettingsSchema });
export const updateCsatSettingsRequestSchema = csatSettingsValuesSchema;

export const CSAT_SURVEY_STATUSES = [
  'pending',
  'sent',
  'answered',
  'expired',
  'failed',
  'skipped',
] as const;
export type CsatSurveyStatus = (typeof CSAT_SURVEY_STATUSES)[number];

/**
 * Survei tidak dikirim (dicatat `skip_reason`): jendela 24 jam sudah tutup (pesan daftar butuh
 * jendela), tidak ada pesan pelanggan / balasan agen manusia (bot, broadcast, API), kontak baru
 * disurvei, nomor/channel tidak bisa dipakai.
 */
export const CSAT_SKIP_REASONS = [
  'window_closed',
  'no_customer_message',
  'no_human_reply',
  'recently_surveyed',
  'channel_unavailable',
  'recipient_unavailable',
  'reopened',
  /** CSAT dimatikan setelah survei dibuat. */
  'disabled',
] as const;
export type CsatSkipReason = (typeof CSAT_SKIP_REASONS)[number];

/** ID baris pilihan survei: `csat:<surveyId>:<skor>` (dibalas pelanggan — input TIDAK tepercaya). */
export function csatRowId(surveyId: string, score: number): string {
  return `csat:${surveyId}:${String(score)}`;
}

const CSAT_ROW = /^csat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-5])$/;

/** Balasan pilihan survei → `{ surveyId, score }`, atau `null` bila bukan balasan CSAT yang sah. */
export function parseCsatReply(
  id: string | null | undefined,
): { surveyId: string; score: number } | null {
  if (typeof id !== 'string' || id.length > 64) return null;
  const match = CSAT_ROW.exec(id);
  return match?.[1] && match[2] ? { surveyId: match[1], score: Number(match[2]) } : null;
}
