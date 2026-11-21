import type { BackupCodes, ConfirmTwoFactorEnrollmentResponse } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { queryKeys, storeSession } from '../../lib/api/queries';
import { useSession } from '../auth/session';
import { BackupCodesPanel } from './BackupCodesPanel';
import { EnrollmentSteps } from './Enrollment';
import styles from './TwoFactor.module.css';

/**
 * Keamanan akun → Aktifkan verifikasi dua langkah, untuk peran yang tidak wajib (CS, Teknisi).
 * Sama dengan pendaftaran wajib, ditambah konfirmasi password karena sesinya sesi penuh.
 */
export function VoluntaryEnrollmentPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [codes, setCodes] = useState<BackupCodes | null>(null);
  const [email] = useState(() => session?.user.email ?? '');

  const backToSecurity = () => void router.navigate({ to: '/pengaturan/keamanan', replace: true });

  const onConfirmed = (response: ConfirmTwoFactorEnrollmentResponse) => {
    // Sesi lama dicabut server: pakai sesi + token CSRF baru (tanpa kode cadangan di cache).
    storeSession(queryClient, response);
    void queryClient.invalidateQueries({ queryKey: queryKeys.twoFactorStatus });
    setCodes(response.backupCodes);
  };

  return (
    <Page>
      <div className={styles.inPage}>
        {codes ? (
          <BackupCodesPanel
            codes={codes}
            email={email}
            variant="enrolled"
            headingLevel={2}
            continueLabel={t.twoFactor.backupCodes.done}
            // Kode hilang bersama komponen saat pindah halaman (tanpa menampilkan form lagi).
            onDone={backToSecurity}
          />
        ) : (
          <>
            <p className={styles.introBody}>{t.twoFactor.enroll.voluntaryBody}</p>
            <EnrollmentSteps
              mode="voluntary"
              onConfirmed={onConfirmed}
              onAlreadyEnabled={backToSecurity}
            />
          </>
        )}
      </div>
    </Page>
  );
}
