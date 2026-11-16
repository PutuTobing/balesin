import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { formatDateTime } from '../../lib/format';
import styles from './ContactPanel.module.css';
import { contactIdentity, formatPhone, formatUsername } from './contact-identity';
import { contactQuery, conversationQuery, isNotFound } from './inbox-queries';
import { ContactAvatar, WindowCountdown } from './InboxBits';
import { useMinuteClock } from './use-minute-clock';

const d = t.inbox.detail;

/**
 * Isi panel detail untuk chat yang terbuka: identitas kontak + ringkasan percakapan. Data dari
 * cache yang sama dengan ruang chat (tidak ada permintaan ganda). Tag, catatan, dan aksi menyusul.
 */
export function ContactPanel({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const now = useMinuteClock();
  const conversationResult = useQuery(conversationQuery(conversationId, queryClient));
  const gone = isNotFound(conversationResult.error);
  const conversation = gone ? undefined : conversationResult.data?.conversation;
  const contactResult = useQuery({
    ...contactQuery(conversation?.contact.id ?? ''),
    enabled: conversation !== undefined,
  });

  if (gone) return <p className={styles.note}>{d.emptyBody}</p>;
  if (!conversation) return <PanelSkeleton />;

  const contact = contactResult.data?.contact;
  const identity = contact ? contactIdentity(contact) : null;
  const name = identity?.name ?? conversation.contact.displayName;

  return (
    <div className={styles.panel}>
      <div className={styles.identity}>
        <ContactAvatar name={name} size="lg" />
        <p className={styles.name} dir="auto">
          {name}
        </p>
        {(identity?.handle ?? formatPhone(conversation.contact.phone)) ? (
          <p className={styles.handle}>
            {identity?.handle ?? formatPhone(conversation.contact.phone)}
          </p>
        ) : null}
        {identity?.fromWhatsApp ? (
          <p className={styles.badge}>{t.inbox.item.fromWhatsApp}</p>
        ) : null}
      </div>

      <section className={styles.section} aria-labelledby="detail-percakapan">
        <h3 id="detail-percakapan" className={styles.sectionTitle}>
          {d.conversation}
        </h3>
        <dl className={styles.facts}>
          <Fact term={d.status}>{t.inbox.item.status[conversation.status]}</Fact>
          <Fact term={d.assignee}>{conversation.assignee?.name ?? t.inbox.item.unassigned}</Fact>
          <Fact term={d.channel}>{conversation.channel.name}</Fact>
          {conversation.windowExpiresAt ? (
            <Fact term={d.window}>
              <WindowCountdown expiresAt={conversation.windowExpiresAt} now={now} showEnd />
            </Fact>
          ) : null}
          <Fact term={d.startedAt}>{formatDateTime(conversation.createdAt)}</Fact>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="detail-kontak">
        <h3 id="detail-kontak" className={styles.sectionTitle}>
          {d.contact}
        </h3>
        {contactResult.isError ? (
          <p className={styles.note}>{d.failed}</p>
        ) : !contact ? (
          <PanelSkeleton rows={3} />
        ) : (
          <dl className={styles.facts}>
            <Fact term={d.teamName}>
              {contact.name ? <span dir="auto">{contact.name}</span> : <Muted>{d.notSet}</Muted>}
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
            <Fact term={d.createdAt}>{formatDateTime(contact.createdAt)}</Fact>
          </dl>
        )}
      </section>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className={styles.muted}>{children}</span>;
}

function PanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <SkeletonRegion className={styles.skeleton}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.skeletonRow}>
          <Skeleton className={styles.skeletonTerm} />
          <Skeleton className={styles.skeletonValue} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
