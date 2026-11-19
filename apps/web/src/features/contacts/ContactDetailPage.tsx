import type { AttributeDefinition, Contact } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { GitMerge, Pencil } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import {
  ContactsIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { formatDateTime } from '../../lib/format';
import { useCan } from '../auth/session';
import {
  contactIdentity,
  formatPhone,
  formatUsername,
  untrustedNameLabel,
} from '../inbox/contact-identity';
import { ContactEditDialog } from '../inbox/ContactEditDialog';
import { ContactPrivacy } from '../inbox/ContactPrivacy';
import { contactQuery, isNotFound } from '../inbox/inbox-queries';
import { ContactAvatar } from '../inbox/InboxBits';
import { ContactTags } from '../inbox/TagPicker';
import { LinkedTickets } from '../tickets/LinkedTickets';
import { displayAttributeValue, splitAttributes } from './attribute-values';
import { contactAttributesQuery, setContactFlash, takeContactFlash } from './contact-queries';
import { MergeDialog } from './MergeDialog';
import styles from './Contacts.module.css';

const c = t.contacts;
const d = t.inbox.detail;
const p = t.inbox.panel;
const routeApi = getRouteApi('/_app/kontak/$contactId');

/**
 * Detail kontak: identitas, data & atribut (berdefinisi berlabel + bebas), tag, tiket terkait, data
 * pribadi (ekspor JSON / hapus), dan penanda "mungkin duplikat" + Gabung (Owner/Admin).
 */
export function ContactDetailPage() {
  const { contactId } = routeApi.useParams();
  const result = useQuery(contactQuery(contactId));
  const contact = result.data?.contact;

  return (
    <Page>
      {result.isPending ? (
        <DetailSkeleton />
      ) : isNotFound(result.error) || (!contact && !result.isError) ? (
        <EmptyState
          illustration={<ContactsIllustration />}
          title={c.notFoundTitle}
          body={c.notFoundBody}
          actions={
            <Button variant="primary" asChild>
              <Link to="/kontak">{c.backToList}</Link>
            </Button>
          }
        />
      ) : !contact ? (
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={c.detailFailedTitle}
          body={isApiError(result.error) ? result.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void result.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      ) : (
        <ContactDetail key={contact.id} contact={contact} />
      )}
    </Page>
  );
}

function ContactDetail({ contact }: { contact: Contact }) {
  const navigate = useNavigate();
  const canManage = useCan('contacts.manage');
  const canTickets = useCan('tickets.manage');
  const definitions = useQuery(contactAttributesQuery).data ?? [];
  const [editing, setEditing] = useState(false);
  // Pesan gabung dibawa dari kontak yang digabung (halaman berpindah ke kontak yang dipertahankan).
  const [merged, setMerged] = useState<string | null>(() => takeContactFlash());
  const identity = contactIdentity(contact);
  const channel = c.channelLabels[contact.channelType] ?? contact.channelType;

  return (
    <div className={styles.detail}>
      {merged ? (
        <Notice tone="success" role="status">
          {merged}
        </Notice>
      ) : null}
      <section className={styles.card} aria-labelledby="kontak-identitas">
        <div className={styles.identity}>
          <ContactAvatar name={identity.name} size="lg" />
          <div className={styles.identityText}>
            <h2 id="kontak-identitas" className={styles.identityName} dir="auto">
              {identity.name}
            </h2>
            <p className={styles.identityMeta}>
              {[
                identity.handle ?? contact.channelHandle,
                channel,
                c.createdOn(formatDateTime(contact.createdAt)),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {untrustedNameLabel(identity, contact.channelType) ? (
              <p className={styles.identityBadge}>{c.nameFromProfile(channel)}</p>
            ) : null}
          </div>
        </div>
      </section>

      {contact.possibleDuplicateOfContactId ? (
        <DuplicateNotice
          contact={contact}
          otherId={contact.possibleDuplicateOfContactId}
          onMerged={(kept, message) => {
            setMerged(message);
            if (kept.id !== contact.id) {
              setContactFlash(message);
              void navigate({
                to: '/kontak/$contactId',
                params: { contactId: kept.id },
                replace: true,
              });
            }
          }}
        />
      ) : null}

      <div className={styles.detailGrid}>
        <div className={styles.column}>
          <section className={styles.card} aria-labelledby="kontak-data">
            <div className={styles.cardHead}>
              <h2 id="kontak-data" className={styles.cardTitle}>
                {c.sectionInfo}
              </h2>
              {canManage ? (
                <Button variant="ghost" onClick={() => setEditing(true)}>
                  <Icon icon={Pencil} size={16} />
                  {p.editContact}
                </Button>
              ) : null}
            </div>
            <dl className={styles.facts}>
              <Fact term={d.teamName}>
                {contact.name ? (
                  <span dir="auto">{contact.name}</span>
                ) : (
                  <span className={styles.muted}>{d.notSet}</span>
                )}
              </Fact>
              {contact.profileName ? (
                <Fact term={d.profileName}>
                  <span dir="auto">{contact.profileName}</span>
                </Fact>
              ) : null}
              {contact.phone ? <Fact term={d.phone}>{formatPhone(contact.phone)}</Fact> : null}
              {contact.waUsername ? (
                <Fact term={d.username}>{formatUsername(contact.waUsername)}</Fact>
              ) : null}
              <Fact term={p.email}>
                {contact.email ?? <span className={styles.muted}>{d.notSet}</span>}
              </Fact>
              {contact.notes ? (
                <Fact term={p.notes}>
                  <span className={styles.multiline} dir="auto">
                    {contact.notes}
                  </span>
                </Fact>
              ) : null}
            </dl>
          </section>

          <AttributesCard contact={contact} definitions={definitions} />
        </div>

        <div className={styles.column}>
          <section className={styles.card} aria-labelledby="kontak-tag">
            <h2 id="kontak-tag" className={styles.cardTitle}>
              {c.sectionTags}
            </h2>
            <ContactTags contact={contact} canManage={canManage} />
          </section>
          {canTickets ? (
            <section className={styles.card} aria-labelledby="kontak-tiket">
              <h2 id="kontak-tiket" className={styles.cardTitle}>
                {c.sectionTickets}
              </h2>
              <LinkedTickets contactId={contact.id} contactName={identity.name} />
            </section>
          ) : null}
          <div className={`${styles.card} ${styles.privacyCard}`}>
            <ContactPrivacy
              contact={contact}
              onDeleted={() => {
                setContactFlash(c.deletedFlash);
                void navigate({ to: '/kontak', replace: true });
              }}
            />
          </div>
        </div>
      </div>

      {editing ? (
        <ContactEditDialog
          contact={contact}
          open
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

function AttributesCard({
  contact,
  definitions,
}: {
  contact: Contact;
  definitions: readonly AttributeDefinition[];
}) {
  const { defined, free } = splitAttributes(definitions, contact.attributes ?? []);
  const empty = definitions.length === 0 && free.length === 0;
  return (
    <section className={styles.card} aria-labelledby="kontak-atribut">
      <h2 id="kontak-atribut" className={styles.cardTitle}>
        {c.sectionAttributes}
      </h2>
      {empty ? (
        <p className={styles.hint}>{c.noAttributes}</p>
      ) : (
        <dl className={styles.facts}>
          {definitions.map((definition) => {
            const value = defined[definition.key];
            return (
              <Fact key={definition.id} term={definition.label}>
                {value ? (
                  <span dir="auto">{displayAttributeValue(definition, value)}</span>
                ) : definition.required ? (
                  <span className={styles.missing}>{c.requiredMissing}</span>
                ) : (
                  <span className={styles.muted}>{d.notSet}</span>
                )}
              </Fact>
            );
          })}
          {free.map((item) => (
            <Fact key={item.key} term={`${item.key} (${c.freeAttribute})`}>
              <span dir="auto">{item.value}</span>
            </Fact>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * Kontak bertanda "mungkin duplikat" (review R4: nomornya pernah tercatat di kontak lain). Gabung =
 * Owner/Admin (`contacts.delete`); peran lain diberi tahu siapa yang bisa.
 */
function DuplicateNotice({
  contact,
  otherId,
  onMerged,
}: {
  contact: Contact;
  otherId: string;
  onMerged: (kept: Contact, message: string) => void;
}) {
  const canMerge = useCan('contacts.delete');
  const other = useQuery(contactQuery(otherId));
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const otherContact = other.data?.contact;
  const otherName = otherContact ? contactIdentity(otherContact).name : null;
  return (
    <Notice
      tone="warning"
      title={c.duplicateNoticeTitle}
      actions={
        <>
          {otherContact ? (
            <Button asChild>
              <Link to="/kontak/$contactId" params={{ contactId: otherId }}>
                {c.openOther}
              </Link>
            </Button>
          ) : null}
          {canMerge && otherContact ? (
            <Button ref={buttonRef} onClick={() => setOpen(true)}>
              <Icon icon={GitMerge} size={16} />
              {c.merge}
            </Button>
          ) : null}
        </>
      }
    >
      <p>{otherName ? c.duplicateNoticeBody(otherName) : c.duplicateNoticeUnknown}</p>
      {other.isError && !isNotFound(other.error) ? <p>{c.mergeLoadFailed}</p> : null}
      {!canMerge ? <p>{c.duplicateNoPermission}</p> : null}
      {otherContact ? (
        <MergeDialog
          open={open}
          current={contact}
          other={otherContact}
          onCancel={() => setOpen(false)}
          onMerged={(kept, result) => {
            setOpen(false);
            onMerged(kept, c.mergeDone(result.moved));
          }}
          returnFocusRef={buttonRef}
        />
      ) : null}
    </Notice>
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
      <div className={styles.card}>
        <div className={styles.identity}>
          <Skeleton className={styles.skeletonAvatar} />
          <span className={styles.skeletonText}>
            <Skeleton className={styles.skeletonName} />
            <Skeleton className={styles.skeletonHandle} />
          </span>
        </div>
      </div>
      <div className={styles.card}>
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className={styles.skeletonName} />
        ))}
      </div>
    </SkeletonRegion>
  );
}
