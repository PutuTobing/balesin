import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_STATUSES,
  TEMPLATE_STATUS_LABELS,
  type MessageTemplate,
  type TemplateCategory,
  type TemplateStatus,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LayoutTemplate, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  ChatIllustration,
  ChannelIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { CreateButton } from '../../components/ui/CreateButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { formatDateTimeInline } from '../../lib/format';
import { useCan } from '../auth/session';
import { inboxChannelsQuery } from '../inbox/inbox-queries';
import { PresetDialog } from './PresetDialog';
import { statusTone } from './template-form';
import { languageLabel, rejectionText } from './template-labels';
import { templateKeys, templatesQuery, takeTemplateFlash } from './template-queries';
import styles from './Templates.module.css';

const c = t.templates;
const STATUS_FILTERS = TEMPLATE_STATUSES.filter((status) => status !== 'DELETED');

/**
 * Pengaturan → Template WhatsApp (`templates.manage`): daftar template Meta semua nomor dengan
 * saringan nomor/status/kategori + cari, lencana status, alasan penolakan, kualitas, tanda
 * "perubahan belum diajukan"; buat, pakai preset, sinkron dari Meta, hapus.
 */
export function TemplatesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery(templatesQuery);
  const channels = useQuery(inboxChannelsQuery);
  const canChannels = useCan('channels.manage');
  const [search, setSearch] = useState('');
  const [channelId, setChannelId] = useState('');
  const [status, setStatus] = useState<TemplateStatus | ''>('');
  const [category, setCategory] = useState<TemplateCategory | ''>('');
  const [done, setDone] = useState<string | null>(() => takeTemplateFlash()?.message ?? null);
  const [presetsOpen, setPresetsOpen] = useState(false);

  const whatsapp = useMemo(
    () => (channels.data?.channels ?? []).filter((channel) => channel.type === 'whatsapp'),
    [channels.data],
  );
  const channelName = (id: string) => whatsapp.find((channel) => channel.id === id)?.name ?? '';

  const sync = useMutation({
    mutationFn: () => endpoints.templates.sync(),
    onMutate: () => setDone(null),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: templateKeys.all }),
  });

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (list.data?.templates ?? [])
      .filter(
        (template) =>
          (!channelId || template.channelId === channelId) &&
          (!status || template.status === status) &&
          (!category || template.category === category) &&
          (!needle ||
            template.name.toLowerCase().includes(needle) ||
            template.content.body.text.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [list.data, search, channelId, status, category]);

  const filtered = Boolean(search.trim() || channelId || status || category);
  const resetFilters = () => {
    setSearch('');
    setChannelId('');
    setStatus('');
    setCategory('');
  };

  const syncResult = sync.data?.channels;
  const syncFailures = syncResult?.filter((entry) => !entry.ok) ?? [];
  const syncTotals = syncResult?.reduce(
    (sum, entry) => ({
      created: sum.created + entry.created,
      updated: sum.updated + entry.updated,
      removed: sum.removed + entry.removed,
    }),
    { created: 0, updated: 0, removed: 0 },
  );

  const noChannel = channels.isSuccess && whatsapp.length === 0;
  const secondary = (
    <>
      <Button onClick={() => setPresetsOpen(true)}>
        <Icon icon={Sparkles} size={16} />
        {c.fromPreset}
      </Button>
      <Button loading={sync.isPending} onClick={() => sync.mutate()}>
        {sync.isPending ? null : <Icon icon={RefreshCw} size={16} />}
        {sync.isPending ? c.syncing : c.sync}
      </Button>
    </>
  );
  // "Buat template" di kepala halaman (audit akhir D1) hanya bila daftar terisi; saat kosong
  // ketiga ajakan ada di `EmptyState`. Preset & sinkron tetap di isi sebagai tombol sekunder.
  const hasTemplates = list.isSuccess && channels.isSuccess && list.data.templates.length > 0;

  return (
    <Page
      actions={
        hasTemplates ? <CreateButton label={c.add} to="/pengaturan/template/baru" /> : undefined
      }
    >
      <div className={styles.content}>
        <p className={styles.intro}>{c.intro}</p>
        {done ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}
        {syncTotals && syncFailures.length === 0 ? (
          <Notice tone="success" role="status">
            {c.syncDone(syncTotals.created, syncTotals.updated, syncTotals.removed)}
          </Notice>
        ) : null}
        {syncFailures.length > 0 ? (
          <Notice tone="warning" role="alert" title={c.syncFailedTitle}>
            <ul className={styles.plainList}>
              {syncFailures.map((entry) => (
                <li key={entry.channelId}>
                  {c.syncFailed(channelName(entry.channelId), entry.error ?? t.api.network)}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {sync.isError ? (
          <Notice tone="danger" role="alert">
            {isApiError(sync.error) ? sync.error.message : t.api.network}
          </Notice>
        ) : null}

        {list.isPending || channels.isPending ? (
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
        ) : noChannel && list.data.templates.length === 0 ? (
          <EmptyState
            illustration={<ChannelIllustration />}
            title={c.noChannelTitle}
            body={c.noChannelBody}
            actions={
              canChannels ? (
                <Button variant="primary" asChild>
                  <Link to="/pengaturan/channel">{c.noChannelAction}</Link>
                </Button>
              ) : undefined
            }
          />
        ) : list.data.templates.length === 0 ? (
          <EmptyState
            illustration={<ChatIllustration />}
            title={c.emptyTitle}
            body={c.emptyBody}
            actions={
              <div className={styles.actions}>
                <Button variant="primary" asChild>
                  <Link to="/pengaturan/template/baru">
                    <Icon icon={Plus} size={16} />
                    {c.add}
                  </Link>
                </Button>
                {secondary}
              </div>
            }
          />
        ) : (
          <>
            <div className={styles.secondaryActions}>{secondary}</div>
            <div className={styles.filters}>
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
              {whatsapp.length > 1 ? (
                <SelectField
                  label={c.channelLabel}
                  value={channelId}
                  onChange={(event) => setChannelId(event.target.value)}
                  options={[
                    { value: '', label: c.allChannels },
                    ...whatsapp.map((channel) => ({ value: channel.id, label: channel.name })),
                  ]}
                  className={styles.filter}
                />
              ) : null}
              <SelectField
                label={c.statusLabel}
                value={status}
                onChange={(event) => setStatus(event.target.value as TemplateStatus | '')}
                options={[
                  { value: '', label: c.allStatuses },
                  ...STATUS_FILTERS.map((value) => ({
                    value,
                    label: TEMPLATE_STATUS_LABELS[value],
                  })),
                ]}
                className={styles.filter}
              />
              <SelectField
                label={c.categoryLabel}
                value={category}
                onChange={(event) => setCategory(event.target.value as TemplateCategory | '')}
                options={[
                  { value: '', label: c.allCategories },
                  ...TEMPLATE_CATEGORIES.map((value) => ({
                    value,
                    label: c.categoryShort[value],
                  })),
                ]}
                className={styles.filter}
              />
            </div>
            {items.length === 0 ? (
              <div className={styles.noMatch}>
                <p>{c.notFound}</p>
                {filtered ? (
                  <Button variant="ghost" onClick={resetFilters}>
                    {c.resetFilters}
                  </Button>
                ) : null}
              </div>
            ) : (
              <ul className={styles.list} aria-label={c.listLabel}>
                {items.map((template) => (
                  <TemplateRow
                    key={template.id}
                    template={template}
                    channelName={whatsapp.length > 1 ? channelName(template.channelId) : null}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <PresetDialog
        open={presetsOpen}
        channels={whatsapp}
        onClose={() => setPresetsOpen(false)}
        onCreated={(template) => {
          setPresetsOpen(false);
          void navigate({
            to: '/pengaturan/template/$templateId',
            params: { templateId: template.id },
          });
        }}
      />
    </Page>
  );
}

/** Seluruh kartu = tautan ke halaman ubah (hapus hanya di halaman ubah — review template TM-S1). */
function TemplateRow({
  template,
  channelName,
}: {
  template: MessageTemplate;
  channelName: string | null;
}) {
  const otp = template.category === 'AUTHENTICATION';
  const detailsId = `template-${template.id}-rincian`;
  const facts = [
    c.categoryShort[template.category],
    languageLabel(template.language),
    channelName,
    template.qualityScore ? c.quality[template.qualityScore] : null,
    c.updatedAt(formatDateTimeInline(template.updatedAt)),
  ].filter(Boolean);
  return (
    <li>
      <Link
        to="/pengaturan/template/$templateId"
        params={{ templateId: template.id }}
        className={cx(styles.item, styles.itemLink)}
        aria-label={c.open(template.name)}
        aria-describedby={detailsId}
      >
        <span className={styles.itemHead}>
          <Icon icon={LayoutTemplate} size={20} className={styles.itemIcon} />
          <span className={styles.itemName}>{template.name}</span>
          <StatusBadge
            tone={statusTone(template.status)}
            label={TEMPLATE_STATUS_LABELS[template.status]}
            className={styles.itemStatus}
          />
        </span>
        <span id={detailsId} className={styles.itemDetails}>
          {otp && !template.content.body.text.trim() ? null : (
            <span className={styles.itemBody} dir="auto">
              {otp ? c.otpPreview('{{1}}') : template.content.body.text}
            </span>
          )}
          {template.status === 'REJECTED' && template.rejectedReason ? (
            <span className={styles.itemDanger}>{rejectionText(template.rejectedReason)}</span>
          ) : null}
          <span className={styles.itemMeta}>
            <span>{facts.join(' · ')}</span>
            {template.localChanges ? <span className={styles.chip}>{c.localChanges}</span> : null}
            {template.source === 'meta' ? <span className={styles.chip}>{c.fromMeta}</span> : null}
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
