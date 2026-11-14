import { twoFactorReauthRequestSchema, type TwoFactorReauthRequest } from '@balesin/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { PasswordField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useLock } from '../../lib/use-lock';
import { CodeField } from '../two-factor/CodeField';
import styles from './Security.module.css';

const copy = t.security.reauth;

interface ReauthFormProps {
  title: string;
  body: string;
  submitLabel: string;
  pendingLabel: string;
  /** Kirim ke server; error API dilempar kembali ke form ini untuk ditampilkan. */
  onSubmit: (body: TwoFactorReauthRequest) => Promise<void>;
  onCancel: () => void;
}

/**
 * Konfirmasi ulang identitas sebelum tindakan sensitif 2FA (buat ulang kode cadangan,
 * nonaktifkan): password + kode dari aplikasi autentikator atau kode cadangan.
 *
 * Sengaja tanpa useMutation: respons "buat ulang" berisi kode cadangan baru yang tidak boleh
 * tertinggal di cache mutasi Query; pemanggil menyimpannya di state layarnya sendiri.
 */
export function ReauthForm({
  title,
  body,
  submitLabel,
  pendingLabel,
  onSubmit,
  onCancel,
}: ReauthFormProps) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useLock();
  const formRef = useRef<HTMLFormElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Naik setiap validasi gagal → fokus ke isian pertama yang salah (dan teksnya dipilih).
  const [invalidTick, setInvalidTick] = useState(0);

  // Dibuka atas permintaan pengguna: langsung siap diketik.
  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  useEffect(() => {
    if (invalidTick === 0) return;
    const field = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
    field?.focus();
    field?.select();
  }, [invalidTick]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || lock.locked) return;
    const parsed = twoFactorReauthRequestSchema.safeParse({ password, code });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setInvalidTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setError(null);
    setPending(true);
    try {
      await onSubmit(parsed.data);
    } catch (caught) {
      setPending(false);
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR' && caught.details.length > 0) {
        setErrors(apiFieldErrors(caught.details));
        setInvalidTick((tick) => tick + 1);
        return;
      }
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setError(caught);
      passwordRef.current?.focus();
    }
  };

  return (
    <form
      ref={formRef}
      className={styles.reauth}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className={styles.reauthHead}>
        <h3 className={styles.reauthTitle}>{title}</h3>
        <p className={styles.text}>{body}</p>
      </div>
      <div className={styles.reauthFields}>
        <PasswordField
          ref={passwordRef}
          size="lg"
          label={copy.password}
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.password}
          disabled={pending}
        />
        <CodeField
          kind="any"
          label={copy.code}
          hint={copy.codeHint}
          name="kode"
          value={code}
          onValueChange={setCode}
          error={errors.code}
          disabled={pending}
        />
      </div>
      <div className={styles.reauthActions}>
        <SubmitButton pending={pending} pendingLabel={pendingLabel} lock={lock}>
          {submitLabel}
        </SubmitButton>
        <Button size="lg" variant="ghost" onClick={onCancel} disabled={pending}>
          {copy.cancel}
        </Button>
      </div>
      {error ? (
        <Notice
          tone={lock.locked ? 'warning' : 'danger'}
          role="alert"
          title={lock.locked ? copy.lockedTitle : undefined}
        >
          {isApiError(error) ? error.message : t.api.network}
        </Notice>
      ) : null}
    </form>
  );
}
