import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { useCan } from '../auth/session';
import { ContactEditDialog } from './ContactEditDialog';
import { ContactPrivacy } from './ContactPrivacy';
import { FilesTab, LogTab, NotesTab } from './PanelTabs';
import { ContactTags } from './TagPicker';
import { LinkedTickets } from '../tickets/LinkedTickets';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { formatDateTime } from '../../lib/format';
import styles from './ContactPanel.module.css';
import {
  contactIdentity,
  formatPhone,
  formatUsername,
  summaryIdentity,
  untrustedNameLabel,
} from './contact-identity';
import { CHANNEL_TYPE_LABELS } from '@balesin/shared';
import { contactQuery, conversationQuery, goneQuery, isNotFound } from './inbox-queries';
import { ContactAvatar, WindowCountdown } from './InboxBits';
import { useMinuteClock } from './use-minute-clock';

const d = t.inbox.detail;

const p = t.inbox.panel;
type PanelTab = 'info' | 'notes' | 'files' | 'log';
const PANEL_TABS: PanelTab[] = ['info', 'notes', 'files', 'log'];

/**
 * Panel detail chat yang terbuka (butir 8): tab Info (identitas, tag, percakapan, kontak), Catatan
 * sesi, Berkas (media/file/ditandai), dan Log. Data dari cache yang sama dengan ruang chat.
 */
