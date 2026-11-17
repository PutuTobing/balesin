import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Bell,
  ChevronRight,
  Gauge,
  History,
  LayoutTemplate,
  KeyRound,
  Webhook,
  type LucideIcon,
  Mail,
  MessageSquareText,
  ShieldCheck,
  Smartphone,
  UsersRound,
} from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useEffect } from 'react';
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
import { endpoints } from '../../lib/api/endpoints';
import { quickRepliesKey } from '../quick-replies/quick-replies-key';
import { EmailStatusBadge } from '../email-settings/EmailStatusBadge';
import { ChannelsMenuStatus } from '../channels/ChannelsMenuStatus';
import {
  channelSettingsQuery,
  emailSettingsQuery,
  emailVerificationQuery,
  sessionsQuery,
  invitationsQuery,
  teamUsersQuery,
  twoFactorStatusQuery,
} from '../../lib/api/queries';
import { TwoFactorBadge } from '../security/TwoFactorBadge';
import { sendingLimitsQuery } from '../inbox/inbox-queries';
import { integrationKeys } from '../integrations/integration-queries';
import { templatesQuery } from '../templates/template-queries';
import { usePushDevice } from '../notifications/use-push-device';
import styles from './Settings.module.css';

const APPEARANCE_HEADING_ID = 'pengaturan-tampilan';
const ORGANIZATION_HEADING_ID = 'pengaturan-organisasi';
const ACCOUNT_HEADING_ID = 'pengaturan-akun';

