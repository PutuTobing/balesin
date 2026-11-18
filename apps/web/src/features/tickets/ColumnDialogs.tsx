import {
  TICKET_LIMITS,
  createTicketBoardRequestSchema,
  type TicketBoard,
  type TicketColumn,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { departmentsQuery } from '../departments/department-queries';
import { storeBoard, ticketKeys } from './ticket-queries';
import styles from './Tickets.module.css';

const k = t.tickets;

function errorText(error: unknown): string {
  return isApiError(error) ? error.message : t.api.network;
}

/** Tambah kolom (di ujung kanan) atau ganti nama kolom. */
export function ColumnDialog({
  board,
  column,
  onClose,
}: {
  board: TicketBoard;
  column: TicketColumn | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(column?.name ?? '');
  const [isDone, setIsDone] = useState(column?.isDone ?? false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      column
        ? endpoints.tickets.updateColumn(board.id, column.id, { name })
        : endpoints.tickets.addColumn(board.id, { name, isDone }),
    onSuccess: ({ board: updated }) => {
      storeBoard(queryClient, updated);
      onClose();
    },
    onError: (error) => {
      const detail = isApiError(error) ? error.details.find((item) => item.field === 'name') : null;
      if (detail) setFieldError(detail.message);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFieldError(`${k.columnNameLabel} wajib diisi.`);
      return;
    }
    setFieldError(null);
    save.mutate();
  };
  return (
    <Dialog open title={column ? k.renameColumnTitle : k.addColumnTitle} onRequestClose={onClose}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label={k.columnNameLabel}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError}
          maxLength={TICKET_LIMITS.columnNameMax}
          autoComplete="off"
        />
        {column ? null : (
          <div>
            <Checkbox checked={isDone} onChange={(event) => setIsDone(event.target.checked)}>
              {k.columnDoneLabel}
            </Checkbox>
            <p className={styles.hint}>{k.columnDoneHint}</p>
          </div>
        )}
        {save.isError && !fieldError ? (
          <Notice tone="danger" role="alert">
            {errorText(save.error)}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{k.cancel}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {save.isPending ? k.saving : k.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * Hapus kolom. Kolom berisi → pilih kolom tujuan (`{ moveToColumnId }`); kosong → body `{}`.
 * Kolom terakhir tidak bisa dihapus.
 */
export function DeleteColumnDialog({
  board,
  column,
  total,
  onClose,
}: {
  board: TicketBoard;
  column: TicketColumn;
  total: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const others = board.columns
    .filter((item) => item.id !== column.id)
    .sort((a, b) => a.position - b.position);
  const [target, setTarget] = useState(others[0]?.id ?? '');
  const remove = useMutation({
    mutationFn: () =>
      endpoints.tickets.removeColumn(board.id, column.id, total > 0 ? target || null : null),
    onSuccess: ({ board: updated }) => {
      storeBoard(queryClient, updated);
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={k.deleteColumnTitle(column.name)}
      description={
        others.length === 0
          ? k.lastColumn
          : total > 0
            ? k.deleteColumnBody(total)
            : k.deleteColumnEmpty
      }
      onRequestClose={onClose}
    >
      {total > 0 && others.length > 0 ? (
        <div className={styles.form}>
          <SelectField
            label={k.deleteColumnTarget}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            options={others.map((item) => ({ value: item.id, label: item.name }))}
          />
        </div>
      ) : null}
      {remove.isError ? (
        <Notice tone="danger" role="alert">
          {errorText(remove.error)}
        </Notice>
      ) : null}
      <DialogActions>
        <Button onClick={onClose}>{k.cancel}</Button>
        {others.length > 0 ? (
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            {k.deleteColumnConfirm}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

/** Board baru (`tickets.configure`): nama, deskripsi, departemen; kolom bawaan. */
export function BoardCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (board: TicketBoard) => void;
}) {
  const queryClient = useQueryClient();
  const departments = useQuery(departmentsQuery);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const create = useMutation({
    mutationFn: (body: Parameters<typeof endpoints.tickets.createBoard>[0]) =>
      endpoints.tickets.createBoard(body),
    onSuccess: ({ board }) => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.boardLists });
      onCreated(board);
    },
    onError: (error) => {
      if (isApiError(error) && error.details.length > 0) setErrors(apiFieldErrors(error.details));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = createTicketBoardRequestSchema.safeParse({
      name,
      description: description.trim() ? description : null,
      departmentId: departmentId || null,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    create.mutate(parsed.data);
  };
  const list = departments.data?.departments ?? [];
  return (
    <Dialog
      open
      title={k.boardCreateTitle}
      description={k.boardColumnsHint}
      onRequestClose={onClose}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label={k.boardName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
          maxLength={TICKET_LIMITS.boardNameMax}
          autoComplete="off"
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
        {list.length > 0 ? (
          <SelectField
            label={k.boardDepartment}
            hint={k.boardDepartmentHint}
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
            options={[
              { value: '', label: k.boardDepartmentNone },
              ...list.map((item) => ({ value: item.id, label: item.name })),
            ]}
            error={errors.departmentId}
          />
        ) : null}
        {create.isError && !(isApiError(create.error) && create.error.details.length > 0) ? (
          <Notice tone="danger" role="alert">
            {errorText(create.error)}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{k.cancel}</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            {create.isPending ? k.creatingBoard : k.createBoard}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
