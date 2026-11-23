import {
  MAIL_ATTACHMENT_TOTAL_MB,
  MAIL_DRAFT_ATTACHMENTS_MAX,
  MAIL_DRAFT_INLINE_IMAGE_MAX_BYTES,
  type MailDraftAttachment,
} from '@balesin/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../../i18n/id';
import { isApiError } from '../../../lib/api/client';
import { endpoints } from '../../../lib/api/endpoints';
import { useLatest } from './use-latest';

const a = t.mail.compose.attachments;

/**
 * Daftar izin lampiran keluar 9.1 (KONTRAK-API-EMAIL-TULIS §8) dari akhiran nama — hanya supaya
 * penolakan terasa langsung. Server memeriksa ISI berkas (bukan nama) dan tetap penentu.
 */
const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'txt',
]);
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const DEFAULT_ATTACHMENT_MAX_BYTES = MAIL_ATTACHMENT_TOTAL_MB.default * 1024 * 1024;

export type LocalRejection = 'type' | 'too_large' | 'too_many' | 'inline_type';

/** Pemeriksaan sebelum unggah (jenis dari nama, total ukuran, jumlah berkas). */
export function rejectBeforeUpload(
  file: Pick<File, 'name' | 'size' | 'type'>,
  context: { totalBytes: number; count: number; maxBytes: number; inline?: boolean },
): LocalRejection | null {
  if (context.inline) {
    if (!INLINE_TYPES.has(file.type) || file.size > MAIL_DRAFT_INLINE_IMAGE_MAX_BYTES) {
      return 'inline_type';
    }
  } else {
    const ext = file.name.toLowerCase().split('.').at(-1) ?? '';
    if (!file.name.includes('.') || !ALLOWED_EXTENSIONS.has(ext)) return 'type';
  }
  if (context.count >= MAIL_DRAFT_ATTACHMENTS_MAX) return 'too_many';
  if (context.totalBytes + file.size > context.maxBytes) return 'too_large';
  return null;
}

export function rejectionMessage(reason: LocalRejection, maxBytes: number): string {
  if (reason === 'type') return a.blockedType;
  if (reason === 'too_many') return a.tooMany;
  if (reason === 'inline_type') return t.mail.compose.imageOnlyRaster;
  return a.tooLarge(Math.round(maxBytes / (1024 * 1024)));
}

export interface UploadItem {
  localId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  progress: number;
  state: 'uploading' | 'failed';
  error: string | null;
  inline: boolean;
}

interface Options {
  draftId: string;
  initial: readonly MailDraftAttachment[];
  maxBytes: number;
  /** Unggah/hapus menaikkan versi draf. */
  onVersion: (version: number) => void;
  /** Gambar inline selesai diunggah: sisipkan ke editor. */
  onInlineReady?: (attachment: MailDraftAttachment) => void;
}

/**
 * Lampiran draf: unggah dengan progres (bisa dibatalkan), hapus, tolak jenis/ukuran, dan lampiran
 * asli (teruskan) yang masih disiapkan server — draf ditanya ulang sampai siap.
 */
export function useDraftAttachments({
  draftId,
  initial,
  maxBytes,
  onVersion,
  onInlineReady,
}: Options) {
  const [attachments, setAttachments] = useState<MailDraftAttachment[]>(() => [...initial]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const counter = useRef(0);
  const callbacks = useLatest({ onVersion, onInlineReady });

  const totalBytes =
    attachments.reduce((sum, item) => sum + item.sizeBytes, 0) +
    uploads
      .filter((item) => item.state === 'uploading')
      .reduce((sum, item) => sum + item.sizeBytes, 0);

  const patchUpload = (localId: string, patch: Partial<UploadItem>) =>
    setUploads((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );

  const add = useCallback(
    (files: readonly File[], options: { inline?: boolean } = {}) => {
      let running = totalBytes;
      let count = attachments.length + uploads.filter((item) => item.state === 'uploading').length;
      for (const file of files) {
        counter.current += 1;
        const localId = `unggah-${String(counter.current)}`;
        const base: UploadItem = {
          localId,
          filename: file.name,
          sizeBytes: file.size,
          contentType: file.type,
          progress: 0,
          state: 'uploading',
          error: null,
          inline: options.inline ?? false,
        };
        const rejected = rejectBeforeUpload(file, {
          totalBytes: running,
          count,
          maxBytes,
          inline: options.inline,
        });
        if (rejected) {
          setUploads((current) => [
            ...current,
            { ...base, state: 'failed', error: rejectionMessage(rejected, maxBytes) },
          ]);
          continue;
        }
        running += file.size;
        count += 1;
        const controller = new AbortController();
        controllers.current.set(localId, controller);
        setUploads((current) => [...current, base]);
        void endpoints.mail
          .uploadAttachment(draftId, file, {
            inline: options.inline,
            signal: controller.signal,
            onProgress: (fraction) => patchUpload(localId, { progress: fraction }),
          })
          .then((response) => {
            controllers.current.delete(localId);
            setUploads((current) => current.filter((item) => item.localId !== localId));
            setAttachments((current) => [...current, response.attachment]);
            callbacks.current.onVersion(response.draft.version);
            if (response.attachment.inline) callbacks.current.onInlineReady?.(response.attachment);
          })
          .catch((error: unknown) => {
            controllers.current.delete(localId);
            if (controller.signal.aborted) {
              setUploads((current) => current.filter((item) => item.localId !== localId));
              return;
            }
            patchUpload(localId, {
              state: 'failed',
              error: isApiError(error) ? error.message : t.api.network,
            });
          });
      }
    },
    [attachments.length, callbacks, draftId, maxBytes, totalBytes, uploads],
  );

  const cancel = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
  }, []);

  const dismiss = useCallback((localId: string) => {
    setUploads((current) => current.filter((item) => item.localId !== localId));
  }, []);

  const [removeError, setRemoveError] = useState<string | null>(null);
  const remove = useCallback(
    async (attachment: MailDraftAttachment) => {
      setRemoveError(null);
      // Langsung hilang dari daftar; dikembalikan bila server menolak.
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      try {
        const response = await endpoints.mail.deleteAttachment(draftId, attachment.id);
        callbacks.current.onVersion(response.draft.version);
      } catch (error) {
        setAttachments((current) => [...current, attachment]);
        setRemoveError(isApiError(error) ? error.message : t.api.network);
      }
    },
    [callbacks, draftId],
  );

  // Lampiran asli yang masih disiapkan server (teruskan): tanya ulang draf tiap 3 dtk.
  const loading = attachments.some((item) => item.state === 'loading');
  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => {
      void endpoints.mail
        .draft(draftId)
        .then((response) => {
          const byId = new Map(response.draft.attachments.map((item) => [item.id, item]));
          setAttachments((current) => current.map((item) => byId.get(item.id) ?? item));
        })
        .catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [draftId, loading]);

  // Jendela ditutup: unggahan yang masih jalan dibatalkan.
  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const controller of map.values()) controller.abort();
    };
  }, []);

  return {
    attachments,
    uploads,
    totalBytes,
    busy: uploads.some((item) => item.state === 'uploading') || loading,
    add,
    cancel,
    dismiss,
    remove,
    removeError,
    clearRemoveError: () => setRemoveError(null),
  };
}
