import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { cx } from '../../../lib/cx';
import {
  htmlToPlainText,
  sanitizeToFragment,
  serializeEditor,
  type CidResolver,
} from './compose-html';
import { useLatest } from './use-latest';
import styles from './Compose.module.css';

export type EditorCommand =
  'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList' | 'blockquote';

export interface EditorHandle {
  getHtml: () => string;
  /** Ganti seluruh isi (mis. versi terbaru dari server). */
  setHtml: (html: string) => void;
  /** Sisipkan HTML di posisi kursor terakhir. Mengembalikan jumlah gambar yang dibuang. */
  insertHtml: (html: string) => number;
  insertImage: (contentId: string, alt: string) => void;
  /** Ganti isi blok `data-signature` (atau tambahkan di akhir); `html` kosong = buang blok. */
  replaceSignature: (html: string, signatureId: string | null) => void;
  signatureId: () => string | null;
  exec: (command: EditorCommand) => void;
  /** Pasang tautan pada teks terpilih (atau sisipkan URL-nya bila tidak ada yang dipilih). */
  link: (url: string) => void;
  /** Teks terpilih saat ini (untuk isian tautan). */
  selectedText: () => string;
  /** Simpan posisi kursor (sebelum fokus pindah ke menu/isian). */
  rememberSelection: () => void;
  focus: () => void;
}

interface ComposeEditorProps {
  ref?: Ref<EditorHandle>;
  initialHtml: string;
  resolveCid: CidResolver;
  label: string;
  placeholder?: string;
  describedBy?: string;
  onChange: () => void;
  /** `/` di baris kosong: buka menu template. */
  onSlash?: () => void;
  /** Tempelan memuat gambar luar yang tidak ikut. */
  onImagesDropped?: () => void;
  /** Berkas ditempel/dilepas di editor. */
  onFiles?: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
}

function exec(command: string, value?: string): void {
  try {
    document.execCommand(command, false, value);
  } catch {
    // Browser tanpa `execCommand` (jsdom): abaikan, isi tetap bisa diketik.
  }
}

/**
 * Editor isi email (KONTRAK-API-EMAIL-TULIS §6.4): `contenteditable` dengan isi yang SELALU dibangun
 * ulang lewat `sanitizeToFragment` (draf, tanda tangan, template, tempelan, seretan). Kutipan email
 * asli tidak pernah masuk ke sini (tampil di iframe ber-token terpisah).
 */
