import type { Ticket, TicketColumn, TicketKanbanResponse } from '@balesin/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Circle,
  EllipsisVertical,
  GripVertical,
  ArrowRightLeft,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useId, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { SelectField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { media, useMediaQuery } from '../../lib/media';
import { ColumnDialog, DeleteColumnDialog } from './ColumnDialogs';
import { AssigneeInitials, DueText, PriorityBadge } from './TicketBits';
import {
  moveInKanban,
  storeBoard,
  storeTicket,
  ticketKeys,
  type KanbanFilter,
} from './ticket-queries';
import styles from './Tickets.module.css';

const k = t.tickets;

interface Grab {
  ticket: Ticket;
  fromColumnId: string;
  columnId: string;
  index: number;
}

/**
 * Kanban satu board. Pindah tiket dengan tiga cara yang setara:
 *  - seret-lepas mouse (HTML5 drag & drop) di desktop;
 *  - keyboard: fokus pegangan kartu → Spasi/Enter angkat → panah kiri/kanan (kolom) & atas/bawah
 *    (urutan) → Spasi/Enter letakkan, Escape batal; setiap langkah diumumkan `aria-live`;
 *  - menu "Pindah ke…" di setiap kartu (HP & pengguna yang tidak menyeret).
 * HP: satu kolom tampil, dipilih lewat `<select>` (tanpa gulir horizontal halaman).
 */
export function KanbanBoard({
  data,
  filter,
  canConfigure,
}: {
  data: TicketKanbanResponse;
  filter: KanbanFilter;
  canConfigure: boolean;
}) {
  const queryClient = useQueryClient();
  const isHp = useMediaQuery(media.hp);
  const hintId = useId();
  const [grab, setGrab] = useState<Grab | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; index: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hpColumn, setHpColumn] = useState<string | null>(null);
  const [columnDialog, setColumnDialog] = useState<
    { kind: 'add' } | { kind: 'rename'; column: TicketColumn } | null
  >(null);
  const [deleting, setDeleting] = useState<{ column: TicketColumn; total: number } | null>(null);
  const key = ticketKeys.kanban(data.board.id, filter);
  const columns = [...data.columns].sort((a, b) => a.column.position - b.column.position);

  const move = useMutation({
    mutationFn: ({
      ticket,
      columnId,
      index,
    }: {
      ticket: Ticket;
      columnId: string;
      index: number;
    }) => {
      const target = columns.find((entry) => entry.column.id === columnId);
      const others = (target?.tickets ?? []).filter((item) => item.id !== ticket.id);
      const afterTicketId = index <= 0 ? null : (others[index - 1]?.id ?? undefined);
      return endpoints.tickets.move(ticket.id, {
        columnId,
        ...(afterTicketId === undefined ? {} : { afterTicketId }),
      });
    },
    onMutate: ({ ticket, columnId, index }) => {
      setError(null);
      const previous = queryClient.getQueryData<TicketKanbanResponse>(key);
      if (previous)
        queryClient.setQueryData(key, moveInKanban(previous, ticket.id, columnId, index));
      return { previous };
    },
    onSuccess: ({ ticket: updated }, { ticket }) => {
      storeTicket(queryClient, ticket.id, updated);
      if (!updated) setError(k.lostAccess);
    },
    onError: (caught, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      setError(isApiError(caught) ? caught.message : k.moveFailed);
    },
  });

  const columnAction = useMutation({
    mutationFn: ({
      column,
      patch,
    }: {
      column: TicketColumn;
      patch: { isDone?: boolean; position?: number };
    }) => endpoints.tickets.updateColumn(data.board.id, column.id, patch),
    onMutate: () => setError(null),
    onSuccess: ({ board }) => storeBoard(queryClient, board),
    onError: (caught) => setError(isApiError(caught) ? caught.message : t.api.network),
  });

  const moveTo = (ticket: Ticket, columnId: string, index: number) => {
    const from = columns.find((entry) => entry.tickets.some((item) => item.id === ticket.id));
    const currentIndex = from?.tickets.findIndex((item) => item.id === ticket.id) ?? -1;
    if (from?.column.id === columnId && currentIndex === index) return;
    move.mutate({ ticket, columnId, index });
  };

  // Tampilan selama kartu diangkat dengan keyboard: kartu dipindah ke posisi sementara.
  const shown = grab
    ? moveInKanban(data, grab.ticket.id, grab.columnId, grab.index).columns.sort(
        (a, b) => a.column.position - b.column.position,
      )
    : columns;

  const onHandleKey = (event: KeyboardEvent, ticket: Ticket) => {
    const columnIndex = shown.findIndex((entry) =>
      entry.tickets.some((item) => item.id === ticket.id),
    );
    const entry = shown[columnIndex];
    if (!entry) return;
    const index = entry.tickets.findIndex((item) => item.id === ticket.id);
    if (!grab) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setGrab({ ticket, fromColumnId: entry.column.id, columnId: entry.column.id, index });
        setAnnouncement(
          k.grabbed(ticket.number, entry.column.name, index + 1, entry.tickets.length),
        );
      }
      return;
    }
    const announce = (columnId: string, nextIndex: number) => {
      const target = shown.find((item) => item.column.id === columnId);
      const count = (target?.tickets.length ?? 0) + (columnId === grab.columnId ? 0 : 1);
      setAnnouncement(k.movedOver(target?.column.name ?? '', nextIndex + 1, count));
    };
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        const next = Math.max(0, Math.min(entry.tickets.length - 1, index + delta));
        setGrab({ ...grab, index: next });
        announce(grab.columnId, next);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault();
        const target = shown[columnIndex + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (!target) break;
        const next = Math.min(index, target.tickets.length);
        setGrab({ ...grab, columnId: target.column.id, index: next });
        if (isHp) setHpColumn(target.column.id);
        announce(target.column.id, next);
        break;
      }
      case ' ':
      case 'Enter': {
        event.preventDefault();
        const column = shown.find((item) => item.column.id === grab.columnId);
        setGrab(null);
        moveTo(grab.ticket, grab.columnId, grab.index);
        setAnnouncement(k.dropped(ticket.number, column?.column.name ?? ''));
        break;
      }
      case 'Escape':
      case 'Tab': {
        if (event.key === 'Escape') event.preventDefault();
        setGrab(null);
        if (isHp) setHpColumn(grab.fromColumnId);
        setAnnouncement(k.dropCancelled(ticket.number));
        break;
      }
    }
  };

  // Fokus mengikuti kartu yang diangkat setelah pindah kolom (elemen dirender ulang).
  useEffect(() => {
    if (!grab) return;
    document.getElementById(`pegangan-${grab.ticket.id}`)?.focus();
  }, [grab]);

  const dragOver = (event: DragEvent, columnId: string) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const list = event.currentTarget as HTMLElement;
    const cards = [...list.querySelectorAll<HTMLElement>('[data-ticket-card]')].filter(
      (card) => card.dataset.ticketCard !== dragging,
    );
    let index = cards.length;
    for (const [position, card] of cards.entries()) {
      const box = card.getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) {
        index = position;
        break;
      }
    }
    if (dropTarget?.columnId !== columnId || dropTarget.index !== index) {
      setDropTarget({ columnId, index });
    }
  };

  const drop = (event: DragEvent, columnId: string) => {
    event.preventDefault();
    const ticket = columns.flatMap((entry) => entry.tickets).find((item) => item.id === dragging);
    if (ticket && dropTarget?.columnId === columnId) moveTo(ticket, columnId, dropTarget.index);
    setDragging(null);
    setDropTarget(null);
  };

  const visible = isHp
    ? shown.filter((entry) => entry.column.id === (hpColumn ?? shown[0]?.column.id))
    : shown;
  const hpEntry = isHp ? visible[0] : undefined;
  const hpPosition = hpEntry
    ? columns.findIndex((item) => item.column.id === hpEntry.column.id)
    : -1;

  return (
    <div className={styles.kanbanWrap}>
      <p id={hintId} className="sr-only">
        {k.dragHint}
      </p>
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
      {grab ? (
        <p className={styles.grabHint} aria-hidden="true">
          {k.grabHintVisible}
        </p>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {isHp ? (
        <div className={styles.columnPicker}>
          <SelectField
            label={k.columnPickerLabel}
            value={hpColumn ?? shown[0]?.column.id ?? ''}
            onChange={(event) => setHpColumn(event.target.value)}
            options={shown.map((entry) => ({
              value: entry.column.id,
              label: `${entry.column.name} (${String(entry.total)})`,
            }))}
            className={styles.columnPickerField}
          />
          {canConfigure && hpEntry ? (
            <ColumnMenu
              column={hpEntry.column}
              first={hpPosition === 0}
              last={hpPosition === columns.length - 1}
              onRename={() => setColumnDialog({ kind: 'rename', column: hpEntry.column })}
              onToggleDone={() =>
                columnAction.mutate({
                  column: hpEntry.column,
                  patch: { isDone: !hpEntry.column.isDone },
                })
              }
              onMove={(delta) =>
                columnAction.mutate({
                  column: hpEntry.column,
                  patch: { position: hpPosition + delta },
                })
              }
              onDelete={() => setDeleting({ column: hpEntry.column, total: hpEntry.total })}
            />
          ) : null}
        </div>
      ) : null}
      <div className={styles.kanban} role="list" aria-label={k.kanbanLabel(data.board.name)}>
        {visible.map((entry) => {
          const position = columns.findIndex((item) => item.column.id === entry.column.id);
          return (
            <section
              key={entry.column.id}
              role="listitem"
              className={cx(
                styles.column,
                dropTarget?.columnId === entry.column.id && styles.columnOver,
              )}
              aria-label={k.columnLabel(entry.column.name, entry.total)}
            >
              <header className={styles.columnHead} hidden={isHp}>
                <h2 className={styles.columnName}>
                  {entry.column.isDone ? (
                    <Icon icon={CheckCircle2} size={16} className={styles.doneIcon} />
                  ) : null}
                  <span>{entry.column.name}</span>
                  {entry.column.isDone ? <span className="sr-only">{k.doneColumn}</span> : null}
                </h2>
                <span className={styles.columnCount}>
                  {k.columnCount(entry.tickets.length, entry.total)}
                </span>
                {canConfigure ? (
                  <ColumnMenu
                    column={entry.column}
                    first={position === 0}
                    last={position === columns.length - 1}
                    onRename={() => setColumnDialog({ kind: 'rename', column: entry.column })}
                    onToggleDone={() =>
                      columnAction.mutate({
                        column: entry.column,
                        patch: { isDone: !entry.column.isDone },
                      })
                    }
                    onMove={(delta) =>
                      columnAction.mutate({
                        column: entry.column,
                        patch: { position: position + delta },
                      })
                    }
                    onDelete={() => setDeleting({ column: entry.column, total: entry.total })}
                  />
                ) : null}
              </header>
              <ol
                className={styles.cards}
                onDragOver={(event) => dragOver(event, entry.column.id)}
                onDrop={(event) => drop(event, entry.column.id)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDropTarget(null);
                  }
                }}
              >
                {entry.tickets.map((ticket, index) => (
                  <li
                    key={ticket.id}
                    data-ticket-card={ticket.id}
                    className={cx(
                      styles.card,
                      grab?.ticket.id === ticket.id && styles.cardGrabbed,
                      dragging === ticket.id && styles.cardDragging,
                      dropTarget?.columnId === entry.column.id &&
                        dropTarget.index === index &&
                        dragging !== ticket.id &&
                        styles.dropBefore,
                    )}
                    draggable={!isHp}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', `#${String(ticket.number)}`);
                      setDragging(ticket.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  >
                    <TicketCard
                      ticket={ticket}
                      columns={columns.map((item) => item.column)}
                      hintId={hintId}
                      grabbed={grab?.ticket.id === ticket.id}
                      onHandleKey={(event) => onHandleKey(event, ticket)}
                      onMoveTo={(columnId) => {
                        const target = columns.find((item) => item.column.id === columnId);
                        moveTo(ticket, columnId, target?.tickets.length ?? 0);
                        setAnnouncement(k.dropped(ticket.number, target?.column.name ?? ''));
                      }}
                    />
                  </li>
                ))}
                {dropTarget?.columnId === entry.column.id &&
                dropTarget.index >=
                  entry.tickets.filter((ticket) => ticket.id !== dragging).length ? (
                  <li className={styles.dropEnd} aria-hidden="true" />
                ) : null}
                {entry.tickets.length === 0 ? (
                  <li className={styles.columnEmpty}>{k.columnEmpty}</li>
                ) : null}
              </ol>
              {entry.total > entry.tickets.length ? (
                <p className={styles.columnMore}>
                  {k.columnMore(entry.total - entry.tickets.length)}
                </p>
              ) : null}
            </section>
          );
        })}
        {canConfigure && !isHp ? (
          <div className={styles.addColumn}>
            <Button variant="ghost" onClick={() => setColumnDialog({ kind: 'add' })}>
              <Icon icon={Plus} size={16} />
              {k.addColumn}
            </Button>
          </div>
        ) : null}
      </div>
      {canConfigure && isHp ? (
        <Button className={styles.addColumnHp} onClick={() => setColumnDialog({ kind: 'add' })}>
          <Icon icon={Plus} size={16} />
          {k.addColumn}
        </Button>
      ) : null}
      {columnDialog ? (
        <ColumnDialog
          board={data.board}
          column={columnDialog.kind === 'rename' ? columnDialog.column : null}
          onClose={() => setColumnDialog(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteColumnDialog
          board={data.board}
          column={deleting.column}
          total={deleting.total}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function TicketCard({
  ticket,
  columns,
  hintId,
  grabbed,
  onHandleKey,
  onMoveTo,
}: {
  ticket: Ticket;
  columns: TicketColumn[];
  hintId: string;
  grabbed: boolean;
  onHandleKey: (event: KeyboardEvent) => void;
  onMoveTo: (columnId: string) => void;
}) {
  return (
    <>
      <div className={styles.cardTop}>
        <button
          type="button"
          id={`pegangan-${ticket.id}`}
          className={styles.handle}
          aria-label={k.grabLabel(ticket.number)}
          aria-describedby={hintId}
          aria-pressed={grabbed}
          onKeyDown={onHandleKey}
        >
          <Icon icon={GripVertical} size={16} />
        </button>
        <span className={styles.number}>#{ticket.number}</span>
        {ticket.priority === 'high' || ticket.priority === 'urgent' ? (
          <PriorityBadge priority={ticket.priority} className={styles.cardPriority} />
        ) : null}
        <MoveMenu ticket={ticket} columns={columns} onMoveTo={onMoveTo} />
      </div>
      <Link
        to="/tiket/$ticketId"
        params={{ ticketId: ticket.id }}
        className={styles.cardTitle}
        aria-label={k.cardLabel(ticket.number, ticket.title)}
        draggable={false}
      >
        <span dir="auto">{ticket.title}</span>
      </Link>
      {ticket.contact ? (
        <p className={styles.cardContact} dir="auto">
          {ticket.contact.displayName}
        </p>
      ) : null}
      <div className={styles.cardFoot}>
        <DueText ticket={ticket} />
        <AssigneeInitials name={ticket.assignee?.name ?? null} />
      </div>
    </>
  );
}

function MoveMenu({
  ticket,
  columns,
  onMoveTo,
}: {
  ticket: Ticket;
  columns: TicketColumn[];
  onMoveTo: (columnId: string) => void;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.cardMenu} aria-label={k.moveMenu(ticket.number)}>
          <Icon icon={ArrowRightLeft} size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={styles.menu}
        >
          <DropdownMenu.Label className={styles.menuLabel}>{k.moveTo}</DropdownMenu.Label>
          {columns.map((column) => {
            const current = column.id === ticket.column.id;
            return (
              <DropdownMenu.Item
                key={column.id}
                className={styles.menuItem}
                disabled={current}
                onSelect={() => onMoveTo(column.id)}
              >
                <span
                  className={styles.menuDot}
                  data-current={current ? '' : undefined}
                  aria-hidden="true"
                />
                <span className={styles.menuText}>
                  {current ? k.currentColumn(column.name) : column.name}
                  {column.isDone ? (
                    <span className={styles.menuNote}>{k.doneColumnShort}</span>
                  ) : null}
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ColumnMenu({
  column,
  first,
  last,
  onRename,
  onToggleDone,
  onMove,
  onDelete,
}: {
  column: TicketColumn;
  first: boolean;
  last: boolean;
  onRename: () => void;
  onToggleDone: () => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.columnMenu} aria-label={k.columnMenu(column.name)}>
          <Icon icon={EllipsisVertical} size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={styles.menu}
        >
          <DropdownMenu.Item className={styles.menuItem} onSelect={onRename}>
            <Icon icon={Pencil} size={16} />
            {k.renameColumn}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={styles.menuItem} onSelect={onToggleDone}>
            <Icon icon={column.isDone ? Circle : CheckCircle2} size={16} />
            {column.isDone ? k.unmarkDone : k.markDone}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={styles.menuItem}
            disabled={first}
            onSelect={() => onMove(-1)}
          >
            <Icon icon={ArrowLeft} size={16} />
            {k.moveColumnLeft}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={styles.menuItem} disabled={last} onSelect={() => onMove(1)}>
            <Icon icon={ArrowRight} size={16} />
            {k.moveColumnRight}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={cx(styles.menuItem, styles.menuDanger)}
            disabled={first && last}
            onSelect={onDelete}
          >
            <Icon icon={Trash2} size={16} />
            {k.deleteColumn}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
