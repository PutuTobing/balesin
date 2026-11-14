import {
  EMAIL_TEMPLATE_IDS,
  EMAIL_TEMPLATE_LABELS,
  emailTemplateIdSchema,
  type EmailTemplateId,
} from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { RadioGroup } from 'radix-ui';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { SelectField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { emailTemplatePreviewQuery } from '../../lib/api/queries';
import { EMAIL_PREVIEW_SANDBOX, emailPreviewDocument } from './preview-document';
import styles from './EmailSettings.module.css';

const copy = t.emailSettings.preview;
const HEADING_ID = 'pratinjau-email';
const TEMPLATE_OPTIONS = EMAIL_TEMPLATE_IDS.map((id) => ({
  value: id,
  label: EMAIL_TEMPLATE_LABELS[id],
}));

type View = 'html' | 'text';

/**
 * Pratinjau template email (di Pengaturan → Email pengirim, izin `settings.email.manage`): template yang sama
 * dengan email sungguhan, dengan branding organisasi dan data contoh. HTML ditampilkan di
 * `<iframe sandbox="" srcdoc>` (lihat `preview-document.ts`), TIDAK PERNAH lewat
 * `dangerouslySetInnerHTML`. "Teks polos" = versi teks yang ikut terkirim (juga cadangan bila
 * kebijakan CSP halaman memblokir gaya inline di pratinjau).
 */
export function EmailTemplatePreview() {
  const [template, setTemplate] = useState<EmailTemplateId>('invitation');
  const [view, setView] = useState<View>('html');
  const preview = useQuery(emailTemplatePreviewQuery(template));
  const data = preview.data?.template === template ? preview.data : undefined;

  return (
    <section className={styles.card} aria-labelledby={HEADING_ID}>
      <div className={styles.previewHead}>
        <h2 id={HEADING_ID} className={styles.previewTitle}>
          {copy.title}
        </h2>
        <p className={styles.previewBody}>{copy.body}</p>
      </div>
      <div className={styles.previewControls}>
        <SelectField
          label={copy.template}
          name="template"
          value={template}
          onChange={(event) => {
            const parsed = emailTemplateIdSchema.safeParse(event.target.value);
            if (parsed.success) setTemplate(parsed.data);
          }}
          options={TEMPLATE_OPTIONS}
        />
        <RadioGroup.Root
          className={styles.viewSwitch}
          value={view}
          onValueChange={(value) => setView(value === 'text' ? 'text' : 'html')}
          aria-label={copy.viewLabel}
          orientation="horizontal"
        >
          <RadioGroup.Item value="html" className={styles.viewOption}>
            {copy.html}
          </RadioGroup.Item>
          <RadioGroup.Item value="text" className={styles.viewOption}>
            {copy.text}
          </RadioGroup.Item>
        </RadioGroup.Root>
      </div>

      {preview.isError ? (
        <Notice
          tone="danger"
          role="alert"
          title={copy.loadFailedTitle}
          actions={<Button onClick={() => void preview.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(preview.error) ? preview.error.message : t.api.network}
        </Notice>
      ) : data ? (
        <div className={styles.previewFrame}>
          <p className={styles.previewSubject}>
            <span className={styles.previewSubjectLabel}>{copy.subject}</span>
            <span>{data.subject}</span>
          </p>
          {view === 'html' ? (
            <iframe
              // Ganti template = dokumen baru (bukan sisa gulir template sebelumnya).
              key={template}
              className={styles.previewIframe}
              title={copy.frameTitle(EMAIL_TEMPLATE_LABELS[template])}
              sandbox={EMAIL_PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              srcDoc={emailPreviewDocument(data.html)}
            />
          ) : (
            <pre className={styles.previewText}>{data.text}</pre>
          )}
        </div>
      ) : (
        <SkeletonRegion className={styles.previewFrame}>
          <span className={styles.previewSubject}>
            <span className={styles.previewSubjectLabel}>{copy.subject}</span>
            <Skeleton className={styles.previewSubjectSkeleton} />
          </span>
          <Skeleton className={styles.previewIframeSkeleton} />
        </SkeletonRegion>
      )}
    </section>
  );
}
