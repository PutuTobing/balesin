import { USER_ROLE_LABELS } from '@balesin/shared';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { queryKeys, twoFactorStatusQuery } from '../../lib/api/queries';
import { useSession } from '../auth/session';
import { EmailCard } from './EmailCard';
import { SessionsCard } from './SessionsCard';
import { BackupCodesCard, TwoFactorCard } from './SecurityCards';
import styles from './Security.module.css';

const copy = t.security;

/**
 * Pengaturan → Keamanan akun (semua peran): status 2FA, sisa kode cadangan, buat ulang kode
 * cadangan, menonaktifkan 2FA bagi peran yang tidak wajib, dan status verifikasi email akun. Status sudah dimuat loader rute
 * (dan biasanya sudah lebih dulu dari menu akun / Lainnya / Pengaturan).
 */
export function SecurityPage() {
  const session = useSession();
  const { data: status } = useSuspenseQuery(twoFactorStatusQuery);
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.twoFactorStatus });
  // Setelah 2FA dinonaktifkan, tombol pembukanya hilang: fokus ke pesan berhasil (bukan <body>).
  const noticeRef = useRef<HTMLDivElement>(null);
  const [focusNotice, setFocusNotice] = useState(0);
  useEffect(() => {
    if (focusNotice > 0) noticeRef.current?.focus();
  }, [focusNotice]);

  return (
    <Page>
      <div className={styles.content}>
        {notice ? (
          <div ref={noticeRef} tabIndex={-1} className={styles.noticeFocus}>
            <Notice tone="success" role="status">
              {notice}
            </Notice>
          </div>
        ) : null}
        <TwoFactorCard
          status={status}
          roleLabel={session ? USER_ROLE_LABELS[session.user.role] : ''}
          onDisabled={() => {
            setNotice(copy.disable.done);
            setFocusNotice((tick) => tick + 1);
            void refresh();
          }}
        />
        {status.enabled ? (
          <BackupCodesCard
            status={status}
            email={session?.user.email ?? ''}
            onRegenerated={() => {
              setNotice(null);
              void refresh();
            }}
          />
        ) : null}
        <EmailCard />
        {/* Paling bawah: panjangnya tergantung jumlah perangkat, kartu lain tidak ikut bergeser. */}
        <SessionsCard requireCode={status.enabled} />
      </div>
    </Page>
  );
}
