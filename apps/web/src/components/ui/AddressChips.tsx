import { X } from 'lucide-react';
import {
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from '../../lib/cx';
import styles from './AddressChips.module.css';
import { Icon } from './Icon';

interface AddressChipsProps {
  /** ID kolom ketik (untuk `<label htmlFor>`). */
  id?: string;
  /** Nama aksesibel kolom ketik, mis. "Alamat Cc". */
  inputLabel: string;
  /** Label pendek di kiri kotak, mis. "Cc" (disembunyikan dari pembaca layar: sudah di `inputLabel`). */
  prefix?: string;
  addresses: readonly string[];
  /**
   * Ketikan dikonfirmasi (Enter, koma, titik koma, spasi, Tab, tempel, atau keluar dari kolom).
   * Kembalikan sisa ketikan yang tetap di kolom (mis. alamat yang tidak sah supaya bisa diperbaiki).
   */
  onCommit: (raw: string) => string;
  onRemove: (address: string) => void;
  /** Alamat yang diberi penanda (mis. "baru"). */
  flagged?: ReadonlySet<string>;
  flagLabel?: string;
  /** Keterangan penanda untuk pembaca layar, mis. "belum pernah ada di utas ini". */
  flagDescription?: string;
  removeLabel: (address: string) => string;
  removedAnnouncement: (address: string) => string;
  placeholder?: string;
  /** Kolom ketik nonaktif (mis. batas tercapai); tombol hapus chip tetap bisa dipakai. */
  inputDisabled?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Diteruskan ke kolom ketik (fokus dari luar). */
  ref?: Ref<HTMLInputElement>;
  /** Isi tambahan di ujung kanan kotak (mis. tombol tutup). */
  trailing?: ReactNode;
  className?: string;
}

/** Tombol yang mengonfirmasi ketikan menjadi chip. */
const SEPARATOR_KEYS = new Set([',', ';', ' ']);

/**
 * Isian alamat email berbentuk chip: ketik lalu Enter/koma untuk menambah, Backspace di kolom
 * kosong menghapus chip terakhir, tempel banyak alamat sekaligus. Validasi & aturan (duplikat,
 * batas) milik pemanggil lewat `onCommit`. Alamat ditampilkan sebagai teks biasa.
 */
export function AddressChips({
  id,
  inputLabel,
  prefix,
  addresses,
  onCommit,
  onRemove,
  flagged,
  flagLabel,
  flagDescription,
  removeLabel,
  removedAnnouncement,
  placeholder,
  inputDisabled = false,
  disabled = false,
  invalid = false,
  describedBy,
  ref,
  trailing,
  className,
}: AddressChipsProps) {
  const [draft, setDraft] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const focusInput = () => boxRef.current?.querySelector('input')?.focus();

  const commit = (raw: string) => {
    if (raw.trim() === '') {
      setDraft('');
      return;
    }
    setDraft(onCommit(raw));
  };

  const remove = (address: string) => {
    onRemove(address);
    setAnnouncement(removedAnnouncement(address));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      // Enter di kolom alamat tidak pernah mengirim pesan/form.
      event.preventDefault();
      event.stopPropagation();
      commit(draft);
      return;
    }
    if (SEPARATOR_KEYS.has(event.key)) {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === 'Tab' && draft.trim() !== '') {
      commit(draft);
      return;
    }
    if (event.key === 'Backspace' && draft === '' && addresses.length > 0) {
      event.preventDefault();
      const last = addresses.at(-1);
      if (last) remove(last);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/[\s,;<]/.test(pasted)) return;
    event.preventDefault();
    commit(`${draft} ${pasted}`);
  };

  return (
    <div
      ref={boxRef}
      className={cx(styles.box, className)}
      data-invalid={invalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      onClick={(event) => {
        // Ketuk area kosong kotak → fokus ke kolom ketik.
        if (event.target === event.currentTarget) focusInput();
      }}
    >
      {prefix ? (
        <span className={styles.prefix} aria-hidden="true">
          {prefix}
        </span>
      ) : null}
      {addresses.length > 0 ? (
        <ul className={styles.chips} aria-label={inputLabel}>
          {addresses.map((address) => {
            const isFlagged = flagged?.has(address) ?? false;
            return (
              <li key={address} className={styles.chip} data-flagged={isFlagged ? '' : undefined}>
                <span className={styles.chipText} title={address}>
                  {address}
                </span>
                {isFlagged && flagLabel ? (
                  <span className={styles.flag}>
                    {flagLabel}
                    {flagDescription ? <span className="sr-only">, {flagDescription}</span> : null}
                  </span>
                ) : null}
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={removeLabel(address)}
                  disabled={disabled}
                  onClick={() => {
                    remove(address);
                    focusInput();
                  }}
                >
                  <Icon icon={X} size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <input
        ref={ref}
        id={id}
        type="email"
        inputMode="email"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        multiple
        className={styles.input}
        value={draft}
        placeholder={inputDisabled ? undefined : placeholder}
        aria-label={inputLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled || inputDisabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(draft)}
      />
      {trailing}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
