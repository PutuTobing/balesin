import type { EmailMessageTemplatePreviewRequest, EmailTemplateContent } from '@balesin/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { RadioGroup } from 'radix-ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { EMAIL_PREVIEW_SANDBOX } from '../email-settings/preview-document';
import { previewBody, templatePreviewDocument, type PreviewTheme } from './email-preview-document';
import { emailTemplateKeys } from './email-template-queries';
import styles from './EmailTemplates.module.css';

const c = t.emailTemplates;

export type PreviewWidth = 'desktop' | 'phone';

/** Lebar email yang lazim (600 px) dan lebar HP rubrik desain (390 px). */
const FRAME_WIDTH: Record<PreviewWidth, number> = { desktop: 600, phone: 390 };
const FRAME_HEIGHT: Record<PreviewWidth, number> = { desktop: 640, phone: 720 };
const DEBOUNCE_MS = 700;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Pratinjau email lengkap dari server (`POST …/preview`, logo & QRIS contoh sebagai `data:` URI) di
 * `<iframe sandbox="" srcdoc>` — isi template tidak pernah masuk DOM aplikasi. Lebar 600/390 px
 * diperkecil mengikuti kolom bila tidak muat (HP), jadi halaman tidak menggulir ke samping.
 */
export function EmailPreview({
  name,
  content,
  usesQris,
  controls,
}: {
  name: string;
  content: EmailTemplateContent;
  usesQris: boolean;
  /** Isian tambahan di baris kontrol (mis. pilihan sumber isi). */
  controls?: ReactNode;
}) {
  // HP: bawaan lebar HP (email 600 px yang diperkecil terlalu kecil untuk dibaca).
  const [width, setWidth] = useState<PreviewWidth>(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 640px)').matches
      ? 'phone'
      : 'desktop',
  );
  const widthLabelId = useId();
  const themeLabelId = useId();
  const [theme, setTheme] = useState<PreviewTheme>('light');
  const [sampleQris, setSampleQris] = useState(true);
  const empty = !content.subject.trim() && !content.html.trim();
  // Didebounce sebagai string: objek baru tiap render akan membuat pewaktu tidak pernah selesai.
  const serialized = useDebounced(
    JSON.stringify(previewBody(content, usesQris && sampleQris)),
    DEBOUNCE_MS,
  );
  const body = JSON.parse(serialized) as EmailMessageTemplatePreviewRequest;
  const preview = useQuery({
    queryKey: emailTemplateKeys.preview(serialized),
    queryFn: ({ signal }) => endpoints.emailTemplates.preview(body, signal),
    enabled: !empty,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
  const data = preview.data;

  return (
    <div className={styles.preview}>
      <div className={styles.previewControls}>
        {controls}
        <div className={styles.control}>
          <span className={styles.controlLabel} id={widthLabelId}>
            {c.previewWidthLabel}
          </span>
          <Segments
            labelledBy={widthLabelId}
            value={width}
            options={[
              { value: 'desktop', label: c.previewWidth.desktop },
              { value: 'phone', label: c.previewWidth.phone },
            ]}
            onChange={(value) => setWidth(value === 'phone' ? 'phone' : 'desktop')}
          />
        </div>
        <div className={styles.control}>
          <span className={styles.controlLabel} id={themeLabelId}>
            {c.previewThemeLabel}
          </span>
          <Segments
            labelledBy={themeLabelId}
            value={theme}
            options={[
              { value: 'light', label: c.previewTheme.light },
              { value: 'dark', label: c.previewTheme.dark },
            ]}
            onChange={(value) => setTheme(value === 'dark' ? 'dark' : 'light')}
          />
        </div>
      </div>
      {usesQris ? (
        <Checkbox
          className={styles.plainCheck}
          checked={sampleQris}
          onChange={(event) => setSampleQris(event.target.checked)}
        >
          {c.previewQris}
        </Checkbox>
      ) : null}
      {theme === 'dark' ? <p className={styles.hint}>{c.previewDarkNote}</p> : null}

      {empty ? (
        <p className={styles.previewEmpty}>{c.previewEmpty}</p>
      ) : preview.isError && !data ? (
        <Notice
          tone="danger"
          role="alert"
          title={c.previewFailed}
          actions={<Button onClick={() => void preview.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(preview.error) ? preview.error.message : t.api.network}
        </Notice>
      ) : (
        <>
          {data && data.warnings.length > 0 ? (
            <Notice tone="warning" role="status" title={c.previewWarningsTitle}>
              <ul className={styles.plainList}>
                {data.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <div className={styles.previewFrame} aria-busy={preview.isFetching}>
            <p className={styles.previewSubject}>
              <span className={styles.previewSubjectLabel}>{c.previewSubject}</span>
              {data ? (
                <span dir="auto">{data.subject}</span>
              ) : (
                <Skeleton className={styles.previewSubjectSkeleton} />
              )}
            </p>
            <ScaledFrame width={FRAME_WIDTH[width]} height={FRAME_HEIGHT[width]}>
              {data ? (
                <iframe
                  className={styles.previewIframe}
                  title={c.previewFrame(name)}
                  sandbox={EMAIL_PREVIEW_SANDBOX}
                  referrerPolicy="no-referrer"
                  srcDoc={templatePreviewDocument(data.html, theme)}
                />
              ) : (
                <Skeleton className={styles.previewIframeSkeleton} />
              )}
            </ScaledFrame>
          </div>
          {preview.isFetching && data ? (
            <p className={styles.hint} role="status">
              {c.previewUpdating}
            </p>
          ) : null}
          {data ? (
            <details className={styles.previewTextBox}>
              <summary className={styles.previewTextSummary}>{c.previewText}</summary>
              <pre className={styles.previewText}>{data.text}</pre>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Bingkai selebar email; diperkecil (transform) bila kolom lebih sempit dari lebar email. */
function ScaledFrame({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setAvailable(box.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const scale = available ? Math.min(1, available / width) : 1;
  return (
    <div ref={boxRef} className={styles.frameBox} style={{ height: height * scale }}>
      <div
        className={styles.frameInner}
        style={{
          width,
          height,
          transform: scale < 1 ? `scale(${String(scale)})` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Segments({
  label,
  labelledBy,
  value,
  options,
  onChange,
}: {
  /** Nama aksesibel bila tidak ada label terlihat; selain itu pakai `labelledBy`. */
  label?: string;
  labelledBy?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <RadioGroup.Root
      className={styles.segments}
      value={value}
      onValueChange={onChange}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      orientation="horizontal"
    >
      {options.map((option) => (
        <RadioGroup.Item key={option.value} value={option.value} className={styles.segment}>
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
