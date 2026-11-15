import {
  identityConfirmationSchema,
  twoFactorReauthRequestSchema,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { PasswordField } from '../../components/ui/Field';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useLock } from '../../lib/use-lock';
import { CodeField } from '../two-factor/CodeField';
import styles from './IdentityDialog.module.css';

const copy = t.identity;

export interface IdentityDialogProps {
  open: boolean;
  title: string;
  /** Akibat aksinya, satu-dua kalimat (dikaitkan ke dialog lewat `aria-describedby`). */
  body: string;
  confirmLabel: string;
  pendingLabel: string;
  /** `danger` untuk aksi yang mencabut akses atau menurunkan keamanan. */
  variant?: 'primary' | 'danger';
  /**
   * Isian kode tampil dan wajib (2FA pelaku aktif — selalu untuk Owner/Admin). `false`: cukup
   * password (pengguna tanpa 2FA mengeluarkan sesinya sendiri).
   */
  requireCode: boolean;
  /**
   * Kirim ke server. Error API dilempar kembali ke dialog untuk ditampilkan; berhasil = pemanggil
   * menutup dialog (`open: false`).
   */
  onConfirm: (identity: IdentityConfirmation) => Promise<void>;
  /** Batal / Escape. Fokus dikembalikan ke `returnFocusRef` (tombol pembuka). */
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Konfirmasi ulang identitas pelaku sebelum aksi sensitif (docs/KONTRAK-API-AUTH.md,
 * "Konfirmasi ulang identitas pelaku"): password + kode autentikator / kode cadangan.
 *
 * Isian hanya di state komponen di dalam dialog: tidak lewat `useMutation`, tidak di cache Query
 * atau storage, dan hilang begitu dialog ditutup (komponen isi dilepas). Pola error sama dengan
 * Keamanan akun: 400 → pesan di isiannya + fokus ke sana; 429 → tombol terkunci dengan hitung
 * mundur; selain itu kotak pesan di bawah tombol dan fokus ke isian kode.
 */
export function IdentityDialog({
  open,
  title,
  body,
  onCancel,
  returnFocusRef,
  ...form
}: IdentityDialogProps) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const cancel = () => {
    onCancel();
    const target = returnFocusRef?.current;
    if (target) requestAnimationFrame(() => target.focus());
  };
  return (
    <Dialog
      open={open}
      title={title}
      description={body}
      onRequestClose={cancel}
      initialFocusRef={passwordRef}
    >
      {open ? <IdentityForm {...form} passwordRef={passwordRef} onCancel={cancel} /> : null}
    </Dialog>
  );
}

function IdentityForm({
  confirmLabel,
  pendingLabel,
  variant = 'primary',
  requireCode,
  onConfirm,
  onCancel,
  passwordRef,
}: Omit<IdentityDialogProps, 'open' | 'title' | 'body' | 'onCancel' | 'returnFocusRef'> & {
  onCancel: () => void;
  passwordRef: RefObject<HTMLInputElement | null>;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useLock();
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Naik setiap isian ditolak → fokus ke isian pertama yang salah, SETELAH isian aktif lagi.
  const [invalidTick, setInvalidTick] = useState(0);
  // Naik setiap server menolak tanpa isian tertentu (429, 409, jaringan).
  const [failedTick, setFailedTick] = useState(0);

  useEffect(() => {
    if (invalidTick === 0) return;
    const field = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
    field?.focus();
    field?.select();
  }, [invalidTick]);

  useEffect(() => {
    if (failedTick === 0) return;
    const field = codeRef.current ?? passwordRef.current;
    field?.focus();
    field?.select();
    noticeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [failedTick, passwordRef]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || lock.locked) return;
    const parsed = requireCode
      ? twoFactorReauthRequestSchema.safeParse({ password, code })
      : identityConfirmationSchema.safeParse({ password });
    if (!parsed.success) {
      const fieldErrors = zodFieldErrors(parsed.error);
      if (fieldErrors.code && code.trim() === '') fieldErrors.code = copy.codeRequired;
      setErrors(fieldErrors);
      setInvalidTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setError(null);
    setPending(true);
    try {
      await onConfirm(parsed.data);
    } catch (caught) {
      setPending(false);
      // Isian dialog: `password`/`code` (aksi kelola), atau `confirmation.password`/`.code`
      // (konfirmasi yang menempel di permintaan lain: undangan, email pengirim).
      const identityErrors = isApiError(caught)
        ? caught.details
            .map((detail) => ({ ...detail, field: detail.field.replace(/^confirmation\./, '') }))
            .filter((detail) => detail.field === 'password' || detail.field === 'code')
        : [];
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR' && identityErrors.length > 0) {
        setErrors(apiFieldErrors(identityErrors));
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
    <form ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <p className={styles.why}>{copy.why}</p>
      <div className={styles.fields}>
        <PasswordField
          ref={passwordRef}
          label={copy.password}
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (errors.password) setErrors(({ password: _password, ...rest }) => rest);
          }}
          error={errors.password}
          disabled={pending}
        />
        {requireCode ? (
          <CodeField
            ref={codeRef}
            kind="any"
            size="md"
            label={copy.code}
            hint={copy.codeHint}
            name="kode"
            value={code}
            onValueChange={(value) => {
              setCode(value);
              if (errors.code) setErrors(({ code: _code, ...rest }) => rest);
            }}
            error={errors.code}
            disabled={pending}
          />
        ) : null}
      </div>
      <div className={styles.actions}>
        {/* Dialog: batal berbingkai, tombol berwarna terakhir (pola semua dialog). */}
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          {copy.cancel}
        </Button>
        <SubmitButton
          size="md"
          variant={variant}
          pending={pending}
          pendingLabel={pendingLabel}
          lock={lock}
        >
          {confirmLabel}
        </SubmitButton>
      </div>
      {error ? (
        <div ref={noticeRef} className={styles.notice}>
          <FormErrorNotice error={error} lock={lock} lockedTitle={copy.lockedTitle} />
        </div>
      ) : null}
    </form>
  );
}
