import { CircleAlert, X } from 'lucide-react';
import {
  useId,
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
  /**
   * Ketikan yang belum jadi chip, dikendalikan pemanggil (mis. supaya bisa diperiksa saat kirim).
   * Tanpa ini komponen menyimpannya sendiri.
   */
  draft?: string;
  /** `reason`: `input` = diketik pengguna, `commit` = sisa setelah dijadikan chip. */
  onDraftChange?: (draft: string, reason: 'input' | 'commit') => void;
  /** Galat kolom ini, tampil tepat di bawah kotak (ikon + teks) dan dikaitkan ke kolom ketik. */
  error?: string | null;
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
  draft: controlledDraft,
  onDraftChange,
  error,
  flagged,
  flagLabel,
  flagDescription,
  removeLabel,
  removedAnnouncement,
  placeholder,
  inputDisabled = false,
  disabled = false,
  describedBy,
  ref,
  trailing,
  className,
}: AddressChipsProps) {
  const [ownDraft, setOwnDraft] = useState('');
  const draft = controlledDraft ?? ownDraft;
  const setDraft = (next: string, reason: 'input' | 'commit' = 'commit') => {
    if (controlledDraft === undefined) setOwnDraft(next);
    onDraftChange?.(next, reason);
  };
  const [announcement, setAnnouncement] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const focusInput = () => boxRef.current?.querySelector('input')?.focus();
  const errorId = `${useId()}-galat`;
  const invalid = Boolean(error);

  const commit = (raw: string) => {
    if (raw.trim() === '') {
      if (draft !== '') setDraft('');
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
    <div className={styles.field}>
      <div
        ref={boxRef}
        className={cx(styles.box, className)}
        data-invalid={invalid ? '' : undefined}
        data-disabled={disabled ? '' : undefined}
        onClick={(event) => {
          // Ketuk area kosong kotak → fokus ke kolom ketik.
          const target = event.target;
          if (
            target === event.currentTarget ||
            (target instanceof HTMLElement && target.dataset.flow !== undefined)
          ) {
            focusInput();
          }
        }}
      >
        {prefix ? (
          <span className={styles.prefix} aria-hidden="true">
            {prefix}
          </span>
        ) : null}
        {/* Chip & kolom ketik satu aliran: baris kedua sejajar chip pertama, bukan di bawah label. */}
        <div className={styles.flow} data-flow="">
          {addresses.length > 0 ? (
            <ul className={styles.chips} aria-label={inputLabel}>
              {addresses.map((address) => {
                const isFlagged = flagged?.has(address) ?? false;
                return (
                  <li
                    key={address}
                    className={styles.chip}
                    data-flagged={isFlagged ? '' : undefined}
                  >
                    <span className={styles.chipText} title={address}>
                      {address}
                    </span>
                    {isFlagged && flagLabel ? (
                      <span className={styles.flag}>
                        {flagLabel}
                        {flagDescription ? (
                          <span className="sr-only">, {flagDescription}</span>
                        ) : null}
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
            aria-describedby={
              [invalid ? errorId : null, describedBy].filter(Boolean).join(' ') || undefined
            }
            disabled={disabled || inputDisabled}
            onChange={(event) => setDraft(event.target.value, 'input')}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => commit(draft)}
          />
        </div>
        {trailing}
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>
      {error ? (
        <p id={errorId} className={styles.error} role="alert">
          <Icon icon={CircleAlert} size={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
