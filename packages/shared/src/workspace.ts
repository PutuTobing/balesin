import { z } from 'zod';

import { botHoursSchema, isWithinBotHours, type BotHours } from './bot';
import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { QUICK_REPLY_VARIABLE_PATTERN } from './quick-replies';
import { identityConfirmationSchema } from './identity';
import { userRoleSchema } from './roles';

/**
 * Pengaturan kerja tim (Fase 5 butir terakhir, PRD §3.4/§3.8; docs/KONTRAK-API-INBOX.md "Jam kerja,
 * pesan otomatis, alokasi"): jam kerja TIM (terpisah dari jam kerja bot, format jadwal sama dengan
 * `BotHours`) + hari libur, pesan otomatis (sapaan / di luar jam kerja / saat di-assign), dan alokasi
 * percakapan (ambil sendiri / round-robin) dengan kapasitas per agen. Kelola =
 * `settings.workspace.manage`; ketersediaan diri sendiri = `inbox.reply`.
 */

// ── Jam kerja tim & hari libur ─────────────────────────────────────────────

/** Format jadwal sama dengan jam kerja bot (`always` / `schedule` per hari, zona organisasi). */
export const teamHoursSchema = botHoursSchema;
export type TeamHours = BotHours;

export const TEAM_HOLIDAYS_MAX = 60;

export const teamHolidaySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal libur format YYYY-MM-DD.')
    .refine(
      (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
      'Tanggal libur tidak valid.',
    ),
  name: z
    .string()
    .trim()
    .min(1, 'Nama hari libur wajib diisi.')
    .max(60, 'Nama hari libur maksimal 60 karakter.')
    .refine((value) => !hasControlCharacters(value), 'Nama hari libur memuat karakter khusus.'),
});
export type TeamHoliday = z.infer<typeof teamHolidaySchema>;

const holidaysSchema = z
  .array(teamHolidaySchema)
  .max(TEAM_HOLIDAYS_MAX, `Maksimal ${String(TEAM_HOLIDAYS_MAX)} hari libur.`)
  .refine(
    (items) => new Set(items.map((item) => item.date)).size === items.length,
    'Tanggal libur tidak boleh kembar.',
  );

/** Tanggal lokal `YYYY-MM-DD` di zona waktu organisasi. */
function localDate(date: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format('Asia/Jakarta');
  }
}

/** `true` bila `date` berada di jam kerja tim (bukan hari libur), zona waktu organisasi. */
export function isWithinTeamHours(
  hours: TeamHours,
  holidays: readonly TeamHoliday[],
  timeZone: string,
  date: Date,
): boolean {
  const today = localDate(date, timeZone);
  if (holidays.some((holiday) => holiday.date === today)) return false;
  return isWithinBotHours(hours, timeZone, date);
}

// ── Pesan otomatis ─────────────────────────────────────────────────────────

/**
 * - `greeting` — percakapan baru dari pelanggan DI DALAM jam kerja tim;
 * - `away` — percakapan baru dari pelanggan DI LUAR jam kerja tim / hari libur;
 * - `assigned` — percakapan diambil/ditugaskan ke agen ("{agen} akan membantumu").
 * Sekali per sesi (percakapan), hanya di jendela 24 jam, tidak untuk percakapan yang ditangani bot
 * (sapaan/di luar jam kerja) atau yang dibuat broadcast/API/agen (pesan pertamanya bukan dari
 * pelanggan). Rem darurat berlaku.
 */
export const AUTO_MESSAGE_KINDS = ['greeting', 'away', 'assigned'] as const;
export const autoMessageKindSchema = z.enum(AUTO_MESSAGE_KINDS);
export type AutoMessageKind = z.infer<typeof autoMessageKindSchema>;

export const AUTO_MESSAGE_LABELS: Readonly<Record<AutoMessageKind, string>> = {
  greeting: 'Sapaan percakapan baru (jam kerja)',
  away: 'Pesan di luar jam kerja',
  assigned: 'Pesan saat ditangani agen',
};

/** Variabel yang boleh dipakai per jenis (`{agen}` hanya saat di-assign). */
export const AUTO_MESSAGE_VARIABLES: Readonly<Record<AutoMessageKind, readonly string[]>> = {
  greeting: ['nama'],
  away: ['nama'],
  assigned: ['nama', 'agen'],
};

