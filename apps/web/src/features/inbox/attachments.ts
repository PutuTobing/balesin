import { OUTBOUND_MEDIA_LIMITS, type OutboundMediaKind } from '@balesin/shared';
import { t } from '../../i18n/id';

const k = t.inbox.compose;

/** Jenis berkas yang ditawarkan pemilih berkas (server tetap memeriksa isi berkas). */
export const ACCEPT = Object.values(OUTBOUND_MEDIA_LIMITS)
  .flatMap((limit) => limit.mimeTypes)
  .join(',');

/** Jenis media menurut tipe berkas dari browser (perkiraan; server memeriksa isi berkas). */
export function guessMediaKind(file: Pick<File, 'type' | 'name'>): OutboundMediaKind | null {
  for (const [kind, limit] of Object.entries(OUTBOUND_MEDIA_LIMITS)) {
    if (limit.mimeTypes.includes(file.type)) return kind as OutboundMediaKind;
  }
  if (/\.(pdf|docx?|xlsx?|pptx?|txt)$/i.test(file.name)) return 'document';
  return null;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Periksa cepat sebelum mengunggah (server tetap penentu: 413/415). */
export function checkAttachment(file: File): string | null {
  const kind = guessMediaKind(file);
  if (!kind) return k.fileUnsupported;
  const limit = OUTBOUND_MEDIA_LIMITS[kind].maxBytes;
  return file.size > limit ? k.fileTooLarge(megabytes(limit)) : null;
}
