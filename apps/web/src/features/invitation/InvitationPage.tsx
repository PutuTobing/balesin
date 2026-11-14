import {
  PASSWORD_RULES_HINT,
  USER_ROLE_LABELS,
  newPasswordSchema,
  personNameSchema,
  type InspectInvitationResponse,
  type MeResponse,
} from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { PasswordField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { PasswordStrength, type ServerPasswordCheck } from '../../components/ui/PasswordStrength';
import { Skeleton } from '../../components/ui/Skeleton';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { clearSessionData, storeSession } from '../../lib/api/queries';
import { formatTime } from '../../lib/format';
import { apiFieldErrors, type FieldErrors } from '../../lib/form';
import { useLinkToken } from '../../lib/link-token';
import { useLock } from '../../lib/use-lock';
import { AuthLayout } from '../auth/AuthLayout';
import layout from '../auth/AuthLayout.module.css';
import styles from '../auth/Login.module.css';
import { LinkFailed, LinkProblem, ToLoginButton } from '../auth/LinkProblem';
import { useAnySession } from '../auth/session';
import { linkInvalidMessage, useLinkInspect } from '../auth/use-link-inspect';

const copy = t.invitation;

/**
 * `/undangan#token=…` (publik): penerima undangan membuat akunnya — nama + password (kebijakan sama
 * dengan setup, diperiksa server saat dikirim). Peran dan email selalu dari undangan.
 *
 * Setelah akun dibuat: CS/Teknisi langsung masuk ke aplikasi; Admin/Supervisor mendapat sesi
 * terbatas dan langsung ke layar pendaftaran 2FA. Tautan yang tidak berlaku → layar penjelasan.
 */
export function InvitationPage() {
  const token = useLinkToken();
  // Tautan lain dibuka di tab ini: layar dimulai dari awal untuk token baru.
  return <InvitationLink key={token ?? ''} token={token} />;
}

function InvitationLink({ token }: { token: string | null }) {
  const { state, setState, retry, lock } = useLinkInspect(token, endpoints.invitations.inspect);

  if (state.kind === 'missing' || state.kind === 'invalid') {
    return (
      <LinkProblem
        documentTitle={copy.documentTitle}
        title={copy.invalidTitle}
        message={state.kind === 'missing' ? copy.missing : state.message}
      >
        <ToLoginButton />
      </LinkProblem>
    );
  }
  if (state.kind === 'failed') {
    return (
      <LinkFailed
        documentTitle={copy.documentTitle}
        error={state.error}
        lock={lock}
        onRetry={retry}
      />
    );
  }
  return (
    <InvitationScreen
      token={token ?? ''}
      invitation={state.kind === 'ready' ? state.data : null}
      onInvalid={(message) => setState({ kind: 'invalid', message })}
    />
  );
}

function InvitationScreen({
  token,
  invitation,
  onInvalid,
}: {
  token: string;
  /** `null` = isi undangan belum tiba (kerangka memuat). */
  invitation: InspectInvitationResponse | null;
  onInvalid: (message: string) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const loading = invitation === null;

  // Isi undangan tiba: fokus ke judul supaya pembaca layar langsung membaca undangannya.
  useEffect(() => {
    if (!loading) titleRef.current?.focus();
  }, [loading]);

  return (
    <AuthLayout
      documentTitle={copy.documentTitle}
      eyebrow={copy.eyebrow}
      title={invitation ? copy.title(invitation.organizationName) : undefined}
      subtitle={
        invitation
          ? copy.subtitle(
              invitation.invitedByName,
              USER_ROLE_LABELS[invitation.role],
              invitation.productName,
            )
          : undefined
      }
      titleRef={titleRef}
      loading={loading ? { subtitleLines: 2 } : undefined}
      tall
    >
      <SignedInWarning />
      <AcceptForm token={token} invitation={invitation} onInvalid={onInvalid} />
      <div className={styles.footnote}>
        {invitation ? (
          <p>{copy.expires(formatTime(invitation.expiresAt))}</p>
        ) : (
          <Skeleton className={layout.skeletonText} />
        )}
      </div>
    </AuthLayout>
  );
}

/**
 * Browser ini sedang masuk dengan akun lain: menerima undangan mengeluarkan akun itu (server
 * mencabut sesinya). Tawarkan keluar dulu tanpa meninggalkan halaman (token tetap di memori).
 */
function SignedInWarning() {
  const queryClient = useQueryClient();
  const session = useAnySession();
  // Nama dipegang supaya pesan "sudah keluar" tetap bisa tampil setelah sesi dikosongkan.
  const [signedIn] = useState<MeResponse | null>(session);
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'failed'>('idle');

  if (!signedIn) return null;
  if (state === 'done') {
    return (
      <Notice tone="success" role="status">
        {copy.signedIn.loggedOut}
      </Notice>
    );
  }

  const logout = async () => {
    setState('pending');
    try {
      await endpoints.auth.logout();
    } catch (error) {
      // Sesi sudah tidak berlaku di server = sama dengan sudah keluar.
      if (!(isApiError(error) && error.status === 401)) {
        setState('failed');
        return;
      }
    }
    // Tidak ada layar aplikasi yang terbuka: sesi dan semua data pengguna langsung dibuang.
    clearSessionData(queryClient);
    setState('done');
  };

  return (
    <Notice
      tone="warning"
      title={copy.signedIn.title(signedIn.user.name)}
      actions={
        <Button
          onClick={() => void logout()}
          loading={state === 'pending'}
          className={layout.noticeAction}
        >
          {state === 'pending' ? copy.signedIn.loggingOut : copy.signedIn.logout}
        </Button>
      }
    >
      {copy.signedIn.body}
      {state === 'failed' ? (
        <span role="alert" className={layout.inlineError}>
          {' '}
          {copy.signedIn.logoutFailed}
        </span>
      ) : null}
    </Notice>
  );
}

function AcceptForm({
  token,
  invitation,
  onInvalid,
}: {
  token: string;
  invitation: InspectInvitationResponse | null;
  onInvalid: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  // Password yang ditolak server (kebijakan): meter ikut menandainya sampai password diubah.
  const [check, setCheck] = useState<ServerPasswordCheck>({ state: 'idle' });
  const lock = useLock();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const strengthId = useId();
  const [invalidTick, setInvalidTick] = useState(0);
  const [failedTick, setFailedTick] = useState(0);
  const disabled = invitation === null || pending;

  useEffect(() => {
    if (invalidTick === 0) return;
    const field = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
    field?.focus();
    field?.select();
  }, [invalidTick]);

  useEffect(() => {
    if (failedTick > 0) nameRef.current?.focus();
  }, [failedTick]);

  const validate = (): FieldErrors => {
    const found: FieldErrors = {};
    const parsedName = personNameSchema.safeParse(name);
    if (!parsedName.success) found.name = parsedName.error.issues[0]?.message ?? copy.name;
    const parsedPassword = newPasswordSchema.safeParse(password);
    if (!parsedPassword.success) {
      found.password = parsedPassword.error.issues[0]?.message ?? copy.password;
    }
    if (!repeat) found.repeat = t.form.repeatRequired;
    else if (repeat !== password) found.repeat = t.form.passwordsDiffer;
    return found;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || lock.locked) return;
    const found = validate();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setInvalidTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setError(null);
    setPending(true);
    try {
      const response = await endpoints.invitations.accept({ token, name: name.trim(), password });
      // Sesi baru (sesi lama di browser ini sudah dicabut server). Data pengguna sebelumnya
      // dibuang oleh `storeSession` bila akunnya berbeda.
      storeSession(queryClient, response);
      await router.navigate(
        response.status === 'authenticated'
          ? { to: '/inbox', replace: true }
          : { to: '/verifikasi-dua-langkah', search: { redirect: undefined }, replace: true },
      );
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
      {invitation?.twoFactorRequired ? (
        <Notice tone="info">{copy.twoFactor(USER_ROLE_LABELS[invitation.role])}</Notice>
      ) : null}
      <TextField
        size="lg"
        label={copy.email}
        hint={copy.emailHint}
        type="email"
        name="email"
        autoComplete="username"
        value={invitation?.email ?? ''}
        readOnly
        disabled={invitation === null}
      />
      <TextField
        ref={nameRef}
        size="lg"
        label={copy.name}
        hint={copy.nameHint}
        name="name"
        autoComplete="name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          clear('name');
        }}
        error={errors.name}
        disabled={disabled}
      />
      <div className={layout.passwordBlock}>
        <PasswordField
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
      <SubmitButton
        className={styles.submit}
        pending={pending}
        pendingLabel={copy.submitting}
        lock={lock}
        disabled={invitation === null}
      >
        {copy.submit}
      </SubmitButton>
      {/* Pesan server di bawah tombol: judul, isian, dan tombol tidak bergeser (kritikus W1). */}
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
