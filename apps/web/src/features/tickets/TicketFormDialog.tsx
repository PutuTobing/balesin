import {
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  createTicketRequestSchema,
  updateTicketRequestSchema,
  type Ticket,
  type TicketPriority,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useCan, useSession } from '../auth/session';
import { AttributeFields } from '../contacts/AttributeFields';
import {
  collectAttributes,
  splitAttributes,
  type AttributeValues,
} from '../contacts/attribute-values';
import { agentsQuery } from '../inbox/inbox-queries';
import {
  boardsQuery,
  fromLocalInput,
  storeTicket,
  ticketScope,
  toLocalInput,
} from './ticket-queries';
import styles from './Tickets.module.css';

const k = t.tickets;

export type TicketFormTarget =
  | {
      kind: 'create';
      boardId?: string;
      columnId?: string;
      contactId?: string;
      conversationId?: string;
      /** Keterangan asal (mis. "Dari chat Budi"). */
      origin?: string;
      title?: string;
    }
  | { kind: 'edit'; ticket: Ticket };

/**
 * Buat / ubah tiket. Teknisi (`own`): tidak bisa memilih penanggung jawab (tiket buatannya selalu
 * miliknya) dan tidak mengubah tautan. Atribut board divalidasi `validateAttributeValues` (wajib
 * ditegakkan, sama dengan server). Jawaban `{ ticket: null }` = berhasil tetapi di luar akses.
 */
