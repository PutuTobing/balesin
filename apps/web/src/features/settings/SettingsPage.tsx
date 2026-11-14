import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, History, Mail, ShieldCheck, UsersRound } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useBrand } from '../../brand/brand';
import { Icon } from '../../components/ui/Icon';
import { Page } from '../../components/ui/Page';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { parsePreference, type ResolvedTheme, type ThemePreference } from '../../theme/theme';
import { useTheme } from '../../theme/theme-context';
import { themeOptions } from '../../theme/theme-options';
import { useCan } from '../auth/session';
import { EmailStatusBadge } from '../email-settings/EmailStatusBadge';
import {
  emailSettingsQuery,
  invitationsQuery,
  teamUsersQuery,
  twoFactorStatusQuery,
} from '../../lib/api/queries';
import { TwoFactorBadge } from '../security/TwoFactorBadge';
import styles from './Settings.module.css';

const APPEARANCE_HEADING_ID = 'pengaturan-tampilan';
const ORGANIZATION_HEADING_ID = 'pengaturan-organisasi';
const ACCOUNT_HEADING_ID = 'pengaturan-akun';

/**
 * Pengaturan. Bagian lain (channel, peran, jam kerja, dan seterusnya) ditambahkan
 * bersama fiturnya masing-masing. Pengaturan organisasi tampil sesuai izin sesi (`permissions`):
 * Tim = `team.invite`, Email pengirim = `settings.email.manage` (keduanya Owner dan Admin); peran
 * lain tidak melihat menunya. Keamanan akun untuk semua peran.
 */
