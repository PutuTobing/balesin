import { BOT_DAY_LABELS } from '@balesin/shared';
import { Checkbox } from '../../components/ui/Checkbox';
import { t } from '../../i18n/id';
import type { HoursDay } from './team-hours';
import styles from './Departments.module.css';

const d = t.departments;

/** Jadwal mingguan: buka/tutup per hari + jam mulai–selesai (Senin dulu). */
export function HoursDays({
  days,
  onChange,
  disabled,
}: {
  days: readonly HoursDay[];
  onChange: (days: HoursDay[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.days}>
      {days.map((item, index) => {
        const label = BOT_DAY_LABELS[item.day] ?? '';
        const patch = (next: Partial<HoursDay>) =>
          onChange(days.map((day, position) => (position === index ? { ...day, ...next } : day)));
        return (
          <div key={item.day} className={styles.day}>
            <Checkbox
              checked={item.on}
              onChange={(event) => patch({ on: event.target.checked })}
              className={styles.dayToggle}
              disabled={disabled}
            >
              {label}
            </Checkbox>
            <input
              type="time"
              className={styles.time}
              value={item.start}
              onChange={(event) => patch({ start: event.target.value })}
              disabled={disabled || !item.on}
              aria-label={d.start(label)}
            />
            <span aria-hidden="true" className={styles.muted}>
              –
            </span>
            <input
              type="time"
              className={styles.time}
              value={item.end}
              onChange={(event) => patch({ end: event.target.value })}
              disabled={disabled || !item.on}
              aria-label={d.end(label)}
            />
          </div>
        );
      })}
    </div>
  );
}
