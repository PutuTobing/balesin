import { Search, X } from 'lucide-react';
import { useRef } from 'react';
import { Icon } from './Icon';
import styles from './SearchField.module.css';

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Nama aksesibel kolom (tidak tampil). */
  label: string;
  placeholder: string;
  clearLabel: string;
}

export function SearchField({ value, onChange, label, placeholder, clearLabel }: SearchFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={styles.field}>
      <Icon icon={Search} size={16} className={styles.icon} />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        className={styles.input}
      />
      {value ? (
        <button
          type="button"
          aria-label={clearLabel}
          className={styles.clear}
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        >
          <Icon icon={X} size={16} />
        </button>
      ) : null}
    </div>
  );
}
