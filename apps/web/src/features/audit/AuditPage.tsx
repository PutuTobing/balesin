import {
  AUDIT_ACTION_NAMES,
  AUDIT_TARGET_TYPES,
  AUDIT_TARGET_TYPE_LABELS,
  auditActionLabel,
  type TeamUser,
} from '@balesin/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ChevronDown, Download, X } from 'lucide-react';
import { useId, useRef, useState, type RefObject } from 'react';
import { useBrand } from '../../brand/brand';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { SkeletonRegion } from '../../components/ui/Skeleton';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { auditLogQuery, teamUsersQuery } from '../../lib/api/queries';
import { cx } from '../../lib/cx';
import { useLock, type Lock } from '../../lib/use-lock';
import { useCan } from '../auth/session';
import { AuditEntryItem } from './AuditEntryItem';
import { AuditListSkeleton } from './AuditListSkeleton';
import { downloadAuditCsv } from './audit-export';
import {
  activeFilterCount,
  auditFilter,
  isValidDate,
  rangeInvalid,
  type AuditSearch,
} from './audit-search';
import styles from './Audit.module.css';

const routeApi = getRouteApi('/_app/pengaturan/audit');
const copy = t.audit;

/** Pilihan aksi: urut label supaya mudah dicari di pemilih sistem. */
const ACTION_OPTIONS = [...AUDIT_ACTION_NAMES]
  .map((action) => ({ value: action, label: auditActionLabel(action) }))
  .sort((a, b) => a.label.localeCompare(b.label, 'id-ID'));

const TARGET_OPTIONS = AUDIT_TARGET_TYPES.map((type) => ({
  value: type,
  label: AUDIT_TARGET_TYPE_LABELS[type],
}));

/**
 * Pengaturan → Audit log (izin `audit.view`): siapa melakukan apa, kapan, dan dari mana.
 * Saringan ada di URL (bisa dibagikan, tombol Back bekerja), daftar per halaman dengan kursor
 * ("Muat lagi"), ekspor CSV dengan saringan yang sama. Rincian yang tampil hanya yang dikirim
 * server (sudah disaring rahasianya), dirender sebagai teks.
 */
export function AuditPage() {
  const search = routeApi.useSearch();
  const filter = auditFilter(search);
  const exporter = useAuditExport();
  return (
    <Page
      actions={
        <ExportButton
          buttonRef={exporter.buttonRef}
          pending={exporter.pending}
          lock={exporter.lock}
          onRun={() => void exporter.run(search)}
        />
      }
    >
      <div className={styles.content}>
        {exporter.result ? (
          <ExportResult
            result={exporter.result}
            locked={exporter.lock.locked}
            onClose={exporter.clear}
          />
        ) : null}
        <Filters search={search} />
        <AuditList search={search} filter={filter} />
      </div>
    </Page>
  );
}

// ── Ekspor ──────────────────────────────────────────────────────────────────

type ExportOutcome =
  | { kind: 'done'; rows: number; truncated: boolean; maxRows: number }
  | { kind: 'error'; error: unknown };

function useAuditExport() {
  const { productName } = useBrand();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ExportOutcome | null>(null);
  const lock = useLock();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const run = async (search: AuditSearch) => {
    if (pending || lock.locked) return;
    setPending(true);
    setResult(null);
    try {
      const exported = await downloadAuditCsv(auditFilter(search), productName);
      setResult({ kind: 'done', ...exported });
    } catch (caught) {
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setResult({ kind: 'error', error: caught });
    } finally {
      setPending(false);
      // Tombol sempat nonaktif selama memproses: kembalikan fokus ke sana (bukan <body>).
      requestAnimationFrame(() => buttonRef.current?.focus());
    }
  };

  return { pending, result, lock, buttonRef, run, clear: () => setResult(null) };
}

