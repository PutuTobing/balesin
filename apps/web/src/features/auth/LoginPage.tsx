import {
  loginRequestSchema,
  type TwoFactorChallengeResponse,
  type TwoFactorMethod,
  type VerifyTwoFactorResponse,
} from '@balesin/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrandLogo } from '../../brand/BrandLogo';
import { useBrand } from '../../brand/brand';
import { LoginHero } from '../../components/illustrations/LoginHero';
import { PasswordField, TextField } from '../../components/ui/Field';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { storeSession } from '../../lib/api/queries';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { safeRedirectTarget } from '../../lib/safe-redirect';
import { useLock } from '../../lib/use-lock';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Login.module.css';
import { clearLoginNotice, peekLoginNotice, type LoginNotice } from './login-notice';
import { BackupCodeUsed, TwoFactorLoginForm } from './TwoFactorLogin';
import { twoFactorLoginCopy } from './two-factor-copy';

const routeApi = getRouteApi('/masuk');

/** Pesan yang dibawa saat kembali ke langkah password (tantangan 2FA kedaluwarsa/hangus). */
export interface ReturnMessage {
  tone: NoticeTone;
  message: string;
  /** `status`: diumumkan sopan (mis. "sudah bisa mencoba lagi"); bawaan `alert`. */
  role?: 'alert' | 'status';
}

type Stage =
  | {
      kind: 'password';
      message: ReturnMessage | null;
      /** Kembali dari langkah kode: email sudah terisi, fokus langsung ke password. */
      returning: boolean;
    }
  | {
      kind: 'code';
      challenge: TwoFactorChallengeResponse;
      method: TwoFactorMethod;
      email: string;
      receivedAt: number;
    }
  | { kind: 'backup-used'; remaining: number };

/**
 * Halaman masuk, dua langkah bila akun memakai 2FA: email + password, lalu kode dari aplikasi
 * autentikator (atau kode cadangan). Tidak ada tautan "Daftar": akun baru hanya lewat undangan.
 */
export function LoginPage() {
  usePageTitle(t.auth.login.title);
  const { organizationName } = useBrand();
  const queryClient = useQueryClient();
  const router = useRouter();
  const search = routeApi.useSearch();
  const [stage, setStage] = useState<Stage>({
    kind: 'password',
    message: null,
    returning: false,
  });
  // Email tetap terisi saat kembali dari langkah kode.
  const [email, setEmail] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const target = safeRedirectTarget(search.redirect);

  useEffect(() => {
    if (stage.kind === 'backup-used') headingRef.current?.focus();
  }, [stage.kind]);

  const onVerified = async (response: VerifyTwoFactorResponse) => {
    storeSession(queryClient, response);
    if (response.twoFactor.method === 'backup_code') {
      setStage({ kind: 'backup-used', remaining: response.twoFactor.backupCodesRemaining });
      return;
    }
    await router.navigate({ href: target, replace: true });
  };

  const head =
    stage.kind === 'code'
      ? twoFactorLoginCopy(stage.method, stage.email)
      : stage.kind === 'backup-used'
        ? {
            title: t.twoFactor.login.backupUsed.title,
            subtitle: t.twoFactor.login.backupUsed.body(stage.remaining),
          }
        : { title: t.auth.login.heading(organizationName), subtitle: t.auth.login.subtitle };

  return (
    <div className={styles.screen}>
      <main className={styles.pane}>
        <div className={styles.inner}>
          <BrandLogo className={styles.logo} />
          <div className={styles.head}>
            <h1
              ref={headingRef}
              tabIndex={stage.kind === 'backup-used' ? -1 : undefined}
              className={styles.title}
            >
              {head.title}
            </h1>
            <p className={styles.subtitle}>{head.subtitle}</p>
          </div>
          {stage.kind === 'password' ? (
            <>
              <LoginForm
                email={email}
                onEmailChange={setEmail}
                returnMessage={stage.message}
                returning={stage.returning}
                onChallenge={(challenge, receivedAt) =>
                  setStage({ kind: 'code', challenge, method: 'totp', email, receivedAt })
                }
                target={target}
                redirect={search.redirect}
              />
              <p className={styles.footnote}>{t.auth.login.noAccount}</p>
            </>
          ) : stage.kind === 'code' ? (
            <TwoFactorLoginForm
              key={stage.challenge.challengeToken}
              challenge={stage.challenge}
              method={stage.method}
              onMethodChange={(method) => setStage({ ...stage, method })}
              receivedAt={stage.receivedAt}
              onVerified={onVerified}
              onRestart={(message) => setStage({ kind: 'password', message, returning: true })}
            />
          ) : (
            <BackupCodeUsed
              remaining={stage.remaining}
              onContinue={() => void router.navigate({ href: target, replace: true })}
              onMakeNew={() => void router.navigate({ to: '/pengaturan/keamanan', replace: true })}
            />
          )}
        </div>
      </main>
      <aside className={styles.hero} aria-hidden="true">
        <LoginHero sizes="60vw" className={styles.heroImage} />
        <div className={styles.heroText}>
          <p className={styles.heroTitle}>{t.auth.login.heroTitle}</p>
          <p className={styles.heroBody}>{t.auth.login.heroBody}</p>
        </div>
      </aside>
    </div>
  );
}

interface LoginFormProps {
  email: string;
  onEmailChange: (email: string) => void;
  /** Pesan dari langkah kode (mis. waktu habis), tampil di bawah tombol sampai dikirim lagi. */
  returnMessage: ReturnMessage | null;
  /** Kembali dari langkah kode (dengan atau tanpa pesan): fokus ke isian password. */
  returning: boolean;
  onChallenge: (challenge: TwoFactorChallengeResponse, receivedAt: number) => void;
  /** Tujuan setelah masuk (sudah divalidasi). */
  target: string;
  /** `?redirect=` mentah, dibawa ke layar pendaftaran 2FA. */
  redirect: string | undefined;
}

