import type { ConversationCountsResponse } from '@balesin/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useBrand } from '../../brand/brand';
import { ChatIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Notice } from '../../components/ui/Notice';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { cx } from '../../lib/cx';
import { media, useMediaQuery } from '../../lib/media';
import { useLock } from '../../lib/use-lock';
import { ConversationItem } from './ConversationItem';
import styles from './ConversationList.module.css';
import {
  SEARCH_MAX,
  TAB_COUNT_KEY,
  hasFilters,
  type ConversationParams,
  type FilterChip,
  type InboxFilters,
} from './inbox-filters';
import { conversationsQuery } from './inbox-queries';
import { INBOX_TABS, parseInboxTab, type InboxTab } from './inbox-search';
import { FilterChips } from './InboxFilterMenu';
import { useEdgeFade } from './use-edge-fade';
import { useMinuteClock } from './use-minute-clock';

const SKELETON_ROWS = 7;
const ROVING_HINT_ID = 'inbox-rows-hint';

/**
 * Daftar chat = satu tab stop (baris terpilih, atau baris pertama); panah atas/bawah, Home, End
 * berpindah baris. Tab langsung keluar ke ruang chat, bukan melewati setiap baris.
 */
function moveRowFocus(event: KeyboardEvent<HTMLUListElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-conversation-id]'),
  );
  const current = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (current === -1) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)));
  rows[next]?.focus();
}

export interface ConversationListProps {
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  /** Kerangka memuat (rute belum siap): hanya ISI daftar yang berganti kerangka. */
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  /** Kata pencarian sudah dirapikan & di-debounce; `null` = tanpa pencarian. */
  query: string | null;
  searchTooShort: boolean;
  filters: InboxFilters;
  onFiltersChange: (filters: InboxFilters) => void;
  chips: FilterChip[];
  /** Tombol saring (dirender di baris judul). */
  filterControl: ReactNode;
  params: ConversationParams;
  counts: ConversationCountsResponse | undefined;
  /** Inbox benar-benar kosong (tanpa saringan/pencarian). */
  inboxEmpty: boolean;
  selectedId: string | null;
  onOpen: (conversationId: string) => void;
  refetchInterval: number;
  className?: string;
}

/**
 * Kolom daftar chat (360px desktop / layar penuh HP): judul + saring, cari, tab berhitungan,
 * lalu daftar bergulir tak terbatas (kursor). Semua keadaan dirancang: memuat, kosong, inbox
 * kosong, tidak ketemu, saringan tanpa hasil, dibatasi (429), terlalu lama (503), gagal.
 */