function ExportButton({
  buttonRef,
  pending,
  lock,
  onRun,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  pending: boolean;
  lock: Lock;
  onRun: () => void;
}) {
  return (
    <SubmitButton
      ref={buttonRef}
      type="button"
      size="md"
      variant="secondary"
      pending={pending}
      pendingLabel={copy.exporting}
      lock={lock}
      onClick={onRun}
      className={styles.exportButton}
    >
      <Icon icon={Download} size={16} />
      {copy.export}
    </SubmitButton>
  );
}

function ExportResult({
  result,
  locked,
  onClose,
}: {
  result: ExportOutcome;
  locked: boolean;
  onClose: () => void;
}) {
  const close = (
    <Button variant="ghost" className={styles.noticeClose} onClick={onClose}>
      {t.common.close}
    </Button>
  );
  if (result.kind === 'done') {
    return (
      <Notice tone={result.truncated ? 'warning' : 'success'} role="status" actions={close}>
        <p>{copy.exported(result.rows)}</p>
        {result.truncated ? <p>{copy.exportTruncated(result.maxRows)}</p> : null}
      </Notice>
    );
  }
  return (
    <Notice
      tone={locked ? 'warning' : 'danger'}
      role="alert"
      title={locked ? copy.exportLockedTitle : copy.exportFailedTitle}
      actions={close}
    >
      {isApiError(result.error) ? result.error.message : t.api.network}
    </Notice>
  );
}

// ── Saringan ────────────────────────────────────────────────────────────────

