import { t } from '../../i18n/id';
import { estimatePasswordStrength } from '../../lib/password-strength';
import styles from './PasswordStrength.module.css';

/**
 * Hasil pemeriksaan password ke server untuk nilai `password` tertentu. Wizard setup memeriksa
 * sambil mengetik (`/setup/check-password`); undangan dan atur ulang password hanya tahu hasilnya
 * setelah dikirim (400 di isian password).
 */
export type ServerPasswordCheck =
  | { state: 'idle' }
  | { state: 'checking'; password: string }
  | { state: 'done'; password: string; acceptable: boolean; message: string | null };

const copy = t.password.strength;

/**
 * Meter kekuatan password di bawah isian password baru: tiga batang + teks yang diumumkan sopan.
 * Ditolak server = satu batang merah dengan alasannya (bukan tiga batang yang menyerupai "kuat").
 */
export function PasswordStrength({
  id,
  password,
  check,
}: {
  /** Dikaitkan ke isian password lewat `aria-describedby`. */
  id: string;
  password: string;
  check: ServerPasswordCheck;
}) {
  const strength = estimatePasswordStrength(password);
  const current = check.state !== 'idle' && check.password === password ? check : null;
  const rejected = current?.state === 'done' && !current.acceptable;
  const level = rejected ? 0 : strength.level;

  let text: string;
  if (password === '') text = copy.empty;
  else if (strength.missing > 0) text = copy.tooShort(strength.missing);
  else if (rejected) text = current.message ?? copy.weak;
  else if (current?.state === 'checking') text = copy.checking;
  else text = [copy.weak, copy.weak, copy.good, copy.strong][strength.level] ?? copy.good;

  const accepted = current?.state === 'done' && current.acceptable;
  const tone = rejected ? 'bad' : level >= 2 ? 'good' : level === 1 ? 'fair' : 'none';

  return (
    <div className={styles.strength} data-tone={tone}>
      <div className={styles.bars} aria-hidden="true">
        {[1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={styles.bar}
            data-on={(rejected ? bar === 1 : bar <= level) ? '' : undefined}
          />
        ))}
      </div>
      <p id={id} className={styles.text} aria-live="polite">
        <span className="sr-only">{copy.label}: </span>
        {text}
        {accepted ? <span className={styles.accepted}> {copy.accepted}</span> : null}
      </p>
    </div>
  );
}
