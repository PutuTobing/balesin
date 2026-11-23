import {
  API_ROUTES,
  apiPath,
  deleteMailAccountResponseSchema,
  detectMailAccountResponseSchema,
  mailAccountAccessResponseSchema,
  mailAccountListResponseSchema,
  mailAccountResponseSchema,
  mailAccountSyncResponseSchema,
  mailActionResponseSchema,
  mailAvatarResponseSchema,
  mailFolderListResponseSchema,
  mailMessageDetailResponseSchema,
  mailMessageListResponseSchema,
  mailMessageViewResponseSchema,
  mailProvidersResponseSchema,
  mailRemoteImageSendersResponseSchema,
  mailSettingsAccountListResponseSchema,
  mailSettingsResponseSchema,
  mailSidebarResponseSchema,
  teamMailAccessResponseSchema,
  testMailAccountResponseSchema,
  type CreateMailAccountInput,
  type IdentityConfirmation,
  type MailActionRequest,
  type MailListView,
  type MailSettings,
  type TestMailAccountRequest,
  type UpdateMailAccountAccessRequest,
  type UpdateMailAccountRequest,
  type UpdateTeamMailAccessRequest,
} from '@balesin/shared';
import type { ApiClient } from './client';
import { queryString } from './endpoints-crm';

/** Parameter daftar email (kontrak §7). */
export interface MailMessageListParams {
  view: MailListView;
  folderId?: string;
  accountId?: string;
  cursor?: string | null;
  limit?: number;
}

/** Hasil unduhan lampiran: berkas, atau server masih mengambilnya dari IMAP (202). */
export type MailAttachmentDownload =
  { state: 'ready'; blob: Blob; headers: Headers } | { state: 'loading' };

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
      // ── Bagian 2: daftar, baca, aksi (kontrak §7–§9) ──
      messages: (params: MailMessageListParams, signal?: AbortSignal) =>
        client.request(`${routes.messages}${queryString({ ...params })}`, {
          schema: mailMessageListResponseSchema,
          signal,
        }),
      /** Detail; isi belum ada → `body.state: "loading"` (event WS saat siap). Tidak menandai dibaca. */
      message: (messageId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.message, { messageId }), {
          schema: mailMessageDetailResponseSchema,
          signal,
        }),
      /** URL dokumen tampilan ber-token (10 menit) untuk `<iframe sandbox>`. */
      view: (messageId: string, images: 'auto' | 'show', signal?: AbortSignal) =>
        client.request(apiPath(routes.messageView, { messageId }), {
          method: 'POST',
          body: { images },
          schema: mailMessageViewResponseSchema,
          signal,
        }),
      /** Aksi dua arah (≤ 100 ID); sebagian boleh gagal (`results[].ok`). */
      act: (body: MailActionRequest) =>
        client.request(routes.messageActions, {
          method: 'POST',
          body,
          schema: mailActionResponseSchema,
        }),
      /** "Selalu tampilkan gambar dari pengirim ini". */
      allowRemoteImages: (address: string) =>
        client.request(routes.remoteImageSenders, {
          method: 'POST',
          body: { address },
          schema: mailRemoteImageSendersResponseSchema,
        }),
      /**
       * Unduh lampiran. Belum ada di cache server → 202 JSON `{ state: "loading" }` (berkas lampiran
       * tidak pernah berjenis JSON: server memakai PDF/raster/`octet-stream`).
       */
      downloadAttachment: async (
        attachmentId: string,
        confirm = false,
      ): Promise<MailAttachmentDownload> => {
        const path = `${apiPath(routes.attachment, { attachmentId })}${confirm ? '?confirm=1' : ''}`;
        const result = await client.download(path, { accept: '*/*' });
        if (result.headers.get('content-type')?.includes('application/json')) {
          return { state: 'loading' };
        }
        return { state: 'ready', blob: result.blob, headers: result.headers };
      },
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