export function TicketFormDialog({
  target,
  onClose,
  onDone,
}: {
  target: TicketFormTarget;
  onClose: () => void;
  onDone: (ticket: Ticket | null) => void;
}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const own = ticketScope(session) === 'own';
  const canAssign = useCan('inbox.assign') && !own;
  const boards = useQuery(boardsQuery(false));
  const agents = useQuery({ ...agentsQuery, enabled: canAssign });
  const editing = target.kind === 'edit' ? target.ticket : null;

  const [boardId, setBoardId] = useState(
    editing?.boardId ?? (target.kind === 'create' ? target.boardId : undefined) ?? '',
  );
  const [columnId, setColumnId] = useState(target.kind === 'create' ? (target.columnId ?? '') : '');
  const [title, setTitle] = useState(
    editing?.title ?? (target.kind === 'create' ? (target.title ?? '') : ''),
  );
  const [description, setDescription] = useState(editing?.description ?? '');
  const [priority, setPriority] = useState<TicketPriority>(editing?.priority ?? 'normal');
  const [assignee, setAssignee] = useState(editing?.assignee?.id ?? '');
  const [due, setDue] = useState(toLocalInput(editing?.dueAt ?? null));
  const [defined, setDefined] = useState<AttributeValues | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const boardList = boards.data ?? [];
  const effectiveBoardId = boardId || boardList[0]?.id || '';
  const board =
    boardList.find((item) => item.id === effectiveBoardId) ?? (editing ? undefined : boardList[0]);
  const definitions = board?.attributes ?? [];
  const split = splitAttributes(definitions, editing?.attributes ?? []);
  const values = defined ?? split.defined;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing
        ? endpoints.tickets.update(editing.id, body)
        : endpoints.tickets.create(body as Parameters<typeof endpoints.tickets.create>[0]),
    onSuccess: ({ ticket }) => {
      if (ticket) storeTicket(queryClient, ticket.id, ticket);
      else if (editing) storeTicket(queryClient, editing.id, null);
      else void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      onDone(ticket);
    },
    onError: (error) => {
      if (isApiError(error) && error.details.length > 0) setErrors(apiFieldErrors(error.details));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const attributes = collectAttributes(definitions, values, split.free);
    if (!attributes.ok) {
      setErrors(attributes.errors);
      return;
    }
    const common = {
      title,
      description: description.trim() ? description : null,
      priority,
      dueAt: fromLocalInput(due),
      attributes: attributes.values,
      ...(canAssign ? { assigneeUserId: assignee || null } : {}),
    };
    if (editing) {
      const parsed = updateTicketRequestSchema.safeParse(common);
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        return;
      }
      setErrors({});
      save.mutate(parsed.data);
      return;
    }
    const parsed = createTicketRequestSchema.safeParse({
      ...common,
      boardId: effectiveBoardId,
      columnId: columnId || undefined,
      contactId: target.kind === 'create' ? (target.contactId ?? null) : null,
      conversationId: target.kind === 'create' ? (target.conversationId ?? null) : null,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };

  const general =
    save.isError && !(isApiError(save.error) && save.error.details.length > 0) ? save.error : null;
  const noBoard = !editing && boards.isSuccess && boardList.length === 0;

  return (
    <Dialog
      open
      title={editing ? k.editTitle : k.createTitle}
      description={target.kind === 'create' ? target.origin : undefined}
      onRequestClose={onClose}
    >
      {noBoard ? (
        <>
          <Notice tone="info">{k.noBoardToCreate}</Notice>
          <DialogActions>
            <Button onClick={onClose}>{t.common.close}</Button>
          </DialogActions>
        </>
      ) : (
        <form className={styles.form} onSubmit={submit} noValidate>
          {!editing ? (
            <div className={styles.formRow}>
              <SelectField
                label={k.boardPick}
                value={effectiveBoardId}
                onChange={(event) => {
                  setBoardId(event.target.value);
                  setColumnId('');
                  setDefined(null);
                }}
                options={boardList.map((item) => ({ value: item.id, label: item.name }))}
                error={errors.boardId}
                disabled={boards.isPending}
              />
              <SelectField
                label={k.columnPick}
                value={columnId}
                onChange={(event) => setColumnId(event.target.value)}
                options={[
                  { value: '', label: k.columnPickDefault },
                  ...(board?.columns ?? []).map((column) => ({
                    value: column.id,
                    label: column.name,
                  })),
                ]}
                error={errors.columnId}
              />
            </div>
          ) : null}
          <TextField
            label={k.titleLabel}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            error={errors.title}
            maxLength={TICKET_LIMITS.titleMax}
            dir="auto"
            autoComplete="off"
          />
          <TextAreaField
            label={k.descriptionLabel}
            optional
            hint={k.descriptionHint}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            error={errors.description}
            maxLength={TICKET_LIMITS.descriptionMax}
            rows={4}
            dir="auto"
          />
          <div className={styles.formRow}>
            <SelectField
              label={k.priorityLabel}
              value={priority}
              onChange={(event) => setPriority(event.target.value as TicketPriority)}
              options={TICKET_PRIORITIES.map((value) => ({
                value,
                label: TICKET_PRIORITY_LABELS[value],
              }))}
              error={errors.priority}
            />
            <TextField
              label={k.duePick}
              optional
              type="datetime-local"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              error={errors.dueAt}
            />
          </div>
          {canAssign ? (
            <SelectField
              label={k.assigneePick}
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              options={[
                { value: '', label: k.assigneeNobody },
                ...(agents.data?.agents ?? [])
                  .filter((agent) => agent.active || agent.id === assignee)
                  .map((agent) => ({
                    value: agent.id,
                    label: agent.id === session?.user.id ? k.assigneeSelf(agent.name) : agent.name,
                  })),
                // Penanggung jawab yang tidak ada di daftar agen tetap tampil.
                ...(editing?.assignee &&
                !(agents.data?.agents ?? []).some((agent) => agent.id === editing.assignee?.id)
                  ? [{ value: editing.assignee.id, label: editing.assignee.name }]
                  : []),
              ]}
              hint={agents.isError ? k.agentsFailed : undefined}
              error={errors.assigneeUserId}
            />
          ) : null}
          {definitions.length > 0 ? (
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>{k.attributesTitle}</legend>
              <AttributeFields
                definitions={definitions}
                values={values}
                onChange={(key, value) => setDefined({ ...values, [key]: value })}
                errors={errors}
              />
            </fieldset>
          ) : null}
          {general ? (
            <Notice tone="danger" role="alert">
              {isApiError(general) ? general.message : t.api.network}
            </Notice>
          ) : null}
          <DialogActions sticky>
            <Button onClick={onClose}>{k.cancel}</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {save.isPending ? (editing ? k.saving : k.creating) : editing ? k.save : k.create}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
