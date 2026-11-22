import {
  MAIL_PORT_NOT_ALLOWED_MESSAGE,
  mailPortAllowed,
  updateMailAccountRequestSchema,
  type IdentityConfirmation,
  type MailAccount,
  type TestMailAccountResponse,
} from '@balesin/shared';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { CredentialFields, ServerCards } from './ServerFields';
import { TestResults } from './TestResults';
import { useRequireCode } from './mail-queries';
import { resultFromSaveFailure, serverBody, type ServerValues } from './wizard-state';
import styles from './Wizard.module.css';

const w = t.mail.wizard;
const d = t.mail.detail;

function valuesOf(account: MailAccount): ServerValues | null {
  if (!account.imap || !account.smtp) return null;
  return {
    displayName: account.displayName,
    fromName: account.fromName,
    username: account.imap.username ?? '',
    imapHost: account.imap.host,
    imapPort: String(account.imap.port),
    imapSecurity: account.imap.security,
    smtpHost: account.smtp.host,
    smtpPort: String(account.smtp.port),
    smtpSecurity: account.smtp.security,
    sameCredentials: account.smtp.sameCredentials,
    smtpUsername: account.smtp.username ?? '',
  };
}

/**
 * Ubah server/kredensial akun tersimpan (kontrak §4 PATCH): wajib konfirmasi identitas dan tes
 * Masuk & Keluar di server (502 bila gagal; pengaturan lama tetap dipakai). Ganti host/port/
 * keamanan/username wajib mengisi ulang password. Password hanya di isian tak terkendali.
 */