function LoginForm({
  email,
  onEmailChange,
  returnMessage,
  returning,
  onChallenge,
  target,
  redirect,
}: LoginFormProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const passwordRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Naik setiap validasi gagal → fokus ke isian pertama yang salah.
  const [invalidTick, setInvalidTick] = useState(0);

  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice] = useState<LoginNotice | null>(peekLoginNotice);
  const [message, setMessage] = useState<ReturnMessage | null>(returnMessage);
  const lock = useLock();
  // Password salah: setelah form aktif lagi, isi password dipilih supaya bisa langsung diketik ulang.
  const [retypePassword, setRetypePassword] = useState(0);
  // Gagal karena server/jaringan/kunci: fokus kembali ke password (tombol nonaktif selama
  // memproses, jadi fokus jatuh ke <body> bila dibiarkan).
  const [refocusPassword, setRefocusPassword] = useState(0);
  const { locked, unlocked } = lock;

  useEffect(() => clearLoginNotice(), []);

  // Kembali dari langkah kode: email sudah terisi, jadi langsung ke password.
  useEffect(() => {
    if (returning) passwordRef.current?.focus();
  }, [returning]);

  useEffect(() => {
    if (retypePassword === 0) return;
    passwordRef.current?.focus();
    passwordRef.current?.select();
  }, [retypePassword]);

  useEffect(() => {
    if (refocusPassword === 0) return;
    passwordRef.current?.focus();
  }, [refocusPassword]);

  useEffect(() => {
    if (unlocked) passwordRef.current?.focus();
  }, [unlocked]);

  useEffect(() => {
    if (invalidTick === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalidTick]);

  const login = useMutation({
    mutationFn: endpoints.auth.login,
    onSuccess: async (response) => {
      switch (response.status) {
        case 'authenticated': {
          storeSession(queryClient, response);
          await router.navigate({ href: target, replace: true });
          return;
        }
        case 'two_factor_required': {
          onChallenge(response, Date.now());
          return;
        }
        case 'two_factor_enrollment_required': {
          // Sesi terbatas: hanya layar pendaftaran 2FA yang bisa dibuka.
          storeSession(queryClient, response);
          await router.navigate({
            to: '/verifikasi-dua-langkah',
            search: { redirect },
            replace: true,
          });
          return;
        }
      }
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        setFieldErrors(apiFieldErrors(error.details));
        setInvalidTick((tick) => tick + 1);
        return;
      }
      if (isApiError(error) && error.code === 'INVALID_CREDENTIALS') {
        setRetypePassword((count) => count + 1);
        return;
      }
      if (isApiError(error) && error.status === 429 && error.retryAfterSeconds) {
        lock.lockFor(error.retryAfterSeconds);
      }
      // 503, jaringan putus, dikunci: isian password tetap aktif, jadi fokus ke sana.
      setRefocusPassword((count) => count + 1);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (locked || login.isPending) return;
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(zodFieldErrors(parsed.error));
      setInvalidTick((tick) => tick + 1);
      return;
    }
    setFieldErrors({});
    setMessage(null);
    lock.clear();
    login.mutate(parsed.data);
  };

  const error = login.error;
  // Pesan "sudah keluar"/"sesi berakhir" tetap tampil: menghilangkannya menggeser form (W1).
  const showNotice = notice !== null && returnMessage === null;

  return (
    <form ref={formRef} className={styles.form} onSubmit={submit} noValidate>
      {showNotice ? (
        <Notice tone={notice === 'logged-out' ? 'success' : 'info'} role="status">
          {notice === 'logged-out' ? t.auth.login.loggedOut : t.auth.login.sessionEnded}
        </Notice>
      ) : null}
      <TextField
        size="lg"
        label={t.auth.login.email}
        type="email"
        inputMode="email"
        name="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={t.auth.login.emailPlaceholder}
        value={email}
        onChange={(event) => onEmailChange(event.target.value)}
        error={fieldErrors.email}
        disabled={login.isPending}
      />
      <PasswordField
        ref={passwordRef}
        size="lg"
        label={t.auth.login.password}
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={fieldErrors.password}
        disabled={login.isPending}
      />
      <SubmitButton
        className={styles.submit}
        pending={login.isPending}
        pendingLabel={t.auth.login.submitting}
        lock={lock}
      >
        {t.auth.login.submit}
      </SubmitButton>
      {/*
        Pesan dari server tampil di BAWAH tombol: judul, isian, dan tombol yang baru diklik tidak
        bergeser saat pesan muncul (kritikus W1).
      */}
      {error && !(isApiError(error) && error.code === 'VALIDATION_ERROR') && !unlocked ? (
        <LoginError error={error} />
      ) : message && !error ? (
        <Notice tone={message.tone} role={message.role ?? 'alert'}>
          {message.message}
        </Notice>
      ) : null}
      {/* Ada sejak akun dikunci (supaya isinya nanti diumumkan), diisi sekali saat kunci habis. */}
      {lock.locked || lock.unlocked ? (
        <p role="status" className="sr-only">
          {unlocked ? t.auth.login.unlocked : ''}
        </p>
      ) : null}
    </form>
  );
}

function LoginError({ error }: { error: Error }) {
  const message = isApiError(error) ? error.message : t.api.network;
  if (isApiError(error) && error.status === 429) {
    // Pesan server tetap jadi isi: membedakan kunci akun dan kunci jaringan.
    return (
      <Notice tone="warning" role="alert" title={t.auth.login.lockedTitle}>
        {message}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" role="alert">
      {message}
    </Notice>
  );
}
