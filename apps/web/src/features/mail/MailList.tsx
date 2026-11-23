import type { MailAccount, MailMessageSummary } from '@balesin/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Clock, Paperclip, Star } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { MailboxIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import type { MailMessageListParams } from '../../lib/api/endpoints-mail';
import { cx } from '../../lib/cx';
import { formatListTime } from '../inbox/inbox-time';
import { ContactAvatar } from '../inbox/InboxBits';
import { useMinuteClock } from '../inbox/use-minute-clock';
import { AccountMark } from './AccountMark';
import { MAIL_PAGE_SIZE, addressName, aliasChip, groupMessages, isUnifiedView } from './mail-list';
import { mailMessagesQuery } from './mail-queries';
import styles from './MailList.module.css';

const l = t.mail.list;
const SKELETON_ROWS = 6;
const ROWS_HINT_ID = 'email-rows-hint';

/** Daftar = satu tab stop; panah atas/bawah, Home, End berpindah baris (sama dengan Inbox). */
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-message-id]'),
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

interface MailListProps {
  params: MailMessageListParams;
  accounts: readonly MailAccount[];
  selectedId: string | null;
  onOpen: (message: MailMessageSummary) => void;
}

/**
 * Isi kolom daftar email (kontrak §7): dikelompokkan per hari, bergulir tak terbatas (kursor).
 * Tampilan gabungan menandai akun asal di setiap baris. Semua isi email (nama, subjek, cuplikan)
 * dirender sebagai teks biasa dengan `dir="auto"`.
 */
