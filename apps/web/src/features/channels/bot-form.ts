import {
  BOT_TIMEOUT_DEFAULT_MINUTES,
  BOT_TIMEOUT_MINUTES,
  type ChannelBotSettings,
} from '@balesin/shared';

export const channelBotKey = (channelId: string) =>
  ['settings', 'channels', channelId, 'bot'] as const;

export interface BotDay {
  day: number;
  on: boolean;
  start: string;
  end: string;
}

export interface BotForm {
  enabled: boolean;
  mode: 'always' | 'schedule';
  /** Satu jendela per hari (0 = Minggu … 6 = Sabtu). */
  days: BotDay[];
  timeout: string;
}

/** `<input type="time">` tidak bisa 24:00: tengah malam ditampilkan 23:59. */
const toInput = (value: string) => (value === '24:00' ? '23:59' : value);
const fromInput = (value: string) => (value === '23:59' ? '24:00' : value);

const WORKDAYS = new Set([1, 2, 3, 4, 5]);

export function botFormFrom(settings: ChannelBotSettings): BotForm {
  const windows = settings.hours.mode === 'schedule' ? settings.hours.windows : [];
  return {
    enabled: settings.enabled,
    mode: settings.hours.mode,
    days: [0, 1, 2, 3, 4, 5, 6].map((day) => {
      const window = windows.find((item) => item.day === day);
      return window
        ? { day, on: true, start: toInput(window.start), end: toInput(window.end) }
        : // Bawaan saat beralih ke jadwal: hari kerja 08.00–17.00.
          { day, on: windows.length === 0 && WORKDAYS.has(day), start: '08:00', end: '17:00' };
    }),
    timeout: String(settings.timeoutMinutes ?? BOT_TIMEOUT_DEFAULT_MINUTES),
  };
}

/**
 * Isian → body PUT. Bot aktif selalu dengan batas waktu (1–1.440); mati = batas waktu tetap dikirim
 * (nilai terakhir) supaya menyalakan lagi tidak kehilangan pengaturan.
 */
export function botSettingsFrom(form: BotForm): {
  settings: ChannelBotSettings;
  timeoutInvalid: boolean;
  noDay: boolean;
} {
  const raw = form.timeout.trim();
  const minutes = /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  const timeoutInvalid =
    form.enabled && !(minutes >= BOT_TIMEOUT_MINUTES.min && minutes <= BOT_TIMEOUT_MINUTES.max);
  const windows = form.days
    .filter((item) => item.on)
    .map((item) => ({ day: item.day, start: fromInput(item.start), end: fromInput(item.end) }));
  const noDay = form.enabled && form.mode === 'schedule' && windows.length === 0;
  return {
    settings: {
      enabled: form.enabled,
      hours: form.mode === 'always' ? { mode: 'always' } : { mode: 'schedule', windows },
      timeoutMinutes:
        Number.isFinite(minutes) && minutes >= 1 ? minutes : BOT_TIMEOUT_DEFAULT_MINUTES,
    },
    timeoutInvalid,
    noDay,
  };
}
