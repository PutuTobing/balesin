import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppShell } from '../components/shell/AppShell';
import { BootErrorScreen, BootScreen } from '../components/shell/BootScreen';
import { NotFoundPage } from '../components/shell/NotFoundPage';
import { PageSkeleton } from '../components/shell/PageSkeleton';
import { RootLayout } from '../components/shell/RootLayout';
import { RouteErrorScreen } from '../components/shell/RouteErrorScreen';
import {
  ForgotPasswordPending,
  InvitationPending,
  ResetPasswordPending,
  VerifyEmailPending,
} from '../features/auth/AuthPending';
import { LoginSkeleton } from '../features/auth/LoginSkeleton';
import { parseLoginSearch } from '../features/auth/login-search';
import { ChannelDetailSkeleton, ChannelsSkeleton } from '../features/channels/ChannelsSkeleton';
import { EmailSettingsSkeleton } from '../features/email-settings/EmailSettingsSkeleton';
import { InboxPage } from '../features/inbox/InboxPage';
import { InboxSkeleton } from '../features/inbox/InboxSkeleton';
import { parseInboxSearch } from '../features/inbox/inbox-search';
import { parseContactSearch } from '../features/contacts/contact-search';
import { MailSkeleton } from '../features/mail/MailSkeleton';
import { parseMailLinkWarningSearch } from '../features/mail/mail-link-warning';
import {
  parseMailAccountSearch,
  parseMailAccountsSearch,
  parseMailSearch,
} from '../features/mail/mail-search';
import { parseTicketSearch } from '../features/tickets/ticket-search';
import { SecuritySkeleton } from '../features/security/SecuritySkeleton';
import { SetupSkeleton } from '../features/setup/SetupSkeleton';
import { SetupStatusError } from '../features/setup/SetupStatusError';
import { TeamSkeleton } from '../features/team/TeamSkeleton';
import { TeamUserSkeleton } from '../features/team-user/TeamUserSkeleton';
import { AuditSkeleton } from '../features/audit/AuditSkeleton';
import { parseAuditSearch } from '../features/audit/audit-search';
import { parseEmailOutboundSearch } from '../features/integrations/email-outbound-search';
import { sessionCan } from '../features/auth/session';
import { isChannelId } from '../features/channels/channel-status';
import { EnrollmentSkeleton } from '../features/two-factor/EnrollmentSkeleton';
import { t } from '../i18n/id';
import {
  channelQuery,
  channelSettingsQuery,
  channelWebhookQuery,
  emailSettingsQuery,
  emailVerificationQuery,
  invitationsQuery,
  sessionsQuery,
  teamUserQuery,
  teamUsersQuery,
  twoFactorStatusQuery,
  userAuditQuery,
  userSessionsQuery,
} from '../lib/api/queries';
import { navPermission } from '../components/shell/nav-items';
import { createPreviewRoutes } from './preview-routes';
import {
  guardAnyPermission,
  guardNavRoute,
  guardEnrollment,
  guardLogin,
  guardMail,
  guardPermission,
  guardSetup,
  guardVoluntaryEnrollment,
  prepareApp,
  preparePublicLink,
  requireSession,
} from './guards';