export function ContactPanel({
  conversationId,
  onClosed,
}: {
  conversationId: string;
  /** Chat tidak tersedia lagi setelah tindakan di panel (mis. kontak dihapus). */
  onClosed?: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>('info');
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => setTab(PANEL_TABS.find((item) => item === value) ?? 'info')}
      className={styles.root}
    >
      <Tabs.List className={styles.tabs} aria-label={p.tabsLabel}>
        {PANEL_TABS.map((id) => (
          <Tabs.Trigger
            key={id}
            value={id}
            className={styles.tab}
            // Cincin fokus hanya untuk keyboard: aktivasi dengan pointer menandai tab-nya sampai
            // fokus pindah atau tombol ditekan (Chromium kadang menganggap klik = :focus-visible).
            onPointerDown={(event) => {
              event.currentTarget.dataset.pointer = '';
            }}
            onKeyDown={(event) => {
              delete event.currentTarget.dataset.pointer;
            }}
            onBlur={(event) => {
              delete event.currentTarget.dataset.pointer;
            }}
          >
            {p.tabs[id]}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="info" className={styles.content}>
        <InfoTab conversationId={conversationId} onClosed={onClosed} />
      </Tabs.Content>
      <Tabs.Content value="notes" className={styles.content}>
        <NotesTab conversationId={conversationId} />
      </Tabs.Content>
      <Tabs.Content value="files" className={styles.content}>
        <FilesTab conversationId={conversationId} />
      </Tabs.Content>
      <Tabs.Content value="log" className={styles.content}>
        <LogTab conversationId={conversationId} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function InfoTab({ conversationId, onClosed }: { conversationId: string; onClosed?: () => void }) {
  const canManage = useCan('contacts.manage');
  const canTickets = useCan('tickets.manage');
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const now = useMinuteClock();
  const forgotten = useQuery(goneQuery(conversationId)).data;
  const conversationResult = useQuery({
    ...conversationQuery(conversationId, queryClient),
    enabled: !forgotten,
  });
  const gone = forgotten || isNotFound(conversationResult.error);
  const conversation = gone ? undefined : conversationResult.data?.conversation;
  const contactResult = useQuery({
    ...contactQuery(conversation?.contact.id ?? ''),
    enabled: conversation !== undefined,
  });

  // Tidak tersedia lagi (dialihkan/dihapus): keterangan, bukan kerangka selamanya.
  if (gone) return <p className={styles.note}>{d.unavailable}</p>;
  if (!conversation) return <PanelSkeleton />;

  const contact = contactResult.data?.contact;
  const identity = contact ? contactIdentity(contact) : null;
  const fallback = summaryIdentity(conversation.contact);
  const name = identity?.name ?? fallback.name;
  const handle = identity ? identity.handle : fallback.handle;

  return (
    <div className={styles.panel}>
      <div className={styles.identity}>
        <ContactAvatar name={name} size="lg" />
        <p className={styles.name} dir="auto">
          {name}
        </p>
        {/* Nama yang sama dengan nomornya tidak ditulis dua kali. */}
        {handle ? <p className={styles.handle}>{handle}</p> : null}
        {identity && untrustedNameLabel(identity, conversation.channel.type) ? (
          <p className={styles.badge}>{untrustedNameLabel(identity, conversation.channel.type)}</p>
        ) : null}
      </div>

      {contact ? (
        <section className={styles.section} aria-labelledby="detail-tag">
          <h3 id="detail-tag" className={styles.sectionTitle}>
            {p.tags}
          </h3>
          <ContactTags contact={contact} canManage={canManage} />
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="detail-percakapan">
        <h3 id="detail-percakapan" className={styles.sectionTitle}>
          {d.conversation}
        </h3>
        <dl className={styles.facts}>
          <Fact term={d.status}>{t.inbox.item.status[conversation.status]}</Fact>
          <Fact term={d.assignee}>{conversation.assignee?.name ?? t.inbox.item.unassigned}</Fact>
          <Fact term={d.channel}>
            {conversation.channel.type === 'whatsapp'
              ? conversation.channel.name
              : `${conversation.channel.name} (${CHANNEL_TYPE_LABELS[conversation.channel.type]})`}
          </Fact>
          {conversation.department ? (
            <Fact term={d.department}>{conversation.department.name}</Fact>
          ) : null}
          {conversation.windowExpiresAt ? (
            <Fact term={d.window}>
              <WindowCountdown expiresAt={conversation.windowExpiresAt} now={now} showEnd />
            </Fact>
          ) : null}
          <Fact term={d.startedAt}>{formatDateTime(conversation.createdAt)}</Fact>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="detail-kontak">
        <div className={styles.sectionHead}>
          <h3 id="detail-kontak" className={styles.sectionTitle}>
            {d.contact}
          </h3>
          {canManage && contact ? (
            <Button
              variant="ghost"
              className={styles.sectionAction}
              onClick={() => setEditing(true)}
            >
              <Icon icon={Pencil} size={16} />
              {p.editContact}
            </Button>
          ) : null}
        </div>
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
              <Fact term={d.profileNameFrom(CHANNEL_TYPE_LABELS[contact.channelType])}>
                <span dir="auto">{contact.profileName}</span>
              </Fact>
            ) : null}
            {contact.phone ? <Fact term={d.phone}>{formatPhone(contact.phone)}</Fact> : null}
            {contact.waUsername ? (
              <Fact term={d.username}>{formatUsername(contact.waUsername)}</Fact>
            ) : null}
            <Fact term={p.email}>
              {contact.email ? (
                <EmailText email={contact.email} />
              ) : contact.channelType === 'email' && contact.channelHandle ? (
                // Kontak dari channel Email: alamat pengirimnya (belum diisi tim).
                <EmailText email={contact.channelHandle} />
              ) : (
                <Muted>{d.notSet}</Muted>
              )}
            </Fact>
            {contact.notes ? (
              <Fact term={p.notes}>
                <span className={styles.multiline} dir="auto">
                  {contact.notes}
                </span>
              </Fact>
            ) : null}
            {(contact.attributes ?? []).map((attribute) => (
              <Fact key={attribute.key} term={attribute.key}>
                <span dir="auto">{attribute.value}</span>
              </Fact>
            ))}
            <Fact term={d.createdAt}>{formatDateTime(contact.createdAt)}</Fact>
          </dl>
        )}
      </section>
      {canTickets ? (
        <section className={styles.section} aria-labelledby="detail-tiket">
          <h3 id="detail-tiket" className={styles.sectionTitle}>
            {t.tickets.linkedTitle}
          </h3>
          <LinkedTickets
            conversationId={conversationId}
            contactId={conversation.contact.id}
            contactName={name}
          />
        </section>
      ) : null}
      {contact ? (
        <ContactPrivacy contact={contact} conversationId={conversationId} onDeleted={onClosed} />
      ) : null}
      {contact && editing ? (
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

/** Email panjang dipatah setelah "@" (bukan di tengah kata). */
function EmailText({ email }: { email: string }) {
  const at = email.indexOf('@');
  if (at < 0) return <span className={styles.email}>{email}</span>;
  return (
    <span className={styles.email}>
      {email.slice(0, at)}
      <wbr />
      {email.slice(at)}
    </span>
  );
}