export function MailList({ params, accounts, selectedId, onOpen }: MailListProps) {
  const list = useInfiniteQuery(mailMessagesQuery(params, MAIL_PAGE_SIZE));
  const now = useMinuteClock();
  const unified = isUnifiedView(params);
  const messages = useMemo(
    () => list.data?.pages.flatMap((page) => page.messages) ?? [],
    [list.data],
  );
  const groups = useMemo(() => groupMessages(messages, new Date(now)), [messages, now]);
  const initial = accounts.filter((account) => account.sync.state === 'initial_sync');

  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = list;
  const canLoadMore = hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
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

  if (list.isPending) return <MailRowsSkeleton />;

  if (list.isError && list.data === undefined) {
    return (
      <div className={styles.notice}>
        <Notice
          tone="danger"
          role="alert"
          title={l.loadFailedTitle}
          actions={
            <Button loading={list.isFetching} onClick={() => void list.refetch()}>
              {t.common.retry}
            </Button>
          }
        >
          {isApiError(list.error) ? list.error.message : t.api.network}
        </Notice>
      </div>
    );
  }

  const syncBanner = initial.length > 0 ? <InitialSync accounts={initial} /> : null;

  if (messages.length === 0) {
    if (syncBanner) return <div className={styles.scroll}>{syncBanner}</div>;
    const empty =
      params.view === 'folder'
        ? l.empty.folder
        : params.view === 'unread'
          ? l.empty.unread
          : params.view === 'starred'
            ? l.empty.starred
            : l.empty.inboxes;
    return (
      <div className={styles.scroll}>
        <EmptyState
          compact
          illustration={<MailboxIllustration />}
          title={empty.title}
          body={empty.body}
        />
      </div>
    );
  }

  const lastPage = list.data?.pages.at(-1);
  const tabStopId = messages.some((message) => message.id === selectedId)
    ? selectedId
    : (messages[0]?.id ?? null);

  return (
    <div className={styles.scroll} onKeyDown={moveRowFocus}>
      {syncBanner}
      <p id={ROWS_HINT_ID} className="sr-only">
        {l.rowsHint}
      </p>
      {groups.map((group) => (
        <section key={group.group} aria-label={l.groups[group.group]}>
          <h2 className={styles.group}>{l.groups[group.group]}</h2>
          <ul className={styles.rows}>
            {group.messages.map((message) => (
              <MailRow
                key={message.id}
                message={message}
                selected={message.id === selectedId}
                tabStop={message.id === tabStopId}
                unified={unified}
                now={now}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
      <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
      {isFetchingNextPage ? (
        <p className={styles.foot} role="status">
          {l.loadingMore}
        </p>
      ) : isFetchNextPageError ? (
        <div className={styles.foot} role="alert">
          <span>{l.loadMoreFailed}</span>
          <Button onClick={() => void fetchNextPage()}>{t.common.retry}</Button>
        </div>
      ) : !hasNextPage && lastPage?.olderOnServer ? (
        <p className={styles.foot}>{l.olderOnServer}</p>
      ) : null}
    </div>
  );
}

interface MailRowProps {
  message: MailMessageSummary;
  selected: boolean;
  tabStop: boolean;
  unified: boolean;
  now: number;
  onOpen: (message: MailMessageSummary) => void;
}

/** Satu baris (±82px): pengirim · alias · akun · waktu / subjek / cuplikan · lampiran · bintang. */
const MailRow = memo(function MailRow({
  message,
  selected,
  tabStop,
  unified,
  now,
  onOpen,
}: MailRowProps) {
  const sender = addressName(message.from);
  const alias = message.deliveredToAlias ? aliasChip(message.deliveredTo) : null;
  const unread = !message.isRead;
  const notes = [
    unread ? l.unread : null,
    message.isStarred ? l.starred : null,
    message.hasAttachments ? l.attachment : null,
    alias && message.deliveredTo ? l.toChipLabel(message.deliveredTo) : null,
    unified ? l.accountLabel(message.account.displayName) : null,
    message.pending ? l.pending : null,
  ].filter((note): note is string => note !== null);
  return (
    <li className={styles.rowWrap}>
      <button
        type="button"
        className={styles.row}
        aria-current={selected ? 'true' : undefined}
        aria-describedby={tabStop ? ROWS_HINT_ID : undefined}
        tabIndex={tabStop ? 0 : -1}
        data-unread={unread ? '' : undefined}
        data-message-id={message.id}
        onClick={() => onOpen(message)}
      >
        <ContactAvatar name={sender} className={styles.avatar} />
        <span className={styles.lines}>
          <span className={styles.line}>
            <span className={styles.from} dir="auto">
              {sender}
            </span>
            {alias ? (
              <span className={styles.alias} aria-hidden="true">
                {alias}
              </span>
            ) : null}
            {unified ? (
              <span className={styles.accountTip} title={message.account.displayName}>
                <AccountMark
                  account={{ ...message.account, avatarUrl: null }}
                  className={styles.accountSquare}
                />
              </span>
            ) : null}
            <time className={styles.time} dateTime={message.receivedAt}>
              {formatListTime(message.receivedAt, new Date(now))}
            </time>
          </span>
          <span className={styles.line}>
            <span className={styles.subject} dir="auto">
              {message.subject?.trim() || l.noSubject}
            </span>
          </span>
          <span className={styles.line}>
            <span className={styles.snippet} dir="auto">
              {message.snippet ?? ''}
            </span>
            {message.pending ? <Icon icon={Clock} size={16} className={styles.marker} /> : null}
            {message.hasAttachments ? (
              <Icon icon={Paperclip} size={16} className={styles.marker} />
            ) : null}
            {message.isStarred ? (
              <Icon icon={Star} size={16} className={cx(styles.marker, styles.star)} />
            ) : null}
            {unread ? <span className={styles.unreadDot} aria-hidden="true" /> : null}
          </span>
        </span>
        {notes.length > 0 ? <span className="sr-only">, {notes.join(', ')}</span> : null}
      </button>
    </li>
  );
});

/** Sinkron awal berjalan: progres gabungan semua akun yang sedang mengambil email pertama kali. */
function InitialSync({ accounts }: { accounts: readonly MailAccount[] }) {
  const done = accounts.reduce((sum, item) => sum + (item.sync.initialProgress?.done ?? 0), 0);
  const total = accounts.reduce((sum, item) => sum + (item.sync.initialProgress?.total ?? 0), 0);
  return (
    <div className={styles.sync} role="status">
      <p className={styles.syncTitle}>{l.initialTitle}</p>
      <p className={styles.syncBody}>{l.initialBody(done, total)}</p>
      {total > 0 ? (
        <progress className={styles.progress} max={total} value={done}>
          {Math.round((Math.min(done, total) / total) * 100)}%
        </progress>
      ) : null}
    </div>
  );
}

/** Kerangka baris: bentuk sama dengan baris jadi (avatar 36 + tiga baris teks). */
export function MailRowsSkeleton() {
  return (
    <SkeletonRegion className={styles.skeleton}>
      {Array.from({ length: SKELETON_ROWS }, (_, key) => (
        <div key={key} className={styles.skeletonRow}>
          <Skeleton className={styles.skeletonAvatar} />
          <div className={styles.skeletonLines}>
            <Skeleton className={styles.skeletonShort} />
            <Skeleton className={styles.skeletonMid} />
            <Skeleton className={styles.skeletonLong} />
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}