export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Peta rute. Alamat halaman memakai bahasa Indonesia karena ikut tampil ke pengguna.
 *
 * - Publik: `/setup` (wizard pertama kali), `/masuk`, `/lupa-password`, dan halaman tujuan tautan
 *   email bertoken (`/undangan`, `/atur-ulang-password`, `/verifikasi-email`; token di fragment).
 * - `/verifikasi-dua-langkah`: pendaftaran 2FA wajib, HANYA untuk sesi terbatas (Owner/Admin/
 *   Supervisor yang belum mengaktifkan 2FA). Sesi terbatas tidak bisa membuka rute lain.
 * - Semua rute lain ada di bawah layout `app`, yang mewajibkan sesi penuh (lihat `guards.ts`).
 *   Penjaga menunggu jawaban `/auth/me` SEBELUM merender apa pun, jadi tidak ada kedipan
 *   layar aplikasi untuk tamu atau layar masuk untuk pengguna yang sudah masuk.
 *
 * `staticData.page` = judul dan layar induk halaman satu kolom, dipakai `Page` dan
 * `PageSkeleton` (lihat components/ui/page-meta.ts).
 */
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  beforeLoad: ({ context }) => prepareApp(context.queryClient),
  // Saat sesi/status setup diperiksa di muatan pertama: layar netral (belum diketahui apakah
  // berikutnya aplikasi, halaman masuk, atau wizard).
  pendingComponent: BootScreen,
  notFoundComponent: NotFoundPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'setup',
  beforeLoad: ({ context }) => guardSetup(context.queryClient),
  component: lazyRouteComponent(() => import('../features/setup/SetupPage'), 'SetupPage'),
  pendingComponent: SetupSkeleton,
  errorComponent: SetupStatusError,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'masuk',
  validateSearch: parseLoginSearch,
  beforeLoad: ({ context, search }) => guardLogin(context.queryClient, search.redirect),
  component: lazyRouteComponent(() => import('../features/auth/LoginPage'), 'LoginPage'),
  pendingComponent: LoginSkeleton,
});

/** Lupa password: minta tautan atur ulang lewat email (publik). */
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'lupa-password',
  component: lazyRouteComponent(
    () => import('../features/password-reset/ForgotPasswordPage'),
    'ForgotPasswordPage',
  ),
  pendingComponent: ForgotPasswordPending,
});

/**
 * Halaman tujuan tautan email bertoken. Token dibaca dari fragment lalu langsung dibuang dari
 * alamat (`lib/link-token.ts`); tidak pernah ikut `?redirect=` atau penjaga rute.
 */
const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'undangan',
  beforeLoad: ({ context }) => preparePublicLink(context.queryClient),
  component: lazyRouteComponent(
    () => import('../features/invitation/InvitationPage'),
    'InvitationPage',
  ),
  pendingComponent: InvitationPending,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'atur-ulang-password',
  component: lazyRouteComponent(
    () => import('../features/password-reset/ResetPasswordPage'),
    'ResetPasswordPage',
  ),
  pendingComponent: ResetPasswordPending,
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'verifikasi-email',
  beforeLoad: ({ context }) => preparePublicLink(context.queryClient),
  component: lazyRouteComponent(
    () => import('../features/email-verification/VerifyEmailPage'),
    'VerifyEmailPage',
  ),
  pendingComponent: VerifyEmailPending,
});

/** Pendaftaran 2FA wajib (sesi terbatas): setelah setup, atau setelah masuk tanpa 2FA aktif. */
const enrollmentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'verifikasi-dua-langkah',
  validateSearch: parseLoginSearch,
  beforeLoad: ({ context, search }) => guardEnrollment(context.queryClient, search.redirect),
  component: lazyRouteComponent(
    () => import('../features/two-factor/EnrollmentPage'),
    'EnrollmentPage',
  ),
  pendingComponent: EnrollmentSkeleton,
  errorComponent: BootErrorScreen,
});

/** Layout aplikasi (rail/navigasi bawah). Hanya untuk pengguna yang sudah masuk. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
  component: AppShell,
  pendingComponent: BootScreen,
  pendingMs: 400,
  errorComponent: BootErrorScreen,
});

const getParentRoute = () => appRoute;

const indexRoute = createRoute({
  getParentRoute,
  path: '/',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/inbox', replace: true });
  },
});

const inboxRoute = createRoute({
  getParentRoute,
  path: 'inbox',
  validateSearch: parseInboxSearch,
  component: InboxPage,
  pendingComponent: InboxSkeleton,
});

/**
 * Menu Email (Fase 9, KONTRAK-API-EMAIL): kolom folder + daftar + panel baca. Hanya bila sesi
 * `navigation.mail` (punya akun yang bisa diakses atau boleh menghubungkan akun).
 */
