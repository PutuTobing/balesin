import type { Ticket } from '@balesin/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import type { TicketListParams } from '../../lib/api/endpoints-crm';
import { formatDateTime } from '../../lib/format';
import { AssigneeInitials, DueText, PriorityBadge } from './TicketBits';
import { ticketListQuery } from './ticket-queries';
import styles from './Tickets.module.css';

const k = t.tickets;

/** Tampilan Daftar: semua tiket board (terbaru diubah dulu) dengan saringan + paginasi kursor. */
export function TicketList({
  params,
  filtered,
  onReset,
}: {
  params: TicketListParams;
  filtered: boolean;
  onReset: () => void;
}) {
  const list = useInfiniteQuery(ticketListQuery(params));
  const items = list.data?.pages.flatMap((page) => page.tickets) ?? [];

  if (list.isPending) {
    return (
      <SkeletonRegion className={styles.list}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={styles.listSkeleton}>
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonMeta} />
          </div>
        ))}
      </SkeletonRegion>
    );
  }
  if (list.isError) {
    return (
      <EmptyState
        illustration={<LoadFailedIllustration />}
        title={k.loadFailedTitle}
        body={isApiError(list.error) ? list.error.message : t.api.network}
        actions={
          <Button variant="primary" onClick={() => void list.refetch()}>
            {t.common.retry}
          </Button>
        }
      />
    );
  }
  if (items.length === 0) {
    return filtered ? (
      <EmptyState
        compact
        align="top"
        title={k.noMatchTitle}
        body={k.noMatchBody}
        actions={<Button onClick={onReset}>{k.resetFilters}</Button>}
      />
    ) : (
      <EmptyState compact align="top" title={k.emptyTitle} body={k.emptyBody} />
    );
  }
  return (
    <>
      <ul className={styles.list} aria-label={k.listLabel}>
        {items.map((ticket) => (
          <TicketRow key={ticket.id} ticket={ticket} />
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          className={styles.loadMore}
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? k.loadingMore : k.loadMore}
        </Button>
      ) : null}
    </>
  );
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  return (
    <li className={styles.listRow}>
      <Link
        to="/tiket/$ticketId"
        params={{ ticketId: ticket.id }}
        className={styles.listLink}
        aria-label={k.cardLabel(ticket.number, ticket.title)}
      >
        <span className={styles.listMain}>
          <span className={styles.listTitleLine}>
            <span className={styles.number}>#{ticket.number}</span>
            <span className={styles.listTitle} dir="auto">
              {ticket.title}
            </span>
          </span>
          <span className={styles.listMeta}>
            <span className={styles.columnName} data-done={ticket.column.isDone ? '' : undefined}>
              {ticket.column.isDone ? <Icon icon={CheckCircle2} size={16} /> : null}
              {ticket.column.name}
            </span>
            {ticket.contact ? <span dir="auto">{ticket.contact.displayName}</span> : null}
            <span>{formatDateTime(ticket.updatedAt)}</span>
          </span>
        </span>
        {/* Sel tetap: kolom prioritas, tenggat, penanggung jawab sejajar antarbaris. */}
        <span className={`${styles.listCell} ${styles.listPriority}`}>
          <PriorityBadge priority={ticket.priority} />
        </span>
        <span className={`${styles.listCell} ${styles.listDue}`}>
          <DueText ticket={ticket} />
        </span>
        <span className={styles.listCellEnd}>
          <AssigneeInitials name={ticket.assignee?.name ?? null} />
        </span>
      </Link>
    </li>
  );
}
