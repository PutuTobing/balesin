import type { EmailTemplate } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Eye, History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { emailTemplateVersionsQuery } from './email-template-queries';
import styles from './EmailTemplates.module.css';

const c = t.emailTemplates;

const STATE_TONE: Record<'published' | 'superseded' | 'draft', StatusTone> = {
  published: 'success',
  superseded: 'neutral',
  draft: 'warning',
};

/**
 * Riwayat versi terbit (maks. 50 terbaru): pratinjau versi lama, dan pulihkan ke draf (tanpa
 * konfirmasi identitas — belum terkirim ke siapa pun sampai diterbitkan lagi).
 */
export function EmailTemplateHistory({
  template,
  dirty,
  onPreview,
  onRestored,
}: {
  template: EmailTemplate;
  dirty: boolean;
  onPreview: (version: number) => void;
  onRestored: (template: EmailTemplate, version: number) => void;
}) {
  const versions = useQuery(emailTemplateVersionsQuery(template.id));
  const [restoring, setRestoring] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  // Versi 0 = draf kerja (bukan versi terbit), tidak ditampilkan di riwayat.
  const list = (versions.data?.versions ?? []).filter((version) => version.version > 0);

  const restore = async (version: number) => {
    setPending(true);
    setFailure(null);
    try {
      const { template: restored } = await endpoints.emailTemplates.restore(template.id, version);
      setRestoring(null);
      onRestored(restored, version);
    } catch (caught) {
      setRestoring(null);
      setFailure(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="riwayat-template-email">
      <div className={styles.cardHead}>
        <h2 id="riwayat-template-email" className={styles.cardTitle}>
          {c.historyTitle}
        </h2>
        <p className={styles.hint}>{c.historyHint}</p>
      </div>
      {failure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : null}
      {versions.isPending ? (
        <SkeletonRegion className={styles.versions}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className={styles.versionSkeleton} />
          ))}
        </SkeletonRegion>
      ) : versions.isError ? (
        <Notice
          tone="danger"
          role="alert"
          title={c.historyFailed}
          actions={<Button onClick={() => void versions.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(versions.error) ? versions.error.message : t.api.network}
        </Notice>
      ) : list.length === 0 ? (
        <div className={styles.emptyRow}>
          <Icon icon={History} size={20} className={styles.itemIcon} />
          <p>{c.historyEmpty}</p>
        </div>
      ) : (
        <ol className={styles.versions}>
          {list.map((version) => {
            const by = version.publishedBy ?? version.createdBy;
            const when = version.publishedAt ?? version.createdAt;
            return (
              <li key={version.version} className={styles.version}>
                <div className={styles.versionHead}>
                  <span className={styles.versionName}>{c.versionName(version.version)}</span>
                  <StatusBadge
                    tone={STATE_TONE[version.state]}
                    label={c.versionState[version.state]}
                  />
                </div>
                <p className={styles.versionSubject} dir="auto">
                  {version.subject}
                </p>
                <p className={styles.itemMeta}>
                  {by
                    ? c.versionPublished(by.name, formatDateTimeInline(when))
                    : c.versionPublishedAt(formatDateTimeInline(when))}
                </p>
                <div className={styles.versionActions}>
                  <Button
                    variant="ghost"
                    aria-label={c.versionPreviewLabel(version.version)}
                    onClick={() => onPreview(version.version)}
                  >
                    <Icon icon={Eye} size={16} />
                    {c.versionPreview}
                  </Button>
                  {template.archived ? null : (
                    <Button
                      variant="ghost"
                      aria-label={c.versionRestoreLabel(version.version)}
                      onClick={() => setRestoring(version.version)}
                    >
                      <Icon icon={RotateCcw} size={16} />
                      {c.versionRestore}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <ConfirmDialog
        open={restoring !== null}
        title={c.restoreTitle(restoring ?? 0)}
        body={dirty ? c.restoreBodyDirty : c.restoreBody}
        cancelLabel={c.cancel}
        confirmLabel={pending ? c.restoring : c.restoreConfirm}
        onCancel={() => setRestoring(null)}
        onConfirm={() => {
          if (!pending && restoring !== null) void restore(restoring);
        }}
      />
    </section>
  );
}
