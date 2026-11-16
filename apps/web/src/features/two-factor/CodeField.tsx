import type { TwoFactorMethod } from '@balesin/shared';
import { TextField, type TextFieldProps } from '../../components/ui/Field';
import { sanitizeTotpInput } from './code-input';
import styles from './TwoFactor.module.css';

type CodeFieldProps = Omit<
  TextFieldProps,
  'value' | 'onChange' | 'type' | 'inputMode' | 'autoComplete' | 'inputClassName'
> & {
  /**
   * `totp`: 6 digit dari aplikasi. `backup_code`: kode cadangan `xxxxx-xxxxx`. `any`: salah
   * satunya (konfirmasi ulang di Keamanan akun).
   */
  kind: TwoFactorMethod | 'any';
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * Satu isian untuk kode verifikasi (bukan enam kotak terpisah): kode yang ditempel utuh atau
 * diisi otomatis oleh pengelola password/keyboard HP (`autocomplete="one-time-code"`) langsung
 * masuk. Huruf monospace supaya angka mudah dicocokkan dengan aplikasi.
 */
export function CodeField({ kind, value, onValueChange, ...field }: CodeFieldProps) {
  const totp = kind === 'totp';
  return (
    <TextField
      size="lg"
      {...field}
      type="text"
      value={value}
      onChange={(event) =>
        onValueChange(totp ? sanitizeTotpInput(event.target.value) : event.target.value)
      }
      inputMode={totp ? 'numeric' : 'text'}
      pattern={totp ? '[0-9]*' : undefined}
      autoComplete={kind === 'backup_code' ? 'off' : 'one-time-code'}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      // Kode sekali pakai tetap rahasia selama dialog terbuka: tanpa atribut `value` di DOM.
      concealValue
      maxLength={totp ? undefined : 24}
      inputClassName={styles.codeInput}
    />
  );
}
