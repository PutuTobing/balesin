import {
  ATTRIBUTE_DEFINITION_LIMITS,
  TICKET_LIMITS,
  updateTicketBoardRequestSchema,
  type TicketBoard,
  type TicketColumn,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, CheckCircle2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  LoadFailedIllustration,
  TicketsIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
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
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { AttributeManager } from '../contacts/AttributeManager';
import { departmentsQuery } from '../departments/department-queries';
import { ColumnDialog, DeleteColumnDialog } from './ColumnDialogs';
import { boardsQuery, storeBoard, ticketKeys } from './ticket-queries';
import styles from './Tickets.module.css';

const k = t.tickets;
const routeApi = getRouteApi('/_app/tiket/board/$boardId');

/** Atur board (`tickets.configure`): info + departemen + arsip, kolom, isian (atribut) board. */
export function BoardSettingsPage() {
  const { boardId } = routeApi.useParams();
  const active = useQuery(boardsQuery(false));
  const archived = useQuery({ ...boardsQuery(true), enabled: active.isSuccess });
  const board =
    active.data?.find((item) => item.id === boardId) ??
    archived.data?.find((item) => item.id === boardId);
  const pending = active.isPending || (!board && archived.isPending && active.isSuccess);

  return (
    <Page>
      {pending ? (
        <SkeletonRegion className={styles.settings}>
          <div className={styles.card}>
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonMeta} />
          </div>
        </SkeletonRegion>
      ) : active.isError ? (
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={k.loadFailedTitle}
          body={isApiError(active.error) ? active.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void active.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      ) : !board ? (
        <EmptyState
          illustration={<TicketsIllustration />}
          title={k.boardMissingTitle}
          body={k.boardMissingBody}
          actions={
            <Button variant="primary" asChild>
              <Link to="/tiket">{k.backToTickets}</Link>
            </Button>
          }
        />
      ) : (
        <BoardSettings board={board} />
      )}
    </Page>
  );
}

function BoardSettings({ board }: { board: TicketBoard }) {
  const queryClient = useQueryClient();
  return (
    <div className={styles.settings}>
      {board.archivedAt ? <Notice tone="info">{k.archivedNotice}</Notice> : null}
      <BoardInfo board={board} />
      <BoardColumns board={board} />
      <section className={styles.card} aria-labelledby="board-isian">
        <div>
          <h2 id="board-isian" className={styles.sectionTitle}>
            {k.settingsAttributes}
          </h2>
          <p className={styles.hint}>{t.attributes.boardIntro}</p>
        </div>
        <AttributeManager
          scope={{ kind: 'board', boardId: board.id }}
          attributes={[...board.attributes].sort((a, b) => a.position - b.position)}
          max={ATTRIBUTE_DEFINITION_LIMITS.ticketPerBoard}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: ticketKeys.boardLists })}
        />
      </section>
      <Button variant="ghost" asChild className={styles.alignStart}>
        <Link to="/tiket" search={{ board: board.id }}>
          {k.backToBoard}
        </Link>
      </Button>
    </div>
  );
}

