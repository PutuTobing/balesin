import { Check } from 'lucide-react';
import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { describedBy } from '../../lib/form';
import styles from './Checkbox.module.css';
import { Icon } from './Icon';

interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'children'> {
  /** Teks di samping kotak; seluruh baris bisa diklik (target sentuh ≥ 44px). */
  children: ReactNode;
  /** Pesan error di bawah baris, dikaitkan lewat `aria-describedby`. */
  error?: string | null;
  className?: string;
}

/** Kotak centang ber-token: tepi `--ink-2`, tercentang `--primary` + centang `--on-primary`. */
export function Checkbox({ children, error, className, id, ...input }: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = error ? `${inputId}-galat` : undefined;
  return (
    <div className={styles.field}>
      <label
        htmlFor={inputId}
        className={cx(styles.row, className)}
        data-invalid={error ? '' : undefined}
      >
        <span className={styles.box}>
          <input
            {...input}
            id={inputId}
            type="checkbox"
            className={styles.input}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(errorId, input['aria-describedby'])}
          />
          <Icon icon={Check} size={16} className={styles.tick} />
        </span>
        <span>{children}</span>
      </label>
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
