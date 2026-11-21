import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { PriorityBadge } from './TicketBits';
import { TicketFormDialog } from './TicketFormDialog';
import { ticketListQuery } from './ticket-queries';
import styles from './Tickets.module.css';

const k = t.tickets;

/**
 * Tiket yang menaut kontak / percakapan (detail kontak, panel detail chat), terbuka & selesai,
 * maks. 10 terbaru + "Buat tiket" dengan tautan terisi. Butuh `tickets.manage` (pemanggil memeriksa).
 */
export function LinkedTickets({
  contactId,
  conversationId,
  contactName,
}: {
  contactId?: string;
  conversationId?: string;
  contactName: string;
}) {
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useInfiniteQuery(
    ticketListQuery({ contactId, conversationId, status: 'all', limit: 10 }),
  );
  const tickets = list.data?.pages[0]?.tickets ?? [];

  return (
    <div className={styles.linked}>
      {list.isPending ? (
        <SkeletonRegion className={styles.linkedList}>
          <Skeleton className={styles.linkedSkeleton} />
          <Skeleton className={styles.linkedSkeleton} />
        </SkeletonRegion>
      ) : list.isError ? (
        <p className={styles.hint}>{k.linkedFailed}</p>
      ) : tickets.length === 0 ? (
        <p className={styles.hint}>{conversationId ? k.linkedEmpty : t.contacts.ticketsEmpty}</p>
      ) : (
        <ul className={styles.linkedList}>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <Link
                to="/tiket/$ticketId"
                params={{ ticketId: ticket.id }}
                className={styles.linkedItem}
                aria-label={k.cardLabel(ticket.number, ticket.title)}
              >
                <span className={styles.linkedTitle} dir="auto">
                  {ticket.title}
                </span>
                <span className={styles.linkedMeta}>
                  <span className={styles.number}>#{ticket.number}</span>
                  {ticket.priority === 'high' || ticket.priority === 'urgent' ? (
                    <PriorityBadge priority={ticket.priority} />
                  ) : null}
                  <span
                    className={styles.columnName}
                    data-done={ticket.column.isDone ? '' : undefined}
                  >
                    {ticket.column.name}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {notice ? (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      ) : null}
      <Button
        variant="ghost"
        className={styles.linkedCreate}
        onClick={() => {
          setNotice(null);
          setCreating(true);
        }}
      >
        <Icon icon={Plus} size={16} />
        {k.createFromChat}
      </Button>
      {creating ? (
        <TicketFormDialog
          target={{
            kind: 'create',
            contactId: conversationId ? undefined : contactId,
            conversationId,
            origin: k.linkedFrom(contactName),
          }}
          onClose={() => setCreating(false)}
          onDone={(ticket) => {
            setCreating(false);
            setNotice(ticket ? k.createdFlash(ticket.number) : k.createdNoAccess);
            void list.refetch();
          }}
        />
      ) : null}
    </div>
  );
}