const mailRoute = createRoute({
  getParentRoute,
  path: 'email',
  validateSearch: parseMailSearch,
  beforeLoad: ({ context }) => guardMail(context.session),
  component: lazyRouteComponent(() => import('../features/mail/MailPage'), 'MailPage'),
  pendingComponent: MailSkeleton,
});

/**
 * Peringatan tautan menipu dari email (`MAIL_LINK_WARNING_PATH`, kontrak §8 `link_mismatch`): hanya
 * menampilkan tujuan asli (http/https saja), tanpa pengalihan otomatis.
 */
const mailLinkWarningRoute = createRoute({
  getParentRoute,
  path: 'email/tautan',
  validateSearch: parseMailLinkWarningSearch,
  component: lazyRouteComponent(
    () => import('../features/mail/MailLinkWarningPage'),
    'MailLinkWarningRoute',
  ),
});

const contactsRoute = createRoute({
  getParentRoute,
  path: 'kontak',
  staticData: { page: { title: t.nav.contacts } },
  validateSearch: parseContactSearch,
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/kontak')),
  component: lazyRouteComponent(() => import('../features/contacts/ContactsPage'), 'ContactsPage'),
});

/** Kontak → impor CSV/XLSX (`contacts.export`). Rute statis ini menang atas `$contactId`. */
const contactImportRoute = createRoute({
  getParentRoute,
  path: 'kontak/impor',
  staticData: { page: { title: t.contacts.importTitle, parent: 'contacts' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'contacts.export'),
  component: lazyRouteComponent(
    () => import('../features/contacts/ContactImportPage'),
    'ContactImportPage',
  ),
});

/** Kontak → detail (data, atribut, tag, tiket, gabung duplikat, data pribadi). */
const contactRoute = createRoute({
  getParentRoute,
  path: 'kontak/$contactId',
  staticData: { page: { title: t.contacts.detailTitle, parent: 'contacts' } },
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/kontak')),
  component: lazyRouteComponent(
    () => import('../features/contacts/ContactDetailPage'),
    'ContactDetailPage',
  ),
});

const broadcastRoute = createRoute({
  getParentRoute,
  path: 'broadcast',
  staticData: { page: { title: t.nav.broadcast } },
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/broadcast')),
  component: lazyRouteComponent(
    () => import('../features/broadcast/BroadcastPage'),
    'BroadcastPage',
  ),
});

/** Broadcast → kampanye baru (wizard; draf dibuat di langkah pertama). */
const broadcastNewRoute = createRoute({
  getParentRoute,
  path: 'broadcast/baru',
  staticData: { page: { title: t.broadcast.newTitle, parent: 'broadcast' } },
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/broadcast')),
  component: lazyRouteComponent(
    () => import('../features/broadcast/BroadcastCampaignPage'),
    'BroadcastNewPage',
  ),
});

/** Broadcast → satu kampanye: draf = wizard, selainnya = detail (progres, laporan, penerima). */
const broadcastCampaignRoute = createRoute({
  getParentRoute,
  path: 'broadcast/$broadcastId',
  staticData: { page: { title: t.broadcast.detailTitle, parent: 'broadcast' } },
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/broadcast')),
  component: lazyRouteComponent(
    () => import('../features/broadcast/BroadcastCampaignPage'),
    'BroadcastCampaignPage',
  ),
});

const ticketsRoute = createRoute({
  getParentRoute,
  path: 'tiket',
  staticData: { page: { title: t.nav.tickets, parent: 'more' } },
  validateSearch: parseTicketSearch,
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/tiket')),
  component: lazyRouteComponent(() => import('../features/tickets/TicketsPage'), 'TicketsPage'),
});

/** Tiket → detail (rincian, komentar, riwayat). */
const ticketRoute = createRoute({
  getParentRoute,
  path: 'tiket/$ticketId',
  staticData: { page: { title: t.tickets.detailTitle, parent: 'tickets' } },
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/tiket')),
  component: lazyRouteComponent(
    () => import('../features/tickets/TicketDetailPage'),
    'TicketDetailPage',
  ),
});

/** Tiket → atur board (info, kolom, atribut): `tickets.configure` (Owner, Admin, Supervisor). */
const ticketBoardRoute = createRoute({
  getParentRoute,
  path: 'tiket/board/$boardId',
  staticData: { page: { title: t.tickets.settingsTitle, parent: 'tickets' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'tickets.configure'),
  component: lazyRouteComponent(
    () => import('../features/tickets/BoardSettingsPage'),
    'BoardSettingsPage',
  ),
});

const reportsRoute = createRoute({
  getParentRoute,
  path: 'laporan',
  staticData: { page: { title: t.nav.reports, parent: 'more' } },
  beforeLoad: ({ context }) => guardNavRoute(context.session, navPermission('/laporan')),
  component: lazyRouteComponent(() => import('../features/reports/ReportsPage'), 'ReportsPage'),
});

const settingsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan',
  staticData: { page: { title: t.nav.settings, parent: 'more' } },
  component: lazyRouteComponent(() => import('../features/settings/SettingsPage'), 'SettingsPage'),
});

