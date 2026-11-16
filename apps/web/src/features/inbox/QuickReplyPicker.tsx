import type { QuickReply } from '@balesin/shared';
import { Link } from '@tanstack/react-router';
import { t } from '../../i18n/id';
import { useCan } from '../auth/session';
import styles from './QuickReplyPicker.module.css';

const q = t.inbox.quickReplies;
interface PickerProps {
  id: string;
  search: string;
  activeIndex: number;
  onActiveChange: (index: number) => void;
  onPick: (quickReply: QuickReply) => void;
  /** Pilihan yang tampil sekarang (untuk navigasi panah di composer). */
  items: QuickReply[];
  loading: boolean;
  failed: boolean;
}

/**
 * Daftar template di atas composer (listbox). Kolom tulis tetap memegang fokus; panah atas/bawah
 * memindah pilihan aktif (`aria-activedescendant`), Enter/Tab memilih, Escape menutup.
 */
export function QuickReplyPicker({
  id,
  search,
  activeIndex,
  onActiveChange,
  onPick,
  items,
  loading,
  failed,
}: PickerProps) {
  const canManage = useCan('quick_replies.manage');
  return (
    <div className={styles.picker}>
      <p className={styles.heading}>{q.title}</p>
      {failed ? (
        <p className={styles.note}>{q.failed}</p>
      ) : loading && items.length === 0 ? (
        <p className={styles.note}>{t.common.loading}</p>
      ) : items.length === 0 ? (
        <div className={styles.note}>
          <p>{search ? q.notFound(search) : q.empty}</p>
          {canManage ? (
            <Link to="/pengaturan/balasan-cepat" className={styles.manage}>
              {q.manage}
            </Link>
          ) : null}
        </div>
      ) : (
        <ul id={id} role="listbox" aria-label={q.title} className={styles.list}>
          {items.map((item, index) => (
            <li
              key={item.id}
              id={`${id}-${item.id}`}
              role="option"
              aria-selected={index === activeIndex}
              className={styles.option}
              // Klik mouse tidak boleh mencuri fokus dari kolom tulis.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActiveChange(index)}
              onClick={() => onPick(item)}
            >
              <span className={styles.shortcut}>/{item.shortcut}</span>
              <span className={styles.texts}>
                <span className={styles.titleText}>{item.title}</span>
                <span className={styles.body} dir="auto">
                  {item.body}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.hint} aria-hidden="true">
        {q.keysHint}
      </p>
    </div>
  );
}
