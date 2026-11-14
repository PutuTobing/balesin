import {
  PASSWORD_RULES_HINT,
  newPasswordSchema,
  totpCodeSchema,
  twoFactorCodeSchema,
  type InspectPasswordResetResponse,
} from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { PasswordField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { PasswordStrength, type ServerPasswordCheck } from '../../components/ui/PasswordStrength';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { clearSessionData } from '../../lib/api/queries';
import { formatTime } from '../../lib/format';
import { apiFieldErrors, type FieldErrors } from '../../lib/form';
import { useLinkToken } from '../../lib/link-token';
import { useLock } from '../../lib/use-lock';
import { AuthLayout } from '../auth/AuthLayout';
import layout from '../auth/AuthLayout.module.css';
import styles from '../auth/Login.module.css';
import { LinkFailed, LinkProblem, ToLoginButton } from '../auth/LinkProblem';
import { setHandoffEmail, setLoginNotice } from '../auth/login-notice';
import { linkInvalidMessage, useLinkInspect } from '../auth/use-link-inspect';
import { CodeField } from '../two-factor/CodeField';

const copy = t.resetPassword;

/**
 * `/atur-ulang-password#token=…` (publik): password baru (+ kode 2FA bila akun memakainya — atur
 * ulang password tidak pernah bisa melewati 2FA). Berhasil → semua sesi akun dicabut server; data
 * sesi di memori web dibuang, lalu ke halaman masuk dengan pesan.
 */
export function ResetPasswordPage() {
  const token = useLinkToken();
  // Tautan lain dibuka di tab ini: layar dimulai dari awal untuk token baru.
  return <ResetLink key={token ?? ''} token={token} />;
}

function ResetLink({ token }: { token: string | null }) {
  const { state, setState, retry, lock } = useLinkInspect(token, endpoints.passwordReset.inspect);

  if (state.kind === 'missing' || state.kind === 'invalid') {
    return (
      <LinkProblem
        documentTitle={copy.title}
        title={copy.invalidTitle}
        message={state.kind === 'missing' ? copy.missing : state.message}
        tall
      >
        <Button asChild variant="primary" size="lg">
          <Link to="/lupa-password">{copy.requestNew}</Link>
        </Button>
        <ToLoginButton variant="secondary" />
      </LinkProblem>
    );
  }
  if (state.kind === 'failed') {
    return (
      <LinkFailed documentTitle={copy.title} error={state.error} lock={lock} onRetry={retry} tall />
    );
  }
  return (
    <ResetScreen
      token={token ?? ''}
      reset={state.kind === 'ready' ? state.data : null}
      onInvalid={(message) => setState({ kind: 'invalid', message })}
    />
  );
}

function ResetScreen({
  token,
  reset,
  onInvalid,
}: {
  token: string;
  /** `null` = isi tautan belum tiba (kerangka memuat). */
  reset: InspectPasswordResetResponse | null;
  onInvalid: (message: string) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const loading = reset === null;
  useEffect(() => {
    if (!loading) titleRef.current?.focus();
  }, [loading]);

  return (
    <AuthLayout
      documentTitle={copy.title}
      title={reset ? copy.heading : undefined}
      subtitle={reset ? copy.subtitle(reset.email) : undefined}
      titleRef={titleRef}
      loading={loading ? { subtitleLines: 2 } : undefined}
      tall
    >
      <ResetForm token={token} reset={reset} onInvalid={onInvalid} />
      {/* Bergantung data: baru tampil setelah tautan diperiksa (di bawah isian, tidak menggeser). */}
      {reset ? (
        <div className={styles.footnote}>
          <p>{copy.expires(formatTime(reset.expiresAt))}</p>
        </div>
      ) : null}
    </AuthLayout>
  );
}

function ResetForm({
  token,
  reset,
  onInvalid,
}: {
  token: string;
  reset: InspectPasswordResetResponse | null;
  onInvalid: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<ServerPasswordCheck>({ state: 'idle' });
  const lock = useLock();
  const formRef = useRef<HTMLFormElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const strengthId = useId();
  const [invalidTick, setInvalidTick] = useState(0);
  const [failedTick, setFailedTick] = useState(0);
  const disabled = reset === null || pending;
  const needsCode = reset?.twoFactorRequired ?? false;
  const codeKind = reset?.methods.includes('backup_code') ? 'any' : 'totp';

  useEffect(() => {
    if (invalidTick === 0) return;
    const field = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
    field?.focus();
    field?.select();
  }, [invalidTick]);

  useEffect(() => {
    if (failedTick === 0) return;
    (needsCode ? codeRef : passwordRef).current?.focus();
  }, [failedTick, needsCode]);

  const validate = (): { errors: FieldErrors; code?: string } => {
    const found: FieldErrors = {};
    const parsedPassword = newPasswordSchema.safeParse(password);
    if (!parsedPassword.success) {
      found.password = parsedPassword.error.issues[0]?.message ?? copy.password;
    }
    if (!repeat) found.repeat = t.form.repeatRequired;
    else if (repeat !== password) found.repeat = t.form.passwordsDiffer;
    if (!needsCode) return { errors: found };
    const parsedCode = (codeKind === 'totp' ? totpCodeSchema : twoFactorCodeSchema).safeParse(code);
    if (!parsedCode.success) {
      found.code = parsedCode.error.issues[0]?.message ?? copy.code;
      return { errors: found };
    }
    return { errors: found, code: parsedCode.data };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || lock.locked || !reset) return;
    const result = validate();
    if (Object.keys(result.errors).length > 0) {
      setErrors(result.errors);
      setInvalidTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setError(null);
    setPending(true);
    try {
      await endpoints.passwordReset.complete(
        needsCode ? { token, password, code: result.code } : { token, password },
      );
      // Semua sesi akun ini sudah dicabut server: buang data sesi yang mungkin ada di memori.
      clearSessionData(queryClient);
      setLoginNotice('password-reset');
      setHandoffEmail(reset.email);
      await router.navigate({ to: '/masuk', replace: true });
    } catch (caught) {
      setPending(false);
      const invalid = linkInvalidMessage(caught);
      if (invalid !== null) {
        onInvalid(invalid);
        return;
      }
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR' && caught.details.length > 0) {
        const fieldErrors = apiFieldErrors(caught.details);
        setErrors(fieldErrors);
        if (fieldErrors.password) {
          setCheck({
            state: 'done',
            password,
            acceptable: false,
            message: t.password.strength.rejected,
          });
        }
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

  const clear = (key: string) => {
    if (errors[key]) setErrors(({ [key]: _removed, ...rest }) => rest);
  };

  return (
    <form ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      {/* Isian username tersembunyi: pengelola password menyimpan password baru ke akun yang benar. */}
      <input
        type="email"
        name="username"
        autoComplete="username"
        value={reset?.email ?? ''}
        readOnly
        hidden
      />
      <div className={layout.passwordBlock}>
        <PasswordField
          ref={passwordRef}
          size="lg"
          label={copy.password}
          hint={PASSWORD_RULES_HINT}
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clear('password');
            clear('repeat');
          }}
          error={errors.password}
          aria-describedby={strengthId}
          disabled={disabled}
        />
        <PasswordStrength id={strengthId} password={password} check={check} />
      </div>
      <PasswordField
        size="lg"
        label={copy.repeat}
        name="repeat-password"
        autoComplete="new-password"
        value={repeat}
        onChange={(event) => {
          setRepeat(event.target.value);
          clear('repeat');
        }}
        error={errors.repeat}
        disabled={disabled}
      />
      {needsCode ? (
        <div className={layout.codeBlock}>
          <Notice tone="info" title={copy.twoFactorTitle}>
            {copy.twoFactorBody}
          </Notice>
          <CodeField
            ref={codeRef}
            kind={codeKind}
            label={copy.code}
            hint={codeKind === 'totp' ? copy.codeHintTotp : copy.codeHintAny}
            name="kode"
            value={code}
            onValueChange={(value) => {
              setCode(value);
              clear('code');
            }}
            error={errors.code}
            disabled={disabled}
          />
        </div>
      ) : null}
      {/* Blok 2FA dan tombol bergantung data: dirender setelah tiba, di bawah isian (kritikus W2). */}
      {reset ? (
        <SubmitButton
          className={styles.submit}
          pending={pending}
          pendingLabel={copy.submitting}
          lock={lock}
        >
          {copy.submit}
        </SubmitButton>
      ) : null}
      {error ? (
        <Notice
          tone={lock.locked ? 'warning' : 'danger'}
          role="alert"
          title={lock.locked ? t.links.lockedTitle : undefined}
        >
          {isApiError(error) ? error.message : t.api.network}
        </Notice>
      ) : null}
    </form>
  );
}
