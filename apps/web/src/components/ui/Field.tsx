import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { useId, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { describedBy } from '../../lib/form';
import styles from './Field.module.css';
import { Icon } from './Icon';

interface FieldFrameProps {
  label: string;
  /** Tampilkan penanda "opsional" di samping label. */
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  /** `lg`: 44px di semua ukuran layar (form utama seperti masuk dan setup). */
  size?: 'md' | 'lg';
  className?: string;
}

interface FieldIds {
  inputId: string;
  hintId: string | undefined;
  errorId: string | undefined;
}

/** Bingkai label + kontrol + petunjuk + pesan error; mengaitkan semuanya untuk pembaca layar. */
function FieldFrame({
  label,
  optional,
  hint,
  error,
  className,
  ids,
  children,
}: FieldFrameProps & { ids: FieldIds; children: ReactNode }) {
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={ids.inputId} className={styles.label}>
        {label}
        {optional ? <span className={styles.optional}>{t.form.optional}</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={ids.hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.errorId} className={styles.error}>
          <Icon icon={CircleAlert} size={16} className={styles.errorIcon} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

function useFieldIds(id: string | undefined, hint: ReactNode, error: string | null | undefined) {
  const generated = useId();
  const inputId = id ?? generated;
  return {
    inputId,
    hintId: hint && !error ? `${inputId}-petunjuk` : undefined,
    errorId: error ? `${inputId}-galat` : undefined,
  };
}

type InputProps = Omit<ComponentPropsWithRef<'input'>, 'size'>;

export interface TextFieldProps extends FieldFrameProps, InputProps {
  /** Elemen di ujung kanan kolom (mis. tombol tampilkan password). */
  trailing?: ReactNode;
  /** Teks tetap di kiri kolom (mis. `#`). */
  leading?: ReactNode;
  /** Kelas tambahan untuk elemen `<input>` (mis. huruf monospace untuk kode). */
  inputClassName?: string;
}

export function TextField({
  label,
  optional,
  hint,
  error,
  size = 'md',
  className,
  trailing,
  leading,
  inputClassName,
  id,
  'aria-describedby': extraDescribedBy,
  ...input
}: TextFieldProps) {
  const ids = useFieldIds(id, hint, error);
  return (
    <FieldFrame
      label={label}
      optional={optional}
      hint={hint}
      error={error}
      className={className}
      ids={ids}
    >
      <div
        className={cx(styles.control, size === 'lg' && styles.lg)}
        data-invalid={error ? '' : undefined}
      >
        {leading ? (
          <span className={styles.leading} aria-hidden="true">
            {leading}
          </span>
        ) : null}
        <input
          id={ids.inputId}
          className={cx(styles.input, inputClassName)}
          {...input}
          aria-invalid={error ? true : input['aria-invalid']}
          aria-describedby={describedBy(ids.errorId, ids.hintId, extraDescribedBy)}
        />
        {trailing}
      </div>
    </FieldFrame>
  );
}

export type PasswordFieldProps = Omit<TextFieldProps, 'type' | 'trailing'>;

/** Kolom password dengan tombol tampilkan/sembunyikan (bukan teks placeholder). */
export function PasswordField(props: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? t.form.hidePassword : t.form.showPassword;
  return (
    <TextField
      {...props}
      type={visible ? 'text' : 'password'}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      trailing={
        <button
          type="button"
          className={styles.reveal}
          aria-label={label}
          aria-pressed={visible}
          title={label}
          onClick={() => setVisible((value) => !value)}
          disabled={props.disabled}
        >
          <Icon icon={visible ? EyeOff : Eye} size={20} />
        </button>
      }
    />
  );
}

export interface TextAreaFieldProps
  extends FieldFrameProps, Omit<ComponentPropsWithRef<'textarea'>, 'size'> {}

/** Teks panjang berbaris (mis. deskripsi profil bisnis). Tinggi awal 4 baris, bisa diperbesar. */
export function TextAreaField({
  label,
  optional,
  hint,
  error,
  className,
  id,
  rows = 4,
  'aria-describedby': extraDescribedBy,
  ...textarea
}: TextAreaFieldProps) {
  const ids = useFieldIds(id, hint, error);
  return (
    <FieldFrame
      label={label}
      optional={optional}
      hint={hint}
      error={error}
      className={className}
      ids={ids}
    >
      <div
        className={cx(styles.control, styles.textareaControl)}
        data-invalid={error ? '' : undefined}
      >
        <textarea
          id={ids.inputId}
          rows={rows}
          className={cx(styles.input, styles.textarea)}
          {...textarea}
          aria-invalid={error ? true : textarea['aria-invalid']}
          aria-describedby={describedBy(ids.errorId, ids.hintId, extraDescribedBy)}
        />
      </div>
    </FieldFrame>
  );
}

export interface SelectFieldProps
  extends FieldFrameProps, Omit<ComponentPropsWithRef<'select'>, 'size'> {
  options: readonly { value: string; label: string }[];
}

/**
 * Pilihan berbentuk `<select>` bawaan browser: di HP membuka pemilih sistem, dan tidak
 * menyuntikkan `<style>` inline seperti Select Radix (CSP `style-src 'self'`).
 */
export function SelectField({
  label,
  optional,
  hint,
  error,
  size = 'md',
  className,
  options,
  id,
  ...select
}: SelectFieldProps) {
  const ids = useFieldIds(id, hint, error);
  return (
    <FieldFrame
      label={label}
      optional={optional}
      hint={hint}
      error={error}
      className={className}
      ids={ids}
    >
      <div
        className={cx(styles.control, styles.selectControl, size === 'lg' && styles.lg)}
        data-invalid={error ? '' : undefined}
      >
        <select
          id={ids.inputId}
          className={cx(styles.input, styles.select)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids.errorId, ids.hintId)}
          {...select}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </FieldFrame>
  );
}
