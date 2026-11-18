import type { Contact } from '@balesin/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { ChevronRight, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ContactsIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { formatDate } from '../../lib/format';
import { useCan } from '../auth/session';
import { summaryIdentity } from '../inbox/contact-identity';
import { tagsQuery } from '../inbox/inbox-queries';
import { ContactAvatar } from '../inbox/InboxBits';
import { TagChip } from '../inbox/TagPicker';
import { contactAttributesQuery, contactListQuery, takeContactFlash } from './contact-queries';
import { contactFilterFrom, hasContactFilter, type ContactSearch } from './contact-search';
import { ExportContactsButton, type ExportResult } from './ExportContactsButton';
import styles from './Contacts.module.css';

const c = t.contacts;
const routeApi = getRouteApi('/_app/kontak');

/**
 * Kontak (`contacts.view`, bercakupan): daftar terbaru dulu + cari, saringan tag/atribut/"mungkin
 * duplikat", paginasi kursor. Impor & ekspor massal = `contacts.export`. Saringan disimpan di URL.
 */
export function ContactsPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const canBulk = useCan('contacts.export');
  const filter = contactFilterFrom(search);
  const filtered = hasContactFilter(filter);
  const list = useInfiniteQuery(contactListQuery(filter));
  const items = list.data?.pages.flatMap((page) => page.contacts) ?? [];
  const [flash] = useState(() => takeContactFlash());
  const [exported, setExported] = useState<ExportResult | null>(null);

  const update = (patch: Partial<ContactSearch>) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });

  const actions = canBulk ? (
    <div className={styles.pageActions}>
      <Button asChild>
        <Link to="/kontak/impor">
          <Icon icon={Upload} size={16} />
          {c.importAction}
        </Link>
      </Button>
      <ExportContactsButton filter={filter} disabled={items.length === 0} onResult={setExported} />
    </div>
  ) : undefined;

  const firstEmpty = !list.isPending && !list.isError && items.length === 0 && !filtered;

  return (
    <Page actions={firstEmpty ? undefined : actions}>
      <div className={styles.content}>
        {flash ? (
          <Notice tone="success" role="status">
            {flash}
          </Notice>
        ) : null}
        {exported ? (
          'rows' in exported ? (
            <Notice tone="success" role="status">
              {c.exportDone(exported.rows)}
            </Notice>
          ) : (
            <Notice tone="danger" role="alert">
              {isApiError(exported.error) ? exported.error.message : t.api.network}
            </Notice>
          )
        ) : null}
        {firstEmpty ? (
          <EmptyState
            illustration={<ContactsIllustration />}
            title={c.emptyTitle}
            body={canBulk ? c.emptyBody : c.emptyBodyNoImport}
            actions={
              <>
                {canBulk ? (
                  <Button variant="primary" asChild>
                    <Link to="/kontak/impor">
                      <Icon icon={Upload} size={16} />
                      {c.importAction}
                    </Link>
                  </Button>
                ) : null}
                <Button asChild>
                  <Link to="/inbox">{c.openInbox}</Link>
                </Button>
              </>
            }
          />
        ) : (
          <>
            <p className={styles.intro}>{c.intro}</p>
            <ContactFilters search={search} onChange={update} />
            {list.isPending ? (
              <ListSkeleton />
            ) : list.isError ? (
              <EmptyState
                illustration={<LoadFailedIllustration />}
                title={c.loadFailedTitle}
                body={isApiError(list.error) ? list.error.message : t.api.network}
                actions={
                  <Button variant="primary" onClick={() => void list.refetch()}>
                    {t.common.retry}
                  </Button>
                }
              />
            ) : items.length === 0 ? (
              <EmptyState
                align="top"
                compact
                title={c.noMatchTitle}
                body={c.noMatchBody}
                actions={
                  <Button onClick={() => void navigate({ search: {}, replace: true })}>
                    {c.resetFilters}
                  </Button>
                }
              />
            ) : (
              <>
                <ul className={styles.list} aria-label={c.listLabel}>
                  {items.map((contact) => (
                    <ContactRow key={contact.id} contact={contact} />
                  ))}
                </ul>
                <div className={styles.listFoot}>
                  <p className={styles.count} role="status">
                    {c.shownCount(items.length)}
                  </p>
                  {list.hasNextPage ? (
                    <Button
                      loading={list.isFetchingNextPage}
                      onClick={() => void list.fetchNextPage()}
                    >
                      {list.isFetchingNextPage ? c.loadingMore : c.loadMore}
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

/** Cari (ditunda 300 ms), tag, atribut (kunci + nilai persis), dan "mungkin duplikat". */
function ContactFilters({
  search,
  onChange,
}: {
  search: ContactSearch;
  onChange: (patch: Partial<ContactSearch>) => void;
}) {
  const tags = useQuery(tagsQuery);
  const attributes = useQuery(contactAttributesQuery);
  const [text, setText] = useState(search.cari ?? '');
  const [attributeKey, setAttributeKey] = useState(search.atribut ?? '');
  const [attributeValue, setAttributeValue] = useState(search.nilai ?? '');
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });

  useEffect(() => {
    const value = text.trim();
    if (value === (search.cari ?? '')) return;
    const timer = window.setTimeout(
      () => latest.current({ cari: value === '' ? undefined : value }),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [text, search.cari]);

  const tooShort = text.trim().length > 0 && Array.from(text.trim()).length < 2;
  const definitions = attributes.data ?? [];
  const keyOptions = [
    { value: '', label: c.anyAttribute },
    ...definitions.map((item) => ({ value: item.key, label: item.label })),
    // Kunci dari URL yang tidak berdefinisi tetap bisa dipilih (atribut bebas).
    ...(search.atribut && !definitions.some((item) => item.key === search.atribut)
      ? [{ value: search.atribut, label: search.atribut }]
      : []),
  ];
  const selected = definitions.find((item) => item.key === attributeKey);

  const applyAttribute = (event: FormEvent) => {
    event.preventDefault();
    const value = attributeValue.trim();
    onChange(
      attributeKey && value
        ? { atribut: attributeKey, nilai: value }
        : { atribut: undefined, nilai: undefined },
    );
  };

  return (
    <div className={styles.filters} role="group" aria-label={c.filtersLabel}>
      <div className={styles.searchRow}>
        <SearchField
          value={text}
          onChange={setText}
          label={c.searchLabel}
          placeholder={c.searchPlaceholder}
          clearLabel={c.clearSearch}
          maxLength={100}
        />
        {tooShort ? <p className={styles.hint}>{c.searchTooShort}</p> : null}
      </div>
      <div className={styles.filterRow}>
        <SelectField
          label={c.tagLabel}
          value={search.tag ?? ''}
          onChange={(event) => onChange({ tag: event.target.value || undefined })}
          options={[
            { value: '', label: c.allTags },
            ...(tags.data?.tags ?? []).map((tag) => ({ value: tag.id, label: tag.name })),
          ]}
          className={styles.filterField}
        />
        <form className={styles.attributeFilter} onSubmit={applyAttribute}>
          <SelectField
            label={c.attributeLabel}
            value={attributeKey}
            onChange={(event) => {
              setAttributeKey(event.target.value);
              setAttributeValue('');
              if (!event.target.value) onChange({ atribut: undefined, nilai: undefined });
            }}
            options={keyOptions}
            className={styles.filterField}
          />
          {attributeKey ? (
            <>
              {selected?.type === 'select' ? (
                <SelectField
                  label={c.attributeValueLabel}
                  value={attributeValue}
                  onChange={(event) => setAttributeValue(event.target.value)}
                  options={[
                    { value: '', label: t.attributes.selectPlaceholder },
                    ...selected.options.map((option) => ({ value: option, label: option })),
                  ]}
                  className={styles.filterField}
                />
              ) : (
                <TextField
                  label={c.attributeValueLabel}
                  placeholder={c.attributeValuePlaceholder}
                  value={attributeValue}
                  onChange={(event) => setAttributeValue(event.target.value)}
                  type={selected?.type === 'date' ? 'date' : 'text'}
                  maxLength={500}
                  className={styles.filterField}
                />
              )}
              <Button type="submit" className={styles.applyButton}>
                {c.applyAttribute}
              </Button>
            </>
          ) : null}
        </form>
        <Checkbox
          checked={search.duplikat === 1}
          onChange={(event) => onChange({ duplikat: event.target.checked ? 1 : undefined })}
          className={styles.duplicateToggle}
        >
          {c.duplicatesOnly}
        </Checkbox>
      </div>
    </div>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const identity = summaryIdentity(contact);
  const tags = contact.tags ?? [];
  const channel = c.channelLabels[contact.channelType] ?? contact.channelType;
  return (
    <li className={styles.row}>
      <Link
        to="/kontak/$contactId"
        params={{ contactId: contact.id }}
        className={styles.rowLink}
        aria-label={c.open(identity.name)}
      >
        <ContactAvatar name={identity.name} />
        <span className={styles.rowMain}>
          <span className={styles.rowName} dir="auto">
            {identity.name}
          </span>
          <span className={styles.rowHandle}>
            {[identity.handle ?? contact.channelHandle, channel].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className={styles.rowTags}>
          {contact.possibleDuplicateOfContactId ? (
            <span className={styles.duplicateBadge}>{c.duplicateBadge}</span>
          ) : null}
          {tags.slice(0, 3).map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
          {tags.length > 3 ? <span className={styles.more}>+{tags.length - 3}</span> : null}
        </span>
        <span className={styles.rowDate}>{c.addedAt(formatDate(contact.createdAt))}</span>
        <Icon icon={ChevronRight} size={16} className={styles.chevron} />
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <SkeletonRegion className={styles.list}>
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className={styles.skeletonRow}>
          <Skeleton className={styles.skeletonAvatar} />
          <span className={styles.skeletonText}>
            <Skeleton className={styles.skeletonName} />
            <Skeleton className={styles.skeletonHandle} />
          </span>
        </div>
      ))}
    </SkeletonRegion>
  );
}
