import {
  AUDIT_LOG_PAGE_DEFAULT,
  type AuditLogFilter,
  type ChannelSettingsListResponse,
  type WhatsAppChannel,
  type EmailTemplateId,
  type MeResponse,
  type TeamUser,
  type TeamUserListResponse,
} from '@balesin/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { api, isApiError } from './client';
import { endpoints } from './endpoints';
import { clearMediaCache } from '../../features/inbox/message-media';
import { resetOutbox } from '../../features/inbox/outbox';

/** Kunci query di satu tempat supaya invalidasi tidak salah ketik. */
export const queryKeys = {
  session: ['auth', 'session'] as const,
  branding: ['branding'] as const,
  setupStatus: ['setup', 'status'] as const,
  emailSettings: ['settings', 'email'] as const,
  twoFactorStatus: ['auth', 'two-factor'] as const,
  emailVerification: ['auth', 'email-verification'] as const,
  invitations: ['team', 'invitations'] as const,
  passwordResetStatus: ['password-reset', 'status'] as const,
  teamUsers: ['team', 'users'] as const,
  teamUser: (userId: string) => ['team', 'users', userId] as const,
  userSessions: (userId: string) => ['team', 'users', userId, 'sessions'] as const,
  /** Riwayat audit satu pengguna (detail pengguna). */
  userAudit: (userId: string) => ['audit', 'user', userId] as const,
  sessions: ['auth', 'sessions'] as const,
  auditLog: (filter: AuditLogFilter) => ['audit', 'list', filter] as const,
  securitySummary: ['audit', 'security-summary'] as const,
  emailTemplatePreview: (template: EmailTemplateId) =>
    ['settings', 'email', 'template', template] as const,
  channels: ['settings', 'channels'] as const,
  channel: (channelId: string) => ['settings', 'channels', channelId] as const,
  channelWebhook: (channelId: string) => ['settings', 'channels', channelId, 'webhook'] as const,
  channelWebhookHealth: (channelId: string) =>
    ['settings', 'channels', channelId, 'webhook-health'] as const,
  businessProfile: (channelId: string) =>
    ['settings', 'channels', channelId, 'business-profile'] as const,
};

/**
 * Sesi yang sedang aktif, atau `null` bila belum masuk. 401 bukan error di sini: artinya
 * "belum masuk". Error lain (jaringan, 5xx) tetap error supaya layar gagal bisa tampil.
 * Token CSRF dari respons langsung dipasang di klien (memori saja).
 *
 * Sesi bisa penuh (`authenticated`) atau terbatas (`two_factor_enrollment_required`: Owner/
 * Admin/Supervisor yang belum mengaktifkan 2FA, hanya boleh membuka layar pendaftaran 2FA).
 */
export const sessionQuery = queryOptions({
  queryKey: queryKeys.session,
  queryFn: async ({ signal }): Promise<MeResponse | null> => {
    try {
      const session = await endpoints.auth.me(signal);
      api.setCsrfToken(session.csrfToken);
      return session;
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        api.setCsrfToken(null);
        return null;
      }
      throw error;
    }
  },
  // Sesi berubah hanya lewat masuk/keluar/sesi habis, yang semuanya memperbarui cache ini.
  staleTime: Infinity,
  retry: false,
});

export const brandingQuery = queryOptions({
  queryKey: queryKeys.branding,
  queryFn: ({ signal }) => endpoints.branding.get(signal),
  staleTime: 5 * 60_000,
  retry: false,
});

export const setupStatusQuery = queryOptions({
  queryKey: queryKeys.setupStatus,
  queryFn: ({ signal }) => endpoints.setup.status(signal),
  staleTime: Infinity,
  retry: false,
});

export const emailSettingsQuery = queryOptions({
  queryKey: queryKeys.emailSettings,
  queryFn: ({ signal }) => endpoints.emailSettings.get(signal),
});

/** Status 2FA pengguna yang sedang masuk (Pengaturan → Keamanan akun). */
export const twoFactorStatusQuery = queryOptions({
  queryKey: queryKeys.twoFactorStatus,
  queryFn: ({ signal }) => endpoints.twoFactor.status(signal),
});

/** Status verifikasi email akun sendiri (Pengaturan → Keamanan akun). */
export const emailVerificationQuery = queryOptions({
  queryKey: queryKeys.emailVerification,
  queryFn: ({ signal }) => endpoints.emailVerification.status(signal),
});

/**
 * Undangan terbuka (Pengaturan → Tim). Selama ada undangan yang emailnya masih diantrekan, daftar
 * dimuat ulang tiap beberapa detik supaya "Sedang dikirim" berganti "Email terkirim" sendiri.
 * Tautan undangan sekali tampil TIDAK pernah ada di sini (hanya di respons buat/kirim ulang).
 */
export const invitationsQuery = queryOptions({
  queryKey: queryKeys.invitations,
  queryFn: ({ signal }) => endpoints.invitations.list(signal),
  refetchInterval: (query) =>
    query.state.data?.invitations.some((invitation) => invitation.deliveryStatus === 'queued')
      ? 3_000
      : false,
});

