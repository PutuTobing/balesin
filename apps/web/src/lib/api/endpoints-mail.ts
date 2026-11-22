import {
  API_ROUTES,
  apiPath,
  deleteMailAccountResponseSchema,
  detectMailAccountResponseSchema,
  mailAccountAccessResponseSchema,
  mailAccountListResponseSchema,
  mailAccountResponseSchema,
  mailAccountSyncResponseSchema,
  mailAvatarResponseSchema,
  mailFolderListResponseSchema,
  mailProvidersResponseSchema,
  mailSettingsAccountListResponseSchema,
  mailSettingsResponseSchema,
  mailSidebarResponseSchema,
  teamMailAccessResponseSchema,
  testMailAccountResponseSchema,
  type CreateMailAccountInput,
  type IdentityConfirmation,
  type MailSettings,
  type TestMailAccountRequest,
  type UpdateMailAccountAccessRequest,
  type UpdateMailAccountRequest,
  type UpdateTeamMailAccessRequest,
} from '@balesin/shared';
import type { ApiClient } from './client';

/**
 * Modul Email tahap 9A bagian 1 (docs/KONTRAK-API-EMAIL.md §4–§6): akun, deteksi & tes koneksi,
 * akses per akun, folder/kolom kiri, pengaturan email. Permintaan yang membawa password akun atau
 * konfirmasi identitas dipanggil langsung dari komponen (bukan `useMutation`), supaya isinya tidak
 * tersimpan di cache mutasi.
 */
export function createMailEndpoints(client: ApiClient) {
  const routes = API_ROUTES.mail;
  const account = (accountId: string) => apiPath(routes.account, { accountId });
  return {
    mail: {
      providers: (signal?: AbortSignal) =>
        client.request(routes.providers, { schema: mailProvidersResponseSchema, signal }),
      /** Saran server dari alamat (10 kali / 5 menit). */
      detect: (emailAddress: string, signal?: AbortSignal) =>
        client.request(routes.detect, {
          method: 'POST',
          body: { emailAddress },
          schema: detectMailAccountResponseSchema,
          signal,
        }),
      /** Tes Masuk/Keluar tanpa menyimpan. Gagal tetap 200 (`ok: false`). */
      test: (body: TestMailAccountRequest) =>
        client.request(routes.test, {
          method: 'POST',
          body,
          schema: testMailAccountResponseSchema,
        }),
      /** Akun yang bisa kuakses (menu Email). */
      accounts: (signal?: AbortSignal) =>
        client.request(routes.accounts, { schema: mailAccountListResponseSchema, signal }),
      /** Buat akun. Bersama = wajib `confirmation`; server menjalankan tes Masuk & Keluar. */
      create: (body: CreateMailAccountInput) =>
        client.request(routes.accounts, {
          method: 'POST',
          body,
          schema: mailAccountResponseSchema,
        }),
      /** Pengaturan → Akun email (termasuk metadata akun pribadi orang lain untuk Owner/Admin). */
      settingsAccounts: (signal?: AbortSignal) =>
        client.request(routes.settingsAccounts, {
          schema: mailSettingsAccountListResponseSchema,
          signal,
        }),
      account: (accountId: string, signal?: AbortSignal) =>
        client.request(account(accountId), { schema: mailAccountResponseSchema, signal }),
      /** Ubah server/kredensial/alamat = wajib `confirmation` + tes lolos (server). */
      update: (accountId: string, body: UpdateMailAccountRequest) =>
        client.request(account(accountId), {
          method: 'PATCH',
          body,
          schema: mailAccountResponseSchema,
        }),
      /** Putuskan (202): kredensial dimusnahkan, cache dihapus bertahap. */
      remove: (accountId: string, confirmation: IdentityConfirmation) =>
        client.request(account(accountId), {
          method: 'DELETE',
          body: { confirmation },
          schema: deleteMailAccountResponseSchema,
        }),
      /** Tes dengan kredensial tersimpan. */
      testSaved: (accountId: string) =>
        client.request(apiPath(routes.accountTest, { accountId }), {
          method: 'POST',
          schema: testMailAccountResponseSchema,
        }),
      sync: (accountId: string) =>
        client.request(apiPath(routes.accountSync, { accountId }), {
          method: 'POST',
          schema: mailAccountSyncResponseSchema,
        }),
      pause: (accountId: string) =>
        client.request(apiPath(routes.accountPause, { accountId }), {
          method: 'POST',
          schema: mailAccountResponseSchema,
        }),
      resume: (accountId: string) =>
        client.request(apiPath(routes.accountResume, { accountId }), {
          method: 'POST',
          schema: mailAccountResponseSchema,
        }),
      /** Foto/logo akun: base64 PNG/JPEG/WebP ≤ 1 MB. */
      setAvatar: (accountId: string, image: string) =>
        client.request(apiPath(routes.accountAvatar, { accountId }), {
          method: 'PUT',
          body: { image },
          schema: mailAvatarResponseSchema,
        }),
      removeAvatar: (accountId: string) =>
        client.request(apiPath(routes.accountAvatar, { accountId }), {
          method: 'DELETE',
          schema: mailAvatarResponseSchema,
        }),
      access: (accountId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.accountAccess, { accountId }), {
          schema: mailAccountAccessResponseSchema,
          signal,
        }),
      /** Mengganti seluruh daftar. Menambah/menaikkan = wajib `confirmation`. */
      updateAccess: (accountId: string, body: UpdateMailAccountAccessRequest) =>
        client.request(apiPath(routes.accountAccess, { accountId }), {
          method: 'PUT',
          body,
          schema: mailAccountAccessResponseSchema,
        }),
      folders: (accountId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.accountFolders, { accountId }), {
          schema: mailFolderListResponseSchema,
          signal,
        }),
      sidebar: (signal?: AbortSignal) =>
        client.request(routes.sidebar, { schema: mailSidebarResponseSchema, signal }),
      settings: (signal?: AbortSignal) =>
        client.request(routes.settings, { schema: mailSettingsResponseSchema, signal }),
      updateSettings: (body: MailSettings) =>
        client.request(routes.settings, {
          method: 'PUT',
          body,
          schema: mailSettingsResponseSchema,
        }),
      teamAccess: (userId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.teamAccess, { userId }), {
          schema: teamMailAccessResponseSchema,
          signal,
        }),
      /** Grant LANGSUNG pengguna itu (`level: null` = cabut). Menambah/menaikkan = `confirmation`. */
      updateTeamAccess: (userId: string, body: UpdateTeamMailAccessRequest) =>
        client.request(apiPath(routes.teamAccess, { userId }), {
          method: 'PUT',
          body,
          schema: teamMailAccessResponseSchema,
        }),
    },
  };
}