/** Pengaturan → Email pengirim: izin `settings.email.manage` (Owner, Admin). */
const emailSettingsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/email',
  staticData: { page: { title: t.emailSettings.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'settings.email.manage'),
  loader: ({ context }) => context.queryClient.ensureQueryData(emailSettingsQuery),
  component: lazyRouteComponent(
    () => import('../features/email-settings/EmailSettingsPage'),
    'EmailSettingsPage',
  ),
  pendingComponent: EmailSettingsSkeleton,
});

/**
 * Pengaturan → Akun email (Fase 9): akun yang bisa kukelola + metadata akun pribadi orang lain
 * untuk Owner/Admin. `?tambah=` membuka wizard hubungkan akun.
 */
const mailAccountsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/akun-email',
  staticData: { page: { title: t.mail.accounts.title, parent: 'settings' } },
  validateSearch: parseMailAccountsSearch,
  beforeLoad: ({ context }) => guardMail(context.session, '/pengaturan'),
  component: lazyRouteComponent(
    () => import('../features/mail/MailAccountsPage'),
    'MailAccountsPage',
  ),
});

/** Pengaturan → Akun email → satu akun (status, tampilan, server, akses, putuskan). */
const mailAccountRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/akun-email/$accountId',
  staticData: { page: { title: t.mail.detail.title, parent: 'mailAccounts' } },
  validateSearch: parseMailAccountSearch,
  beforeLoad: ({ context }) => guardMail(context.session, '/pengaturan'),
  component: lazyRouteComponent(
    () => import('../features/mail/MailAccountPage'),
    'MailAccountPage',
  ),
});

/**
 * Pengaturan → Channel: izin `channels.manage` (Owner, Admin); peran lain dialihkan ke Pengaturan.
 * Data yang gagal dimuat tidak menggagalkan rute: halamannya sendiri menampilkan gagal + coba lagi.
 */
const channelsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/channel',
  staticData: { page: { title: t.channels.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'channels.manage'),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(channelSettingsQuery).catch(() => null),
  component: lazyRouteComponent(() => import('../features/channels/ChannelsPage'), 'ChannelsPage'),
  pendingComponent: ChannelsSkeleton,
});

/** Pengaturan → Balasan cepat: izin `quick_replies.manage` (Owner, Admin, Supervisor). */
const quickRepliesRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/balasan-cepat',
  staticData: { page: { title: t.quickReplies.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'quick_replies.manage'),
  component: lazyRouteComponent(
    () => import('../features/quick-replies/QuickRepliesPage'),
    'QuickRepliesPage',
  ),
});