/**
 * Pengaturan. Bagian lain (peran, jam kerja, dan seterusnya) ditambahkan bersama fiturnya
 * masing-masing. Pengaturan organisasi tampil sesuai izin sesi (`permissions`): Channel =
 * `channels.manage`, Tim = `team.invite`, Email pengirim = `settings.email.manage` (keduanya Owner dan Admin); peran
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
  const canChannels = useCan('channels.manage');
  const canQuickReplies = useCan('quick_replies.manage');
  const canSendingLimits = useCan('sending.limits.manage');
  const canApiKeys = useCan('api_keys.manage');
  const canWebhooks = useCan('integrations.manage');
  const canTemplates = useCan('templates.manage');

  return (
    <Page>
      <div className={styles.content}>
        {canChannels ||
        canTeam ||
        canEmail ||
        canAudit ||
        canQuickReplies ||
        canTemplates ||
        canSendingLimits ||
        canApiKeys ||
        canWebhooks ? (
          <OrganizationSettings
            showChannels={canChannels}
            showTeam={canTeam}
            showEmail={canEmail}
            showAudit={canAudit}
            showQuickReplies={canQuickReplies}
            showTemplates={canTemplates}
            showSendingLimits={canSendingLimits}
            showApiKeys={canApiKeys}
            showWebhooks={canWebhooks}
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
  showChannels,
  showTeam,
  showEmail,
  showAudit,
  showQuickReplies,
  showTemplates,
  showSendingLimits,
  showApiKeys,
  showWebhooks,
  canInvite,
  canManageTeam,
}: {
  showChannels: boolean;
  showTeam: boolean;
  showEmail: boolean;
  showAudit: boolean;
  showQuickReplies: boolean;
  showTemplates: boolean;
  showSendingLimits: boolean;
  showApiKeys: boolean;
  showWebhooks: boolean;
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
        {showChannels ? <ChannelsMenuItem /> : null}
        {showTeam ? <TeamMenuItem canInvite={canInvite} canManage={canManageTeam} /> : null}
        {showEmail ? <EmailMenuItem /> : null}
        {showTemplates ? <TemplatesMenuItem /> : null}
        {showQuickReplies ? <QuickRepliesMenuItem /> : null}
        {showSendingLimits ? <SendingLimitsMenuItem /> : null}
        {showApiKeys ? <ApiKeysMenuItem /> : null}
        {showWebhooks ? <WebhooksMenuItem /> : null}
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

/** Channel: jumlah nomor + status terburuk (Gagal > Belum dites > Terhubung). */
function ChannelsMenuItem() {
  const channels = useQuery(channelSettingsQuery);
  return (
    <li>
      <Link to="/pengaturan/channel" className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={Smartphone} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{t.channels.title}</span>
          <span className={styles.menuHint}>{t.channels.menuHint}</span>
        </span>
        <span className={styles.menuStatus}>
          {channels.data ? (
            <ChannelsMenuStatus channels={channels.data.channels} />
          ) : channels.isPending ? (
            <Skeleton className={styles.statusSkeleton} />
          ) : null}
        </span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}

/** Balasan cepat `/`: jumlah balasan. */
function QuickRepliesMenuItem() {
  const list = useQuery({
    queryKey: [...quickRepliesKey, ''],
    queryFn: ({ signal }) => endpoints.quickReplies.list(null, signal),
  });
  return (
    <li>
      <Link to="/pengaturan/balasan-cepat" className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={MessageSquareText} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{t.quickReplies.title}</span>
          <span className={styles.menuHint}>{t.quickReplies.menuHint}</span>
        </span>
        <span className={styles.menuStatus}>
          {list.data ? (
            <span className={styles.menuCount}>
              {t.quickReplies.menuCount(list.data.quickReplies.length)}
            </span>
          ) : list.isPending ? (
            <Skeleton className={styles.statusSkeleton} />
          ) : null}
        </span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}

/** Template WhatsApp (Meta): jumlah disetujui dari seluruhnya. */
function TemplatesMenuItem() {
  const list = useQuery(templatesQuery);
  const all = list.data?.templates;
  return (
    <MenuRow
      to="/pengaturan/template"
      icon={LayoutTemplate}
      label={t.templates.title}
      hint={t.templates.menuHint}
      status={
        all
          ? t.templates.menuCount(
              all.filter((template) => template.status === 'APPROVED').length,
              all.length,
            )
          : null
      }
      loading={list.isPending}
    />
  );
}

/** API key: jumlah key aktif. */
function ApiKeysMenuItem() {
  const list = useQuery({
    queryKey: integrationKeys.apiKeys,
    queryFn: ({ signal }) => endpoints.apiKeys.list(signal),
  });
  const active = list.data?.apiKeys.filter((key) => key.status === 'active').length;
  return (
    <MenuRow
      to="/pengaturan/api-key"
      icon={KeyRound}
      label={t.apiKeys.title}
      hint={t.apiKeys.menuHint}
      status={active === undefined ? null : t.apiKeys.menuCount(active)}
      loading={list.isPending}
    />
  );
}

/** Webhook keluar: jumlah webhook. */
function WebhooksMenuItem() {
  const list = useQuery({
    queryKey: integrationKeys.webhooks,
    queryFn: ({ signal }) => endpoints.webhooks.list(signal),
  });
  return (
    <MenuRow
      to="/pengaturan/webhook"
      icon={Webhook}
      label={t.webhooks.title}
      hint={t.webhooks.menuHint}
      status={list.data ? t.webhooks.menuCount(list.data.webhooks.length) : null}
      loading={list.isPending}
    />
  );
}

function MenuRow({
  to,
  icon,
  label,
  hint,
  status,
  loading,
}: {
  to: '/pengaturan/api-key' | '/pengaturan/webhook' | '/pengaturan/template';
  icon: LucideIcon;
  label: string;
  hint: string;
  status: string | null;
  loading: boolean;
}) {
  return (
    <li>
      <Link to={to} className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={icon} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{label}</span>
          <span className={styles.menuHint}>{hint}</span>
        </span>
        <span className={styles.menuStatus}>
          {status ? (
            <span className={styles.menuCount}>{status}</span>
          ) : loading ? (
            <Skeleton className={styles.statusSkeleton} />
          ) : null}
        </span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}

/** Batas kirim: pesan 24 jam, atau "Rem darurat ditarik" (merah) saat pengiriman dihentikan. */
function SendingLimitsMenuItem() {
  const limits = useQuery(sendingLimitsQuery);
  const data = limits.data?.limits;
  return (
    <li>
      <Link to="/pengaturan/batas-kirim" className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={Gauge} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{t.sendingLimits.title}</span>
          <span className={styles.menuHint}>{t.sendingLimits.menuHint}</span>
        </span>
        <span className={styles.menuStatus}>
          {data ? (
            data.paused ? (
              <span className={styles.menuDanger}>
                <span className={styles.dangerDot} aria-hidden="true" />
                {t.sendingLimits.menuPaused}
              </span>
            ) : (
              <span className={styles.menuCount}>
                {t.sendingLimits.menuRunning(data.sentLast24Hours)}
              </span>
            )
          ) : limits.isPending ? (
            <Skeleton className={styles.statusSkeleton} />
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
  const canNotifications = useCan('inbox.view');
  const queryClient = useQueryClient();
  // Data Keamanan akun dimuat lebih dulu (seperti undangan & anggota untuk baris Tim): dibuka dari
  // menu, halamannya langsung tampil tanpa kerangka. Gagal di sini tidak apa-apa; halamannya
  // memuat ulang sendiri.
  useEffect(() => {
    void queryClient.prefetchQuery(emailVerificationQuery);
    void queryClient.prefetchQuery(sessionsQuery);
  }, [queryClient]);
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
        {canNotifications ? <NotificationsMenuItem /> : null}
      </ul>
    </section>
  );
}

/** Notifikasi: keadaan di perangkat INI (izin browser + langganan). */
function NotificationsMenuItem() {
  const device = usePushDevice();
  const label =
    device.support !== 'supported'
      ? null
      : device.permission === 'denied'
        ? t.notifications.menuBlocked
        : device.subscribed === null
          ? null
          : device.subscribed
            ? t.notifications.menuOn
            : t.notifications.menuOff;
  return (
    <li>
      <Link to="/pengaturan/notifikasi" className={styles.menuLink}>
        <span className={styles.menuIcon}>
          <Icon icon={Bell} size={20} />
        </span>
        <span className={styles.menuText}>
          <span className={styles.menuLabel}>{t.notifications.title}</span>
          <span className={styles.menuHint}>{t.notifications.menuHint}</span>
        </span>
        <span className={styles.menuStatus}>
          {label ? <span className={styles.menuCount}>{label}</span> : null}
        </span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}
