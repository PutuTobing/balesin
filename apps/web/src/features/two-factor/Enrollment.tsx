import {
  TWO_FACTOR_ENROLLMENT_PENDING_MINUTES,
  loginPasswordSchema,
  totpCodeSchema,
  type ConfirmTwoFactorEnrollmentResponse,
  type StartTwoFactorEnrollmentResponse,
} from '@balesin/shared';
import { ExternalLink, RotateCw } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { PasswordField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { media, useMediaQuery } from '../../lib/media';
import { useLock, type Lock } from '../../lib/use-lock';
import { CodeField } from './CodeField';
import { QrCode } from './QrCode';
import styles from './TwoFactor.module.css';

const copy = t.twoFactor.enroll;

/** Pesan di langkah password (mode `voluntary`). */
interface PasswordStepMessage {
  /** Error di isian password (password salah). */
  fieldError?: string;
  /** Error lain dari server (503, 429, jaringan). */
  error?: unknown;
  /** QR sebelumnya kedaluwarsa. */
  expired?: boolean;
}

type EnrollmentState =
  | { kind: 'password'; message: PasswordStepMessage | null; pending: boolean }
  | { kind: 'starting' }
  | { kind: 'start-failed'; error: unknown }
  | { kind: 'ready'; enrollment: StartTwoFactorEnrollmentResponse; receivedAt: number }
  | { kind: 'expired' }
  | { kind: 'done' };

interface EnrollmentStepsProps {
  /**
   * `required`: sesi terbatas (baru saja memasukkan password), pendaftaran langsung dimulai.
   * `voluntary`: dari Keamanan akun dengan sesi penuh, password dikonfirmasi dulu.
   */
  mode: 'required' | 'voluntary';
  /** 2FA aktif. Rahasia sudah dibuang dari memori; kode cadangan diteruskan ke pemanggil. */
  onConfirmed: (response: ConfirmTwoFactorEnrollmentResponse) => void;
  /** Server menjawab 409 saat memulai: 2FA ternyata sudah aktif (mis. di tab lain). */
  onAlreadyEnabled: () => void;
}

/**
 * Tiga langkah mendaftarkan aplikasi autentikator: pasang aplikasi, tambahkan akun (QR yang
 * dibuat di browser dari `otpauthUri`, atau kunci untuk diketik), lalu masukkan kode pertama.
 * Rahasia hanya ada di state komponen ini: tidak di cache Query, URL, atau penyimpanan browser,
 * dan hilang begitu komponen ditutup. Kode QR berlaku 15 menit; setelah itu dibuat ulang.
 */
export function EnrollmentSteps({ mode, onConfirmed, onAlreadyEnabled }: EnrollmentStepsProps) {
  const [state, setState] = useState<EnrollmentState>(
    mode === 'required'
      ? { kind: 'starting' }
      : { kind: 'password', message: null, pending: false },
  );
  const startLock = useLock();
  // Mode `voluntary`: rahasia kedaluwarsa → minta password lagi (password tidak disimpan).
  const expiredState = (): EnrollmentState =>
    mode === 'voluntary'
      ? { kind: 'password', message: { expired: true }, pending: false }
      : { kind: 'expired' };

  const start = async (password?: string) => {
    setState(
      password === undefined
        ? { kind: 'starting' }
        : { kind: 'password', message: null, pending: true },
    );
    try {
      const enrollment = await endpoints.twoFactor.enroll(password);
      setState({ kind: 'ready', enrollment, receivedAt: Date.now() });
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        onAlreadyEnabled();
        return;
      }
      if (isApiError(error) && error.status === 429 && error.retryAfterSeconds) {
        startLock.lockFor(error.retryAfterSeconds);
      }
      if (mode === 'voluntary') {
        const fieldError = isApiError(error)
          ? error.details.find((detail) => detail.field === 'password')?.message
          : undefined;
        setState({
          kind: 'password',
          message: fieldError ? { fieldError } : { error },
          pending: false,
        });
        return;
      }
      setState({ kind: 'start-failed', error });
    }
  };

  // Sesi terbatas: mulai sekali saat dibuka (StrictMode menjalankan efek dua kali; memanggil
  // ulang = rahasia baru, jadi dijaga dengan ref).
  const started = useRef(false);
  const startOnOpen = useEffectEvent(() => void start());
  useEffect(() => {
    if (mode !== 'required' || started.current) return;
    started.current = true;
    startOnOpen();
  }, [mode]);

  // Kedaluwarsa dihitung dari saat rahasia diterima (bukan dari jam perangkat vs `expiresAt`).
  const receivedAt = state.kind === 'ready' ? state.receivedAt : null;
  const expire = useEffectEvent(() => setState(expiredState()));
  useEffect(() => {
    if (receivedAt === null) return;
    const timer = window.setTimeout(
      expire,
      Math.max(0, receivedAt + TWO_FACTOR_ENROLLMENT_PENDING_MINUTES * 60_000 - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [receivedAt]);

  if (state.kind === 'done') return null;
  if (state.kind === 'password') {
    return (
      <PasswordStep
        message={state.message}
        pending={state.pending}
        lock={startLock}
        onSubmit={(password) => void start(password)}
      />
    );
  }

  return (
    <ol className={styles.steps} aria-label={copy.stepsLabel}>
      <Step number={1} title={copy.install.title}>
        <p className={styles.stepText}>{copy.install.body}</p>
      </Step>
      <Step number={2} title={copy.add.title}>
        {state.kind === 'ready' ? (
          <AddAccount enrollment={state.enrollment} />
        ) : state.kind === 'starting' ? (
          <AddAccountSkeleton />
        ) : state.kind === 'expired' ? (
          <Notice
            tone="warning"
            role="alert"
            title={copy.expiredTitle}
            actions={
              <Button variant="primary" onClick={() => void start()}>
                <Icon icon={RotateCw} size={16} />
                {copy.restart}
              </Button>
            }
          >
            {copy.expiredBody(TWO_FACTOR_ENROLLMENT_PENDING_MINUTES)}
          </Notice>
        ) : (
          <StartFailed
            error={state.error}
            locked={startLock.locked}
            retry={
              <SubmitButton
                type="button"
                variant="secondary"
                size="md"
                pending={false}
                pendingLabel={t.common.retry}
                lock={startLock}
                onClick={() => void start()}
              >
                <Icon icon={RotateCw} size={16} />
                {t.common.retry}
              </SubmitButton>
            }
          />
        )}
      </Step>
      <Step number={3} title={copy.confirm.title}>
        <p className={styles.stepText}>{copy.confirm.body}</p>
        <ConfirmForm
          // Rahasia baru = form baru (isian dan error lama dibuang).
          key={state.kind === 'ready' ? `ready-${state.receivedAt}` : state.kind}
          ready={state.kind === 'ready'}
          onExpired={() => setState(expiredState())}
          onConfirmed={(response) => {
            // Rahasia dibuang dari memori sebelum kode cadangan ditampilkan.
            setState({ kind: 'done' });
            onConfirmed(response);
          }}
        />
      </Step>
    </ol>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className={styles.step}>
      <span className={styles.marker} aria-hidden="true">
        {number}
      </span>
      <div className={styles.stepBody}>
        <h2 className={styles.stepTitle}>{title}</h2>
        {children}
      </div>
    </li>
  );
}

/** QR + kunci untuk diketik. Di HP ada tombol yang membuka aplikasi autentikator langsung. */
function AddAccount({ enrollment }: { enrollment: StartTwoFactorEnrollmentResponse }) {
  const isHp = useMediaQuery(media.hp);
  return (
    <div className={styles.add}>
      <p className={styles.stepText}>{isHp ? copy.add.bodyHp : copy.add.bodyQr}</p>
      {isHp ? (
        <Button asChild size="lg" className={styles.openApp}>
          {/* Tautan `otpauth://` dibuka aplikasi autentikator di ponsel yang sama. */}
          <a href={enrollment.otpauthUri}>
            <Icon icon={ExternalLink} size={16} />
            {copy.add.openApp}
          </a>
        </Button>
      ) : null}
      <div className={styles.addGrid}>
        <QrCode value={enrollment.otpauthUri} label={copy.add.qrLabel} />
        <div className={styles.manual}>
          <p className={styles.manualTitle}>{copy.add.manualTitle}</p>
          <code className={styles.secret}>{enrollment.secretGrouped}</code>
          <div>
            <CopyButton
              text={enrollment.secret}
              label={copy.add.copy}
              copiedLabel={copy.add.copied}
              announcement={copy.add.copiedAnnouncement}
            />
          </div>
          <p className={styles.meta}>
            {copy.add.entryName(enrollment.issuer, enrollment.accountName)}{' '}
            {copy.add.validity(TWO_FACTOR_ENROLLMENT_PENDING_MINUTES)}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Kerangka langkah 2 selama rahasia dibuat: ukuran QR dan kunci sama dengan layar jadi. */
function AddAccountSkeleton() {
  return (
    <SkeletonRegion className={styles.add}>
      <span className="sr-only">{copy.preparing}</span>
      <Skeleton className={styles.skeletonLine} />
      <div className={styles.addGrid}>
        <Skeleton className={styles.qrSkeleton} />
        <div className={styles.manual}>
          <Skeleton className={styles.skeletonLabel} />
          <Skeleton className={styles.skeletonSecret} />
          <Skeleton className={styles.skeletonButton} />
          <Skeleton className={styles.skeletonLine} />
        </div>
      </div>
    </SkeletonRegion>
  );
}

function StartFailed({
  error,
  locked,
  retry,
}: {
  error: unknown;
  locked: boolean;
  retry: ReactNode;
}) {
  const message = isApiError(error) ? error.message : t.api.network;
  return (
    <Notice
      tone={locked ? 'warning' : 'danger'}
      role="alert"
      title={locked ? copy.lockedTitle : copy.startFailedTitle}
      actions={retry}
    >
      {message}
    </Notice>
  );
}

function ConfirmForm({
  ready,
  onExpired,
  onConfirmed,
}: {
  ready: boolean;
  onExpired: () => void;
  onConfirmed: (response: ConfirmTwoFactorEnrollmentResponse) => void;
}) {
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
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
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? copy.confirm.label);
      setFocusTick((tick) => tick + 1);
      return;
    }
    setFieldError(null);
    setError(null);
    setPending(true);
    try {
      // Sengaja tanpa useMutation: respons memuat kode cadangan, dan hasil mutasi tersimpan di
      // cache mutasi Query sampai dibersihkan. Di sini respons hanya lewat ke pemanggil.
      const response = await endpoints.twoFactor.confirmEnrollment(parsed.data);
      onConfirmed(response);
    } catch (caught) {
      setPending(false);
      if (isApiError(caught) && caught.status === 409) {
        onExpired();
        return;
      }
      const detail = isApiError(caught)
        ? caught.details.find((item) => item.field === 'code')
        : undefined;
      if (detail) {
        setFieldError(detail.message);
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
    <form className={styles.confirm} onSubmit={(event) => void submit(event)} noValidate>
      <CodeField
        ref={inputRef}
        kind="totp"
        label={copy.confirm.label}
        name="kode-konfirmasi"
        className={styles.confirmField}
        value={code}
        onValueChange={(value) => {
          setCode(value);
          if (fieldError) setFieldError(null);
        }}
        error={fieldError}
        disabled={!ready || pending}
      />
      <SubmitButton
        className={styles.confirmSubmit}
        pending={pending}
        pendingLabel={copy.confirm.submitting}
        lock={lock}
      >
        {copy.confirm.submit}
      </SubmitButton>
      {error ? (
        <Notice
          tone={isApiError(error) && error.status === 429 ? 'warning' : 'danger'}
          role="alert"
          title={isApiError(error) && error.status === 429 ? copy.lockedTitle : undefined}
        >
          {isApiError(error) ? error.message : t.api.network}
        </Notice>
      ) : null}
    </form>
  );
}

/** Sesi penuh: konfirmasi password sebelum rahasia baru dibuat. */
function PasswordStep({
  message,
  pending,
  lock,
  onSubmit,
}: {
  message: PasswordStepMessage | null;
  pending: boolean;
  lock: Lock;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shownError = localError ?? message?.fieldError ?? null;

  // Kembali dengan pesan (password salah, server menolak, QR kedaluwarsa): fokus ke isian.
  useEffect(() => {
    if (!message) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [message]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending || lock.locked) return;
    const parsed = loginPasswordSchema.safeParse(password);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? copy.password.label);
      inputRef.current?.focus();
      return;
    }
    setLocalError(null);
    onSubmit(parsed.data);
  };

  const error = message?.error;
  return (
    <form className={styles.passwordStep} onSubmit={submit} noValidate>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{copy.password.title}</h2>
        <p className={styles.stepText}>{copy.password.body}</p>
      </div>
      {message?.expired ? (
        <Notice tone="warning" role="status" title={copy.expiredTitle}>
          {copy.expiredBody(TWO_FACTOR_ENROLLMENT_PENDING_MINUTES)}
        </Notice>
      ) : null}
      <PasswordField
        ref={inputRef}
        size="lg"
        label={copy.password.label}
        name="password"
        autoComplete="current-password"
        className={styles.confirmField}
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          if (localError) setLocalError(null);
        }}
        error={shownError}
        disabled={pending}
      />
      <SubmitButton
        className={styles.confirmSubmit}
        pending={pending}
        pendingLabel={copy.password.submitting}
        lock={lock}
      >
        {copy.password.submit}
      </SubmitButton>
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
