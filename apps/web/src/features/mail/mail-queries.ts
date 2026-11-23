import type {
  MailAccount,
  MailAccountListResponse,
  MailMessageDetail,
  MailMessageListResponse,
  MailMessageSummary,
  MailSettingsAccountListResponse,
  MailSidebarResponse,
} from '@balesin/shared';
import {
  infiniteQueryOptions,
  queryOptions,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import type { MailMessageListParams } from '../../lib/api/endpoints-mail';
import { twoFactorStatusQuery } from '../../lib/api/queries';
import { retryTransient } from '../inbox/inbox-queries';

/**
 * Kunci cache modul Email. Semua berawalan `['mail']`, jadi `mail.resync` / `mail.access.changed`
 * cukup menyegarkan satu awalan.
 */
export const mailKeys = {
  all: ['mail'] as const,
  providers: ['mail', 'providers'] as const,
  accounts: ['mail', 'accounts'] as const,
  settingsAccounts: ['mail', 'settings-accounts'] as const,
  account: (accountId: string) => ['mail', 'account', accountId] as const,
  access: (accountId: string) => ['mail', 'access', accountId] as const,
  sidebar: ['mail', 'sidebar'] as const,
  settings: ['mail', 'settings'] as const,
  teamAccess: (userId: string) => ['mail', 'team-access', userId] as const,
  /** Semua daftar email (awalan untuk menyegarkan/menambal semua tampilan sekaligus). */
  messageLists: ['mail', 'messages'] as const,
  messages: (params: MailMessageListParams) =>
    ['mail', 'messages', params.view, params.folderId ?? null] as const,
  /** Semua detail email (awalan). */
  messageDetails: ['mail', 'message'] as const,
  message: (messageId: string) => ['mail', 'message', messageId] as const,
  /** URL dokumen tampilan ber-token; `images` = `auto`/`show`. */
  view: (messageId: string, images: 'auto' | 'show') =>
    ['mail', 'view', messageId, images] as const,
  // ── 9B: tulis ──
  /** Pilihan "Dari" di jendela tulis (semua akun ber-hak kirim). */
  composeIdentities: ['mail', 'compose-identities'] as const,
  /** Identitas & alias satu akun (Pengaturan → Akun email). */
  identities: (accountId: string) => ['mail', 'identities', accountId] as const,
  signatures: (accountId: string) => ['mail', 'signatures', accountId] as const,
  preferences: ['mail', 'preferences'] as const,
  draft: (draftId: string) => ['mail', 'draft', draftId] as const,
  snippets: (q: string) => ['mail', 'snippets', q] as const,
  suggest: (q: string, accountId: string | null) => ['mail', 'suggest', q, accountId] as const,
};

/** Kartu penyedia jarang berubah (daftar tetap di server). */
export const mailProvidersQuery = queryOptions({
  queryKey: mailKeys.providers,
  queryFn: ({ signal }) => endpoints.mail.providers(signal),
  staleTime: 10 * 60_000,
  retry: retryTransient,
});

/** Akun yang bisa kuakses (menu Email) + boleh menghubungkan akun pribadi/bersama. */
export const mailAccountsQuery = queryOptions({
  queryKey: mailKeys.accounts,
  queryFn: ({ signal }) => endpoints.mail.accounts(signal),
  retry: retryTransient,
});

/** Pengaturan → Akun email (termasuk metadata akun pribadi orang lain untuk Owner/Admin). */
export const mailSettingsAccountsQuery = queryOptions({
  queryKey: mailKeys.settingsAccounts,
  queryFn: ({ signal }) => endpoints.mail.settingsAccounts(signal),
  retry: retryTransient,
});

export const mailAccountQuery = (accountId: string) =>
  queryOptions({
    queryKey: mailKeys.account(accountId),
    queryFn: ({ signal }) => endpoints.mail.account(accountId, signal),
    retry: retryTransient,
  });

export const mailAccessQuery = (accountId: string) =>
  queryOptions({
    queryKey: mailKeys.access(accountId),
    queryFn: ({ signal }) => endpoints.mail.access(accountId, signal),
    retry: retryTransient,
  });

/** Kolom kiri menu Email (gabungan, belum dibaca, berbintang, akun + folder + jumlah). */
export const mailSidebarQuery = queryOptions({
  queryKey: mailKeys.sidebar,
  queryFn: ({ signal }) => endpoints.mail.sidebar(signal),
  retry: retryTransient,
});

/** Daftar email satu tampilan/folder, bergulir tak terbatas dengan kursor (kontrak §7). */
export function mailMessagesQuery(params: MailMessageListParams, limit: number) {
  return infiniteQueryOptions({
    queryKey: mailKeys.messages(params),
    queryFn: ({ signal, pageParam }) =>
      endpoints.mail.messages({ ...params, cursor: pageParam, limit }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryTransient,
  });
}

/**
 * Satu email. Selama isinya masih diambil server (`body.state: "loading"`), ditanya ulang tiap 3
 * detik sebagai cadangan bila event WS `mail.message.updated` tidak sampai.
 */
export function mailMessageQuery(messageId: string) {
  return queryOptions({
    queryKey: mailKeys.message(messageId),
    queryFn: ({ signal }) => endpoints.mail.message(messageId, signal),
    retry: (count, error) => !isNotFound(error) && retryTransient(count, error),
    refetchInterval: (query) => {
      const state = query.state.data?.message.body.state;
      return state === 'loading' || state === 'none' ? 3_000 : false;
    },
  });
}

/**
 * URL dokumen tampilan (token 10 menit). Tidak disegarkan otomatis: dokumen di iframe sudah dimuat,
 * token baru hanya saat isi berubah atau pengguna meminta gambar ditampilkan.
 */
export function mailViewQuery(messageId: string, images: 'auto' | 'show') {
  return queryOptions({
    queryKey: mailKeys.view(messageId, images),
    queryFn: ({ signal }) => endpoints.mail.view(messageId, images, signal),
    staleTime: Infinity,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    retry: retryTransient,
  });
}

export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

type MessageListData = InfiniteData<MailMessageListResponse, string | null>;

/** Email di daftar mana pun yang sudah dimuat (untuk kepala panel baca sebelum detail tiba). */
export function findListedMessage(
  queryClient: QueryClient,
  messageId: string,
): MailMessageSummary | undefined {
  for (const [, data] of queryClient.getQueriesData<MessageListData>({
    queryKey: mailKeys.messageLists,
  })) {
    for (const page of data?.pages ?? []) {
      const found = page.messages.find((message) => message.id === messageId);
      if (found) return found;
    }
  }
  return undefined;
}

type FlagPatch = Partial<Pick<MailMessageSummary, 'isRead' | 'isStarred'>>;

/** Tambal bendera (dibaca/bintang) di semua daftar & detail yang dimuat, tanpa memuat ulang. */
export function patchMessageFlags(
  queryClient: QueryClient,
  messageIds: readonly string[],
  patch: FlagPatch,
): void {
  const ids = new Set(messageIds);
  queryClient.setQueriesData<MessageListData>({ queryKey: mailKeys.messageLists }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            messages: page.messages.map((message) =>
              ids.has(message.id) ? { ...message, ...patch } : message,
            ),
          })),
        }
      : data,
  );
  for (const id of ids) {
    queryClient.setQueryData<{ message: MailMessageDetail }>(
      mailKeys.message(id),
      (data) => data && { message: { ...data.message, ...patch } },
    );
  }
}

