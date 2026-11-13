import { Fragment } from 'react';
import styles from './RichText.module.css';

/**
 * Teks UI dengan kode sebaris: bagian di antara backtick (`SETUP_TOKEN`) ditampilkan sebagai
 * `<code>` (JetBrains Mono, DESIGN.md §1). Teks tetap teks biasa — tidak pernah HTML.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={index} className={styles.code}>
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
