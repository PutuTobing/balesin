import { TICKET_DUE_FILTERS, TICKET_PRIORITIES, TICKET_PRIORITY_LABELS } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Columns3, List, Plus, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  LoadFailedIllustration,
  TicketsIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import type { TicketListParams } from '../../lib/api/endpoints-crm';
import { cx } from '../../lib/cx';
import { useCan, useSession } from '../auth/session';
import { agentsQuery } from '../inbox/inbox-queries';
import { BoardCreateDialog } from './ColumnDialogs';
import { KanbanBoard } from './KanbanBoard';
import { TicketFormDialog } from './TicketFormDialog';
import { TicketList } from './TicketList';
import { boardsQuery, kanbanQuery, takeTicketFlash, ticketScope } from './ticket-queries';
import type { TicketSearch } from './ticket-search';
import styles from './Tickets.module.css';

const k = t.tickets;
const routeApi = getRouteApi('/_app/tiket');

/**
 * Tiket (`tickets.manage`): pilih board, Kanban atau Daftar, saringan, "Tiket baru". Board/kolom =
 * `tickets.configure`. Teknisi (`own`) hanya melihat tiket yang ia pegang (server menyaring).
 */
export function TicketsPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const goTo = useNavigate();
  const session = useSession();
  const own = ticketScope(session) === 'own';
  const canConfigure = useCan('tickets.configure');
  const boards = useQuery(boardsQuery(false));
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [flash, setFlash] = useState(() => takeTicketFlash());

  const list = boards.data ?? [];
  const board = list.find((item) => item.id === search.board) ?? list[0];
  const view = search.tampilan === 'daftar' ? 'daftar' : 'kanban';

  const update = (patch: Partial<TicketSearch>) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });

  const actions =
    board || canConfigure ? (
      <div className={styles.pageActions}>
        {board ? (
          <Button variant="primary" onClick={() => setCreatingTicket(true)}>
            <Icon icon={Plus} size={16} />
            {k.newTicket}
          </Button>
        ) : null}
      </div>
    ) : undefined;

  return (
    <Page actions={list.length > 0 ? actions : undefined}>
      <div className={styles.content}>
        {flash ? (
          <Notice tone="success" role="status">
            {flash}
          </Notice>
        ) : null}
        {boards.isPending ? (
          <BoardSkeleton />
        ) : boards.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={k.loadFailedTitle}
            body={isApiError(boards.error) ? boards.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void boards.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : !board ? (
          <EmptyState
            illustration={<TicketsIllustration />}
            title={k.noBoardsTitle}
            body={canConfigure ? k.noBoardsBody : k.noBoardsBodyNoConfigure}
            actions={
              canConfigure ? (
                <Button variant="primary" onClick={() => setCreatingBoard(true)}>
                  <Icon icon={Plus} size={16} />
                  {k.createFirstBoard}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className={styles.toolbar}>
              <SelectField
                label={k.boardLabel}
                value={board.id}
                onChange={(event) => update({ board: event.target.value })}
                options={list.map((item) => ({ value: item.id, label: item.name }))}
                className={styles.boardSelect}
              />
              <div className={styles.viewSwitch} role="group" aria-label={k.viewLabel}>
                {(['kanban', 'daftar'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={cx(styles.viewOption)}
                    aria-pressed={view === value}
                    onClick={() => update({ tampilan: value === 'daftar' ? 'daftar' : undefined })}
                  >
                    <Icon icon={value === 'kanban' ? Columns3 : List} size={16} />
                    {k.views[value]}
                  </button>
                ))}
              </div>
              {canConfigure ? (
                <div className={styles.boardActions}>
                  <Button variant="ghost" asChild>
                    <Link to="/tiket/board/$boardId" params={{ boardId: board.id }}>
                      <Icon icon={Settings2} size={16} />
                      {k.boardSettings}
                    </Link>
                  </Button>
                  <Button variant="ghost" onClick={() => setCreatingBoard(true)}>
                    <Icon icon={Plus} size={16} />
                    {k.newBoard}
                  </Button>
                </div>
              ) : null}
            </div>
            <TicketFilters search={search} view={view} own={own} onChange={update} />
            {view === 'kanban' ? (
              <KanbanView
                boardId={board.id}
                assignee={own ? undefined : search.pj}
                priority={search.prioritas}
                canConfigure={canConfigure}
              />
            ) : (
              <TicketList
                params={listParams(board.id, search, own)}
                filtered={Boolean(
                  search.pj || search.prioritas || search.status || search.tenggat || search.cari,
                )}
                onReset={() =>
                  void navigate({ search: { board: board.id, tampilan: 'daftar' }, replace: true })
                }
              />
            )}
          </>
        )}
      </div>
      {creatingBoard ? (
        <BoardCreateDialog
          onClose={() => setCreatingBoard(false)}
          onCreated={(created) => {
            setCreatingBoard(false);
            update({ board: created.id });
          }}
        />
      ) : null}
      {creatingTicket && board ? (
        <TicketFormDialog
          target={{ kind: 'create', boardId: board.id }}
          onClose={() => setCreatingTicket(false)}
          onDone={(ticket) => {
            setCreatingTicket(false);
            if (ticket) {
              void goTo({ to: '/tiket/$ticketId', params: { ticketId: ticket.id } });
            } else {
              setFlash(k.createdNoAccess);
            }
          }}
        />
      ) : null}
    </Page>
  );
}

function listParams(boardId: string, search: TicketSearch, own: boolean): TicketListParams {
  const q = search.cari?.trim();
  return {
    boardId,
    assignee: own ? undefined : search.pj,
    priority: search.prioritas,
    status: search.status ?? 'open',
    due: search.tenggat,
    q: q && q.length >= 1 ? q : undefined,
  };
}

function KanbanView({
  boardId,
  assignee,
  priority,
  canConfigure,
}: {
  boardId: string;
  assignee?: string;
  priority?: string;
  canConfigure: boolean;
}) {
  const filter = { assignee, priority };
  const kanban = useQuery(kanbanQuery(boardId, filter));
  if (kanban.isPending) return <BoardSkeleton columnsOnly />;
  if (kanban.isError) {
    return (
      <EmptyState
        illustration={<LoadFailedIllustration />}
        title={
          isApiError(kanban.error) && kanban.error.status === 404
            ? k.boardMissingTitle
            : k.loadFailedTitle
        }
        body={
          isApiError(kanban.error) && kanban.error.status === 404
            ? k.boardMissingBody
            : isApiError(kanban.error)
              ? kanban.error.message
              : t.api.network
        }
        actions={
          <Button variant="primary" onClick={() => void kanban.refetch()}>
            {t.common.retry}
          </Button>
        }
      />
    );
  }
  return <KanbanBoard data={kanban.data} filter={filter} canConfigure={canConfigure} />;
}

/** Penanggung jawab & prioritas (Kanban + Daftar); status, tenggat, cari (Daftar). */
function TicketFilters({
  search,
  view,
  own,
  onChange,
}: {
  search: TicketSearch;
  view: 'kanban' | 'daftar';
  own: boolean;
  onChange: (patch: Partial<TicketSearch>) => void;
}) {
  const canAssign = useCan('inbox.assign');
  const agents = useQuery({ ...agentsQuery, enabled: canAssign && !own });
  const [text, setText] = useState(search.cari ?? '');
  useEffect(() => {
    const value = text.trim();
    if (value === (search.cari ?? '')) return;
    const timer = window.setTimeout(() => onChange({ cari: value || undefined }), 300);
    return () => window.clearTimeout(timer);
  }, [text, search.cari, onChange]);

  return (
    <div className={styles.filters} role="group" aria-label={k.filtersLabel}>
      {view === 'daftar' ? (
        <div className={styles.filterSearch}>
          <SearchField
            value={text}
            onChange={setText}
            label={k.searchLabel}
            placeholder={k.searchPlaceholder}
            clearLabel={k.clearSearch}
            maxLength={100}
          />
        </div>
      ) : null}
      {own ? null : (
        <SelectField
          label={k.assigneeLabel}
          value={search.pj ?? ''}
          onChange={(event) => onChange({ pj: event.target.value || undefined })}
          options={[
            { value: '', label: k.assigneeAll },
            { value: 'me', label: k.assigneeMe },
            { value: 'none', label: k.assigneeNone },
            ...(agents.data?.agents ?? [])
              .filter((agent) => agent.active)
              .map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
          className={styles.filterField}
        />
      )}
      <SelectField
        label={k.priorityLabel}
        value={search.prioritas ?? ''}
        onChange={(event) =>
          onChange({
            prioritas: TICKET_PRIORITIES.find((value) => value === event.target.value),
          })
        }
        options={[
          { value: '', label: k.priorityAll },
          ...TICKET_PRIORITIES.map((value) => ({ value, label: TICKET_PRIORITY_LABELS[value] })),
        ]}
        className={styles.filterField}
      />
      {view === 'daftar' ? (
        <>
          <SelectField
            label={k.statusLabel}
            value={search.status ?? 'open'}
            onChange={(event) =>
              onChange({
                status:
                  event.target.value === 'closed' || event.target.value === 'all'
                    ? event.target.value
                    : undefined,
              })
            }
            options={(['open', 'closed', 'all'] as const).map((value) => ({
              value,
              label: k.statuses[value],
            }))}
            className={styles.filterField}
          />
          <SelectField
            label={k.dueLabel}
            value={search.tenggat ?? ''}
            onChange={(event) =>
              onChange({
                tenggat: TICKET_DUE_FILTERS.find((value) => value === event.target.value),
              })
            }
            options={[
              { value: '', label: k.dueAll },
              ...TICKET_DUE_FILTERS.map((value) => ({ value, label: k.dues[value] })),
            ]}
            className={styles.filterField}
          />
        </>
      ) : null}
      {own ? <p className={styles.hint}>{k.mineOnlyNote}</p> : null}
    </div>
  );
}

function BoardSkeleton({ columnsOnly = false }: { columnsOnly?: boolean }) {
  return (
    <SkeletonRegion className={styles.skeletonBoard}>
      {columnsOnly ? null : <Skeleton className={styles.skeletonToolbar} />}
      <div className={styles.skeletonColumns}>
        {[0, 1, 2].map((column) => (
          <div key={column} className={styles.skeletonColumn}>
            <Skeleton className={styles.skeletonMeta} />
            {[0, 1].map((card) => (
              <Skeleton key={card} className={styles.skeletonCard} />
            ))}
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