export const AUTO_MESSAGE_TEXT_MAX = 1_000;

export const AUTO_MESSAGE_DEFAULT_TEXTS: Readonly<Record<AutoMessageKind, string>> = {
  greeting: 'Halo {nama}, terima kasih sudah menghubungi kami. Tim kami akan segera membalas ya.',
  away: 'Halo {nama}, terima kasih sudah menghubungi kami. Saat ini di luar jam kerja — pesanmu akan kami balas di jam kerja berikutnya ya.',
  assigned: 'Halo {nama}, {agen} akan membantumu ya.',
};

const autoMessageTextSchema = z
  .string({ error: 'Isi pesan wajib diisi.' })
  .trim()
  .min(1, 'Isi pesan wajib diisi.')
  .max(
    AUTO_MESSAGE_TEXT_MAX,
    `Isi pesan maksimal ${AUTO_MESSAGE_TEXT_MAX.toLocaleString('id-ID')} karakter.`,
  )
  .refine(
    (value) => !hasControlCharacters(value.replace(/\r?\n|\t/g, ' ')),
    'Isi pesan memuat karakter khusus tak terlihat.',
  );

/** Variabel di teks yang tidak boleh dipakai jenis ini. */
export function invalidAutoMessageVariables(kind: AutoMessageKind, text: string): string[] {
  const allowed = AUTO_MESSAGE_VARIABLES[kind];
  const invalid = new Set<string>();
  for (const match of text.matchAll(QUICK_REPLY_VARIABLE_PATTERN)) {
    const name = match[1] ?? '';
    if (!allowed.includes(name)) invalid.add(name);
  }
  return [...invalid];
}

const NAME_LINK_PATTERN =
  /(?:https?:\/\/|www\.)\S+|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|id|co|io|me|ly|info|biz|site|online|app|xyz|link|click|shop|store|top|vip|ru|cn|in|us|uk|sg|my|ai|dev|to)(?![\p{L}\p{N}])\S*/giu;

/**
 * Nilai `{nama}` untuk pesan otomatis: tautan dibuang dari nama (nama profil WhatsApp = teks bebas
 * pelanggan; review jam kerja Info 3), spasi dirapikan, maks. 60 karakter; kosong → `fallback`.
 */
export function autoMessageName(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '').replace(NAME_LINK_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return fallback;
  return Array.from(cleaned).slice(0, 60).join('');
}

/** Isi variabel; nilai pengganti TIDAK diproses ulang. */
export function renderAutoMessage(text: string, values: { nama: string; agen?: string }): string {
  return text.replace(QUICK_REPLY_VARIABLE_PATTERN, (whole, name: string) =>
    name === 'nama'
      ? values.nama
      : name === 'agen' && values.agen !== undefined
        ? values.agen
        : whole,
  );
}

const autoMessageSchema = z.object({ enabled: z.boolean(), text: autoMessageTextSchema });

// ── Alokasi ────────────────────────────────────────────────────────────────

/**
 * - `manual` — agen mengambil sendiri dari antrian (perilaku bawaan);
 * - `round_robin` — percakapan `unserved` otomatis ditugaskan bergiliran (paling lama tidak mendapat
 *   tugas lebih dulu) ke agen yang tersedia, tidak dikecualikan, belum penuh kapasitas, dalam jam
 *   kerja tim (per departemen bila percakapan punya departemen).
 */
export const ALLOCATION_MODES = ['manual', 'round_robin'] as const;
export const allocationModeSchema = z.enum(ALLOCATION_MODES, {
  error: 'Mode alokasi tidak dikenal.',
});
export type AllocationMode = z.infer<typeof allocationModeSchema>;
export const ALLOCATION_MODE_LABELS: Readonly<Record<AllocationMode, string>> = {
  manual: 'Ambil sendiri dari antrian',
  round_robin: 'Bagi otomatis bergiliran (round-robin)',
};
export const AGENT_CAPACITY = { min: 1, max: 200 } as const;

const capacitySchema = z
  .number()
  .int()
  .min(AGENT_CAPACITY.min, 'Kapasitas minimal 1 percakapan.')
  .max(AGENT_CAPACITY.max, 'Kapasitas maksimal 200 percakapan.')
  .nullable();

// ── Respons & permintaan ────────────────────────────────────────────────────