export function EditServerDialog({
  account,
  onClose,
  onSaved,
}: {
  account: MailAccount;
  onClose: () => void;
  onSaved: (account: MailAccount) => void;
}) {
  const initial = valuesOf(account);
  const requireCode = useRequireCode();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const imapPasswordRef = useRef<HTMLInputElement>(null);
  const smtpPasswordRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [values, setValues] = useState<ServerValues | null>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<TestMailAccountResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLElement>('input')?.focus();
    return () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  }, []);

  if (!values || !initial) return null;

  const set = <K extends keyof ServerValues>(key: K, value: ServerValues[K]) => {
    setValues((current) => (current ? { ...current, [key]: value } : current));
    setErrors({});
    setNotice(null);
  };

  const secret = (ref: { current: HTMLInputElement | null }) => {
    const value = ref.current?.value ?? '';
    return value.length > 0 ? value : undefined;
  };

  /** Isian server berubah (selain password) → password wajib diisi ulang (kontrak §4). */
  const identityChanged = (kind: 'imap' | 'smtp') =>
    kind === 'imap'
      ? values.imapHost !== initial.imapHost ||
        values.imapPort !== initial.imapPort ||
        values.imapSecurity !== initial.imapSecurity ||
        values.username !== initial.username
      : values.smtpHost !== initial.smtpHost ||
        values.smtpPort !== initial.smtpPort ||
        values.smtpSecurity !== initial.smtpSecurity ||
        values.sameCredentials !== initial.sameCredentials ||
        values.smtpUsername !== initial.smtpUsername;

  const build = () => {
    const passwords = { imap: secret(imapPasswordRef), smtp: secret(smtpPasswordRef) };
    const imapChanged = identityChanged('imap') || passwords.imap !== undefined;
    const smtpChanged =
      identityChanged('smtp') || (!values.sameCredentials && passwords.smtp !== undefined);
    const body = serverBody(values, passwords);
    const fieldErrors: FieldErrors = {};
    if (identityChanged('imap') && !passwords.imap) fieldErrors['imap.password'] = w.passwordRefill;
    if (
      !values.sameCredentials &&
      (identityChanged('smtp') || initial.sameCredentials) &&
      !passwords.smtp
    ) {
      fieldErrors['smtp.password'] = w.passwordRefill;
    }
    // SMTP memakai login IMAP: password IMAP baru ikut dipakai SMTP, jadi SMTP ikut dikirim.
    const sendSmtp = smtpChanged || (imapChanged && values.sameCredentials);
    const request = {
      ...(imapChanged || sendSmtp ? { imap: body.imap } : {}),
      ...(sendSmtp ? { smtp: body.smtp } : {}),
    };
    const parsed = updateMailAccountRequestSchema.safeParse(request);
    if (!parsed.success) Object.assign(fieldErrors, zodFieldErrors(parsed.error));
    if (!mailPortAllowed('imap', body.imap.port, body.imap.security)) {
      fieldErrors['imap.port'] ??= MAIL_PORT_NOT_ALLOWED_MESSAGE;
    }
    if (!mailPortAllowed('smtp', body.smtp.port, body.smtp.security)) {
      fieldErrors['smtp.port'] ??= MAIL_PORT_NOT_ALLOWED_MESSAGE;
    }
    return { request, fieldErrors, empty: Object.keys(request).length === 0 };
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFailure(null);
    const { fieldErrors, empty } = build();
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      return;
    }
    if (empty) {
      setNotice(d.noChanges);
      return;
    }
    setConfirming(true);
  };

  const send = async (confirmation: IdentityConfirmation) => {
    // Dibaca ulang saat konfirmasi: password tetap hanya di isian.
    const { request } = build();
    try {
      const { account: saved } = await endpoints.mail.update(account.id, {
        ...request,
        confirmation,
      });
      if (imapPasswordRef.current) imapPasswordRef.current.value = '';
      if (smtpPasswordRef.current) smtpPasswordRef.current.value = '';
      setConfirming(false);
      onSaved(saved);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(false);
      if (isApiError(caught) && caught.code === 'CHANNEL_REQUEST_FAILED') {
        setFailure(resultFromSaveFailure(null, caught.details));
        return;
      }
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR' && caught.details.length > 0) {
        const fieldErrors = apiFieldErrors(
          caught.details.filter((detail) => !detail.field.startsWith('confirmation')),
        );
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          return;
        }
      }
      setError(caught);
    }
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          if (!confirming) onClose();
        }}
      >
        <form className={styles.frame} onSubmit={submit} noValidate>
          <header className={styles.head}>
            <div className={styles.headRow}>
              <h2 id={titleId} className={styles.title}>
                {d.editServerTitle}
              </h2>
              <IconButton label={w.close} icon={X} className={styles.close} onClick={onClose} />
            </div>
          </header>
          <div className={styles.body}>
            <p className={styles.fieldHint}>{d.serverConfirmBody}</p>
            <CredentialFields
              values={values}
              set={set}
              errors={errors}
              imapPasswordRef={imapPasswordRef}
              passwordHint={w.passwordKeep}
              onSecretChange={() => setErrors({})}
            />
            <ServerCards
              values={values}
              set={set}
              errors={errors}
              smtpPasswordRef={smtpPasswordRef}
              passwordHint={w.passwordKeep}
              onSecretChange={() => setErrors({})}
            />
            {failure ? (
              <div className={styles.stack} role="alert">
                <TestResults result={failure} pending={false} emailAddress={account.emailAddress} />
                <Notice tone="danger" title={w.failedTitle}>
                  {w.fixHint}
                </Notice>
              </div>
            ) : null}
            {notice ? <Notice tone="info">{notice}</Notice> : null}
            {error ? (
              <Notice tone="danger" role="alert">
                {isApiError(error) ? error.message : t.api.network}
              </Notice>
            ) : null}
          </div>
          <footer className={styles.foot}>
            <span />
            <div className={styles.footButtons}>
              <Button onClick={onClose}>{w.cancel}</Button>
              <Button ref={submitRef} type="submit" variant="primary">
                {d.save}
              </Button>
            </div>
          </footer>
        </form>
      </dialog>
      <IdentityDialog
        open={confirming}
        title={d.serverConfirmTitle}
        body={d.serverConfirmBody}
        confirmLabel={d.save}
        pendingLabel={d.saving}
        requireCode={requireCode}
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(false)}
        onConfirm={send}
      />
    </>
  );
}