export function ComposeEditor({
  ref,
  initialHtml,
  resolveCid,
  label,
  placeholder,
  describedBy,
  onChange,
  onSlash,
  onImagesDropped,
  onFiles,
  disabled = false,
  className,
}: ComposeEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const resolver = useLatest(resolveCid);

  const markEmpty = () => {
    const root = rootRef.current;
    if (!root) return;
    const empty =
      htmlToPlainText(serializeEditor(root)).trim() === '' && !root.querySelector('img');
    if (empty) root.setAttribute('data-empty', '');
    else root.removeAttribute('data-empty');
  };

  const fill = (html: string) => {
    const root = rootRef.current;
    if (!root) return 0;
    const { fragment, droppedImages } = sanitizeToFragment(html, document, (cid) =>
      resolver.current(cid),
    );
    root.replaceChildren(fragment);
    if (!root.firstChild) root.appendChild(paragraph());
    markEmpty();
    return droppedImages;
  };

  // Isi awal dipasang sekali; sesudahnya editor tidak dikendalikan React.
  useLayoutEffect(() => {
    fill(initialHtml);
    exec('defaultParagraphSeparator', 'p');
    exec('styleWithCSS', 'false');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ingat posisi kursor di editor supaya menu (template, tautan) bisa menyisipkan di tempat itu.
  useEffect(() => {
    const onSelection = () => {
      const root = rootRef.current;
      const selection = document.getSelection();
      if (!root || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer)) savedRange.current = range.cloneRange();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  const restoreRange = (): Range => {
    const root = rootRef.current as HTMLDivElement;
    const range =
      savedRange.current && root.contains(savedRange.current.commonAncestorContainer)
        ? savedRange.current
        : endRange(root);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  };

  const insertFragment = (fragment: DocumentFragment) => {
    const root = rootRef.current;
    if (!root) return;
    root.focus({ preventScroll: true });
    const range = restoreRange();
    range.deleteContents();
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(after);
      savedRange.current = after.cloneRange();
    }
    markEmpty();
    onChange();
  };

  useImperativeHandle(ref, () => ({
    getHtml: () => (rootRef.current ? serializeEditor(rootRef.current) : ''),
    setHtml: (html) => {
      fill(html);
    },
    insertHtml: (html) => {
      const { fragment, droppedImages } = sanitizeToFragment(html, document, (cid) =>
        resolver.current(cid),
      );
      insertFragment(fragment);
      return droppedImages;
    },
    insertImage: (contentId, alt) => {
      const { fragment } = sanitizeToFragment(
        `<img src="cid:${contentId}" alt="${alt.replace(/[<>"&]/g, '')}">`,
        document,
        (cid) => resolver.current(cid),
      );
      insertFragment(fragment);
    },
    replaceSignature: (html, signatureId) => {
      const root = rootRef.current;
      if (!root) return;
      const block = root.querySelector('div[data-signature]');
      if (!html.trim() || signatureId === null) {
        block?.remove();
      } else {
        const { fragment } = sanitizeToFragment(html, document, (cid) => resolver.current(cid));
        // Server mengirim tanda tangan sudah terbungkus `<div data-signature>`: ambil isinya.
        const only = fragment.childNodes.length === 1 ? fragment.firstChild : null;
        if (only instanceof HTMLElement && only.hasAttribute('data-signature')) {
          fragment.replaceChildren(...Array.from(only.childNodes));
        }
        const target = block ?? document.createElement('div');
        target.setAttribute('data-signature', signatureId);
        target.replaceChildren(fragment);
        if (!block) root.appendChild(target);
      }
      if (!root.firstChild) root.appendChild(paragraph());
      markEmpty();
      onChange();
    },
    signatureId: () =>
      rootRef.current?.querySelector('div[data-signature]')?.getAttribute('data-signature') ?? null,
    exec: (command) => {
      rootRef.current?.focus({ preventScroll: true });
      if (savedRange.current) restoreRange();
      if (command === 'blockquote') exec('formatBlock', 'blockquote');
      else exec(command);
      markEmpty();
      onChange();
    },
    link: (url) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus({ preventScroll: true });
      const range = restoreRange();
      if (range.collapsed) {
        const anchor = document.createElement('a');
        anchor.setAttribute('href', url);
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.setAttribute('target', '_blank');
        anchor.textContent = url.replace(/^mailto:/i, '');
        const fragment = document.createDocumentFragment();
        fragment.appendChild(anchor);
        insertFragment(fragment);
        return;
      }
      exec('createLink', url);
      markEmpty();
      onChange();
    },
    selectedText: () => {
      const range = savedRange.current;
      return range && rootRef.current?.contains(range.commonAncestorContainer)
        ? range.toString()
        : '';
    },
    rememberSelection: () => {
      const selection = document.getSelection();
      const root = rootRef.current;
      if (!root || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer)) savedRange.current = range.cloneRange();
    },
    focus: () => rootRef.current?.focus(),
  }));

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0 && onFiles) {
      onFiles(files);
      return;
    }
    const html = event.clipboardData.getData('text/html');
    if (html) {
      const { fragment, droppedImages } = sanitizeToFragment(html, document, () => null);
      insertFragment(fragment);
      if (droppedImages > 0) onImagesDropped?.();
      return;
    }
    const text = event.clipboardData.getData('text/plain');
    if (text) insertFragment(textFragment(text));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    // Seretan HTML dari halaman lain tidak boleh masuk apa adanya: selalu lewat jalur aman.
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      onFiles?.(files);
      return;
    }
    const text = event.dataTransfer.getData('text/plain');
    if (text) insertFragment(textFragment(text));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== '/' || !onSlash || event.ctrlKey || event.metaKey || event.altKey) return;
    const selection = document.getSelection();
    const node = selection?.anchorNode;
    const block =
      node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
    const line = block?.closest('p, div, li') ?? null;
    const lineText = (line && rootRef.current?.contains(line) ? line.textContent : '') ?? '';
    if (lineText.trim() === '') {
      event.preventDefault();
      savedRange.current =
        selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      onSlash();
    }
  };

  return (
    <div
      ref={rootRef}
      className={cx(styles.editor, className)}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      tabIndex={0}
      spellCheck
      onInput={() => {
        markEmpty();
        onChange();
      }}
      onPaste={onPaste}
      onDrop={onDrop}
      onKeyDown={onKeyDown}
    />
  );
}

function paragraph(): HTMLParagraphElement {
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  return p;
}

function endRange(root: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

/** Teks biasa → simpul teks + `br` (tidak pernah di-parse sebagai HTML). */
function textFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, index) => {
    if (index > 0) fragment.appendChild(document.createElement('br'));
    if (line) fragment.appendChild(document.createTextNode(line));
  });
  return fragment;
}
