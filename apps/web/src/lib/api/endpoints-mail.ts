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
  cancelMailOutboxResponseSchema,
  createMailDraftResponseSchema,
  deleteMailDraftResponseSchema,
  deleteMailIdentityResponseSchema,
  mailComposeIdentityListResponseSchema,
  mailDraftAttachmentResponseSchema,
  mailDraftAttachmentsFromMessageResponseSchema,
  mailDraftCheckResponseSchema,
  mailDraftListResponseSchema,
  mailDraftResponseSchema,
  mailIdentityApprovalListResponseSchema,
  mailIdentityListResponseSchema,
  mailIdentityResponseSchema,
  mailIdentitySignatureResponseSchema,
  mailOutboxListResponseSchema,
  mailOutboxResponseSchema,
  mailPreferencesSchema,
  mailPresenceResponseSchema,
  mailRecipientSuggestResponseSchema,
  mailSignatureListResponseSchema,
  mailSignatureLogoResponseSchema,
  mailSignatureResponseSchema,
  mailSnippetResponseSchema,
  mailSnippetsResponseSchema,
  mailVerificationResponseSchema,
  updateMailDraftResponseSchema,
  type CreateMailDraftRequest,
  type CreateMailIdentityRequest,
  type MailIdentityApprovalRequest,
  type CreateMailSignatureRequest,
  type MailSnippetRequest,
  type SendMailDraftRequest,
  type UpdateMailDraftRequest,
  type UpdateMailIdentityRequest,
  type UpdateMailPreferencesRequest,
  type UpdateMailSignatureRequest,
  type CreateMailAccountInput,
  type IdentityConfirmation,
  type MailActionRequest,
  type MailListView,
  type UpdateMailSettingsRequest,
  type TestMailAccountRequest,
  type UpdateMailAccountAccessRequest,
  type UpdateMailAccountRequest,
  type UpdateTeamMailAccessRequest,
} from '@balesin/shared';
import { z } from 'zod';
import type { ApiClient } from './client';
import { queryString } from './endpoints-crm';

