import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import styles from './ConfirmDialog.module.css';

interface DialogProps {
  open: boolean;
  title: string;
  /** Teks penjelasan di bawah judul (dikaitkan lewat `aria-describedby`). */
  description?: ReactNode;
  /** Escape atau permintaan tutup lain dari browser. */
  onRequestClose: () => void;
  /** Elemen yang difokus saat dialog terbuka (bawaan: elemen pertama yang bisa difokus). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * Dialog bawaan browser (`<dialog>` + `showModal()`) untuk isi yang lebih kaya dari
 * `ConfirmDialog`: fokus terkurung, latar tidak bisa diklik, Escape = `onRequestClose`. Tanpa
 * `<style>` sisipan (CSP `style-src 'self'`). Gaya sama dengan `ConfirmDialog`.
 */
export function Dialog({
  open,
  title,
  description,
  onRequestClose,
  initialFocusRef,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      const target =
        initialFocusRef?.current ??
        dialog.querySelector<HTMLElement>('button:not(:disabled), [href], input, [tabindex]');
      target?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open, initialFocusRef]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={description ? bodyId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onRequestClose();
      }}
    >
      {open ? (
        <div className={styles.content}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {description ? (
            <div id={bodyId} className={styles.body}>
              {description}
            </div>
          ) : null}
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * Baris tombol dialog (kanan di desktop, bertumpuk penuh di HP). `sticky`: untuk form panjang —
 * tombol menempel di dasar dialog, isi di atasnya yang bergulir.
 */
export function DialogActions({
  children,
  sticky = false,
}: {
  children: ReactNode;
  sticky?: boolean;
}) {
  return (
    <div className={sticky ? `${styles.actions} ${styles.actionsSticky}` : styles.actions}>
      {children}
    </div>
  );
}
