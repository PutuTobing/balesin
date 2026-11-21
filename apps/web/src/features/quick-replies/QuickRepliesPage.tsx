import {
  QUICK_REPLY_BODY_MAX,
  QUICK_REPLY_TITLE_MAX,
  QUICK_REPLY_VARIABLES,
  QUICK_REPLY_VARIABLE_LABELS,
  createQuickReplyRequestSchema,
  type QuickReply,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ChatIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CreateButton } from '../../components/ui/CreateButton';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import styles from './QuickReplies.module.css';
import { quickRepliesKey } from './quick-replies-key';

const q = t.quickReplies;

/**
 * Pengaturan → Balasan cepat (izin `quick_replies.manage`): daftar template `/` yang dipakai
 * tim di composer, dengan cari, buat, ubah, dan hapus. Variabel hanya `{nama}` dan `{agen}`.
 */
export function QuickRepliesPage() {
  const list = useQuery({
    queryKey: [...quickRepliesKey, ''],
    queryFn: ({ signal }) => endpoints.quickReplies.list(null, signal),
  });
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<QuickReply | 'new' | null>(null);
  const [removing, setRemoving] = useState<QuickReply | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (item: QuickReply) => endpoints.quickReplies.remove(item.id),
    onSuccess: (_, item) => {
      setRemoving(null);
      setDone(q.deleted(item.shortcut));
      void queryClient.invalidateQueries({ queryKey: quickRepliesKey });
    },
  });

  const items = useMemo(() => {
    const all = list.data?.quickReplies ?? [];
    const needle = search.trim().toLowerCase().replace(/^\//, '');
    if (!needle) return all;
    return all.filter((item) =>
      [item.shortcut, item.title, item.body].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [list.data, search]);

  const hasItems = list.isSuccess && list.data.quickReplies.length > 0;

  return (
    <Page
      actions={
        hasItems ? <CreateButton label={q.add} onClick={() => setEditing('new')} /> : undefined
      }
    >
      <div className={styles.content}>
        <p className={styles.intro}>{q.intro}</p>
        {done ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}
        {remove.isError ? (
          <Notice tone="danger" role="alert">
            {isApiError(remove.error) ? remove.error.message : t.api.network}
          </Notice>
        ) : null}

        {list.isPending ? (
          <ListSkeleton />
        ) : list.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={q.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : list.data.quickReplies.length === 0 ? (
          <EmptyState
            illustration={<ChatIllustration />}
            title={q.emptyTitle}
            body={q.emptyBody}
            actions={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Icon icon={Plus} size={16} />
                {q.addFirst}
              </Button>
            }
          />
        ) : (
          <>
            <SearchField
              value={search}
              onChange={setSearch}
              label={q.searchLabel}
              placeholder={q.searchPlaceholder}
              clearLabel={q.clearSearch}
            />
            {items.length === 0 ? (
              <p className={styles.note}>{q.notFound(search.trim())}</p>
            ) : (
              <ul className={styles.list} aria-label={q.listLabel}>
                {items.map((item) => (
                  <li key={item.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={styles.shortcut}>/{item.shortcut}</span>
                      <span className={styles.itemTitle}>{item.title}</span>
                      <span className={styles.itemActions}>
                        <IconButton
                          label={q.edit(item.shortcut)}
                          icon={Pencil}
                          onClick={() => {
                            setDone(null);
                            setEditing(item);
                          }}
                        />
                        <IconButton
                          label={q.remove(item.shortcut)}
                          icon={Trash2}
                          onClick={() => {
                            setDone(null);
                            remove.reset();
                            setRemoving(item);
                          }}
                        />
                      </span>
                    </div>
                    <p className={styles.itemBody} dir="auto">
                      {item.body}
                    </p>
                    <p className={styles.itemMeta}>
                      {[
                        q.used(item.usageCount),
                        item.updatedBy
                          ? q.updatedBy(item.updatedBy.name, formatDateTimeInline(item.updatedAt))
                          : q.updatedAt(formatDateTimeInline(item.updatedAt)),
                      ].join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <QuickReplyDialog
        key={editing === null ? 'tutup' : editing === 'new' ? 'baru' : editing.id}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={(item, created) => {
          setEditing(null);
          setDone(created ? q.created(item.shortcut) : q.updated(item.shortcut));
          void queryClient.invalidateQueries({ queryKey: quickRepliesKey });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={q.removeTitle(removing?.shortcut ?? '')}
        body={q.removeBody}
        cancelLabel={q.cancel}
        confirmLabel={remove.isPending ? q.removing : q.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing && !remove.isPending) remove.mutate(removing);
        }}
      />
    </Page>
  );
}

function ListSkeleton() {
  return (
    <SkeletonRegion className={styles.list}>
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.item}>
          <Skeleton className={styles.skeletonHead} />
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonShort} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Form buat/ubah template di dialog. */
function QuickReplyDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: QuickReply | 'new' | null;
  onClose: () => void;
  onSaved: (item: QuickReply, created: boolean) => void;
}) {
  const existing = editing !== 'new' ? editing : null;
  const [shortcut, setShortcut] = useState(existing?.shortcut ?? '');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: (input: { shortcut: string; title: string; body: string }) =>
      existing
        ? endpoints.quickReplies.update(existing.id, input)
        : endpoints.quickReplies.create(input),
    onSuccess: ({ quickReply }) => onSaved(quickReply, existing === null),
    onError: (error) => {
      if (isApiError(error) && error.details.length > 0) setErrors(apiFieldErrors(error.details));
      else if (isApiError(error) && error.status === 409) setErrors({ shortcut: error.message });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = createQuickReplyRequestSchema.safeParse({ shortcut, title, body });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };

  /** Sisipkan variabel di posisi kursor isi. */
  const insert = (variable: string) => {
    const element = bodyRef.current;
    const token = `{${variable}}`;
    const start = element?.selectionStart ?? body.length;
    const end = element?.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const generalError =
    save.isError &&
    !(isApiError(save.error) && (save.error.details.length > 0 || save.error.status === 409))
      ? save.error
      : null;

  return (
    <Dialog
      open={editing !== null}
      title={existing ? q.editTitle : q.addTitle}
      onRequestClose={onClose}
      initialFocusRef={firstRef}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          ref={firstRef}
          label={q.shortcutLabel}
          hint={q.shortcutHint}
          leading="/"
          value={shortcut}
          onChange={(event) => setShortcut(event.target.value)}
          error={errors.shortcut}
          inputClassName={styles.mono}
          autoComplete="off"
          spellCheck={false}
          maxLength={33}
        />
        <TextField
          label={q.titleLabel}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={errors.title}
          maxLength={QUICK_REPLY_TITLE_MAX}
        />
        <div className={styles.bodyField}>
          <TextAreaField
            ref={bodyRef}
            label={q.bodyLabel}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            error={errors.body}
            rows={6}
            maxLength={QUICK_REPLY_BODY_MAX}
          />
          {/* Tepat di bawah kotak isi: kiri sisipkan variabel, kanan penghitung. */}
          <div className={styles.bodyFooter}>
            <div className={styles.variables} role="group" aria-label={q.variablesLabel}>
              <span className={styles.insertLabel} aria-hidden="true">
                {q.insertLabel}
              </span>
              {QUICK_REPLY_VARIABLES.map((variable) => (
                <button
                  key={variable}
                  type="button"
                  className={styles.variable}
                  title={QUICK_REPLY_VARIABLE_LABELS[variable]}
                  aria-label={q.insertVariable(
                    `{${variable}}`,
                    QUICK_REPLY_VARIABLE_LABELS[variable],
                  )}
                  onClick={() => insert(variable)}
                >
                  {`{${variable}}`}
                </button>
              ))}
            </div>
            <span className={styles.count}>
              {body.length.toLocaleString('id-ID')} / {QUICK_REPLY_BODY_MAX.toLocaleString('id-ID')}
            </span>
          </div>
        </div>
        {generalError ? (
          <Notice tone="danger" role="alert">
            {isApiError(generalError) ? generalError.message : t.api.network}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{q.cancel}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {save.isPending ? q.saving : q.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
