import {
  USER_ROLE_LABELS,
  type BackupCodes,
  type ConfirmTwoFactorEnrollmentResponse,
} from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandLogo } from '../../brand/BrandLogo';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { refetchSession, storeSession } from '../../lib/api/queries';
import { DEFAULT_AFTER_LOGIN, safeRedirectTarget } from '../../lib/safe-redirect';
import { usePageTitle } from '../../lib/use-page-title';
import { useAnySession, useLogout } from '../auth/session';
import { BackupCodesPanel } from './BackupCodesPanel';
import { EnrollmentSteps } from './Enrollment';
import styles from './TwoFactor.module.css';

const routeApi = getRouteApi('/verifikasi-dua-langkah');
const copy = t.twoFactor.enroll;

/**
 * Layar pendaftaran 2FA WAJIB (Owner/Admin/Supervisor yang belum mengaktifkannya): setelah
 * wizard setup, atau setelah masuk dengan sesi terbatas. Selain layar ini hanya "Keluar" yang
 * bisa dipakai; rute aplikasi lain dialihkan ke sini oleh penjaga rute.
 */
export function EnrollmentPage() {
  usePageTitle(copy.title);
  const session = useAnySession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const search = routeApi.useSearch();
  const target = safeRedirectTarget(search.redirect);
  // Kode cadangan hanya di state layar ini (tidak di cache Query), hilang saat layar ditutup.
  const [codes, setCodes] = useState<BackupCodes | null>(null);
  // Email dipegang terpisah: sesi di cache berganti (terbatas → penuh) saat 2FA aktif.
  const [email] = useState(() => session?.user.email ?? '');
  // Layar dibuka (setelah setup atau masuk): fokus ke judul, seperti langkah wizard.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const onConfirmed = (response: ConfirmTwoFactorEnrollmentResponse) => {
    // Sesi penuh baru + token CSRF baru (sesi terbatas sudah dicabut server). `storeSession`
    // hanya menyimpan bagian sesi; kode cadangan tidak ikut ke cache.
    storeSession(queryClient, response);
    setCodes(response.backupCodes);
  };

  // 2FA ternyata sudah aktif (tab lain): muat ulang sesi lalu lanjut seperti biasa.
  const onAlreadyEnabled = () => {
    void refetchSession(queryClient)
      .catch(() => null)
      .then(() => router.navigate({ href: target, replace: true }));
  };

  return (
    <EnrollmentFrame email={email} showLogout={codes === null}>
      {codes ? (
        <BackupCodesPanel
          codes={codes}
          email={email}
          variant="enrolled"
          headingLevel={1}
          continueLabel={
            target === DEFAULT_AFTER_LOGIN
              ? t.twoFactor.backupCodes.continueTo(t.nav.inbox)
              : t.twoFactor.login.backupUsed.continue
          }
          // Layar ditutup lewat navigasi: state (beserta kode) hilang saat komponen dilepas.
          // Jangan kosongkan `codes` dulu: langkah pendaftaran akan tampil lagi dan memulai
          // pendaftaran baru (409, 2FA sudah aktif).
          onDone={() => void router.navigate({ href: target, replace: true })}
        />
      ) : (
        <>
          <div className={styles.intro}>
            <p className={styles.eyebrow}>{copy.eyebrow}</p>
            <h1 ref={titleRef} tabIndex={-1} className={styles.title}>
              {copy.title}
            </h1>
            <p className={styles.introBody}>
              {copy.requiredBody(session ? USER_ROLE_LABELS[session.user.role] : '')}
            </p>
          </div>
          <EnrollmentSteps
            mode="required"
            onConfirmed={onConfirmed}
            onAlreadyEnabled={onAlreadyEnabled}
          />
        </>
      )}
    </EnrollmentFrame>
  );
}

/** Bingkai layar pendaftaran: logo + akun yang sedang masuk + Keluar, lalu kartu isi. */
export function EnrollmentFrame({
  email,
  showLogout,
  children,
}: {
  email: string;
  showLogout: boolean;
  children: ReactNode;
}) {
  const logout = useLogout();
  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <BrandLogo className={styles.topLogo} />
        {showLogout ? (
          <div className={styles.account}>
            {email ? <span className={styles.accountEmail}>{copy.signedInAs(email)}</span> : null}
            <Button variant="ghost" onClick={() => logout.mutate()} loading={logout.isPending}>
              {logout.isPending ? null : <Icon icon={LogOut} size={16} />}
              {logout.isPending ? t.auth.userMenu.loggingOut : t.auth.userMenu.logout}
            </Button>
          </div>
        ) : null}
      </header>
      <main className={styles.main}>
        <div className={styles.card}>
          {logout.isError ? (
            <Notice tone="danger" role="alert">
              {t.auth.userMenu.logoutFailed}
            </Notice>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}