function BoardInfo({ board }: { board: TicketBoard }) {
  const queryClient = useQueryClient();
  const departments = useQuery(departmentsQuery);
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description ?? '');
  const [departmentId, setDepartmentId] = useState(board.department?.id ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof endpoints.tickets.updateBoard>[1]) =>
      endpoints.tickets.updateBoard(board.id, body),
    onMutate: () => setDone(null),
    onSuccess: ({ board: updated }, body) => {
      storeBoard(queryClient, updated);
      setDone(body.archived === true ? k.archived : k.boardSaved);
    },
    onError: (error) => {
      if (isApiError(error) && error.details.length > 0) setErrors(apiFieldErrors(error.details));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = updateTicketBoardRequestSchema.safeParse({
      name,
      description: description.trim() ? description : null,
      departmentId: departmentId || null,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };
  const list = departments.data?.departments ?? [];

  return (
    <section className={styles.card} aria-labelledby="board-info">
      <h2 id="board-info" className={styles.sectionTitle}>
        {k.settingsInfo}
      </h2>
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label={k.boardName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
          maxLength={TICKET_LIMITS.boardNameMax}
        />
        <TextAreaField
          label={k.boardDescription}
          optional
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={errors.description}
          maxLength={TICKET_LIMITS.boardDescriptionMax}
          rows={2}
        />
        <SelectField
          label={k.boardDepartment}
          hint={k.boardDepartmentHint}
          value={departmentId}
          onChange={(event) => setDepartmentId(event.target.value)}
          options={[
            { value: '', label: k.boardDepartmentNone },
            ...list.map((item) => ({ value: item.id, label: item.name })),
            ...(board.department && !list.some((item) => item.id === board.department?.id)
              ? [{ value: board.department.id, label: board.department.name }]
              : []),
          ]}
          error={errors.departmentId}
        />
        {save.isError && !(isApiError(save.error) && save.error.details.length > 0) ? (
          <Notice tone="danger" role="alert">
            {isApiError(save.error) ? save.error.message : t.api.network}
          </Notice>
        ) : done ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}
        <div className={styles.formActions}>
          {board.archivedAt ? (
            <Button onClick={() => save.mutate({ archived: false })} disabled={save.isPending}>
              {k.unarchive}
            </Button>
          ) : (
            <Button className={styles.dangerText} onClick={() => setArchiving(true)}>
              {k.archive}
            </Button>
          )}
          <Button type="submit" variant="primary" loading={save.isPending}>
            {save.isPending ? k.saving : k.save}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={archiving}
        title={k.archiveTitle}
        body={k.archiveBody}
        cancelLabel={k.cancel}
        confirmLabel={k.archive}
        confirmVariant="danger"
        onCancel={() => setArchiving(false)}
        onConfirm={() => {
          setArchiving(false);
          save.mutate({ archived: true });
        }}
      />
    </section>
  );
}

function BoardColumns({ board }: { board: TicketBoard }) {
  const queryClient = useQueryClient();
  const columns = [...board.columns].sort((a, b) => a.position - b.position);
  const [dialog, setDialog] = useState<{ column: TicketColumn | null } | null>(null);
  const [deleting, setDeleting] = useState<TicketColumn | null>(null);
  const kanban = useQuery({
    queryKey: ticketKeys.kanban(board.id, {}),
    queryFn: ({ signal }) => endpoints.tickets.kanban(board.id, {}, signal),
    enabled: deleting !== null,
  });
  const update = useMutation({
    mutationFn: ({
      column,
      patch,
    }: {
      column: TicketColumn;
      patch: { isDone?: boolean; position?: number };
    }) => endpoints.tickets.updateColumn(board.id, column.id, patch),
    onSuccess: ({ board: updated }) => storeBoard(queryClient, updated),
  });
  const total = deleting
    ? (kanban.data?.columns.find((entry) => entry.column.id === deleting.id)?.total ?? null)
    : null;

  return (
    <section className={styles.card} aria-labelledby="board-kolom">
      <div>
        <h2 id="board-kolom" className={styles.sectionTitle}>
          {k.settingsColumns}
        </h2>
        <p className={styles.hint}>{k.settingsColumnsHint}</p>
      </div>
      <ol className={styles.columnList}>
        {columns.map((column, index) => (
          <li key={column.id} className={styles.columnRow}>
            <span className={styles.columnRowName}>
              {column.isDone ? (
                <Icon icon={CheckCircle2} size={16} className={styles.doneIcon} />
              ) : null}
              {column.name}
              {column.isDone ? <span className={styles.doneBadge}>{k.columnDoneLabel}</span> : null}
            </span>
            <span className={styles.columnRowActions}>
              <Checkbox
                checked={column.isDone}
                disabled={update.isPending}
                onChange={(event) =>
                  update.mutate({ column, patch: { isDone: event.target.checked } })
                }
              >
                <span aria-hidden="true">{k.doneShort}</span>
                <span className="sr-only">{`${k.columnDoneLabel}: ${column.name}`}</span>
              </Checkbox>
              <IconButton
                label={t.attributes.moveUp(column.name)}
                icon={ArrowUp}
                disabled={index === 0 || update.isPending}
                onClick={() => update.mutate({ column, patch: { position: index - 1 } })}
              />
              <IconButton
                label={t.attributes.moveDown(column.name)}
                icon={ArrowDown}
                disabled={index === columns.length - 1 || update.isPending}
                onClick={() => update.mutate({ column, patch: { position: index + 1 } })}
              />
              <IconButton
                label={`${k.renameColumn}: ${column.name}`}
                icon={Pencil}
                onClick={() => setDialog({ column })}
              />
              <IconButton
                label={`${k.deleteColumn}: ${column.name}`}
                icon={Trash2}
                disabled={columns.length === 1}
                onClick={() => setDeleting(column)}
              />
            </span>
          </li>
        ))}
      </ol>
      <p className={styles.hint}>{k.doneChangeNote}</p>
      {update.isError ? (
        <Notice tone="danger" role="alert">
          {isApiError(update.error) ? update.error.message : t.api.network}
        </Notice>
      ) : null}
      {columns.length < TICKET_LIMITS.columnsPerBoard ? (
        <Button className={styles.alignStart} onClick={() => setDialog({ column: null })}>
          <Icon icon={Plus} size={16} />
          {k.addColumn}
        </Button>
      ) : null}
      {dialog ? (
        <ColumnDialog board={board} column={dialog.column} onClose={() => setDialog(null)} />
      ) : null}
      {deleting && total !== null ? (
        <DeleteColumnDialog
          board={board}
          column={deleting}
          total={total}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}