/** Buang email dari semua daftar yang dimuat (dipindah/dihapus: tidak tampil di daftar mana pun). */
export function removeListedMessages(
  queryClient: QueryClient,
  messageIds: readonly string[],
): void {
  const ids = new Set(messageIds);
  queryClient.setQueriesData<MessageListData>({ queryKey: mailKeys.messageLists }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            messages: page.messages.filter((message) => !ids.has(message.id)),
          })),
        }
      : data,
  );
}

/** Lampiran selesai diambil server: unduhan berikutnya langsung berkas (200). */
export function markAttachmentCached(queryClient: QueryClient, attachmentId: string): void {
  queryClient.setQueriesData<{ message: MailMessageDetail }>(
    { queryKey: mailKeys.messageDetails },
    (data) =>
      data?.message.attachments.some((item) => item.id === attachmentId)
        ? {
            message: {
              ...data.message,
              attachments: data.message.attachments.map((item) =>
                item.id === attachmentId ? { ...item, cached: true } : item,
              ),
            },
          }
        : data,
  );
}

// ── 9B: tulis, identitas, tanda tangan, preferensi ──

export const composeIdentitiesQuery = queryOptions({
  queryKey: mailKeys.composeIdentities,
  queryFn: ({ signal }) => endpoints.mail.composeIdentities(signal),
  retry: retryTransient,
});

export const mailIdentitiesQuery = (accountId: string) =>
  queryOptions({
    queryKey: mailKeys.identities(accountId),
    queryFn: ({ signal }) => endpoints.mail.accountIdentities(accountId, signal),
    retry: retryTransient,
  });

export const mailSignaturesQuery = (accountId: string) =>
  queryOptions({
    queryKey: mailKeys.signatures(accountId),
    queryFn: ({ signal }) => endpoints.mail.signatures(accountId, signal),
    retry: retryTransient,
  });

