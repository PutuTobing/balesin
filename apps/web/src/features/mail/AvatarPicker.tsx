import type { MailAccountColor } from '@balesin/shared';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { AccountMark } from './AccountMark';
import { AVATAR_TYPES, readAvatarFile, type AvatarDraft } from './avatar-file';
import styles from './Wizard.module.css';

const w = t.mail.wizard;

/**
 * Pemilih foto/logo akun (PRD §4.12): pratinjau bulat (inisial + warna bila kosong), Pilih/Ganti,
 * Hapus. `onPick(null)` = tanpa foto.
 */
export function AvatarPicker({
  displayName,
  color,
  value,
  onPick,
  disabled,
  label = w.photoLabel,
  hint = w.photoHint,
  labelAsTitle = false,
}: {
  displayName: string;
  color: MailAccountColor;
  /** URL pratinjau (`data:` dari pilihan baru, atau URL foto tersimpan). */
  value: string | null;
  onPick: (draft: AvatarDraft | null) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
  /** Label tampil sebagai judul kartu (halaman akun: kartu "Foto atau logo"). */
  labelAsTitle?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <div className={styles.avatarField} role="group" aria-labelledby={`${id}-label`}>
      {labelAsTitle ? (
        <h2 id={`${id}-label`} className={styles.cardTitle}>
          {label}
        </h2>
      ) : (
        <span id={`${id}-label`} className={styles.fieldLabel}>
          {label}
        </span>
      )}
      <div className={styles.avatarRow}>
        <AccountMark
          account={{ displayName: displayName || '?', color, avatarUrl: value }}
          variant="avatar"
          size="lg"
        />
        <div className={styles.avatarActions}>
          <input
            ref={inputRef}
            id={`${id}-berkas`}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setError(null);
              readAvatarFile(file).then(onPick, (caught: unknown) =>
                setError(caught instanceof Error ? caught.message : w.photoWrongType),
              );
            }}
          />
          <Button disabled={disabled} onClick={() => inputRef.current?.click()}>
            <Icon icon={ImagePlus} size={16} />
            {value ? w.photoChange : w.photoChoose}
          </Button>
          {value ? (
            <Button variant="ghost" disabled={disabled} onClick={() => onPick(null)}>
              <Icon icon={Trash2} size={16} />
              {w.photoRemove}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.fieldHint}>{hint}</p>
      )}
    </div>
  );
}
