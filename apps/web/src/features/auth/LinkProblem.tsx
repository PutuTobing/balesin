import { Link } from '@tanstack/react-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import type { Lock } from '../../lib/use-lock';
import { AuthLayout } from './AuthLayout';
import layout from './AuthLayout.module.css';

/**
 * Layar penjelasan di halaman tautan email: tautan tidak lengkap, tidak berlaku (410), atau belum
 * bisa diperiksa. Pesan server tampil apa adanya; di bawahnya langkah berikutnya sebagai tombol.
 * Judul difokus saat layar ini muncul supaya pembaca layar langsung membacanya.
 */
export function LinkProblem({
  documentTitle,
  title,
  message,
  tall = false,
  children,
}: {
  documentTitle: string;
  title: string;
  message: string;
  /** Halaman form panjang (undangan, atur ulang): posisi kolom sama dengan kerangkanya. */
  tall?: boolean;
  /** Tombol langkah berikutnya (utama dulu). */
  children: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [title, message]);
  return (
    <AuthLayout
      documentTitle={documentTitle}
      title={title}
      subtitle={message}
      titleRef={titleRef}
      tall={tall}
    >
      <div className={layout.actions}>{children}</div>
    </AuthLayout>
  );
}

/** Tombol ke halaman masuk (utama atau sekunder). */
export function ToLoginButton({ variant = 'primary' }: { variant?: 'primary' | 'secondary' }) {
  return (
    <Button asChild variant={variant} size="lg">
      <Link to="/masuk">{t.links.toLogin}</Link>
    </Button>
  );
}

/**
 * Pemeriksaan tautan gagal karena masalah sementara (jaringan, server, 429): "Coba lagi" (terkunci
 * dengan hitung mundur `m:ss` selama 429) + ke halaman masuk.
 */
export function LinkFailed({
  documentTitle,
  error,
  lock,
  onRetry,
  tall = false,
}: {
  documentTitle: string;
  error: unknown;
  lock: Lock;
  onRetry: () => void;
  tall?: boolean;
}) {
  const limited = isApiError(error) && error.status === 429;
  return (
    <LinkProblem
      documentTitle={documentTitle}
      title={limited ? t.links.lockedTitle : t.links.failedTitle}
      message={isApiError(error) ? error.message : t.api.network}
      tall={tall}
    >
      <SubmitButton type="button" onClick={onRetry} pending={false} pendingLabel="" lock={lock}>
        {t.common.retry}
      </SubmitButton>
      <ToLoginButton variant="secondary" />
    </LinkProblem>
  );
}