const deletedResponseSchema = z.object({ deleted: z.literal(true) });
const deletedAttachmentResponseSchema = z.object({
  deleted: z.literal(true),
  draft: z.object({ version: z.number().int().positive() }),
});
const mailPreferencesResponseSchema = mailPreferencesSchema;
/** Jawaban setujui/tolak belum dikunci kontrak (§20): cukup sukses; data identitas dimuat ulang. */
const approvalDecisionResponseSchema = z.object({}).loose();

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
      updateSettings: (body: UpdateMailSettingsRequest) =>
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
      // ── 9B: tulis, balas, teruskan (KONTRAK-API-EMAIL-TULIS) ──
      /** Pilihan "Dari": identitas semua akun ber-level ≥ send (yang belum terverifikasi ikut). */
      composeIdentities: (signal?: AbortSignal) =>
        client.request(routes.composeIdentities, {
          schema: mailComposeIdentityListResponseSchema,
          signal,
        }),
      accountIdentities: (accountId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.accountIdentities, { accountId }), {
          schema: mailIdentityListResponseSchema,
          signal,
        }),
      /** Alias akun bersama = wajib `confirmation` (+ `mail.accounts.manage`). */
      createIdentity: (accountId: string, body: CreateMailIdentityRequest) =>
        client.request(apiPath(routes.accountIdentities, { accountId }), {
          method: 'POST',
          body,
          schema: mailIdentityResponseSchema,
        }),
      updateIdentity: (identityId: string, body: UpdateMailIdentityRequest) =>
        client.request(apiPath(routes.identity, { identityId }), {
          method: 'PATCH',
          body,
          schema: mailIdentityResponseSchema,
        }),
      deleteIdentity: (identityId: string) =>
        client.request(apiPath(routes.identity, { identityId }), {
          method: 'DELETE',
          schema: deleteMailIdentityResponseSchema,
        }),
      /** Mulai / kirim ulang email verifikasi (202). */
      startVerification: (identityId: string) =>
        client.request(apiPath(routes.identityVerification, { identityId }), {
          method: 'POST',
          schema: mailVerificationResponseSchema,
        }),
      confirmVerification: (identityId: string, code: string) =>
        client.request(apiPath(routes.identityVerificationConfirm, { identityId }), {
          method: 'POST',
          body: { code },
          schema: mailIdentityResponseSchema,
        }),
      /** Review 9B S3: identitas akun pribadi berdomain organisasi menunggu persetujuan (Owner/Admin). */
      identityApprovals: (signal?: AbortSignal) =>
        client.request(routes.identityApprovals, {
          schema: mailIdentityApprovalListResponseSchema,
          signal,
        }),
      /** Setujui/tolak = wajib `confirmation`. */
      decideIdentityApproval: (identityId: string, body: MailIdentityApprovalRequest) =>
        client.request(apiPath(routes.identityApproval, { identityId }), {
          method: 'POST',
          body,
          schema: approvalDecisionResponseSchema,
        }),
      /** Tanda tangan efektif siap sisip (variabel terisi). */
      identitySignature: (identityId: string, purpose: 'new' | 'reply', signal?: AbortSignal) =>
        client.request(
          `${apiPath(routes.identitySignature, { identityId })}${queryString({ purpose })}`,
          { schema: mailIdentitySignatureResponseSchema, signal },
        ),
      signatures: (accountId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.accountSignatures, { accountId }), {
          schema: mailSignatureListResponseSchema,
          signal,
        }),
      createSignature: (accountId: string, body: CreateMailSignatureRequest) =>
        client.request(apiPath(routes.accountSignatures, { accountId }), {
          method: 'POST',
          body,
          schema: mailSignatureResponseSchema,
        }),
      updateSignature: (signatureId: string, body: UpdateMailSignatureRequest) =>
        client.request(apiPath(routes.signature, { signatureId }), {
          method: 'PATCH',
          body,
          schema: mailSignatureResponseSchema,
        }),
      deleteSignature: (signatureId: string) =>
        client.request(apiPath(routes.signature, { signatureId }), {
          method: 'DELETE',
          schema: deletedResponseSchema,
        }),
      setSignatureLogo: (signatureId: string, image: string) =>
        client.request(apiPath(routes.signatureLogo, { signatureId }), {
          method: 'PUT',
          body: { image },
          schema: mailSignatureLogoResponseSchema,
        }),
      removeSignatureLogo: (signatureId: string) =>
        client.request(apiPath(routes.signatureLogo, { signatureId }), {
          method: 'DELETE',
          schema: mailSignatureLogoResponseSchema,
        }),
      preferences: (signal?: AbortSignal) =>
        client.request(routes.preferences, { schema: mailPreferencesResponseSchema, signal }),
      updatePreferences: (body: UpdateMailPreferencesRequest) =>
        client.request(routes.preferences, {
          method: 'PUT',
          body,
          schema: mailPreferencesResponseSchema,
        }),
      drafts: (params: { accountId?: string; cursor?: string | null }, signal?: AbortSignal) =>
        client.request(`${routes.drafts}${queryString({ ...params })}`, {
          schema: mailDraftListResponseSchema,
          signal,
        }),
      createDraft: (body: CreateMailDraftRequest) =>
        client.request(routes.drafts, {
          method: 'POST',
          body,
          schema: createMailDraftResponseSchema,
        }),
      draft: (draftId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.draft, { draftId }), {
          schema: mailDraftResponseSchema,
          signal,
        }),
      /** Simpan otomatis; versi basi → 409 `draft_version_conflict`. */
      updateDraft: (draftId: string, body: UpdateMailDraftRequest) =>
        client.request(apiPath(routes.draft, { draftId }), {
          method: 'PUT',
          body,
          schema: updateMailDraftResponseSchema,
        }),
      deleteDraft: (draftId: string) =>
        client.request(apiPath(routes.draft, { draftId }), {
          method: 'DELETE',
          schema: deleteMailDraftResponseSchema,
        }),
      checkDraft: (draftId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.draftCheck, { draftId }), {
          method: 'POST',
          schema: mailDraftCheckResponseSchema,
          signal,
        }),
      /** 202 baru / 200 `duplicate` (klik ganda); 409 `thread_has_new_messages` dsb. */
      sendDraft: (draftId: string, body: SendMailDraftRequest) =>
        client.request(apiPath(routes.draftSend, { draftId }), {
          method: 'POST',
          body,
          schema: mailOutboxResponseSchema,
        }),
      /** Penanda "sedang membalas": `true` = detak (tiap 20 dtk), `false` = keluar. */
      presence: (draftId: string, active: boolean) =>
        client.request(apiPath(routes.draftPresence, { draftId }), {
          method: active ? 'PUT' : 'DELETE',
          schema: mailPresenceResponseSchema,
        }),
      snippet: (draftId: string, body: MailSnippetRequest) =>
        client.request(apiPath(routes.draftSnippet, { draftId }), {
          method: 'POST',
          body,
          schema: mailSnippetResponseSchema,
        }),
      /** Unggah lampiran draf (multipart `file`); `inline` = gambar di badan email. */
      uploadAttachment: (
        draftId: string,
        file: File,
        options: {
          inline?: boolean;
          signal?: AbortSignal;
          onProgress?: (fraction: number) => void;
        } = {},
      ) => {
        const form = new FormData();
        if (options.inline) form.append('inline', 'true');
        form.append('file', file, file.name);
        return client.upload(apiPath(routes.draftAttachments, { draftId }), {
          body: form,
          schema: mailDraftAttachmentResponseSchema,
          signal: options.signal,
          onProgress: options.onProgress,
        });
      },
      attachFromMessage: (draftId: string, attachmentIds: string[]) =>
        client.request(apiPath(routes.draftAttachmentsFromMessage, { draftId }), {
          method: 'POST',
          body: { attachmentIds },
          schema: mailDraftAttachmentsFromMessageResponseSchema,
        }),
      deleteAttachment: (draftId: string, attachmentId: string) =>
        client.request(apiPath(routes.draftAttachment, { draftId, attachmentId }), {
          method: 'DELETE',
          schema: deletedAttachmentResponseSchema,
        }),
      outbox: (state: 'active' | 'failed' | 'recent', signal?: AbortSignal) =>
        client.request(`${routes.outbox}${queryString({ state })}`, {
          schema: mailOutboxListResponseSchema,
          signal,
        }),
      outboxItem: (outboxId: string, signal?: AbortSignal) =>
        client.request(apiPath(routes.outboxItem, { outboxId }), {
          schema: mailOutboxResponseSchema,
          signal,
        }),
      /** Batalkan kirim (hanya `pending`/`queued`; selain itu 409 `not_cancelable`). */
      cancelOutbox: (outboxId: string) =>
        client.request(apiPath(routes.outboxCancel, { outboxId }), {
          method: 'POST',
          schema: cancelMailOutboxResponseSchema,
        }),
      sendOutboxNow: (outboxId: string) =>
        client.request(apiPath(routes.outboxSendNow, { outboxId }), {
          method: 'POST',
          schema: mailOutboxResponseSchema,
        }),
      composeSnippets: (q: string, signal?: AbortSignal) =>
        client.request(`${routes.composeSnippets}${queryString({ q: q || undefined })}`, {
          schema: mailSnippetsResponseSchema,
          signal,
        }),
      suggestRecipients: (q: string, accountId: string | undefined, signal?: AbortSignal) =>
        client.request(`${routes.recipientSuggest}${queryString({ q, accountId })}`, {
          schema: mailRecipientSuggestResponseSchema,
          signal,
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
