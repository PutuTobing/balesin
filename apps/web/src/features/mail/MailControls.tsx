import { MAIL_ACCOUNT_COLORS, type MailAccountColor, type MailTlsSecurity } from '@balesin/shared';
import { Check } from 'lucide-react';
import { useId } from 'react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import styles from './MailShared.module.css';

const m = t.mail;

/** Pilihan warna akun: enam token tag/status (tanpa warna baru), radio bawaan browser. */
export function ColorPicker({
  value,
  onChange,
  label,
  hint,
  disabled,
}: {
  value: MailAccountColor;
  onChange: (color: MailAccountColor) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const name = useId();
  const hintId = `${name}-petunjuk`;
  return (
    <fieldset
      className={styles.segmentField}
      disabled={disabled}
      aria-describedby={hint ? hintId : undefined}
    >
      <legend className={styles.segmentLabel}>{label}</legend>
      <div className={styles.swatches}>
        {MAIL_ACCOUNT_COLORS.map((color) => (
          <label key={color} className={styles.swatch} title={m.colors[color]}>
            <input
              type="radio"
              name={name}
              value={color}
              checked={value === color}
              onChange={() => onChange(color)}
              className={styles.swatchInput}
              aria-label={m.colors[color]}
            />
            <span className={styles.swatchFill} data-color={color}>
              <Icon icon={Check} size={16} className={styles.swatchTick} />
            </span>
          </label>
        ))}
      </div>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Keamanan sambungan: SSL/TLS atau STARTTLS (TLS wajib, kontrak §4.3). */
export function SecurityChoice({
  value,
  onChange,
  disabled,
  className,
}: {
  value: MailTlsSecurity;
  onChange: (security: MailTlsSecurity) => void;
  disabled?: boolean;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cx(styles.segmentField, className)} disabled={disabled}>
      <legend className={styles.segmentLabel}>{m.wizard.security}</legend>
      <div className={styles.segments}>
        {(['ssl', 'starttls'] as const).map((mode) => (
          <label key={mode} className={styles.segment}>
            <input
              type="radio"
              name={name}
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              className={styles.segmentInput}
            />
            {m.wizard.securityLabels[mode]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