/** Semua pengguna organisasi (Pengaturan → Tim; izin `team.manage`). */
export const teamUsersQuery = queryOptions({
  queryKey: queryKeys.teamUsers,
  queryFn: ({ signal }) => endpoints.team.list(signal),
});

/** Satu pengguna (detail anggota). Data awal diambil dari daftar bila sudah dimuat. */
export function teamUserQuery(userId: string, queryClient?: QueryClient) {
  return queryOptions({
    queryKey: queryKeys.teamUser(userId),
    queryFn: async ({ signal }) => (await endpoints.team.get(userId, signal)).user,
    initialData: () =>
      queryClient
        ?.getQueryData<TeamUserListResponse>(queryKeys.teamUsers)
        ?.users.find((user) => user.id === userId),
    initialDataUpdatedAt: () => queryClient?.getQueryState(queryKeys.teamUsers)?.dataUpdatedAt,
  });
}

/** Sesi aktif pengguna lain (detail anggota). */
export function userSessionsQuery(userId: string) {
  return queryOptions({
    queryKey: queryKeys.userSessions(userId),
    queryFn: ({ signal }) => endpoints.team.sessions(userId, signal),
  });
}

/** Sesi aktif milik sendiri (Keamanan akun). */
export const sessionsQuery = queryOptions({
  queryKey: queryKeys.sessions,
  queryFn: ({ signal }) => endpoints.sessions.list(signal),
});

