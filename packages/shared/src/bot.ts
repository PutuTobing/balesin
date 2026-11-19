import { z } from 'zod';

import { CHANNEL_TYPES } from './channels';
import { isoDateTimeSchema } from './fields';

/**
 * Bot eksternal (Fase 3 — PRD §3.4 "Saklar bot per channel & per percakapan", "Jam kerja bot",
 * "Aturan handoff"; docs/KONTRAK-API-INBOX.md "Bot"). Bot = penerima webhook keluar (native atau
 * format MobiChat) yang membalas lewat API key.
 *
 * - Saklar per CHANNEL (`integrations.manage`) — SEMUA jenis channel (WhatsApp, Telegram, Email,
 *   Messenger, Instagram): percakapan BARU di channel itu masuk status `bot` bila bot aktif DAN
 *   sekarang dalam jam kerja bot DAN ada penerima bot aktif; selain itu `unserved` (antrian tim).
 * - Saklar per PERCAKAPAN (`inbox.reply` + cakupan): matikan = serahkan ke tim (`handoff`),
 *   nyalakan = kembalikan ke bot (`bot_resumed`).
 * - Batas waktu: pesan pelanggan tidak dibalas bot selama N menit → otomatis ke antrian (`handoff`
 *   oleh sistem). `null` = tanpa batas.
 */

/** Hari: 0 = Minggu … 6 = Sabtu (sama dengan `Date.getDay()`). */
export const BOT_DAY_LABELS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
export const BOT_TIMEOUT_MINUTES = { min: 1, max: 1440 } as const;
/**
 * Batas waktu bawaan saat bot dinyalakan tanpa nilai (review bot R1): bot aktif TIDAK PERNAH tanpa
 * batas waktu — pelanggan tidak boleh "terjebak" di bot yang mati.
 */
export const BOT_TIMEOUT_DEFAULT_MINUTES = 15;
export const BOT_HOURS_WINDOWS_MAX = 21;

const timeSchema = z
  .string({ error: 'Jam wajib diisi.' })
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Format jam HH:MM (00:00–24:00).');

const minutesOf = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

export const botHoursWindowSchema = z
  .object({
    day: z.number().int().min(0).max(6),
    start: timeSchema,
    end: timeSchema,
  })
  .refine((window) => minutesOf(window.start) < minutesOf(window.end), {
    error: 'Jam selesai harus setelah jam mulai (lewat tengah malam: pecah jadi dua hari).',
  });

/** `always` = bot 24 jam; `schedule` = hanya di jendela yang diisi (zona waktu organisasi). */
export const botHoursSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('always') }),
  z.object({
    mode: z.literal('schedule'),
    windows: z
      .array(botHoursWindowSchema)
      .min(1, 'Isi minimal satu jam kerja bot.')
      .max(BOT_HOURS_WINDOWS_MAX, `Maksimal ${String(BOT_HOURS_WINDOWS_MAX)} jam kerja.`),
  }),
]);
export type BotHours = z.infer<typeof botHoursSchema>;

export const channelBotSettingsSchema = z.object({
  enabled: z.boolean(),
  hours: botHoursSchema,
  /**
   * Menit tanpa balasan bot sebelum percakapan otomatis masuk antrian. Saat `enabled`, `null` diisi
   * server dengan `BOT_TIMEOUT_DEFAULT_MINUTES` (bot aktif selalu punya batas waktu).
   */
  timeoutMinutes: z
    .number()
    .int()
    .min(BOT_TIMEOUT_MINUTES.min, 'Batas waktu minimal 1 menit.')
    .max(BOT_TIMEOUT_MINUTES.max, 'Batas waktu maksimal 1.440 menit (24 jam).')
    .nullable(),
});
export type ChannelBotSettings = z.infer<typeof channelBotSettingsSchema>;

export const updateChannelBotSettingsRequestSchema = channelBotSettingsSchema;

export const channelBotSettingsResponseSchema = z.object({
  settings: channelBotSettingsSchema.extend({
    /**
     * Jenis channel (bot berlaku sama di SEMUA jenis — DECISIONS 2026-11-19). UI memakai
     * `channelHasCustomerWindow(channelType)` untuk keterangan jendela 24 jam (hanya channel Meta).
     * `channelType` & `receiverReady` SELALU dikirim server; opsional di skema hanya supaya klien &
     * data tiruan yang dibuat sebelum 2026-11-19 tetap lolos validasi (penambahan non-breaking).
     */
    channelType: z.enum(CHANNEL_TYPES).optional(),
    /** Zona waktu jam kerja bot (zona organisasi). */
    timezone: z.string(),
    /** Bot aktif + sekarang dalam jam kerja bot (belum memperhitungkan penerima). */
    activeNow: z.boolean(),
    /**
     * Ada penerima bot aktif untuk channel ini: endpoint webhook aktif yang melanggan
     * `message.received` — format native (semua channel) atau format MobiChat (WhatsApp saja, key
     * masih aktif). Percakapan baru masuk ke bot hanya bila `activeNow && receiverReady`.
     */
    receiverReady: z.boolean().optional(),
    updatedAt: isoDateTimeSchema.nullable(),
  }),
});

export const conversationBotRequestSchema = z.object({
  /** `false` = matikan bot / serahkan ke tim; `true` = kembalikan ke bot. */
  active: z.boolean({ error: 'Isi active: true atau false.' }),
});

/** Jam & hari lokal di zona `timeZone`. */
function localParts(date: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
  return { day, minutes: Number(value('hour')) * 60 + Number(value('minute')) };
}

/** `true` bila `date` berada di jam kerja bot (zona waktu organisasi). */
export function isWithinBotHours(hours: BotHours, timeZone: string, date: Date): boolean {
  if (hours.mode === 'always') return true;
  let local: { day: number; minutes: number };
  try {
    local = localParts(date, timeZone);
  } catch {
    local = localParts(date, 'Asia/Jakarta');
  }
  return hours.windows.some(
    (window) =>
      window.day === local.day &&
      local.minutes >= minutesOf(window.start) &&
      local.minutes < minutesOf(window.end),
  );
}
