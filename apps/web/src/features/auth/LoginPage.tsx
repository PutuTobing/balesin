import { loginRequestSchema } from '@balesin/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrandLogo } from '../../brand/BrandLogo';
import { useBrand } from '../../brand/brand';
import { LoginHero } from '../../components/illustrations/LoginHero';
import { Button } from '../../components/ui/Button';
import { PasswordField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { storeSession } from '../../lib/api/queries';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { safeRedirectTarget } from '../../lib/safe-redirect';
import { formatClock } from '../../lib/format';
import { useCountdown, type Deadline } from '../../lib/use-countdown';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Login.module.css';
import { clearLoginNotice, peekLoginNotice, type LoginNotice } from './login-notice';

const routeApi = getRouteApi('/masuk');

/** Halaman masuk. Tidak ada tautan "Daftar": akun baru hanya lewat undangan. */
export function LoginPage() {
  usePageTitle(t.auth.login.title);
  const { organizationName } = useBrand();

  return (
    <div className={styles.screen}>
      <main className={styles.pane}>
        <div className={styles.inner}>
          <BrandLogo className={styles.logo} />
          <div className={styles.head}>
            <h1 className={styles.title}>{t.auth.login.heading(organizationName)}</h1>
            <p className={styles.subtitle}>{t.auth.login.subtitle}</p>
          </div>
          <LoginForm />
          <p className={styles.footnote}>{t.auth.login.noAccount}</p>
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

function LoginForm() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const search = routeApi.useSearch();
  const passwordRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Naik setiap validasi gagal → fokus ke isian pertama yang salah.
  const [invalidTick, setInvalidTick] = useState(0);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice] = useState<LoginNotice | null>(peekLoginNotice);
  const [lock, setLock] = useState<Deadline | null>(null);
  // Password salah: setelah form aktif lagi, isi password dipilih supaya bisa langsung diketik ulang.
  const [retypePassword, setRetypePassword] = useState(0);
  // Gagal karena server/jaringan/kunci: fokus kembali ke password (tombol nonaktif selama
  // memproses, jadi fokus jatuh ke <body> bila dibiarkan).
  const [refocusPassword, setRefocusPassword] = useState(0);
  const secondsLeft = useCountdown(lock);
  const locked = lock !== null && secondsLeft > 0;
  // Kunci sudah lewat: pesan kunci disembunyikan dan pembaca layar diberi tahu sekali.
  const unlocked = lock !== null && secondsLeft === 0;

  useEffect(() => clearLoginNotice(), []);

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
          await router.navigate({ href: safeRedirectTarget(search.redirect), replace: true });
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
        const startedAt = Date.now();
        setLock({ until: startedAt + error.retryAfterSeconds * 1000, startedAt });
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
    setLock(null);
    login.mutate(parsed.data);
  };

  const error = login.error;
  // Pesan "sudah keluar"/"sesi berakhir" tetap tampil: menghilangkannya menggeser form (W1).
  const showNotice = notice !== null;

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
        onChange={(event) => setEmail(event.target.value)}
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
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className={styles.submit}
        loading={login.isPending}
        disabled={locked}
        // Terkunci: label tombol = sisa waktu, jadi tidak dipudarkan (Login.module.css).
        data-locked={locked ? '' : undefined}
      >
        {login.isPending ? (
          t.auth.login.submitting
        ) : locked ? (
          // Sisa waktu di label tombol (bukan di wilayah aria-live): tidak diumumkan tiap detik.
          <span className={styles.countdown}>
            {t.auth.login.countdownButton(formatClock(secondsLeft))}
          </span>
        ) : (
          t.auth.login.submit
        )}
      </Button>
      {/*
        Pesan dari server tampil di BAWAH tombol: judul, isian, dan tombol yang baru diklik tidak
        bergeser saat pesan muncul (kritikus W1).
      */}
      {error && !(isApiError(error) && error.code === 'VALIDATION_ERROR') && !unlocked ? (
        <LoginError error={error} />
      ) : null}
      {/* Ada sejak akun dikunci (supaya isinya nanti diumumkan), diisi sekali saat kunci habis. */}
      {lock ? (
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
