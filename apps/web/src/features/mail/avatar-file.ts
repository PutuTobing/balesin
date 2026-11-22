import { MAIL_AVATAR_UPLOAD_MAX_BYTES } from '@balesin/shared';
import { t } from '../../i18n/id';

const w = t.mail.wizard;

/** Foto/logo yang dipilih di browser: base64 untuk `PUT …/avatar` + `data:` URL untuk pratinjau. */
export interface AvatarDraft {
  base64: string;
  dataUrl: string;
}

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Baca berkas foto akun: PNG/JPEG/WebP ≤ 1 MB (server memeriksa ulang isi & memotong persegi). */
export function readAvatarFile(file: File): Promise<AvatarDraft> {
  return new Promise((resolve, reject) => {
    if (!AVATAR_TYPES.includes(file.type)) {
      reject(new Error(w.photoWrongType));
      return;
    }
    if (file.size > MAIL_AVATAR_UPLOAD_MAX_BYTES) {
      reject(new Error(w.photoTooBig));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(w.photoWrongType));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma === -1) {
        reject(new Error(w.photoWrongType));
        return;
      }
      resolve({ base64: dataUrl.slice(comma + 1), dataUrl });
    };
    reader.readAsDataURL(file);
  });
}
