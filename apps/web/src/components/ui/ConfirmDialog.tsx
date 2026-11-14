import { useEffect, useId, useRef } from 'react';
import { Button, type ButtonVariant } from './Button';
import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  /** Aksi aman (tetap di sini). Mendapat fokus saat dialog terbuka. */
  cancelLabel: string;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Konfirmasi sebelum tindakan yang tidak bisa dibatalkan, memakai `<dialog>` bawaan browser
 * (bukan dialog Radix mode modal yang menyuntikkan `<style>` inline). Escape = batal.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  cancelLabel,
  confirmLabel,
  confirmVariant = 'secondary',
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        // Escape: tutup lewat state supaya React dan elemen tetap selaras.
        event.preventDefault();
        onCancel();
      }}
    >
      {open ? (
        <div className={styles.content}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <p id={bodyId} className={styles.body}>
            {body}
          </p>
          <div className={styles.actions}>
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmLabel}
            </Button>
            <Button ref={cancelRef} variant="primary" onClick={onCancel}>
              {cancelLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
