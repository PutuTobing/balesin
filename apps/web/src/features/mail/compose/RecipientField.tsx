import type { MailComposeAddress } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, History, UserRound, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Icon } from '../../../components/ui/Icon';
import { t } from '../../../i18n/id';
import { mailSuggestQuery } from '../mail-queries';
import { parseRecipientInput, recipientInitials, recipientLabel } from './compose-recipients';
import styles from './Compose.module.css';

const c = t.mail.compose;
const SUGGEST_DELAY_MS = 250;

interface RecipientFieldProps {
  /** Label baris yang tampil ("Kepada"). */
  label: string;
  /** Nama aksesibel kolom ketik ("Penerima (Kepada)"). */
  inputLabel: string;
  values: readonly MailComposeAddress[];
  /** Alamat sah dari ketikan/saran. Mengembalikan alamat yang ditolak karena duplikat. */
  onAdd: (items: MailComposeAddress[]) => string[];
  onRemove: (address: string) => void;
  /** Akun draf (saran riwayat dari akun itu). */
  accountId: string | null;
  disabled?: boolean;
  /** Isi tambahan di kanan baris (mis. tombol "Cc/Bcc", catatan "Tersembunyi"). */
  trailing?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  /** Alamat yang diberi penanda (mis. di luar domain kantor). */
  flagged?: ReadonlySet<string>;
}

/**
 * Kolom Kepada/Cc/Bcc berbentuk chip (mockup docs/design/email, keadaan Tulis): nama (atau alamat)
 * + avatar inisial, hapus per chip, Backspace di kolom kosong menghapus chip terakhir, tempel banyak
 * alamat sekaligus, dan saran penerima (kontak + riwayat kirim akun, q ≥ 2 karakter) sebagai
 * combobox. Semua alamat & nama tampil sebagai teks biasa.
 */
export function RecipientField({
  label,
  inputLabel,
  values,
  onAdd,
  onRemove,
  accountId,
  disabled = false,
  trailing,
  inputRef,
  flagged,
}: RecipientFieldProps) {
  const id = useId();
  const inputId = `${id}-ketik`;
  const listId = `${id}-saran`;
  const errorId = `${id}-galat`;
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  // Saran ditanyakan setelah ketikan berhenti sebentar (≤ 120/menit di server).
  useEffect(() => {
    const value = draft.trim();
    const timer = window.setTimeout(() => setQuery(value), SUGGEST_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const suggest = useQuery({
    ...mailSuggestQuery(query, accountId),
    enabled: open && query.length >= 2,
  });
  const existing = new Set(values.map((item) => item.address.toLowerCase()));
  const suggestions = (suggest.data?.suggestions ?? []).filter(
    (item) => !existing.has(item.address.toLowerCase()),
  );
  const showList = open && query.length >= 2 && draft.trim().length >= 2 && suggestions.length > 0;

  const commit = (raw: string) => {
    if (raw.trim() === '') {
      setDraft('');
      return;
    }
    const parsed = parseRecipientInput(raw);
    const duplicates = parsed.valid.length > 0 ? onAdd(parsed.valid) : [];
    if (parsed.invalid.length > 0) {
      setError(c.invalidAddress(parsed.invalid[0] ?? ''));
      setDraft(parsed.invalid.join(', '));
    } else {
      setError(duplicates.length > 0 ? c.duplicateAddress(duplicates[0] ?? '') : null);
      setDraft('');
    }
    setOpen(false);
  };

  const choose = (item: MailComposeAddress) => {
    onAdd([{ address: item.address, name: item.name }]);
    setDraft('');
    setError(null);
    setOpen(false);
    boxRef.current?.querySelector('input')?.focus();
  };

  const remove = (item: MailComposeAddress) => {
    onRemove(item.address);
    setAnnouncement(c.removedRecipient(recipientLabel(item)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (showList && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActive((current) => {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        return (current + delta + suggestions.length) % suggestions.length;
      });
      return;
    }
    if (event.key === 'Escape' && showList) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const picked = showList ? suggestions[active] : undefined;
      if (picked) choose(picked);
      else commit(draft);
      return;
    }
    if (event.key === ',' || event.key === ';') {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === 'Tab' && draft.trim() !== '') {
      const picked = showList ? suggestions[active] : undefined;
      if (picked) {
        event.preventDefault();
        choose(picked);
      } else {
        commit(draft);
      }
      return;
    }
    if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      event.preventDefault();
      const last = values.at(-1);
      if (last) remove(last);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/[\s,;<]/.test(pasted)) return;
    event.preventDefault();
    commit(`${draft} ${pasted}`);
  };

  const activeOption = showList ? `${listId}-${String(active)}` : undefined;

  return (
    <div className={styles.row} data-invalid={error ? '' : undefined}>
      <label className={styles.rowLabel} htmlFor={inputId}>
        {label}
      </label>
      <div
        ref={boxRef}
        className={styles.recipients}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            boxRef.current?.querySelector('input')?.focus();
          }
        }}
      >
        {values.length > 0 ? (
          <ul className={styles.chips} aria-label={inputLabel}>
            {values.map((item) => {
              const name = recipientLabel(item);
              const isFlagged = flagged?.has(item.address.toLowerCase()) ?? false;
              return (
                <li
                  key={item.address}
                  className={styles.chip}
                  data-flagged={isFlagged ? '' : undefined}
                  title={item.name ? `${item.name} <${item.address}>` : item.address}
                >
                  <span className={styles.chipAvatar} aria-hidden="true">
                    {recipientInitials(item)}
                  </span>
                  <span className={styles.chipText} dir="auto">
                    {name}
                  </span>
                  {item.name ? <span className="sr-only">{` <${item.address}>`}</span> : null}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={c.removeRecipient(name)}
                    disabled={disabled}
                    onClick={() => {
                      remove(item);
                      boxRef.current?.querySelector('input')?.focus();
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
          ref={inputRef}
          id={inputId}
          className={styles.recipientInput}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="next"
          multiple
          role="combobox"
          aria-label={inputLabel}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setOpen(true);
            setActive(0);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setOpen(true)}
          onBlur={(event) => {
            // Klik saran: jangan jadikan ketikan chip sebelum pilihan diproses.
            if (
              event.relatedTarget &&
              boxRef.current?.parentElement?.contains(event.relatedTarget)
            ) {
              return;
            }
            commit(draft);
          }}
        />
        <ul
          id={listId}
          role="listbox"
          aria-label={c.suggestionsLabel}
          className={styles.suggestions}
          hidden={!showList}
        >
          {suggestions.map((item, index) => (
            <li
              key={item.address}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === active}
              className={styles.suggestion}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item)}
            >
              <span className={styles.chipAvatar} aria-hidden="true">
                {recipientInitials(item)}
              </span>
              <span className={styles.suggestionText}>
                <span className={styles.suggestionName} dir="auto">
                  {item.name?.trim() || item.address}
                </span>
                <span className={styles.suggestionMeta}>
                  {item.name?.trim() ? `${item.address} · ` : ''}
                  {item.source === 'contact' ? c.suggestionContact : c.suggestionHistory}
                </span>
              </span>
              <Icon
                icon={item.source === 'contact' ? UserRound : History}
                size={16}
                className={styles.suggestionIcon}
              />
            </li>
          ))}
        </ul>
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>
      {trailing ? <div className={styles.rowTrailing}>{trailing}</div> : null}
      {error ? (
        <p id={errorId} className={styles.rowError} role="alert">
          <Icon icon={CircleAlert} size={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