/**
 * Pengaturan → Template WhatsApp (template Meta): `templates.manage` (Owner, Admin, Supervisor).
 * Daftar dan editor memuat datanya sendiri (kerangka, gagal + coba lagi, tidak ditemukan).
 */
const templatesRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/template',
  staticData: { page: { title: t.templates.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'templates.manage'),
  component: lazyRouteComponent(
    () => import('../features/templates/TemplatesPage'),
    'TemplatesPage',
  ),
});

/** Template baru. Rute statis ini menang atas `$templateId`. */
const templateNewRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/template/baru',
  staticData: { page: { title: t.templates.newTitle, parent: 'templates' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'templates.manage'),
  component: lazyRouteComponent(
    () => import('../features/templates/TemplateEditorPage'),
    'TemplateNewPage',
  ),
});

const templateEditRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/template/$templateId',
  staticData: { page: { title: t.templates.editTitle, parent: 'templates' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'templates.manage'),
  component: lazyRouteComponent(
    () => import('../features/templates/TemplateEditorPage'),
    'TemplateEditPage',
  ),
});

/**
 * Pengaturan → Template email (tahap 9.1): `templates.manage` (Owner, Admin, Supervisor). Isi
 * email yang dikirim aplikasi lain lewat API; terbit = konfirmasi identitas.
 */
const emailTemplatesRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/template-email',
  staticData: { page: { title: t.emailTemplates.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'templates.manage'),
  component: lazyRouteComponent(
    () => import('../features/email-templates/EmailTemplatesPage'),
    'EmailTemplatesPage',
  ),
});

const emailTemplateEditRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/template-email/$templateId',
  staticData: { page: { title: t.emailTemplates.editTitle, parent: 'emailTemplates' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'templates.manage'),
  component: lazyRouteComponent(
    () => import('../features/email-templates/EmailTemplateEditorPage'),
    'EmailTemplateEditorPage',
  ),
});

/** Pengaturan → API key → Email terkirim (tahap 9.1): `api_keys.manage`; saringan di URL. */
const emailOutboundRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/api-key/email-terkirim',
  staticData: { page: { title: t.emailOutbound.title, parent: 'apiKeys' } },
  validateSearch: parseEmailOutboundSearch,
  beforeLoad: ({ context }) => guardPermission(context.session, 'api_keys.manage'),
  component: lazyRouteComponent(
    () => import('../features/integrations/EmailOutboundPage'),
    'EmailOutboundPage',
  ),
});

/** Pengaturan → API key: `api_keys.manage` (Owner, Admin). */
const apiKeysRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/api-key',
  staticData: { page: { title: t.apiKeys.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'api_keys.manage'),
  component: lazyRouteComponent(
    () => import('../features/integrations/ApiKeysPage'),
    'ApiKeysPage',
  ),
});

/** Pengaturan → Webhook keluar: `integrations.manage` (Owner, Admin). */
const webhooksRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/webhook',
  staticData: { page: { title: t.webhooks.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'integrations.manage'),
  component: lazyRouteComponent(
    () => import('../features/integrations/WebhooksPage'),
    'WebhooksPage',
  ),
});

/** Pengaturan → Konektor data (sumber penerima broadcast): `integrations.manage`. */
const connectorsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/konektor-data',
  staticData: { page: { title: t.connectors.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'integrations.manage'),
  component: lazyRouteComponent(
    () => import('../features/broadcast/ConnectorsPage'),
    'ConnectorsPage',
  ),
});

/** Pengaturan → Alarm Telegram: `integrations.manage`. */
const alarmsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/alarm',
  staticData: { page: { title: t.alarms.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'integrations.manage'),
  component: lazyRouteComponent(
    () => import('../features/broadcast/TelegramAlarmPage'),
    'TelegramAlarmPage',
  ),
});

