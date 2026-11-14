import { requestPasswordResetRequestSchema } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { passwordResetStatusQuery } from '../../lib/api/queries';
import { zodFieldErrors, apiFieldErrors, type FieldErrors } from '../../lib/form';
import { useLock } from '../../lib/use-lock';
import { AuthLayout } from '../auth/AuthLayout';
import layout from '../auth/AuthLayout.module.css';
import styles from '../auth/Login.module.css';
import { LinkProblem, ToLoginButton } from '../auth/LinkProblem';
import { clearHandoffEmail, peekHandoffEmail, setHandoffEmail } from '../auth/login-notice';

const copy = t.forgotPassword;

/**
 * `/lupa-password` (publik): minta tautan atur ulang password lewat email.
 *
 * - Email pengirim instalasi belum diatur (`available: false`) → penjelasan tanpa form (keadaan
 *   instalasi, sama untuk semua orang; tidak membuka ada/tidaknya akun).
 * - Jawaban permintaan SELALU sama untuk email terdaftar maupun tidak (202): kalimat netral
 *   "Kalau … terdaftar, tautan … sudah dikirim", tidak pernah "email terkirim".
 */
export function ForgotPasswordPage() {
  const status = useQuery(passwordResetStatusQuery);
  const [sentTo, setSentTo] = useState<{ email: string; minutes: number } | null>(null);
  const [email, setEmail] = useState(peekHandoffEmail);
  useEffect(() => clearHandoffEmail(), []);

  if (status.isError) {
    return (
      <LinkProblem
        documentTitle={copy.title}
        title={copy.loadFailedTitle}
        message={isApiError(status.error) ? status.error.message : t.api.network}
      >
        <Button variant="primary" size="lg" onClick={() => void status.refetch()}>
          {t.common.retry}
        </Button>
        <ToLoginButton variant="secondary" />
      </LinkProblem>
    );
  }
  if (status.data && !status.data.available) {
    return (
      <LinkProblem
        documentTitle={copy.title}
        title={copy.unavailableTitle}
        message={copy.unavailable}
      >
        <BackToLogin email={email} primary />
      </LinkProblem>
    );
  }
  if (sentTo) {
    return (
      <Sent
        email={sentTo.email}
        minutes={sentTo.minutes}
        onOtherEmail={() => {
          setEmail('');
          setSentTo(null);
        }}
      />
    );
  }
  return (
    <AuthLayout
      documentTitle={copy.title}
      title={status.data ? copy.heading : undefined}
      subtitle={copy.subtitle}
      loading={status.data ? undefined : { subtitleLines: 2 }}
    >
      <RequestForm
        email={email}
        onEmailChange={setEmail}
        ready={status.data !== undefined}
        onSent={(minutes) => setSentTo({ email: email.trim(), minutes })}
      />
      <div className={styles.footnote}>
        <BackToLogin email={email} />
      </div>
    </AuthLayout>
  );
}

function RequestForm({
  email,
  onEmailChange,
  ready,
  onSent,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  ready: boolean;
  onSent: (minutes: number) => void;
}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useLock();
  const inputRef = useRef<HTMLInputElement>(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    if (focusTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || pending || lock.locked) return;
    const parsed = requestPasswordResetRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFocusTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setError(null);
    setPending(true);
    try {
      const response = await endpoints.passwordReset.request(parsed.data.email);
      onSent(response.validMinutes);
    } catch (caught) {
      setPending(false);
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR' && caught.details.length > 0) {
        setErrors(apiFieldErrors(caught.details));
        setFocusTick((tick) => tick + 1);
        return;
      }
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setError(caught);
      setFocusTick((tick) => tick + 1);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <TextField
        ref={inputRef}
        size="lg"
        label={copy.email}
        type="email"
        inputMode="email"
        name="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={t.auth.login.emailPlaceholder}
        value={email}
        onChange={(event) => {
          onEmailChange(event.target.value);
          if (errors.email) setErrors({});
        }}
        error={errors.email}
        disabled={!ready || pending}
      />
      <SubmitButton
        className={styles.submit}
        pending={pending}
        pendingLabel={copy.submitting}
        lock={lock}
        disabled={!ready}
      >
        {copy.submit}
      </SubmitButton>
      {/* Pesan server di bawah tombol: isian dan tombol tidak bergeser. */}
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

/** Jawaban netral setelah permintaan diterima server (sama untuk email terdaftar/tidak). */
function Sent({
  email,
  minutes,
  onOtherEmail,
}: {
  email: string;
  minutes: number;
  onOtherEmail: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <AuthLayout
      documentTitle={copy.title}
      title={copy.sentTitle}
      subtitle={copy.sent(email, minutes)}
      titleRef={titleRef}
    >
      <div className={layout.actions}>
        <BackToLogin email={email} primary />
        <Button variant="ghost" size="lg" onClick={onOtherEmail}>
          {copy.otherEmail}
        </Button>
      </div>
    </AuthLayout>
  );
}

/** Kembali ke halaman masuk; email yang sudah diketik ikut terbawa (memori, bukan URL). */
function BackToLogin({ email, primary = false }: { email: string; primary?: boolean }) {
  const remember = () => setHandoffEmail(email);
  if (primary) {
    return (
      <Button asChild variant="primary" size="lg">
        <Link to="/masuk" onClick={remember}>
          {copy.back}
        </Link>
      </Button>
    );
  }
  return (
    <Link to="/masuk" onClick={remember} className={layout.backLink}>
      <Icon icon={ArrowLeft} size={16} />
      {copy.back}
    </Link>
  );
}
