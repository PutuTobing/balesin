import type { Contact, TagRef } from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { inboxKeys, storeContact, tagsQuery } from './inbox-queries';
import styles from './TagPicker.module.css';

const p = t.inbox.panel;

/** Satu tag: titik berwarna (kunci palet → token) + nama sebagai teks. */
export function TagChip({ tag, onRemove }: { tag: TagRef; onRemove?: () => void }) {
  return (
    <span className={styles.chip} data-color={tag.color}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.chipName} dir="auto">
        {tag.name}
      </span>
      {onRemove ? (
        <button
          type="button"
          className={styles.chipRemove}
          aria-label={p.removeTag(tag.name)}
          onClick={onRemove}
        >
          <Icon icon={X} size={16} />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Tag kontak di panel detail: daftar tag + "Tambah tag" (cari, pilih, atau buat baru). Tag
 * menempel ke KONTAK (semua chat-nya). Ubah = `contacts.manage`.
 */
export function ContactTags({ contact, canManage }: { contact: Contact; canManage: boolean }) {
  const queryClient = useQueryClient();
  const tags = contact.tags ?? [];
  const [error, setError] = useState<unknown>(null);
  const change = useMutation({
    mutationFn: ({ tagId, add }: { tagId: string; add: boolean }) =>
      add
        ? endpoints.inbox.addTag(contact.id, tagId)
        : endpoints.inbox.removeTag(contact.id, tagId),
    onMutate: () => setError(null),
    onSuccess: ({ contact: updated }) => storeContact(queryClient, updated),
    onError: setError,
  });

  return (
    <div className={styles.tags}>
      {tags.length === 0 && !canManage ? <p className={styles.empty}>{p.noTags}</p> : null}
      <ul className={styles.list} aria-label={p.tags}>
        {tags.map((tag) => (
          <li key={tag.id}>
            <TagChip
              tag={tag}
              onRemove={canManage ? () => change.mutate({ tagId: tag.id, add: false }) : undefined}
            />
          </li>
        ))}
        {canManage ? (
          <li>
            <AddTag
              selected={tags}
              onToggle={(tagId, add) => change.mutate({ tagId, add })}
              onError={setError}
            />
          </li>
        ) : null}
      </ul>
      {error ? (
        <p className={styles.error} role="alert">
          {isApiError(error) ? error.message : p.tagFailed}
        </p>
      ) : null}
    </div>
  );
}

function AddTag({
  selected,
  onToggle,
  onError,
}: {
  selected: TagRef[];
  onToggle: (tagId: string, add: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const all = useQuery({ ...tagsQuery, enabled: open }).data?.tags ?? [];
  const needle = search.trim().toLowerCase();
  const shown = needle ? all.filter((tag) => tag.name.toLowerCase().includes(needle)) : all;
  const exact = all.some((tag) => tag.name.toLowerCase() === needle);
  const create = useMutation({
    mutationFn: (name: string) => endpoints.tags.create({ name }),
    onSuccess: ({ tag }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags });
      onToggle(tag.id, true);
      setSearch('');
    },
    onError,
  });
  const isSelected = (id: string) => selected.some((tag) => tag.id === id);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={styles.add}>
          <Icon icon={Plus} size={16} />
          {p.addTag}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <input
            className={styles.search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={p.tagSearch}
            aria-label={p.tagSearch}
            maxLength={40}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && needle && !exact && !create.isPending) {
                event.preventDefault();
                create.mutate(search.trim());
              }
            }}
          />
          <ul className={styles.options} aria-label={p.tags}>
            {shown.map((tag) => (
              <li key={tag.id}>
                <button
                  type="button"
                  className={styles.option}
                  aria-pressed={isSelected(tag.id)}
                  onClick={() => onToggle(tag.id, !isSelected(tag.id))}
                >
                  <TagChip tag={tag} />
                  {isSelected(tag.id) ? (
                    <Icon icon={Check} size={16} className={styles.check} />
                  ) : null}
                </button>
              </li>
            ))}
            {needle && !exact ? (
              <li>
                <button
                  type="button"
                  className={styles.option}
                  disabled={create.isPending}
                  onClick={() => create.mutate(search.trim())}
                >
                  <Icon icon={Plus} size={16} />
                  <span className={styles.createText}>{p.tagCreate(search.trim())}</span>
                </button>
              </li>
            ) : null}
            {all.length === 0 && !needle ? <li className={styles.empty}>{p.tagNone}</li> : null}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
