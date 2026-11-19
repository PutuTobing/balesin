import { TICKET_PRIORITY_LABELS, type Ticket, type TicketPriority } from '@balesin/shared';
import { CalendarClock, UserPlus } from 'lucide-react';
import { Icon } from '../../components/ui/Icon';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import styles from './Tickets.module.css';

const k = t.tickets;

const PRIORITY_TONES: Record<TicketPriority, StatusTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

export function PriorityBadge({
  priority,
  className,
}: {
  priority: TicketPriority;
  className?: string;
}) {
  return (
    <StatusBadge
      tone={PRIORITY_TONES[priority]}
      label={TICKET_PRIORITY_LABELS[priority]}
      className={className}
    />
  );
}

const dueFormat = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDue(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dueFormat.format(date);
}

/** Tenggat: abu-abu, atau merah (`--danger-ink`) bila lewat dan tiket belum selesai. */
export function DueText({ ticket, className }: { ticket: Ticket; className?: string }) {
  if (!ticket.dueAt) return null;
  return (
    <span className={cx(styles.due, className)} data-overdue={ticket.overdue ? '' : undefined}>
      <Icon icon={CalendarClock} size={16} />
      <span>
        {ticket.overdue ? `${k.overdue} · ` : null}
        {formatDue(ticket.dueAt)}
      </span>
    </span>
  );
}

/** Inisial penanggung jawab (nama lengkap di `title` + teks tersembunyi). */
export function AssigneeInitials({ name }: { name: string | null }) {
  if (!name) {
    return (
      <span className={styles.assignee} title={k.unassigned} data-empty="">
        <Icon icon={UserPlus} size={16} />
        <span className="sr-only">{k.unassigned}</span>
      </span>
    );
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase('id-ID'))
    .join('');
  return (
    <span className={styles.assignee} title={name}>
      <span aria-hidden="true">{initials}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}