/** Pengaturan → Notifikasi: per pengguna (`inbox.view`); bagian organisasi = `organization.manage`. */
const notificationsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/notifikasi',
  staticData: { page: { title: t.notifications.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'inbox.view'),
  component: lazyRouteComponent(
    () => import('../features/notifications/NotificationsPage'),
    'NotificationsPage',
  ),
});

/** Pengaturan → Atribut kontak: kelola = `settings.workspace.manage` (Owner, Admin). */
const contactAttributesRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/atribut-kontak',
  staticData: { page: { title: t.attributes.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'settings.workspace.manage'),
  component: lazyRouteComponent(
    () => import('../features/contacts/AttributeDefinitionsPage'),
    'AttributeDefinitionsPage',
  ),
});

/** Pengaturan → Departemen: `settings.workspace.manage` (Owner, Admin). */
const departmentsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/departemen',
  staticData: { page: { title: t.departments.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'settings.workspace.manage'),
  component: lazyRouteComponent(
    () => import('../features/departments/DepartmentsPage'),
    'DepartmentsPage',
  ),
});

/** Pengaturan → CSAT otomatis: `settings.workspace.manage` (Owner, Admin). */
const csatSettingsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/csat',
  staticData: { page: { title: t.csat.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'settings.workspace.manage'),
  component: lazyRouteComponent(
    () => import('../features/reports/CsatSettingsPage'),
    'CsatSettingsPage',
  ),
});

/** Pengaturan → Merek (white-label): `organization.manage` (Owner). */
const brandingSettingsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/merek',
  staticData: { page: { title: t.brandingSettings.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'organization.manage'),
  component: lazyRouteComponent(
    () => import('../features/branding/BrandingSettingsPage'),
    'BrandingSettingsPage',
  ),
});

/** Pengaturan → Jam kerja & alokasi: `settings.workspace.manage` (Owner, Admin). */
const workspaceRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/jam-kerja',
  staticData: { page: { title: t.workspace.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'settings.workspace.manage'),
  component: lazyRouteComponent(
    () => import('../features/workspace/WorkspaceSettingsPage'),
    'WorkspaceSettingsPage',
  ),
});

/** Pengaturan → Batas kirim & rem darurat: `sending.limits.manage` (Owner, Admin). */
const sendingLimitsRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/batas-kirim',
  staticData: { page: { title: t.sendingLimits.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'sending.limits.manage'),
  component: lazyRouteComponent(
    () => import('../features/sending-limits/SendingLimitsPage'),
    'SendingLimitsPage',
  ),
});

/** Alamat lama (sebelum istilah "balasan cepat") dialihkan. */
const oldQuickRepliesRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/template-percakapan',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- pola resmi TanStack Router
    throw redirect({ to: '/pengaturan/balasan-cepat', replace: true });
  },
});

/** Channel → Tambah nomor (wizard). Rute statis ini menang atas `$channelId`. */
const channelWizardRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/channel/tambah',
  staticData: { page: { title: t.channels.wizard.title, parent: 'channels' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'channels.manage'),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(channelSettingsQuery).catch(() => null),
  component: lazyRouteComponent(
    () => import('../features/channels/ChannelWizardPage'),
    'ChannelWizardPage',
  ),
  pendingComponent: ChannelsSkeleton,
});

/** Channel → hubungkan Telegram / Email / Messenger / Instagram (wizard per jenis). */
const connectionNewRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/channel/baru/$type',
  staticData: { page: { title: t.connections.addTitle, parent: 'channels' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'channels.manage'),
  component: lazyRouteComponent(
    () => import('../features/channels/connections/ConnectionWizardPage'),
    'ConnectionWizardPage',
  ),
});

/** Channel → halaman channel selain WhatsApp (koneksi, tes, pengaturan, status, hapus). */
const connectionRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/channel/lain/$channelId',
  staticData: { page: { title: t.connections.detailTitle, parent: 'channels' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'channels.manage'),
  component: lazyRouteComponent(
    () => import('../features/channels/connections/ConnectionPage'),
    'ConnectionPage',
  ),
});

