import {
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  type Ticket,
  type TicketPriority,
  type UpdateTicketRequest,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Pencil, Trash2, X } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  LoadFailedIllustration,
  TicketsIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTime } from '../../lib/format';
import { useCan, useSession } from '../auth/session';
import { displayAttributeValue, splitAttributes } from '../contacts/attribute-values';
import { agentsQuery, isNotFound } from '../inbox/inbox-queries';
import { DueText, PriorityBadge } from './TicketBits';
import { describeEvent } from './ticket-events';
import { TicketFormDialog } from './TicketFormDialog';
import {
  boardsQuery,
  fromLocalInput,
  setTicketFlash,
  storeTicket,
  ticketCommentsQuery,
  ticketEventsQuery,
  ticketKeys,
  ticketQuery,
  ticketScope,
  toLocalInput,
} from './ticket-queries';
import styles from './Tickets.module.css';

const k = t.tickets;
const routeApi = getRouteApi('/_app/tiket/$ticketId');

/**
 * Detail tiket: judul + deskripsi, rincian (kolom, prioritas, penanggung jawab, tenggat, tautan,
 * isian board), komentar & riwayat. Aksi tulis menjawab `{ ticket | null }` — `null` = kehilangan
 * akses → kembali ke daftar dengan pesan. Teknisi: penanggung jawab & tautan hanya-baca.
 */
