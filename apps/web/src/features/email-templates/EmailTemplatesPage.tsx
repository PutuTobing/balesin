import type { EmailTemplate, EmailTemplateSummary } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Mails, Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  EmailTemplateIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { CreateButton } from '../../components/ui/CreateButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { cx } from '../../lib/cx';
import { formatDateTimeInline } from '../../lib/format';
import { Segments } from './EmailPreview';
import { EmailTemplateCreateDialog, EmailTemplatePresetDialog } from './EmailTemplateCreateDialogs';
import { matchesSearch, templateBadge } from './email-template-form';
import { emailTemplatesQuery, takeEmailTemplateFlash } from './email-template-queries';
import styles from './EmailTemplates.module.css';

const c = t.emailTemplates;
type View = 'active' | 'archived';

/**
 * Pengaturan → Template email (`templates.manage`, tahap 9.1): daftar aktif/arsip + cari, lencana
 * versi terbit, tanda "ada perubahan belum terbit"; buat dari kosong atau dari 6 preset ISP.
 */
export function EmailTemplatesPage() {
  const navigate = useNavigate();
  const active = useQuery(emailTemplatesQuery(false));
  const archived = useQuery(emailTemplatesQuery(true));
  const [view, setView] = useState<View>('active');
  const [search, setSearch] = useState('');
  const [done] = useState(() => takeEmailTemplateFlash());
  const [dialog, setDialog] = useState<'create' | 'preset' | null>(null);

  const list = view === 'active' ? active : archived;
  const items = useMemo(
    () =>
      (list.data?.templates ?? [])
        .filter((template) => matchesSearch(template, search))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [list.data, search],
  );

  const activeCount = active.data?.templates.length ?? 0;
  const archivedCount = archived.data?.templates.length ?? 0;
  const nothingYet = active.isSuccess && archived.isSuccess && activeCount + archivedCount === 0;
  const open = (template: EmailTemplate) =>
    void navigate({
      to: '/pengaturan/template-email/$templateId',
      params: { templateId: template.id },
    });

  const presetButton = (variant: 'primary' | 'secondary') => (
    <Button variant={variant} onClick={() => setDialog('preset')}>
      <Icon icon={Sparkles} size={16} />
      {c.fromPreset}
    </Button>
  );

  return (
    <Page
      actions={
        active.isSuccess && !nothingYet ? (
          <CreateButton label={c.create} onClick={() => setDialog('create')} />
        ) : undefined
      }
    >
      <div className={styles.content}>
        <p className={styles.intro}>{c.intro}</p>
        {done ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}

        {active.isPending || (view === 'archived' && archived.isPending) ? (
          <ListSkeleton />
        ) : list.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={c.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : nothingYet ? (
          <EmptyState
            illustration={<EmailTemplateIllustration />}
            title={c.emptyTitle}
            body={c.emptyBody}
            actions={
              <div className={styles.emptyActions}>
                {presetButton('primary')}
                <Button onClick={() => setDialog('create')}>
                  <Icon icon={Plus} size={16} />
                  {c.create}
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <div className={styles.toolbar}>
              <div className={styles.searchBox}>
                <SearchField
                  value={search}
                  onChange={setSearch}
                  label={c.searchLabel}
                  placeholder={c.searchPlaceholder}
                  clearLabel={c.clearSearch}
                  maxLength={100}
                />
              </div>
              <Segments
                label={c.viewLabel}
                value={view}
                options={[
                  {
                    value: 'active',
                    label: `${c.viewActive} (${activeCount.toLocaleString('id-ID')})`,
                  },
                  {
                    value: 'archived',
                    label: `${c.viewArchived} (${archivedCount.toLocaleString('id-ID')})`,
                  },
                ]}
                onChange={(value) => setView(value === 'archived' ? 'archived' : 'active')}
              />
              <div className={styles.toolbarEnd}>{presetButton('secondary')}</div>
            </div>
            {items.length === 0 ? (
              search.trim() ? (
                <div className={styles.noMatch}>
                  <p>{c.notFound}</p>
                  <Button variant="ghost" onClick={() => setSearch('')}>
                    {c.resetSearch}
                  </Button>
                </div>
              ) : (
                <div className={styles.noMatch}>
                  <p>
                    <strong>{view === 'archived' ? c.archivedEmptyTitle : c.emptyTitle}.</strong>{' '}
                    {view === 'archived' ? c.archivedEmptyBody : c.emptyBody}
                  </p>
                </div>
              )
            ) : (
              <ul className={styles.list} aria-label={c.listLabel}>
                {items.map((template) => (
                  <TemplateRow key={template.id} template={template} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {dialog === 'create' ? (
        <EmailTemplateCreateDialog onClose={() => setDialog(null)} onCreated={open} />
      ) : null}
      {dialog === 'preset' ? (
        <EmailTemplatePresetDialog onClose={() => setDialog(null)} onCreated={open} />
      ) : null}
    </Page>
  );
}

/** Seluruh kartu = tautan ke editor (arsip & hapus hanya di editor). */
function TemplateRow({ template }: { template: EmailTemplateSummary }) {
  const badge = templateBadge(template);
  const detailsId = `template-email-${template.id}-rincian`;
  const facts = [
    c.updatedAt(formatDateTimeInline(template.updatedAt)),
    template.publishedVersion === null
      ? null
      : template.lastUsedAt
        ? c.lastUsed(formatDateTimeInline(template.lastUsedAt))
        : c.neverUsed,
  ].filter(Boolean);
  return (
    <li>
      <Link
        to="/pengaturan/template-email/$templateId"
        params={{ templateId: template.id }}
        className={cx(styles.item, styles.itemLink)}
        aria-label={c.open(template.name)}
        aria-describedby={detailsId}
      >
        <span className={styles.itemHead}>
          <Icon icon={Mails} size={20} className={styles.itemIcon} />
          <span className={styles.itemName} dir="auto">
            {template.name}
          </span>
          <StatusBadge tone={badge.tone} label={badge.label} className={styles.itemStatus} />
        </span>
        <span id={detailsId} className={styles.itemDetails}>
          <code className={styles.slug}>{template.slug}</code>
          <span className={styles.itemSubject} dir="auto">
            {template.subject?.trim() ? template.subject : c.noSubject}
          </span>
          <span className={styles.itemMeta}>
            <span>{facts.join(' · ')}</span>
            {template.hasUnpublishedChanges && template.publishedVersion !== null ? (
              <span className={styles.chip}>{c.unpublishedChanges}</span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <SkeletonRegion className={styles.list}>
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.item}>
          <Skeleton className={styles.skeletonHead} />
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonShort} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