export const mailPreferencesQuery = queryOptions({
  queryKey: mailKeys.preferences,
  queryFn: ({ signal }) => endpoints.mail.preferences(signal),
  retry: retryTransient,
  staleTime: 5 * 60_000,
});

/** Menu template (balasan cepat + template email terbit), dicari di server. */
export function mailSnippetsQuery(q: string) {
  return queryOptions({
    queryKey: mailKeys.snippets(q),
    queryFn: ({ signal }) => endpoints.mail.composeSnippets(q, signal),
    staleTime: 60_000,
    retry: retryTransient,
  });
}

/** Pelengkap Kepada/Cc/Bcc (q ≥ 2 karakter). Tidak diulang otomatis: ketikan berikutnya cukup. */
export function mailSuggestQuery(q: string, accountId: string | null) {
  return queryOptions({
    queryKey: mailKeys.suggest(q, accountId),
    queryFn: ({ signal }) => endpoints.mail.suggestRecipients(q, accountId ?? undefined, signal),
    staleTime: 60_000,
    retry: false,
    enabled: q.trim().length >= 2,
  });
}

/** Identitas berubah (verifikasi, alias): pilihan "Dari" & daftar identitas akun dimuat ulang. */
export function refreshIdentities(queryClient: QueryClient, accountId?: string): void {
  void queryClient.invalidateQueries({ queryKey: mailKeys.composeIdentities });
  void queryClient.invalidateQueries({
    queryKey: accountId ? mailKeys.identities(accountId) : ['mail', 'identities'],
  });
  // Peringatan akun (`identity_unverified`) ikut berubah: banner menu Email & halaman akun.
  void queryClient.invalidateQueries({ queryKey: mailKeys.accounts });
  if (accountId) void queryClient.invalidateQueries({ queryKey: mailKeys.account(accountId) });
}

export const mailSettingsQuery = queryOptions({
  queryKey: mailKeys.settings,
  queryFn: ({ signal }) => endpoints.mail.settings(signal),
  retry: retryTransient,
});

export const teamMailAccessQuery = (userId: string) =>
  queryOptions({
    queryKey: mailKeys.teamAccess(userId),
    queryFn: ({ signal }) => endpoints.mail.teamAccess(userId, signal),
    retry: retryTransient,
  });

/** Akun hasil aksi (jeda, lanjut, ubah) ke semua cache yang memuatnya, tanpa memuat ulang. */
export function storeMailAccount(queryClient: QueryClient, account: MailAccount): void {
  queryClient.setQueryData(mailKeys.account(account.id), { account });
  queryClient.setQueryData<MailAccountListResponse>(
    mailKeys.accounts,
    (data) =>
      data && {
        ...data,
        accounts: data.accounts.map((item) => (item.id === account.id ? account : item)),
      },
  );
  queryClient.setQueryData<MailSettingsAccountListResponse>(
    mailKeys.settingsAccounts,
    (data) =>
      data && {
        ...data,
        accounts: data.accounts.map((item) => (item.id === account.id ? account : item)),
      },
  );
  queryClient.setQueryData<MailSidebarResponse>(
    mailKeys.sidebar,
    (data) =>
      data && {
        ...data,
        accounts: data.accounts.map((entry) =>
          entry.account.id === account.id
            ? {
                ...entry,
                account: {
                  ...entry.account,
                  displayName: account.displayName,
                  color: account.color,
                  avatarUrl: account.avatarUrl,
                  sync: { state: account.sync.state },
                },
              }
            : entry,
        ),
      },
  );
}

/** Akun baru/diputus: semua daftar akun & kolom kiri dimuat ulang. */
export function refreshMailAccounts(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: mailKeys.accounts });
  void queryClient.invalidateQueries({ queryKey: mailKeys.settingsAccounts });
  void queryClient.invalidateQueries({ queryKey: mailKeys.sidebar });
}

/**
 * Konfirmasi identitas perlu kode verifikasi bila 2FA pelaku aktif (selalu untuk Owner/Admin;
 * peran lain bisa mengaktifkannya sendiri). Selama status belum dimuat, anggap perlu.
 */
export function useRequireCode(): boolean {
  return useQuery(twoFactorStatusQuery).data?.enabled ?? true;
}

/** Pesan satu kali untuk halaman Akun email (mis. setelah memutus akun dari halaman akunnya). */
let pendingAccountsFlash: string | null = null;

export function setAccountsFlash(message: string): void {
  pendingAccountsFlash = message;
}

/** Dibaca saat halaman dipasang (aman dipanggil dua kali di StrictMode), lalu dibuang. */
export function peekAccountsFlash(): string | null {
  return pendingAccountsFlash;
}

export function clearAccountsFlash(): void {
  pendingAccountsFlash = null;
}