export function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const { productName } = useBrand();
  const canInvite = useCan('team.invite');
  const canManageTeam = useCan('team.manage');
  const canTeam = canInvite || canManageTeam;
  const canEmail = useCan('settings.email.manage');
  const canAudit = useCan('audit.view');

  return (
    <Page>
      <div className={styles.content}>
        {canTeam || canEmail || canAudit ? (
          <OrganizationSettings
            showTeam={canTeam}
            showEmail={canEmail}
            showAudit={canAudit}
            canInvite={canInvite}
            canManageTeam={canManageTeam}
          />
        ) : null}
        <AccountSettings />
        <section className={styles.card} aria-labelledby={APPEARANCE_HEADING_ID}>
          <div className={styles.cardHead}>
            <h2 id={APPEARANCE_HEADING_ID} className={styles.cardTitle}>
              {t.settings.appearance.title}
            </h2>
            <p className={styles.cardHint}>{t.settings.appearance.hint}</p>
          </div>
          <RadioGroup.Root
            className={styles.options}
            value={preference}
            onValueChange={(value) => setPreference(parsePreference(value))}
            aria-label={t.settings.appearance.themeLabel}
          >
            {themeOptions.map((option) => (
              <RadioGroup.Item key={option.value} value={option.value} className={styles.option}>
                <ThemePreview preference={option.value} />
                <span className={styles.optionLabel}>
                  <span className={styles.radio}>
                    <RadioGroup.Indicator className={styles.radioDot} />
                  </span>
                  {option.label}
                </span>
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </section>
        <p className={styles.about}>{t.common.version(productName, __APP_VERSION__)}</p>
      </div>
    </Page>
  );
}

/** Miniatur kerangka aplikasi dalam tema yang dipilih; "Ikuti sistem" = separuh-separuh. */
function ThemePreview({ preference }: { preference: ThemePreference }) {
  return (
    <span className={styles.preview} aria-hidden="true">
      {preference === 'system' ? (
        <>
          <Scene theme="light" />
          <Scene theme="dark" split />
        </>
      ) : (
        <Scene theme={preference} />
      )}
    </span>
  );
}

function Scene({ theme, split = false }: { theme: ResolvedTheme; split?: boolean }) {
  return (
    // `data-theme` memaksa warna token tema itu di dalam miniatur, apa pun tema aplikasi.
    <span data-theme={theme} className={cx(styles.scene, split && styles.sceneSplit)}>
      <span className={styles.sceneRail}>
        <span className={styles.sceneMark} />
      </span>
      <span className={styles.sceneList}>
        <span className={styles.sceneLine} />
        <span className={styles.sceneLine} />
        <span className={styles.sceneLine} />
      </span>
      <span className={styles.sceneChat}>
        <span className={styles.sceneIn} />
        <span className={styles.sceneOut} />
        <span className={styles.sceneIn} />
      </span>
    </span>
  );
}

/**
 * Menu pengaturan organisasi sesuai izin (Tim, Email pengirim), lengkap dengan status tiap baris.
 */
function OrganizationSettings({
  showTeam,
  showEmail,
  showAudit,
  canInvite,
  canManageTeam,
}: {
  showTeam: boolean;
  showEmail: boolean;
  showAudit: boolean;
  canInvite: boolean;
  canManageTeam: boolean;
}) {
  return (
    <section className={styles.card} aria-labelledby={ORGANIZATION_HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={ORGANIZATION_HEADING_ID} className={styles.cardTitle}>
          {t.settingsMenu.sectionTitle}
        </h2>
      </div>
      <ul className={styles.menu}>
        {showTeam ? <TeamMenuItem canInvite={canInvite} canManage={canManageTeam} /> : null}
        {showEmail ? <EmailMenuItem /> : null}
        {showAudit ? <AuditMenuItem /> : null}
      </ul>
    </section>
  );
}

function TeamMenuItem({ canInvite, canManage }: { canInvite: boolean; canManage: boolean }) {
  const team = useQuery({ ...invitationsQuery, enabled: canInvite });
  const users = useQuery({ ...teamUsersQuery, enabled: canManage });
  const parts = [
    canManage && users.data ? t.team.menuMembers(users.data.users.length) : null,
    canInvite && team.data ? t.team.menuStatus(team.data.invitations.length) : null,
  ]
    .filter((part) => part !== null)
    // "3 anggota · belum ada undangan terbuka": bagian kedua di tengah kalimat.
    .map((part, index) =>
      index === 0 ? part : part.charAt(0).toLocaleLowerCase('id-ID') + part.slice(1),
    );
  const loading = (canInvite && team.isPending) || (canManage && users.isPending);
  return (
    <li>
      <Link to="/pengaturan/tim" className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={UsersRound} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{t.team.title}</span>
          <span className={styles.menuHint}>{t.team.menuHint}</span>
        </span>
        <span className={styles.menuStatus}>
          {loading ? (
            <Skeleton className={styles.statusSkeleton} />
          ) : parts.length > 0 ? (
            <span className={styles.menuCount}>{parts.join(' · ')}</span>
          ) : null}
        </span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}

function EmailMenuItem() {
  const email = useQuery(emailSettingsQuery);
  return (
    <li>
      <Link to="/pengaturan/email" className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={Mail} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{t.emailSettings.title}</span>
          <span className={styles.menuHint}>{t.emailSettings.menuHint}</span>
        </span>
        <span className={styles.menuStatus}>
          {email.data ? (
            <>
              <EmailStatusBadge status={email.data.status} />
              {email.data.status === 'not_configured' ? (
                <>
                  {/* Titik pemisah sendiri: jarak sama di kedua sisi (gap), warna netral. */}
                  <span className={styles.statusSeparator} aria-hidden="true">
                    ·
                  </span>
                  <span className={styles.setUpNow}>{t.emailSettings.setUpNow}</span>
                </>
              ) : null}
            </>
          ) : email.isPending ? (
            <Skeleton className={styles.statusSkeleton} />
          ) : null}
        </span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}

function AuditMenuItem() {
  return (
    <li>
      <Link to="/pengaturan/audit" className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={History} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{t.audit.title}</span>
          <span className={styles.menuHint}>{t.audit.menuHint}</span>
        </span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}

/** Menu akun pengguna sendiri (semua peran): Keamanan akun dengan status 2FA. */
function AccountSettings() {
  const status = useQuery(twoFactorStatusQuery);
  return (
    <section className={styles.card} aria-labelledby={ACCOUNT_HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={ACCOUNT_HEADING_ID} className={styles.cardTitle}>
          {t.security.sectionTitle}
        </h2>
      </div>
      <ul className={styles.menu}>
        <li>
          <Link to="/pengaturan/keamanan" className={styles.menuLink}>
            <span className={styles.menuIcon}>
              <Icon icon={ShieldCheck} size={20} />
            </span>
            <span className={styles.menuText}>
              <span className={styles.menuLabel}>{t.security.title}</span>
              <span className={styles.menuHint}>{t.security.menuHint}</span>
            </span>
            <span className={styles.menuStatus}>
              {status.data ? (
                <TwoFactorBadge enabled={status.data.enabled} />
              ) : status.isPending ? (
                <Skeleton className={styles.statusSkeleton} />
              ) : null}
            </span>
            <Icon icon={ChevronRight} size={16} className={styles.chevron} />
          </Link>
        </li>
      </ul>
    </section>
  );
}
