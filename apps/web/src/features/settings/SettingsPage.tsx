import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Bell,
  Building2,
  ChevronRight,
  Clock,
  ListTree,
  SmilePlus,
  BellRing,
  Database,
  Gauge,
  History,
  LayoutTemplate,
  KeyRound,
  Webhook,
  type LucideIcon,
  Mail,
  Mails,
  MessageSquareText,
  Palette,
  ShieldCheck,
  Smartphone,
  UsersRound,
} from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useEffect } from 'react';
import { defaultBrand, useBrand } from '../../brand/brand';
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
import { emailTemplatesQuery } from '../email-templates/email-template-queries';
import { connectorsQuery, telegramAlarmQuery } from '../broadcast/broadcast-queries';
import { usePushDevice } from '../notifications/use-push-device';
import { contactAttributesQuery } from '../contacts/contact-queries';
import { departmentsQuery } from '../departments/department-queries';
import { csatSettingsQuery } from '../reports/csat-queries';
import { workspaceQuery } from '../workspace/workspace-queries';
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
  const canWorkspace = useCan('settings.workspace.manage');
  const canBranding = useCan('organization.manage');

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
        canWebhooks ||
        canWorkspace ||
        canBranding ? (
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
            showWorkspace={canWorkspace}
            showBranding={canBranding}
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
  showWorkspace,
  showBranding,
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
  showWorkspace: boolean;
  showBranding: boolean;
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
        {showWorkspace ? <WorkspaceMenuItem /> : null}
        {showBranding ? <BrandingMenuItem /> : null}
        {showWorkspace ? <DepartmentsMenuItem /> : null}
        {showEmail ? <EmailMenuItem /> : null}
        {showTemplates ? <TemplatesMenuItem /> : null}
        {showTemplates ? <EmailTemplatesMenuItem /> : null}
        {showQuickReplies ? <QuickRepliesMenuItem /> : null}
        {showWorkspace ? <AttributesMenuItem /> : null}
        {showWorkspace ? <CsatMenuItem /> : null}
        {showSendingLimits ? <SendingLimitsMenuItem /> : null}
        {showApiKeys ? <ApiKeysMenuItem /> : null}
        {showWebhooks ? <WebhooksMenuItem /> : null}
        {showWebhooks ? <ConnectorsMenuItem /> : null}
        {showWebhooks ? <AlarmMenuItem /> : null}
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

/** Template email (tahap 9.1): jumlah yang sudah terbit dari semua template aktif. */
function EmailTemplatesMenuItem() {
  const list = useQuery(emailTemplatesQuery(false));
  const all = list.data?.templates;
  return (
    <MenuRow
      to="/pengaturan/template-email"
      icon={Mails}
      label={t.emailTemplates.title}
      hint={t.emailTemplates.menuHint}
      status={
        all
          ? t.emailTemplates.menuCount(
              all.filter((template) => template.publishedVersion !== null).length,
              all.length,
            )
          : null
      }
      loading={list.isPending}
    />
  );
}

/** Merek: disesuaikan atau masih bawaan (dari `GET /branding` publik — tanpa permintaan tambahan). */
function BrandingMenuItem() {
  const brand = useBrand();
  const custom =
    brand.productName !== defaultBrand.productName ||
    brand.mascotName !== defaultBrand.mascotName ||
    brand.logoUrl !== null ||
    brand.primaryColor !== null;
  return (
    <MenuRow
      to="/pengaturan/merek"
      icon={Palette}
      label={t.brandingSettings.title}
      hint={t.brandingSettings.menuHint}
      status={custom ? t.brandingSettings.menuCustom : t.brandingSettings.menuDefault}
      loading={false}
    />
  );
}

/** Jam kerja & alokasi: sedang di dalam / di luar jam kerja tim. */
function WorkspaceMenuItem() {
  const settings = useQuery(workspaceQuery);
  const data = settings.data?.settings;
  return (
    <MenuRow
      to="/pengaturan/jam-kerja"
      icon={Clock}
      label={t.workspace.title}
      hint={t.workspace.menuHint}
      status={
        data ? (data.withinTeamHoursNow ? t.workspace.menuOpen : t.workspace.menuClosed) : null
      }
      loading={settings.isPending}
    />
  );
}

/** Departemen: jumlah departemen. */
function DepartmentsMenuItem() {
  const list = useQuery(departmentsQuery);
  return (
    <MenuRow
      to="/pengaturan/departemen"
      icon={Building2}
      label={t.departments.title}
      hint={t.departments.menuHint}
      status={list.data ? t.departments.menuCount(list.data.departments.length) : null}
      loading={list.isPending}
    />
  );
}

/** Atribut kontak: jumlah definisi. */
function AttributesMenuItem() {
  const list = useQuery(contactAttributesQuery);
  return (
    <MenuRow
      to="/pengaturan/atribut-kontak"
      icon={ListTree}
      label={t.attributes.title}
      hint={t.attributes.menuHint}
      status={list.data ? t.attributes.menuCount(list.data.length) : null}
      loading={list.isPending}
    />
  );
}

/** CSAT otomatis: aktif / mati. */
function CsatMenuItem() {
  const settings = useQuery(csatSettingsQuery);
  const csat = settings.data?.csat;
  return (
    <MenuRow
      to="/pengaturan/csat"
      icon={SmilePlus}
      label={t.csat.title}
      hint={t.csat.menuHint}
      status={csat ? (csat.enabled ? t.csat.menuOn : t.csat.menuOff) : null}
      loading={settings.isPending}
    />
  );
}

/** Konektor data broadcast: jumlah konektor. */
function ConnectorsMenuItem() {
  const list = useQuery(connectorsQuery);
  return (
    <MenuRow
      to="/pengaturan/konektor-data"
      icon={Database}
      label={t.connectors.title}
      hint={t.connectors.menuHint}
      status={list.data ? t.connectors.menuCount(list.data.connectors.length) : null}
      loading={list.isPending}
    />
  );
}

/** Alarm Telegram: aktif / nonaktif / belum diatur. */
function AlarmMenuItem() {
  const alarm = useQuery(telegramAlarmQuery);
  const telegram = alarm.data?.telegram;
  return (
    <MenuRow
      to="/pengaturan/alarm"
      icon={BellRing}
      label={t.alarms.title}
      hint={t.alarms.menuHint}
      status={
        telegram
          ? !telegram.configured
            ? t.alarms.menuOff
            : telegram.enabled
              ? t.alarms.menuOn
              : t.alarms.menuPaused
          : null
      }
      loading={alarm.isPending}
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
  to:
    | '/pengaturan/api-key'
    | '/pengaturan/webhook'
    | '/pengaturan/template'
    | '/pengaturan/template-email'
    | '/pengaturan/konektor-data'
    | '/pengaturan/alarm'
    | '/pengaturan/atribut-kontak'
    | '/pengaturan/departemen'
    | '/pengaturan/jam-kerja'
    | '/pengaturan/merek'
    | '/pengaturan/csat';
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