function Filters({ search }: { search: AuditSearch }) {
  const navigate = routeApi.useNavigate();
  const canListUsers = useCan('team.manage');
  const users = useQuery({ ...teamUsersQuery, enabled: canListUsers });
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const count = activeFilterCount(search);
  const badRange = rangeInvalid(search);

  const set = (patch: Partial<AuditSearch>) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });

  const actorOptions = [
    { value: '', label: copy.filters.anyActor },
    ...(users.data?.users ?? []).map((user: TeamUser) => ({ value: user.id, label: user.name })),
  ];
  // Pelaku dari URL yang belum ada di daftar (daftar belum dimuat): tetap bisa dipilih.
  if (search.actorUserId && !actorOptions.some((option) => option.value === search.actorUserId)) {
    actorOptions.push({ value: search.actorUserId, label: copy.filters.actor });
  }
  const userName =
    search.userId && users.data?.users.find((user) => user.id === search.userId)?.name;

  const chips = [
    search.userId
      ? {
          key: 'userId' as const,
          label: copy.filters.chipUser(userName || copy.columns.actor.toLocaleLowerCase('id-ID')),
        }
      : null,
    search.targetId
      ? { key: 'targetId' as const, label: copy.filters.chipTarget(search.targetId) }
      : null,
  ].filter((chip) => chip !== null);

  return (
    <section className={styles.filters} aria-label={copy.filters.label}>
      <button
        type="button"
        className={styles.filterToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{count > 0 ? copy.filters.toggleCount(count) : copy.filters.toggle}</span>
        <Icon icon={ChevronDown} size={16} className={styles.toggleIcon} />
      </button>
      <div id={bodyId} className={styles.filterBody} data-open={open ? '' : undefined}>
        <div className={styles.filterGrid}>
          <SelectField
            label={copy.filters.actor}
            name="actorUserId"
            value={search.actorUserId ?? ''}
            onChange={(event) => set({ actorUserId: event.target.value || undefined })}
            options={actorOptions}
          />
          <SelectField
            label={copy.filters.action}
            name="action"
            value={search.action ?? ''}
            onChange={(event) =>
              set({ action: (event.target.value || undefined) as AuditSearch['action'] })
            }
            options={[{ value: '', label: copy.filters.anyAction }, ...ACTION_OPTIONS]}
          />
          <SelectField
            label={copy.filters.target}
            name="targetType"
            value={search.targetType ?? ''}
            onChange={(event) =>
              set({ targetType: (event.target.value || undefined) as AuditSearch['targetType'] })
            }
            options={[{ value: '', label: copy.filters.anyTarget }, ...TARGET_OPTIONS]}
          />
          <TextField
            label={copy.filters.from}
            type="date"
            name="from"
            value={search.from ?? ''}
            max={search.to}
            onChange={(event) => {
              const value = event.target.value;
              if (!value || isValidDate(value)) set({ from: value || undefined });
            }}
          />
          <TextField
            label={copy.filters.to}
            type="date"
            name="to"
            value={search.to ?? ''}
            min={search.from}
            error={badRange ? copy.filters.rangeError : undefined}
            onChange={(event) => {
              const value = event.target.value;
              if (!value || isValidDate(value)) set({ to: value || undefined });
            }}
          />
        </div>
        {chips.length > 0 || count > 0 ? (
          <div className={styles.filterFooter}>
            {chips.map((chip) => (
              <span key={chip.key} className={styles.chip}>
                <span className={styles.chipText}>{chip.label}</span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={copy.filters.removeChip(chip.label)}
                  onClick={() => set({ [chip.key]: undefined })}
                >
                  <Icon icon={X} size={16} />
                </button>
              </span>
            ))}
            <Button
              variant="ghost"
              className={styles.clear}
              onClick={() => void navigate({ search: {}, replace: true })}
            >
              {copy.filters.clear}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ── Daftar ──────────────────────────────────────────────────────────────────

function AuditList({
  search,
  filter,
}: {
  search: AuditSearch;
  filter: ReturnType<typeof auditFilter>;
}) {
  const navigate = routeApi.useNavigate();
  const list = useInfiniteQuery({ ...auditLogQuery(filter), placeholderData: keepPreviousData });
  const retryLock = useLock();
  const entries = list.data?.pages.flatMap((page) => page.entries) ?? [];
  const filtered = activeFilterCount(search) > 0;

  if (!list.data) {
    if (list.isError) {
      const limited = isApiError(list.error) && list.error.status === 429;
      return (
        <EmptyState
          align="top"
          title={limited ? copy.lockedTitle : copy.loadFailedTitle}
          body={isApiError(list.error) ? list.error.message : t.api.network}
          actions={
            <SubmitButton
              type="button"
              size="md"
              variant="primary"
              pending={list.isFetching}
              pendingLabel={t.common.loading}
              lock={retryLock}
              onClick={() => void list.refetch()}
            >
              {t.common.retry}
            </SubmitButton>
          }
          className={styles.state}
        />
      );
    }
    return (
      <SkeletonRegion>
        <AuditListSkeleton />
      </SkeletonRegion>
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        align="top"
        title={filtered ? copy.noMatchTitle : copy.emptyTitle}
        body={filtered ? copy.noMatchBody : copy.emptyBody}
        actions={
          filtered ? (
            <Button onClick={() => void navigate({ search: {}, replace: true })}>
              {copy.filters.clear}
            </Button>
          ) : undefined
        }
        className={styles.state}
      />
    );
  }

  return (
    <div className={styles.listCard}>
      <div className={styles.listHead} aria-hidden="true">
        <span>{copy.columns.time}</span>
        <span>{copy.columns.action}</span>
        <span>{copy.columns.actor}</span>
        <span>{copy.columns.target}</span>
        <span>{copy.columns.origin}</span>
      </div>
      <ol
        className={cx(styles.list, list.isPlaceholderData && styles.stale)}
        aria-label={copy.listLabel}
        aria-busy={list.isPlaceholderData || undefined}
      >
        {entries.map((entry) => (
          <AuditEntryItem key={entry.id} entry={entry} />
        ))}
      </ol>
      {list.isFetchNextPageError ? (
        <Notice tone="danger" role="alert" className={styles.moreError}>
          {isApiError(list.error) ? list.error.message : t.api.network}
        </Notice>
      ) : null}
      <div className={styles.listFooter}>
        <span className={styles.footerText} role="status">
          {list.hasNextPage ? copy.shown(entries.length) : copy.end}
        </span>
        {list.hasNextPage ? (
          <Button
            onClick={() => void list.fetchNextPage()}
            loading={list.isFetchingNextPage}
            disabled={list.isPlaceholderData}
          >
            {list.isFetchingNextPage ? copy.loadingMore : copy.loadMore}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
