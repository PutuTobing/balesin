import { BOT_DAY_LABELS, type BotHours } from '@balesin/shared';
import { t } from '../../i18n/id';

/** Urutan tampil hari (Senin dulu); nilai `day` tetap 0 = Minggu … 6 = Sabtu. */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export interface HoursDay {
  day: number;
  on: boolean;
  start: string;
  end: string;
}

export interface HoursForm {
  /** `false` = ikut jam kerja organisasi (`teamHours: null`). */
  custom: boolean;
  days: HoursDay[];
}

/** `<input type="time">` tidak bisa 24:00: tengah malam ditampilkan 23:59. */
const toInput = (value: string) => (value === '24:00' ? '23:59' : value);
const fromInput = (value: string) => (value === '23:59' ? '24:00' : value);
const WORKDAYS = new Set([1, 2, 3, 4, 5]);

export function hoursFormFrom(hours: BotHours | null): HoursForm {
  const windows = hours?.mode === 'schedule' ? hours.windows : [];
  return {
    custom: hours !== null,
    days: DAY_ORDER.map((day) => {
      const window = windows.find((item) => item.day === day);
      return window
        ? { day, on: true, start: toInput(window.start), end: toInput(window.end) }
        : { day, on: windows.length === 0 && WORKDAYS.has(day), start: '08:00', end: '17:00' };
    }),
  };
}

/** Isian → `teamHours`; galat bila tidak ada hari atau jam selesai ≤ mulai. */
export function teamHoursFrom(
  form: HoursForm,
): { ok: true; hours: BotHours | null } | { ok: false; error: string } {
  if (!form.custom) return { ok: true, hours: null };
  const on = form.days.filter((item) => item.on);
  if (on.length === 0) return { ok: false, error: t.departments.noDay };
  for (const item of on) {
    if (fromInput(item.end) <= item.start) {
      return { ok: false, error: t.departments.endBeforeStart(BOT_DAY_LABELS[item.day] ?? '') };
    }
  }
  return {
    ok: true,
    hours: {
      mode: 'schedule',
      windows: on.map((item) => ({ day: item.day, start: item.start, end: fromInput(item.end) })),
    },
  };
}

/** Ringkasan "Sen–Jum 08.00–20.00, Sab 08.00–14.00" (hari berurutan berjam sama digabung). */
export function hoursSummary(hours: BotHours | null): string {
  if (!hours) return t.departments.hoursOrganization;
  if (hours.mode === 'always') return t.departments.hoursCustom;
  const short = (day: number) => (BOT_DAY_LABELS[day] ?? '').slice(0, 3);
  const time = (value: string) => value.replace(':', '.');
  const slots = DAY_ORDER.flatMap((day) =>
    hours.windows
      .filter((item) => item.day === day)
      .map((item) => ({ day, range: `${time(item.start)}–${time(item.end)}` })),
  );
  const groups: { first: number; last: number; range: string; index: number }[] = [];
  for (const slot of slots) {
    const index = DAY_ORDER.indexOf(slot.day);
    const previous = groups.at(-1);
    if (previous && previous.range === slot.range && previous.index === index - 1) {
      previous.last = slot.day;
      previous.index = index;
    } else {
      groups.push({ first: slot.day, last: slot.day, range: slot.range, index });
    }
  }
  return t.departments.hoursSummary(
    groups
      .map((group) =>
        group.first === group.last
          ? `${short(group.first)} ${group.range}`
          : `${short(group.first)}–${short(group.last)} ${group.range}`,
      )
      .join(', '),
  );
}