export const workspaceSettingsSchema = z.object({
  /** Zona waktu jam kerja (zona organisasi). */
  timezone: z.string(),
  teamHours: teamHoursSchema,
  holidays: z.array(teamHolidaySchema),
  /** Sekarang dalam jam kerja tim (tingkat organisasi). */
  withinTeamHoursNow: z.boolean(),
  allocation: z.object({
    mode: allocationModeSchema,
    /** Maks. percakapan `served` terbuka per agen untuk penugasan OTOMATIS; `null` = tanpa batas. */
    maxOpenPerAgent: z.number().int().nullable(),
  }),
  autoMessages: z.object({
    greeting: autoMessageSchema,
    away: autoMessageSchema,
    assigned: autoMessageSchema,
  }),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export const workspaceSettingsResponseSchema = z.object({ settings: workspaceSettingsSchema });
export type WorkspaceSettingsResponse = z.infer<typeof workspaceSettingsResponseSchema>;

/** `PUT /settings/workspace` — hanya bagian yang dikirim yang diubah. */
export const updateWorkspaceSettingsRequestSchema = z
  .object({
    teamHours: teamHoursSchema.optional(),
    holidays: holidaysSchema.optional(),
    allocation: z
      .object({ mode: allocationModeSchema, maxOpenPerAgent: capacitySchema })
      .optional(),
    autoMessages: z
      .object({
        greeting: autoMessageSchema.optional(),
        away: autoMessageSchema.optional(),
        assigned: autoMessageSchema.optional(),
      })
      .optional(),
    /**
     * WAJIB saat MENGAKTIFKAN pesan otomatis atau MENGUBAH teksnya (dikirim otomatis ke semua
     * pelanggan baru dari nomor resmi; review jam kerja S1). Mematikan tidak perlu.
     */
    confirmation: identityConfirmationSchema.optional(),
  })
  .superRefine((value, ctx) => {
    for (const kind of AUTO_MESSAGE_KINDS) {
      const message = value.autoMessages?.[kind];
      if (!message) continue;
      const invalid = invalidAutoMessageVariables(kind, message.text);
      if (invalid.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['autoMessages', kind, 'text'],
          message: `Variabel ${invalid.map((name) => `{${name}}`).join(', ')} tidak bisa dipakai di sini. Yang tersedia: ${AUTO_MESSAGE_VARIABLES[kind].map((name) => `{${name}}`).join(', ')}.`,
        });
      }
    }
  })
  .refine(
    ({ confirmation: _confirmation, ...value }) =>
      Object.values(value).some((item) => item !== undefined),
    { error: 'Tidak ada yang diubah.' },
  );
export type UpdateWorkspaceSettingsRequest = z.infer<typeof updateWorkspaceSettingsRequestSchema>;

/** Agen untuk alokasi otomatis (Pengaturan → Alokasi agen). */
export const allocationAgentSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: userRoleSchema,
  /** Agen sedang tersedia (saklar milik agen sendiri; bisa juga diatur Owner/Admin). */
  available: z.boolean(),
  /** Dikecualikan dari penugasan otomatis (bawaan: Owner/Admin dikecualikan). */
  excluded: z.boolean(),
  /** Percakapan `served` terbuka yang ia pegang sekarang. */
  openConversations: z.number().int().nonnegative(),
  lastAssignedAt: isoDateTimeSchema.nullable(),
});
export type AllocationAgent = z.infer<typeof allocationAgentSchema>;
export const allocationAgentListResponseSchema = z.object({
  agents: z.array(allocationAgentSchema),
});
export const allocationAgentResponseSchema = z.object({ agent: allocationAgentSchema });
export const allocationAgentParamsSchema = z.object({ userId: z.string() });
export const updateAllocationAgentRequestSchema = z
  .object({ available: z.boolean().optional(), excluded: z.boolean().optional() })
  .refine((value) => value.available !== undefined || value.excluded !== undefined, {
    error: 'Tidak ada yang diubah.',
  });
export type UpdateAllocationAgentRequest = z.infer<typeof updateAllocationAgentRequestSchema>;

/** `GET`/`PUT /inbox/availability` — saklar ketersediaan milik agen sendiri. */
export const availabilitySchema = z.object({ available: z.boolean() });
export const availabilityResponseSchema = z.object({
  availability: availabilitySchema.extend({
    excluded: z.boolean(),
    mode: allocationModeSchema,
  }),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
