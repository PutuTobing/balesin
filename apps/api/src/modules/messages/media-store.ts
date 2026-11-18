/**
 * Penyimpanan media di disk (`MEDIA_DIR`). Sejak Fase 6 tinggal di `@balesin/core` supaya worker
 * (lampiran email masuk) memakai penyimpanan yang SAMA dengan api — berkas ini hanya meneruskan.
 */
export {
  MediaTooLargeError,
  contentDisposition,
  createMediaStore,
  type MediaFolder,
  type MediaStore,
  type MediaWriter,
  type StoredFile,
} from '@balesin/core';
