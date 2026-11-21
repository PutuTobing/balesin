import type { ReactNode } from 'react';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import type { Lock } from '../../lib/use-lock';
import { Notice } from './Notice';

interface FormErrorNoticeProps {
  /** Error terakhir dari server (atau jaringan). `null` = tidak ada pesan. */
  error: unknown;
  /** Kunci 429 milik form ini (`useLock`), yang juga mengunci tombolnya dengan hitung mundur. */
  lock: Lock;
  /** Judul selama terkunci, pola "… dikunci sementara" / "… dibatasi sementara". */
  lockedTitle: string;
  /** Judul untuk gagal biasa (bawaan tanpa judul). */
  failedTitle?: string;
  /** Teks setelah hitung mundur habis (bawaan `t.api.unlocked`). */
  unlockedText?: string;
  /** Tombol di dalam kotak (mis. "Tutup", "Coba lagi"). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Pesan server di bawah tombol form — satu pola untuk semua form (kritikus akhir Fase 1 W2):
 *  - terkunci (429, hitung mundur berjalan) → kotak kuning berjudul + pesan server;
 *  - hitung mundur habis → kotak kuning hilang, diganti kotak info "Sudah bisa dicoba lagi."
 *    (pesan server yang menyebut durasi sudah basi);
 *  - gagal lain → kotak merah tanpa judul.
 * Pemanggil merender komponen ini selama `error` ada; mengirim ulang form mengosongkan `error`.
 */
export function FormErrorNotice({
  error,
  lock,
  lockedTitle,
  failedTitle,
  unlockedText,
  actions,
  className,
}: FormErrorNoticeProps) {
  if (!error) return null;
  const limited = isApiError(error) && error.status === 429;
  if (limited && lock.unlocked) {
    return (
      <Notice tone="info" role="status" actions={actions} className={className}>
        {unlockedText ?? t.api.unlocked}
      </Notice>
    );
  }
  const message = isApiError(error) ? error.message : t.api.network;
  if (lock.locked) {
    return (
      <Notice
        tone="warning"
        role="alert"
        title={lockedTitle}
        actions={actions}
        className={className}
      >
        {message}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" role="alert" title={failedTitle} actions={actions} className={className}>
      {message}
    </Notice>
  );
}
