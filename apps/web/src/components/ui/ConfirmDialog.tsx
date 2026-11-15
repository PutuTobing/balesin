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
  const confirmColored = confirmVariant === 'primary' || confirmVariant === 'danger';
  const confirm = (
    <Button variant={confirmVariant} onClick={onConfirm}>
      {confirmLabel}
    </Button>
  );
  const cancel = (
    <Button ref={cancelRef} variant={confirmColored ? 'secondary' : 'primary'} onClick={onCancel}>
      {cancelLabel}
    </Button>
  );

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
          {/*
            Satu tombol berwarna per dialog, dan ia selalu TERAKHIR: kanan di desktop, paling atas di
            HP (`column-reverse`). Aksi berwarna (primer/merah) → batal berbingkai di depannya; aksi
            netral (mis. "Tinggalkan") → batal yang aman jadi tombol berwarna di belakangnya.
          */}
          <div className={styles.actions}>
            {confirmColored ? cancel : confirm}
            {confirmColored ? confirm : cancel}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
