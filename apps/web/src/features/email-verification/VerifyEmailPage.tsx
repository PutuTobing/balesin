import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { queryKeys } from '../../lib/api/queries';
import { useLinkToken } from '../../lib/link-token';
import { useLock } from '../../lib/use-lock';
import { AuthLayout } from '../auth/AuthLayout';
import layout from '../auth/AuthLayout.module.css';
import { LinkFailed, LinkProblem, ToLoginButton } from '../auth/LinkProblem';
import { useAnySession } from '../auth/session';
import { linkInvalidMessage, type LinkState } from '../auth/use-link-inspect';

const copy = t.verifyEmail;

/**
 * `/verifikasi-email#token=…` (publik, tidak perlu sedang masuk): token dibaca + dibuang dari
 * alamat, lalu langsung dikirim SEKALI ke server (tautan sekali pakai; StrictMode menjalankan efek
 * dua kali, jadi dijaga dengan ref).
 */
export function VerifyEmailPage() {
  const token = useLinkToken();
  // Tautan lain dibuka di tab ini: verifikasi dimulai dari awal untuk token baru.
  return <VerifyLink key={token ?? ''} token={token} />;
}

function VerifyLink({ token }: { token: string | null }) {
  const queryClient = useQueryClient();
  const session = useAnySession();
  const signedIn = session?.status === 'authenticated';
  const [state, setState] = useState<LinkState<{ email: string }>>(
    token ? { kind: 'loading' } : { kind: 'missing' },
  );
  const lock = useLock();
  const { lockFor } = lock;
  const started = useRef(false);

  const verify = useCallback(
    (value: string) => {
      endpoints.emailVerification.verify(value).then(
        (response) => {
          setState({ kind: 'ready', data: { email: response.email } });
          // Status di Keamanan akun (bila sedang masuk) dimuat ulang saat dibuka lagi.
          void queryClient.invalidateQueries({ queryKey: queryKeys.emailVerification });
        },
        (error: unknown) => {
          const invalid = linkInvalidMessage(error);
          if (invalid !== null) {
            setState({ kind: 'invalid', message: invalid });
            return;
          }
          if (isApiError(error) && error.status === 429 && error.retryAfterSeconds) {
            lockFor(error.retryAfterSeconds);
          }
          setState({ kind: 'failed', error });
        },
      );
    },
    [queryClient, lockFor],
  );

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    verify(token);
  }, [token, verify]);

  const next = signedIn ? (
    <Button asChild variant="primary" size="lg">
      <Link to="/pengaturan/keamanan">{copy.toSecurity}</Link>
    </Button>
  ) : (
    <ToLoginButton />
  );

  switch (state.kind) {
    case 'missing':
    case 'invalid':
      return (
        <LinkProblem
          documentTitle={copy.title}
          title={copy.invalidTitle}
          message={state.kind === 'missing' ? copy.missing : state.message}
        >
          {next}
        </LinkProblem>
      );
    case 'failed':
      return (
        <LinkFailed
          documentTitle={copy.title}
          error={state.error}
          lock={lock}
          onRetry={() => {
            if (!token) return;
            setState({ kind: 'loading' });
            verify(token);
          }}
        />
      );
    case 'ready':
      return (
        <LinkProblem
          documentTitle={copy.title}
          title={copy.doneTitle}
          message={copy.done(state.data.email)}
        >
          {signedIn ? (
            <Button asChild variant="primary" size="lg">
              <Link to="/inbox">{copy.toApp}</Link>
            </Button>
          ) : (
            <ToLoginButton />
          )}
        </LinkProblem>
      );
    case 'loading':
      return (
        <AuthLayout documentTitle={copy.title} loading={{ subtitleLines: 2 }}>
          <div className={layout.actions}>
            <Skeleton className={layout.skeletonButton} />
          </div>
        </AuthLayout>
      );
  }
}