export function ConversationList(props: ConversationListProps) {
  const { tab, onTabChange, search, onSearchChange, chips, filterControl, counts } = props;
  const tabsRef = useRef<HTMLDivElement>(null);
  useEdgeFade(tabsRef, 'x', [counts]);
  // Tab aktif selalu terlihat (tab bisa digeser di layar sempit).
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[data-state="active"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  return (
    <section className={cx(styles.list, props.className)} aria-label={t.inbox.listLabel}>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => onTabChange(parseInboxTab(value))}
        className={styles.listInner}
      >
        <header className={styles.listHeader}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{t.inbox.title}</h1>
            {filterControl}
          </div>
          <div className={styles.searchRow}>
            <SearchField
              value={search}
              onChange={onSearchChange}
              label={t.inbox.searchLabel}
              placeholder={t.inbox.searchPlaceholder}
              clearLabel={t.inbox.clearSearch}
              maxLength={SEARCH_MAX}
            />
          </div>
          <FilterChips
            chips={chips}
            onRemove={(key) => props.onFiltersChange({ ...props.filters, [key]: undefined })}
          />
          <Tabs.List ref={tabsRef} className={styles.tabs} aria-label={t.inbox.tabsLabel}>
            {INBOX_TABS.map((id) => {
              const count = counts?.counts[TAB_COUNT_KEY[id]];
              // Hitungan hanya untuk antrian yang masih berjalan; "Semua" dan "Selesai" terus
              // bertambah sehingga angkanya tidak membantu memilih tab.
              const showCount =
                count !== undefined && count > 0 && id !== 'semua' && id !== 'selesai';
              return (
                <Tabs.Trigger key={id} value={id} className={styles.tab}>
                  <span className={styles.tabLabel}>
                    {t.inbox.tabs[id]}
                    {showCount ? (
                      <span className={styles.tabCount}>
                        <span aria-hidden="true">{t.inbox.tabCount(count)}</span>
                        <span className="sr-only">, {t.inbox.tabCountLabel(count)}</span>
                      </span>
                    ) : null}
                  </span>
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        </header>

        <Tabs.Content value={tab} className={styles.listBody} tabIndex={-1}>
          {props.searchTooShort ? (
            // Di dalam isi daftar, bukan di bawah kolom cari: tab tidak terdorong saat mengetik.
            <p className={styles.searchHint} role="status">
              {t.inbox.searchTooShort}
            </p>
          ) : null}
          {props.loading ? <ConversationRowsSkeleton /> : <ListBody {...props} />}
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function ListBody({
  tab,
  query,
  filters,
  onFiltersChange,
  onSearchChange,
  params,
  inboxEmpty,
  selectedId,
  onOpen,
  refetchInterval,
}: ConversationListProps) {
  const { mascotName } = useBrand();
  const isHp = useMediaQuery(media.hp);
  const now = useMinuteClock();
  const lock = useLock();
  const { lockFor, clear: clearLock } = lock;
  const searching = query !== null;
  const list = useInfiniteQuery({
    ...conversationsQuery(params),
    // Selama pencarian dibatasi (429), jangan memanggil server lagi sampai hitung mundur habis.
    enabled: !lock.locked,
    refetchInterval,
  });
  const error = list.error;
  const limited = isApiError(error) && error.status === 429;

  // 429: kunci dengan hitung mundur dari `Retry-After` (pola `FormErrorNotice`).
  useEffect(() => {
    if (isApiError(error) && error.status === 429) lockFor(error.retryAfterSeconds ?? 30);
  }, [error, lockFor]);
  // Kata/saringan berganti: kunci lama tidak berlaku untuk permintaan baru.
  useEffect(() => clearLock, [query, clearLock]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const canLoadMore = hasNextPage && !isFetchingNextPage && !list.isFetchNextPageError;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
      },
      { rootMargin: '0px 0px 240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, fetchNextPage]);

  const compact = !isHp;
  const align = isHp ? 'center' : 'top';

  if (list.isPending && !limited) return <ConversationRowsSkeleton />;

  if (list.isError && list.data === undefined) {
    const retrySearch = (
      <SubmitButton
        type="button"
        variant="secondary"
        size="md"
        pending={list.isFetching}
        pendingLabel={t.common.loading}
        lock={lock}
        onClick={() => void list.refetch()}
      >
        {t.inbox.searchAgain}
      </SubmitButton>
    );
    if (searching && limited) {
      return (
        <div className={styles.notice}>
          <FormErrorNotice
            error={error}
            lock={lock}
            lockedTitle={t.inbox.searchLimited}
            actions={retrySearch}
          />
        </div>
      );
    }
    if (searching && isApiError(error) && error.status === 503) {
      // Judul sudah menyebut masalahnya; isi cukup jalan keluarnya (pesan server mengulang judul).
      return (
        <div className={styles.notice}>
          <Notice tone="danger" role="alert" title={t.inbox.searchSlowTitle} actions={retrySearch}>
            {t.inbox.searchSlowBody}
          </Notice>
        </div>
      );
    }
    return (
      <EmptyState
        compact={compact}
        align={align}
        title={t.inbox.failed.title}
        body={isApiError(error) ? error.message : t.api.network}
        actions={
          <Button onClick={() => void list.refetch()} loading={list.isFetching}>
            {t.common.retry}
          </Button>
        }
      />
    );
  }

  const conversations = list.data?.pages.flatMap((page) => page.conversations) ?? [];
  const selectedInList = conversations.some((item) => item.id === selectedId);

  if (conversations.length === 0) {
    if (searching) {
      return (
        <EmptyState
          compact={compact}
          align={align}
          title={t.inbox.searchEmpty.title(query)}
          body={t.inbox.searchEmpty.body}
          actions={<Button onClick={() => onSearchChange('')}>{t.inbox.clearSearch}</Button>}
        />
      );
    }
    if (hasFilters(filters)) {
      return (
        <EmptyState
          compact={compact}
          align={align}
          title={t.inbox.filteredEmpty.title}
          body={t.inbox.filteredEmpty.body}
          actions={<Button onClick={() => onFiltersChange({})}>{t.inbox.filters.clearAll}</Button>}
        />
      );
    }
    if (inboxEmpty && isHp) {
      return (
        <EmptyState
          illustration={<ChatIllustration />}
          title={t.inbox.chat.inboxEmptyTitle}
          body={t.inbox.chat.inboxEmptyBody(mascotName)}
        />
      );
    }
    const empty = t.inbox.empty[tab];
    return (
      <EmptyState
        compact={compact}
        align={align}
        // Di desktop ilustrasi ada di ruang chat; di HP daftar adalah seluruh layar.
        illustration={isHp ? <ChatIllustration /> : undefined}
        title={empty.title}
        // Inbox benar-benar kosong di desktop: ajakan lengkap sudah ada di ruang chat, jangan diulang.
        body={inboxEmpty ? t.inbox.empty.listHint : empty.body(mascotName)}
      />
    );
  }

  return (
    <>
      <ul className={styles.items} aria-describedby={ROVING_HINT_ID} onKeyDown={moveRowFocus}>
        {conversations.map((conversation, index) => (
          <ConversationItem
            key={conversation.id}
            conversation={conversation}
            selected={conversation.id === selectedId}
            tabStop={selectedInList ? conversation.id === selectedId : index === 0}
            showStatus={tab === 'semua'}
            now={now}
            onOpen={onOpen}
          />
        ))}
      </ul>
      <p id={ROVING_HINT_ID} className="sr-only">
        {t.inbox.rowsHint}
      </p>
      <div ref={sentinelRef} className={styles.listEnd}>
        {isFetchingNextPage ? (
          <ConversationRowsSkeleton rows={2} />
        ) : list.isFetchNextPageError ? (
          <Notice
            tone="danger"
            role="alert"
            actions={<Button onClick={() => void fetchNextPage()}>{t.common.retry}</Button>}
          >
            {t.inbox.loadMoreFailed}
          </Notice>
        ) : hasNextPage ? (
          // Cadangan tanpa IntersectionObserver / untuk keyboard.
          <Button variant="ghost" onClick={() => void fetchNextPage()}>
            {t.inbox.loadMore}
          </Button>
        ) : conversations.length > 8 ? (
          <p className={styles.endText}>{t.inbox.endOfList}</p>
        ) : null}
      </div>
    </>
  );
}

/** Kerangka baris chat: avatar, nama, cuplikan pesan, jam. */
export function ConversationRowsSkeleton({ rows = SKELETON_ROWS }: { rows?: number }) {
  return (
    <SkeletonRegion className={styles.skeletonRows}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.skeletonRow}>
          <Skeleton className={styles.skeletonAvatar} />
          <div className={styles.skeletonLines}>
            <Skeleton className={styles.skeletonName} />
            <Skeleton className={styles.skeletonSnippet} />
            <Skeleton className={styles.skeletonMeta} />
          </div>
          <Skeleton className={styles.skeletonTime} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