export function TicketDetailPage() {
  const { ticketId } = routeApi.useParams();
  const result = useQuery(ticketQuery(ticketId));
  const ticket = result.data?.ticket;
  return (
    <Page>
      {result.isPending ? (
        <DetailSkeleton />
      ) : isNotFound(result.error) || (!ticket && !result.isError) ? (
        <EmptyState
          illustration={<TicketsIllustration />}
          title={k.notFoundTitle}
          body={k.notFoundBody}
          actions={
            <Button variant="primary" asChild>
              <Link to="/tiket">{k.backToTickets}</Link>
            </Button>
          }
        />
      ) : !ticket ? (
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={k.loadFailedTitle}
          body={isApiError(result.error) ? result.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void result.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      ) : (
        <TicketDetail ticket={ticket} />
      )}
    </Page>
  );
}

function TicketDetail({ ticket }: { ticket: Ticket }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const own = ticketScope(session) === 'own';
  const canAssign = useCan('inbox.assign') && !own;
  const canConfigure = useCan('tickets.configure');
  const boards = useQuery(boardsQuery(false));
  const archivedBoards = useQuery({ ...boardsQuery(true), enabled: boards.isSuccess });
  const agents = useQuery({ ...agentsQuery, enabled: canAssign });
  const board =
    boards.data?.find((item) => item.id === ticket.boardId) ??
    archivedBoards.data?.find((item) => item.id === ticket.boardId);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);

  const leave = (message: string) => {
    setTicketFlash(message);
    void navigate({ to: '/tiket', search: { board: ticket.boardId }, replace: true });
  };

  const update = useMutation({
    mutationFn: (body: UpdateTicketRequest) => endpoints.tickets.update(ticket.id, body),
    onMutate: () => setSaved(false),
    onSuccess: ({ ticket: updated }) => {
      storeTicket(queryClient, ticket.id, updated);
      if (!updated) leave(k.lostAccess);
      else setSaved(true);
    },
  });
  const move = useMutation({
    mutationFn: (columnId: string) => endpoints.tickets.move(ticket.id, { columnId }),
    onMutate: () => setSaved(false),
    onSuccess: ({ ticket: updated }) => {
      storeTicket(queryClient, ticket.id, updated);
      if (!updated) leave(k.lostAccess);
      else setSaved(true);
    },
  });
  const remove = useMutation({
    mutationFn: () => endpoints.tickets.remove(ticket.id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ticketKeys.detail(ticket.id) });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
      leave(k.deletedFlash(ticket.number));
    },
  });
  const failure = update.error ?? move.error ?? remove.error;
  const busy = update.isPending || move.isPending;

  const columns = [...(board?.columns ?? [ticket.column])].sort((a, b) => a.position - b.position);
  const { defined, free } = splitAttributes(board?.attributes ?? [], ticket.attributes);

  return (
    <div className={styles.detail}>
      <header className={styles.detailHead}>
        <div className={styles.detailTitleRow}>
          <span className={styles.number}>#{ticket.number}</span>
          <PriorityBadge priority={ticket.priority} />
          {ticket.column.isDone ? (
            <span className={styles.doneBadge}>{k.statuses.closed}</span>
          ) : null}
        </div>
        <h2 className={styles.detailTitle} dir="auto">
          {ticket.title}
        </h2>
        <div className={styles.detailActions}>
          <Button onClick={() => setEditing(true)}>
            <Icon icon={Pencil} size={16} />
            {k.edit}
          </Button>
          {canConfigure ? (
            <Button className={styles.dangerText} onClick={() => setDeleting(true)}>
              <Icon icon={Trash2} size={16} />
              {k.deleteTicket}
            </Button>
          ) : null}
        </div>
      </header>
      {board?.archivedAt ? <Notice tone="info">{k.archivedNotice}</Notice> : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : saved ? (
        <p className={styles.savedNote} role="status">
          {k.saved}
        </p>
      ) : null}

      <div className={styles.detailGrid}>
        <div className={styles.detailMain}>
          <section
            className={`${styles.card} ${styles.descriptionCard}`}
            aria-labelledby="tiket-deskripsi"
          >
            <h3 id="tiket-deskripsi" className={styles.sectionTitle}>
              {k.descriptionLabel}
            </h3>
            {ticket.description ? (
              <p className={styles.description} dir="auto">
                {ticket.description}
              </p>
            ) : (
              <p className={styles.hint}>{k.noDescription}</p>
            )}
          </section>
          <Activity ticket={ticket} />
        </div>

        <aside
          className={`${styles.card} ${styles.propertiesCard}`}
          aria-labelledby="tiket-rincian"
        >
          <h3 id="tiket-rincian" className={styles.sectionTitle}>
            {k.properties}
          </h3>
          <div className={styles.propertyFields}>
            <SelectField
              label={k.columnStatus}
              value={ticket.column.id}
              onChange={(event) => move.mutate(event.target.value)}
              options={columns.map((column) => ({ value: column.id, label: column.name }))}
              disabled={busy || !board}
            />
            <SelectField
              label={k.priorityLabel}
              value={ticket.priority}
              onChange={(event) =>
                update.mutate({ priority: event.target.value as TicketPriority })
              }
              options={TICKET_PRIORITIES.map((value) => ({
                value,
                label: TICKET_PRIORITY_LABELS[value],
              }))}
              disabled={busy}
            />
            {canAssign ? (
              <SelectField
                label={k.assigneePick}
                value={ticket.assignee?.id ?? ''}
                onChange={(event) => update.mutate({ assigneeUserId: event.target.value || null })}
                options={[
                  { value: '', label: k.assigneeNobody },
                  ...(agents.data?.agents ?? [])
                    .filter((agent) => agent.active || agent.id === ticket.assignee?.id)
                    .map((agent) => ({ value: agent.id, label: agent.name })),
                  ...(ticket.assignee &&
                  !(agents.data?.agents ?? []).some((agent) => agent.id === ticket.assignee?.id)
                    ? [{ value: ticket.assignee.id, label: ticket.assignee.name }]
                    : []),
                ]}
                disabled={busy}
              />
            ) : null}
            <DueField
              ticket={ticket}
              disabled={busy}
              onSave={(dueAt) => update.mutate({ dueAt })}
            />
          </div>
          <dl className={styles.facts}>
            {canAssign ? null : (
              <Fact term={k.assigneePick}>{ticket.assignee?.name ?? k.unassigned}</Fact>
            )}
            <Fact term={k.board}>{board?.name ?? '—'}</Fact>
            <Fact term={k.linkedContact}>
              {ticket.contact ? (
                <Link
                  to="/kontak/$contactId"
                  params={{ contactId: ticket.contact.id }}
                  className={styles.inlineLink}
                  dir="auto"
                >
                  {ticket.contact.displayName}
                </Link>
              ) : (
                <span className={styles.muted}>{k.notLinked}</span>
              )}
            </Fact>
            <Fact term={k.linkedConversation}>
              {ticket.conversation ? (
                <Link
                  to="/inbox"
                  search={{ chat: ticket.conversation.id }}
                  className={styles.inlineLink}
                  aria-label={k.openConversation(ticket.conversation.number)}
                >
                  {k.conversationStatus(
                    ticket.conversation.number,
                    t.inbox.item.status[ticket.conversation.status],
                  )}
                </Link>
              ) : ticket.conversationUnavailable ? (
                // Tahap 9.0: percakapan di channel yang tidak boleh dilihat pengguna ini.
                <span className={styles.muted}>{k.conversationUnavailable}</span>
              ) : (
                <span className={styles.muted}>{k.notLinked}</span>
              )}
            </Fact>
            {(board?.attributes ?? []).map((definition) => (
              <Fact key={definition.id} term={definition.label}>
                {defined[definition.key] ? (
                  <span dir="auto">
                    {displayAttributeValue(definition, defined[definition.key] ?? '')}
                  </span>
                ) : (
                  <span className={definition.required ? styles.missing : styles.muted}>
                    {definition.required ? t.contacts.requiredMissing : t.inbox.detail.notSet}
                  </span>
                )}
              </Fact>
            ))}
            {free.map((item) => (
              <Fact key={item.key} term={item.key}>
                <span dir="auto">{item.value}</span>
              </Fact>
            ))}
            <Fact term={k.createdBy}>
              {ticket.createdBy
                ? ticket.createdBy.kind === 'api_key'
                  ? k.createdByKey(ticket.createdBy.name)
                  : ticket.createdBy.name
                : k.systemActor}
            </Fact>
            <Fact term={k.createdAt}>{formatDateTime(ticket.createdAt)}</Fact>
            <Fact term={k.updatedAt}>{formatDateTime(ticket.updatedAt)}</Fact>
          </dl>
          {own ? <p className={styles.hint}>{k.technicianNote}</p> : null}
        </aside>
      </div>

      {editing ? (
        <TicketFormDialog
          target={{ kind: 'edit', ticket }}
          onClose={() => setEditing(false)}
          onDone={(updated) => {
            setEditing(false);
            if (!updated) leave(k.lostAccess);
            else setSaved(true);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        title={k.deleteTitle(ticket.number)}
        body={k.deleteBody}
        cancelLabel={k.cancel}
        confirmLabel={k.deleteConfirm}
        confirmVariant="danger"
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          remove.mutate();
        }}
      />
    </div>
  );
}

/** Tenggat: `datetime-local` + simpan / hapus. */
function DueField({
  ticket,
  disabled,
  onSave,
}: {
  ticket: Ticket;
  disabled: boolean;
  onSave: (dueAt: string | null) => void;
}) {
  const [value, setValue] = useState(toLocalInput(ticket.dueAt));
  const changed = value !== toLocalInput(ticket.dueAt);
  return (
    <div className={styles.dueField}>
      <TextField
        label={k.duePick}
        type="datetime-local"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        hint={ticket.dueAt && !changed ? <DueText ticket={ticket} /> : undefined}
      />
      {changed ? (
        <Button disabled={disabled} onClick={() => onSave(fromLocalInput(value))}>
          {k.save}
        </Button>
      ) : ticket.dueAt ? (
        <Button
          variant="ghost"
          className={styles.dueClear}
          disabled={disabled}
          onClick={() => {
            setValue('');
            onSave(null);
          }}
        >
          <Icon icon={X} size={16} />
          {k.clearDue}
        </Button>
      ) : null}
    </div>
  );
}

/** Komentar & riwayat (tab). */
function Activity({ ticket }: { ticket: Ticket }) {
  const [tab, setTab] = useState('comments');
  return (
    <Tabs.Root
      value={tab}
      onValueChange={setTab}
      className={`${styles.card} ${styles.activityCard}`}
    >
      <Tabs.List className={styles.tabs} aria-label={k.tabsLabel}>
        <Tabs.Trigger value="comments" className={styles.tab}>
          {k.tabComments}
        </Tabs.Trigger>
        <Tabs.Trigger value="history" className={styles.tab}>
          {k.tabHistory}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="comments" className={styles.tabContent}>
        <Comments ticket={ticket} />
      </Tabs.Content>
      <Tabs.Content value="history" className={styles.tabContent}>
        <History ticketId={ticket.id} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function Comments({ ticket }: { ticket: Ticket }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const canModerate = useCan('tickets.configure');
  const comments = useQuery(ticketCommentsQuery(ticket.id));
  const [body, setBody] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (text: string) => endpoints.tickets.addComment(ticket.id, text),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ticketKeys.comments(ticket.id) });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.events(ticket.id) });
    },
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => endpoints.tickets.removeComment(ticket.id, commentId),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ticketKeys.comments(ticket.id) }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (body.trim()) add.mutate(body);
  };
  const list = comments.data?.comments ?? [];
  return (
    <div className={styles.comments}>
      {comments.isPending ? (
        <SkeletonRegion className={styles.commentList}>
          <Skeleton className={styles.skeletonCard} />
        </SkeletonRegion>
      ) : comments.isError ? (
        <p className={styles.hint}>{k.commentsFailed}</p>
      ) : list.length === 0 ? (
        <p className={styles.hint}>{k.noComments}</p>
      ) : (
        <ol className={styles.commentList}>
          {list.map((comment) => {
            const mine = comment.author?.kind === 'user' && comment.author.id === session?.user.id;
            return (
              <li key={comment.id} className={styles.comment}>
                <div className={styles.commentHead}>
                  <span className={styles.commentAuthor}>
                    {comment.author
                      ? comment.author.kind === 'api_key'
                        ? k.commentByKey(comment.author.name)
                        : comment.author.name
                      : k.systemActor}
                  </span>
                  <span className={styles.commentTime}>{formatDateTime(comment.createdAt)}</span>
                  {mine || canModerate ? (
                    <IconButton
                      label={k.deleteComment}
                      icon={Trash2}
                      className={styles.commentDelete}
                      onClick={() => setRemoving(comment.id)}
                    />
                  ) : null}
                </div>
                <p className={styles.commentBody} dir="auto">
                  {comment.body}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      <form className={styles.commentForm} onSubmit={submit}>
        <TextAreaField
          label={k.commentLabel}
          placeholder={k.commentPlaceholder}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={TICKET_LIMITS.commentMax}
          rows={3}
          dir="auto"
          error={
            add.isError && isApiError(add.error) && add.error.details.length > 0
              ? add.error.details[0]?.message
              : undefined
          }
        />
        {add.isError && !(isApiError(add.error) && add.error.details.length > 0) ? (
          <Notice tone="danger" role="alert">
            {isApiError(add.error) ? add.error.message : t.api.network}
          </Notice>
        ) : null}
        {remove.isError ? (
          <Notice tone="danger" role="alert">
            {isApiError(remove.error) ? remove.error.message : t.api.network}
          </Notice>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          className={styles.commentSend}
          loading={add.isPending}
          disabled={!body.trim()}
        >
          {add.isPending ? k.sendingComment : k.sendComment}
        </Button>
      </form>
      <ConfirmDialog
        open={removing !== null}
        title={k.deleteCommentTitle}
        body={k.deleteCommentBody}
        cancelLabel={k.cancel}
        confirmLabel={k.deleteComment}
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove.mutate(removing);
          setRemoving(null);
        }}
      />
    </div>
  );
}

function History({ ticketId }: { ticketId: string }) {
  const events = useQuery(ticketEventsQuery(ticketId));
  if (events.isPending) {
    return (
      <SkeletonRegion className={styles.commentList}>
        <Skeleton className={styles.skeletonMeta} />
        <Skeleton className={styles.skeletonMeta} />
      </SkeletonRegion>
    );
  }
  if (events.isError) return <p className={styles.hint}>{k.historyFailed}</p>;
  const list = [...events.data.events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (list.length === 0) return <p className={styles.hint}>{k.historyEmpty}</p>;
  return (
    <ol className={styles.history}>
      {list.map((event) => (
        <li key={event.id} className={styles.historyItem}>
          <span className={styles.historyText}>{describeEvent(event)}</span>
          <span className={styles.commentTime}>{formatDateTime(event.createdAt)}</span>
        </li>
      ))}
    </ol>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

function DetailSkeleton() {
  return (
    <SkeletonRegion className={styles.detail}>
      <Skeleton className={styles.skeletonToolbar} />
      <div className={styles.detailGrid}>
        <div className={styles.card}>
          <Skeleton className={styles.skeletonTitle} />
          <Skeleton className={styles.skeletonMeta} />
        </div>
        <div className={styles.card}>
          <Skeleton className={styles.skeletonMeta} />
          <Skeleton className={styles.skeletonMeta} />
        </div>
      </div>
    </SkeletonRegion>
  );
}