/** Channel → halaman nomor. */
const channelRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/channel/$channelId',
  staticData: { page: { title: t.channels.detail.title, parent: 'channels' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'channels.manage'),
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    if (!isChannelId(params.channelId)) return;
    void queryClient.prefetchQuery(channelWebhookQuery(params.channelId));
    await queryClient
      .ensureQueryData(channelQuery(params.channelId, queryClient))
      .catch(() => null);
  },
  component: lazyRouteComponent(() => import('../features/channels/ChannelPage'), 'ChannelPage'),
  pendingComponent: ChannelDetailSkeleton,
});

/**
 * Pengaturan → Tim: izin `team.invite` (undangan) dan/atau `team.manage` (daftar anggota) — Owner,
 * Admin; peran lain dialihkan ke Pengaturan.
 */
const teamRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/tim',
  staticData: { page: { title: t.team.title, parent: 'settings' } },
  beforeLoad: ({ context }) => guardAnyPermission(context.session, ['team.invite', 'team.manage']),
  loader: async ({ context }) => {
    const { queryClient, session } = context;
    await Promise.all([
      sessionCan(session, 'team.invite') ? queryClient.ensureQueryData(invitationsQuery) : null,
      sessionCan(session, 'team.manage') ? queryClient.ensureQueryData(teamUsersQuery) : null,
    ]);
  },
  component: lazyRouteComponent(() => import('../features/team/TeamPage'), 'TeamPage'),
  pendingComponent: TeamSkeleton,
});

/**
 * Pengaturan → Tim → detail anggota: izin `team.manage`. Data yang gagal dimuat (mis. 404) tidak
 * menggagalkan rute: halamannya sendiri menampilkan "tidak ditemukan" / gagal + coba lagi.
 */
const teamUserRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/tim/$userId',
  staticData: { page: { title: t.teamUser.title, parent: 'team' } },
  beforeLoad: ({ context }) => guardPermission(context.session, 'team.manage'),
  loader: async ({ context, params }) => {
    const { queryClient, session } = context;
    if (sessionCan(session, 'audit.view')) {
      void queryClient.prefetchInfiniteQuery(userAuditQuery(params.userId));
    }
    const user = await queryClient
      .ensureQueryData(teamUserQuery(params.userId, queryClient))
      .catch(() => null);
    // Sesi pengguna lain termasuk "kelola": hanya dimuat bila pemanggil boleh mengelolanya
    // (selain itu server menjawab 403).
    if (user?.canManage) void queryClient.prefetchQuery(userSessionsQuery(params.userId));
  },
  component: lazyRouteComponent(() => import('../features/team-user/TeamUserPage'), 'TeamUserPage'),
  pendingComponent: TeamUserSkeleton,
});

/** Pengaturan → Audit log: izin `audit.view` (Owner, Admin). Saringan di parameter URL. */
const auditRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/audit',
  staticData: { page: { title: t.audit.title, parent: 'settings' } },
  validateSearch: parseAuditSearch,
  beforeLoad: ({ context }) => guardPermission(context.session, 'audit.view'),
  component: lazyRouteComponent(() => import('../features/audit/AuditPage'), 'AuditPage'),
  pendingComponent: AuditSkeleton,
});

/** Pengaturan → Keamanan akun: semua peran. */
const securityRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/keamanan',
  staticData: { page: { title: t.security.title, parent: 'settings' } },
  loader: async ({ context }) => {
    // Status email dimuat bersamaan; bila gagal, kartunya sendiri yang menampilkan error.
    const email = context.queryClient.ensureQueryData(emailVerificationQuery).catch(() => null);
    const sessions = context.queryClient.ensureQueryData(sessionsQuery).catch(() => null);
    await context.queryClient.ensureQueryData(twoFactorStatusQuery);
    await Promise.all([email, sessions]);
  },
  component: lazyRouteComponent(() => import('../features/security/SecurityPage'), 'SecurityPage'),
  pendingComponent: SecuritySkeleton,
});

