import {
  CONTACT_FIELD_LABELS,
  CONVERSATION_EVENT_LABELS,
  conversationNoteBodySchema,
  type ConversationEvent,
  type ConversationNote,
  type Message,
  type MessageListFilter,
} from '@balesin/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Star, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { IconButton } from '../../components/ui/IconButton';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTime } from '../../lib/format';
import { useCan } from '../auth/session';
import styles from './ContactPanel.module.css';
import {
  eventsQuery,
  flattenMessages,
  inboxKeys,
  messagesOnlyQuery,
  notesQuery,
} from './inbox-queries';
import { messageBody } from './message-content';
import { MessageMedia } from './MessageMedia';
import { TagChip } from './TagPicker';

const p = t.inbox.panel;

// ── Catatan sesi ────────────────────────────────────────────────────────────

/** Catatan internal per percakapan (tidak pernah terkirim). Ubah/hapus sesuai `canEdit`/`canDelete`. */
export function NotesTab({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const canReply = useCan('inbox.reply');
  const notes = useQuery(notesQuery(conversationId));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: inboxKeys.notes(conversationId) });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.events(conversationId) });
  };
  const add = useMutation({
    mutationFn: (body: string) => endpoints.inbox.addNote(conversationId, body),
    onSuccess: () => {
      setDraft('');
      refresh();
    },
    onError: (reason) => setError(isApiError(reason) ? reason.message : t.api.network),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = conversationNoteBodySchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? null);
      return;
    }
    setError(null);
    add.mutate(parsed.data);
  };

  return (
    <div className={styles.tabBody}>
      <p className={styles.hint}>{p.sessionNotesHint}</p>
      {notes.isPending ? (
        <ListSkeleton />
      ) : notes.isError ? (
        <p className={styles.note}>{p.notesFailed}</p>
      ) : notes.data.notes.length === 0 ? (
        <p className={styles.note}>{p.noNotes}</p>
      ) : (
        <ol className={styles.notes}>
          {notes.data.notes.map((note) => (
            <NoteItem
              key={note.id}
              conversationId={conversationId}
              note={note}
              onChanged={refresh}
            />
          ))}
        </ol>
      )}
      {canReply ? (
        <form className={styles.noteForm} onSubmit={submit} noValidate>
          <textarea
            className={styles.noteInput}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={p.notePlaceholder}
            aria-label={p.sessionNotes}
            rows={3}
            maxLength={2000}
            dir="auto"
          />
          {error ? (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" loading={add.isPending} disabled={!draft.trim()}>
            {add.isPending ? p.saving : p.addNote}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function NoteItem({
  conversationId,
  note,
  onChanged,
}: {
  conversationId: string;
  note: ConversationNote;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: string) => endpoints.inbox.updateNote(conversationId, note.id, body),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError: (reason) => setError(isApiError(reason) ? reason.message : t.api.network),
  });
  const remove = useMutation({
    mutationFn: () => endpoints.inbox.deleteNote(conversationId, note.id),
    onSuccess: () => {
      setConfirming(false);
      onChanged();
    },
    onError: (reason) => {
      setConfirming(false);
      setError(isApiError(reason) ? reason.message : t.api.network);
    },
  });

  return (
    <li className={styles.noteItem}>
      <div className={styles.noteHead}>
        <span className={styles.noteAuthor}>{note.author.name}</span>
        <time className={styles.noteTime} dateTime={note.createdAt}>
          {formatDateTime(note.createdAt)}
          {note.edited ? ` · ${p.edited}` : ''}
        </time>
        <span className={styles.noteActions}>
          {note.canEdit && !editing ? (
            <IconButton label={p.editNote} icon={Pencil} onClick={() => setEditing(true)} />
          ) : null}
          {note.canDelete ? (
            <IconButton label={p.deleteNote} icon={Trash2} onClick={() => setConfirming(true)} />
          ) : null}
        </span>
      </div>
      {editing ? (
        <form
          className={styles.noteForm}
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = conversationNoteBodySchema.safeParse(text);
            if (!parsed.success) {
              setError(parsed.error.issues[0]?.message ?? null);
              return;
            }
            update.mutate(parsed.data);
          }}
        >
          <textarea
            className={styles.noteInput}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label={p.editNote}
            rows={3}
            maxLength={2000}
            dir="auto"
          />
          <div className={styles.noteEditActions}>
            <Button
              onClick={() => {
                setEditing(false);
                setText(note.body);
              }}
            >
              {p.cancel}
            </Button>
            <Button type="submit" variant="primary" loading={update.isPending}>
              {update.isPending ? p.saving : p.save}
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.noteBody} dir="auto">
          {note.body}
        </p>
      )}
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={p.deleteNoteTitle}
        body={p.deleteNoteBody}
        cancelLabel={p.cancel}
        confirmLabel={p.deleteNoteConfirm}
        confirmVariant="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          if (!remove.isPending) remove.mutate();
        }}
      />
    </li>
  );
}