/** Audit log bersaring, per halaman dengan kursor ("Muat lagi"). */
export function auditLogQuery(filter: AuditLogFilter, limit = AUDIT_LOG_PAGE_DEFAULT) {
  return infiniteQueryOptions({
    queryKey: [...queryKeys.auditLog(filter), limit] as const,
    queryFn: ({ signal, pageParam }) =>
      endpoints.audit.list({ ...filter, limit, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/** Riwayat aktivitas satu pengguna (oleh ATAU terhadap dia) di detail anggota. */
export function userAuditQuery(userId: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.userAudit(userId),
    queryFn: ({ signal, pageParam }) =>
      endpoints.audit.list({ userId, limit: 10, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/**
 * Ringkasan kejadian keamanan 7 hari (banner Owner/Admin). Dimuat sekali per kunjungan dan saat
 * tab kembali dibuka setelah lama; bukan polling.
 */
export const securitySummaryQuery = queryOptions({
  queryKey: queryKeys.securitySummary,
  queryFn: ({ signal }) => endpoints.audit.securitySummary(signal),
  staleTime: 5 * 60_000,
  retry: false,
});

/**
 * Simpan hasil aksi kelola (data pengguna sesudahnya) ke cache daftar dan detail, lalu tandai
 * keduanya basi supaya dimuat ulang dari server.
 */
export function storeTeamUser(queryClient: QueryClient, user: TeamUser): void {
  queryClient.setQueryData(queryKeys.teamUser(user.id), user);
  queryClient.setQueryData<TeamUserListResponse>(queryKeys.teamUsers, (old) =>
    old ? { ...old, users: old.users.map((item) => (item.id === user.id ? user : item)) } : old,
  );
  // Daftar saja (urutan, jumlah sesi); detail barusan diisi dari jawaban server.
  void queryClient.invalidateQueries({ queryKey: queryKeys.teamUsers, exact: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.userAudit(user.id) });
}

/** Atur ulang password lewat email tersedia (email pengirim instalasi sudah diatur). */
export const passwordResetStatusQuery = queryOptions({
  queryKey: queryKeys.passwordResetStatus,
  queryFn: ({ signal }) => endpoints.passwordReset.status(signal),
  staleTime: 60_000,
  retry: false,
});

/** Pratinjau satu template email (isi contoh dengan branding organisasi). */
export function emailTemplatePreviewQuery(template: EmailTemplateId) {
  return queryOptions({
    queryKey: queryKeys.emailTemplatePreview(template),
    queryFn: ({ signal }) => endpoints.emailSettings.templatePreview(template, signal),
    staleTime: 60_000,
  });
}

/** Pengaturan → Channel: semua channel + `canStoreSecrets` + `maxChannels`. */
export const channelSettingsQuery = queryOptions({
  queryKey: queryKeys.channels,
  queryFn: ({ signal }) => endpoints.channels.list(signal),
});

/** Satu channel (halaman nomor). Data awal diambil dari daftar bila sudah dimuat. */
export function channelQuery(channelId: string, queryClient?: QueryClient) {
  return queryOptions({
    queryKey: queryKeys.channel(channelId),
    queryFn: async ({ signal }) => (await endpoints.channels.get(channelId, signal)).channel,
    initialData: () =>
      queryClient
        ?.getQueryData<ChannelSettingsListResponse>(queryKeys.channels)
        ?.channels.find((channel) => channel.id === channelId),
    initialDataUpdatedAt: () => queryClient?.getQueryState(queryKeys.channels)?.dataUpdatedAt,
  });
}

/**
 * URL webhook + verify token (hanya `channels.manage`). Verify token memang ditampilkan ke peran
 * ini, tetapi tidak disimpan lebih lama dari halaman yang memakainya (`gcTime: 0`).
 */
export function channelWebhookQuery(channelId: string) {
  return queryOptions({
    queryKey: queryKeys.channelWebhook(channelId),
    queryFn: ({ signal }) => endpoints.channels.webhook(channelId, signal),
    gcTime: 0,
  });
}

/** Diagnosis webhook 24 jam; dimuat ulang tiap menit selama halaman nomor terbuka. */
export function channelWebhookHealthQuery(channelId: string) {
  return queryOptions({
    queryKey: queryKeys.channelWebhookHealth(channelId),
    queryFn: ({ signal }) => endpoints.channels.webhookHealth(channelId, signal),
    refetchInterval: 60_000,
  });
}

/**
 * Profil bisnis dari Meta. Setiap pembacaan memanggil Meta dan memakai jatah batas laju
 * (30 per 5 menit per pengguna), jadi tidak diulang otomatis saat gagal atau saat tab kembali
 * dibuka.
 */
export function businessProfileQuery(channelId: string) {
  return queryOptions({
    queryKey: queryKeys.businessProfile(channelId),
    queryFn: ({ signal }) => endpoints.channels.businessProfile(channelId, signal),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Simpan channel sesudah diubah ke cache detail dan daftar, lalu tandai daftar basi. */
export function storeChannel(queryClient: QueryClient, channel: WhatsAppChannel): void {
  queryClient.setQueryData(queryKeys.channel(channel.id), channel);
  queryClient.setQueryData<ChannelSettingsListResponse>(queryKeys.channels, (old) =>
    old
      ? {
          ...old,
          channels: old.channels.some((item) => item.id === channel.id)
            ? old.channels.map((item) => (item.id === channel.id ? channel : item))
            : [...old.channels, channel],
        }
      : old,
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.channels, exact: true });
}

/**
 * Simpan sesi baru (setelah masuk, langkah 2FA, pendaftaran 2FA, atau setup selesai) ke cache
 * dan klien. Hanya bagian sesi yang disimpan: respons pendaftaran 2FA juga memuat kode cadangan,
 * dan kode itu TIDAK boleh tertinggal di cache Query (hanya ditampilkan sekali).
 */
export function storeSession(queryClient: QueryClient, response: MeResponse): void {
  const { status, user, organization, csrfToken, session } = response;
  // `permissions` ikut disimpan (menu/tombol disembunyikan berdasarkan izin); tidak ada = [].
  const permissions = response.permissions ?? [];
  const clean: MeResponse = { status, user, organization, csrfToken, session, permissions };
  // Pengguna lain masuk di browser yang sama (komputer bersama): buang data milik pengguna
  // sebelumnya supaya tidak tampil sekilas dari cache.
  const previous = queryClient.getQueryData<MeResponse | null>(queryKeys.session);
  if (previous && previous.user.id !== clean.user.id) clearAppData(queryClient);
  api.setCsrfToken(clean.csrfToken);
  queryClient.setQueryData(queryKeys.session, clean);
}

/** Ambil ulang sesi dari server (mis. setelah API menjawab "wajib mendaftar 2FA"). */
export function refetchSession(queryClient: QueryClient): Promise<MeResponse | null> {
  return queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
}

/**
 * Bersihkan semua data milik sesi (setelah keluar atau sesi habis). Data publik (branding,
 * status setup) dibiarkan supaya halaman masuk tetap tampil dengan merek yang benar.
 */
export function clearSessionData(queryClient: QueryClient): void {
  endSession(queryClient);
  clearAppData(queryClient);
}

/**
 * Tandai sesi berakhir (token CSRF dan sesi di cache dikosongkan) TANPA membuang data lain.
 * Dipakai sebelum pindah ke halaman masuk: data yang masih dipakai layar sekarang tidak boleh
 * dibuang dulu, karena query yang masih terpasang akan langsung memuat ulang dan ditolak 401.
 * Panggil `clearAppData` setelah layar itu ditutup.
 */
export function endSession(queryClient: QueryClient): void {
  // Cache modul (draf gagal kirim, Blob media) tidak memicu permintaan ulang: aman dibuang sekarang.
  resetOutbox();
  clearMediaCache();
  api.setCsrfToken(null);
  queryClient.setQueryData(queryKeys.session, null);
}

/**
 * Hapus data aplikasi milik pengguna, kecuali sesi itu sendiri dan data publik. Termasuk cache di
 * luar Query: draf/pesan gagal kirim (outbox) dan Blob media yang sudah diunduh (review composer
 * R1) — pengguna berikutnya di tab yang sama tidak boleh melihatnya.
 */
export function clearAppData(queryClient: QueryClient): void {
  resetOutbox();
  clearMediaCache();
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] !== queryKeys.branding[0] &&
      query.queryKey[0] !== 'setup' &&
      query.queryHash !== JSON.stringify(queryKeys.session),
  });
}
