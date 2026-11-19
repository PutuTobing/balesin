import { LOGO_CONTENT_TYPES, type LogoContentType } from '@balesin/shared';

/** Logo yang dipilih di browser, siap dikirim (wizard setup, Pengaturan → Merek). */
export interface LogoDraft {
  contentType: LogoContentType;
  /** Isi berkas base64 tanpa awalan `data:`. */
  dataBase64: string;
  /** `data:` URL untuk pratinjau. */
  dataUrl: string;
  name: string;
  size: number;
}

export function isLogoType(type: string): type is LogoContentType {
  return (LOGO_CONTENT_TYPES as readonly string[]).includes(type);
}

/** Baca berkas logo jadi base64 (tanpa awalan `data:`); gagal = `Error(unreadableMessage)`. */
export function readLogoFile(file: File, unreadableMessage: string): Promise<LogoDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(unreadableMessage));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma === -1 || !isLogoType(file.type)) {
        reject(new Error(unreadableMessage));
        return;
      }
      resolve({
        contentType: file.type,
        dataBase64: dataUrl.slice(comma + 1),
        dataUrl,
        name: file.name,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}