// ── Berkas: media, file, pesan ditandai ─────────────────────────────────────

const FILE_TABS: { id: MessageListFilter; label: string; empty: string }[] = [
  { id: 'media', label: p.media, empty: p.noMedia },
  { id: 'files', label: p.files, empty: p.noFiles },
  { id: 'starred', label: p.starred, empty: p.noStarred },
];

export function FilesTab({ conversationId }: { conversationId: string }) {
  const [only, setOnly] = useState<MessageListFilter>('media');
  const query = useInfiniteQuery(messagesOnlyQuery(conversationId, only));
  const items = useMemo(() => flattenMessages(query.data).reverse(), [query.data]);
  const tab = FILE_TABS.find((item) => item.id === only) ?? FILE_TABS[0]!;

  return (
    <div className={styles.tabBody}>
      <div className={styles.segments} role="radiogroup" aria-label={p.filesLabel}>
        {FILE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={item.id === only}
            className={styles.segment}
            onClick={() => setOnly(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError ? (
        <p className={styles.note}>{p.filesFailed}</p>
      ) : items.length === 0 ? (
        <p className={styles.note}>{tab.empty}</p>
      ) : only === 'media' ? (
        <ul className={styles.mediaGrid}>
          {items.map((message) => (
            <li key={message.id} className={styles.mediaCell}>
              <MessageMedia message={message} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className={styles.fileList}>
          {items.map((message) => (
            <FileRow key={message.id} message={message} starred={only === 'starred'} />
          ))}
        </ul>
      )}
      {query.hasNextPage ? (
        <Button
          variant="ghost"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {p.loadMore}
        </Button>
      ) : null}
    </div>
  );
}

/** Isi ringkas pesan ditandai: teks, atau nama/alamat lokasi, atau label jenisnya. */
function starredText(message: Message): string {
  const body = messageBody(message);
  if (body.text) return body.text;
  return [body.label, body.detail].filter(Boolean).join(': ');
}

function FileRow({ message, starred }: { message: Message; starred: boolean }) {
  return (
    <li className={styles.fileRow}>
      {starred ? (
        <>
          <p className={styles.fileMeta}>
            <Icon icon={Star} size={16} className={styles.starIcon} />
            {message.senderName ?? t.inbox.chat.senders[message.senderKind]} ·{' '}
            {formatDateTime(message.createdAt)}
          </p>
          <p className={styles.fileText} dir="auto">
            {starredText(message)}
          </p>
        </>
      ) : (
        <>
          <MessageMedia message={message} />
          <p className={styles.fileMeta}>{formatDateTime(message.createdAt)}</p>
        </>
      )}
    </li>
  );
}

// ── Log ─────────────────────────────────────────────────────────────────────

/** Riwayat penanganan + kejadian kontak (tag, isian yang diubah) — tanpa isi data pelanggan. */
export function LogTab({ conversationId }: { conversationId: string }) {
  const events = useQuery(eventsQuery(conversationId));
  return (
    <div className={styles.tabBody}>
      {events.isPending ? (
        <ListSkeleton />
      ) : events.isError ? (
        <Notice tone="danger">{p.logFailed}</Notice>
      ) : events.data.events.length === 0 ? (
        <p className={styles.note}>{p.noLog}</p>
      ) : (
        <ol className={styles.log}>
          {[...events.data.events].reverse().map((event) => (
            <LogItem key={event.id} event={event} />
          ))}
        </ol>
      )}
    </div>
  );
}

function LogItem({ event }: { event: ConversationEvent }) {
  const details: string[] = [];
  if (event.kind === 'assigned' && event.assignee) details.push(p.logAssignee(event.assignee.name));
  if (event.previousAssignee && event.kind !== 'claimed') {
    details.push(p.logFrom(event.previousAssignee.name));
  }
  if (event.fields && event.fields.length > 0) {
    details.push(p.logFields(event.fields.map((field) => CONTACT_FIELD_LABELS[field]).join(', ')));
  }
  return (
    <li className={styles.logItem}>
      <span className={styles.logDot} aria-hidden="true" />
      <div className={styles.logText}>
        <p>
          <strong>{event.actor?.name ?? p.system}</strong> ·{' '}
          {CONVERSATION_EVENT_LABELS[event.kind].toLocaleLowerCase('id-ID')}
          {details.length > 0 ? ` ${details.join(' ')}` : ''}
        </p>
        {event.tag ? (
          <TagChip tag={{ id: event.id, name: event.tag.name, color: event.tag.color }} />
        ) : null}
        <time className={styles.noteTime} dateTime={event.createdAt}>
          {formatDateTime(event.createdAt)}
        </time>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <SkeletonRegion className={styles.skeleton}>
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.skeletonRow}>
          <Skeleton className={styles.skeletonTerm} />
          <Skeleton className={styles.skeletonValue} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
