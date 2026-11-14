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
  /** `danger` untuk tindakan yang menurunkan keamanan akun (menonaktifkan 2FA). */
  submitVariant?: 'primary' | 'danger';
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
 *
 * Kontrol berukuran `md` (36 px di desktop, 44 px di HP/layar sentuh lewat CSS bawaan), sama
 * dengan tombol lain di halaman Pengaturan.
 */
export function ReauthForm({
  title,
  body,
  submitLabel,
  pendingLabel,
  submitVariant = 'primary',
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
  const codeRef = useRef<HTMLInputElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Naik setiap validasi gagal → fokus ke isian pertama yang salah (dan teksnya dipilih).
  const [invalidTick, setInvalidTick] = useState(0);
  // Naik setiap server menolak tanpa isian tertentu (429, 503, jaringan) → fokus ke isian kode,
  // SETELAH isian aktif lagi (selama memproses isian nonaktif, fokus akan gagal ke <body>).
  const [failedTick, setFailedTick] = useState(0);

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

  useEffect(() => {
    if (failedTick === 0) return;
    codeRef.current?.focus();
    codeRef.current?.select();
    // Di HP pesan bisa jatuh di bawah navigasi bawah: gulir sampai terlihat.
    noticeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [failedTick]);

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
      setFailedTick((tick) => tick + 1);
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
          label={copy.password}
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.password}
          disabled={pending}
        />
        <CodeField
          ref={codeRef}
          kind="any"
          size="md"
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
        <SubmitButton
          size="md"
          variant={submitVariant}
          pending={pending}
          pendingLabel={pendingLabel}
          lock={lock}
        >
          {submitLabel}
        </SubmitButton>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          {copy.cancel}
        </Button>
      </div>
      {error ? (
        <div ref={noticeRef} className={styles.reauthNotice}>
          <Notice
            tone={lock.locked ? 'warning' : 'danger'}
            role="alert"
            title={lock.locked ? copy.lockedTitle : undefined}
          >
            {isApiError(error) ? error.message : t.api.network}
          </Notice>
        </div>
      ) : null}
    </form>
  );
}
