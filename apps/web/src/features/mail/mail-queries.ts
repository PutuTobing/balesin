import type {
  MailAccount,
  MailAccountListResponse,
  MailSettingsAccountListResponse,
  MailSidebarResponse,
} from '@balesin/shared';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';
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