/** Keamanan akun → Aktifkan 2FA (peran yang tidak wajib; yang wajib sudah aktif). */
const securityEnrollRoute = createRoute({
  getParentRoute,
  path: 'pengaturan/keamanan/aktifkan',
  staticData: { page: { title: t.twoFactor.enroll.title, parent: 'security' } },
  beforeLoad: ({ context }) => guardVoluntaryEnrollment(context.queryClient),
  component: lazyRouteComponent(
    () => import('../features/two-factor/VoluntaryEnrollmentPage'),
    'VoluntaryEnrollmentPage',
  ),
});

const moreRoute = createRoute({
  getParentRoute,
  path: 'lainnya',
  staticData: { page: { title: t.nav.more } },
  component: lazyRouteComponent(() => import('../features/more/MorePage'), 'MorePage'),
});

/** Alamat yang tidak dikenal: 404 di dalam kerangka aplikasi (navigasi tetap bisa dipakai). */
const notFoundRoute = createRoute({
  getParentRoute,
  path: '$',
  component: NotFoundPage,
});

const appChildren = [
  indexRoute,
  inboxRoute,
  mailRoute,
  mailLinkWarningRoute,
  contactsRoute,
  contactImportRoute,
  contactRoute,
  contactAttributesRoute,
  departmentsRoute,
  workspaceRoute,
  brandingSettingsRoute,
  csatSettingsRoute,
  broadcastRoute,
  broadcastNewRoute,
  broadcastCampaignRoute,
  ticketsRoute,
  ticketRoute,
  ticketBoardRoute,
  reportsRoute,
  settingsRoute,
  emailSettingsRoute,
  mailAccountsRoute,
  mailAccountRoute,
  channelsRoute,
  quickRepliesRoute,
  templatesRoute,
  templateNewRoute,
  templateEditRoute,
  emailTemplatesRoute,
  emailTemplateEditRoute,
  oldQuickRepliesRoute,
  sendingLimitsRoute,
  notificationsRoute,
  apiKeysRoute,
  emailOutboundRoute,
  webhooksRoute,
  connectorsRoute,
  alarmsRoute,
  channelWizardRoute,
  connectionNewRoute,
  connectionRoute,
  channelRoute,
  teamRoute,
  teamUserRoute,
  auditRoute,
  securityRoute,
  securityEnrollRoute,
  moreRoute,
  notFoundRoute,
] as const;

const publicRoutes = [
  setupRoute,
  loginRoute,
  forgotPasswordRoute,
  invitationRoute,
  resetPasswordRoute,
  verifyEmailRoute,
  enrollmentRoute,
] as const;

const routeTree = rootRoute.addChildren([...publicRoutes, appRoute.addChildren(appChildren)]);

/**
 * Mode pengembangan: tambah rute pratinjau. Tipe pohon rute sengaja tetap versi
 * produksi, jadi rute pratinjau tidak bisa dituju dari kode aplikasi.
 */
function routeTreeWithPreviews(): typeof routeTree {
  return rootRoute.addChildren([
    ...publicRoutes,
    appRoute.addChildren([...appChildren, ...createPreviewRoutes(appRoute)]),
  ]) as unknown as typeof routeTree;
}

interface AppRouterOptions {
  queryClient: QueryClient;
  /** Riwayat khusus (tes memakai riwayat di memori). Bawaan: riwayat browser. */
  history?: RouterHistory;
}

export function createAppRouter({ queryClient, history }: AppRouterOptions) {
  return createRouter({
    routeTree: import.meta.env.DEV ? routeTreeWithPreviews() : routeTree,
    context: { queryClient },
    history,
    defaultPreload: 'intent',
    // Data rute sudah dikelola TanStack Query; preload hanya memuat kode halaman.
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PageSkeleton,
    defaultErrorComponent: RouteErrorScreen,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
