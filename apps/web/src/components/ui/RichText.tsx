import { Fragment } from 'react';
import styles from './RichText.module.css';

/**
 * Teks UI dengan kode sebaris dan penekanan: bagian di antara backtick (`SETUP_TOKEN`) ditampilkan
 * sebagai `<code>` (JetBrains Mono, DESIGN.md §1), bagian di antara `**…**` sebagai `<strong>`
 * (nama tombol/menu di layar pihak lain, mis. **Verifikasi dan simpan** di Meta). Teks tetap teks
 * biasa — tidak pernah HTML.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={index} className={styles.code}>
            {part.slice(1, -1)}
          </code>
        ) : part.length > 4 && part.startsWith('**') && part.endsWith('**') ? (
          <strong key={index} className={styles.strong}>
            {part.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
