import {
  EMAIL_OUTBOUND_STATUSES,
  type EmailOutboundEntry,
  type EmailOutboundStatus,
} from '@balesin/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import {
  EmailSentIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { emailSendersQuery } from '../sending-limits/email-sender-queries';
import {
  emailOutboundQuery,
  emailOutboundRangeInvalid,
  hasEmailOutboundFilters,
  type EmailOutboundSearch,
} from './email-outbound-search';
import { integrationKeys } from './integration-queries';
import styles from './EmailOutbound.module.css';

const copy = t.emailOutbound;
const PAGE_SIZE = 30;
const SHOWN_RECIPIENTS = 2;

const STATUS_TONE: Record<EmailOutboundStatus, StatusTone> = {
  scheduled: 'neutral',
  queued: 'neutral',
  sending: 'neutral',
  sent: 'success',
  failed: 'danger',
  bounced: 'danger',
  canceled: 'neutral',
};

/**
 * Pengaturan → API key → Email terkirim (`api_keys.manage`, tahap 9.1): riwayat email lewat API &
 * kirim tes, tersaring key/pengirim/status/tanggal (di URL), kursor "Muat lagi". Penerima selalu
 * tersamar dari server; isi & lampiran tidak pernah ditampilkan.
 */
export function EmailOutboundPage() {
  const search = useSearch({ from: '/_app/pengaturan/api-key/email-terkirim' });
  const navigate = useNavigate({ from: '/pengaturan/api-key/email-terkirim' });
  const apiKeys = useQuery({
    queryKey: integrationKeys.apiKeys,
    queryFn: ({ signal }) => endpoints.apiKeys.list(signal),
  });
  const senders = useQuery(emailSendersQuery);
  const query = emailOutboundQuery(search);
  const invalidRange = emailOutboundRangeInvalid(search);
  const list = useInfiniteQuery({
    queryKey: [...integrationKeys.emailOutbound, query] as const,
    queryFn: ({ pageParam, signal }) =>
      endpoints.emailOutbound.list(
        { ...query, limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const emails = list.data?.pages.flatMap((page) => page.emails) ?? [];
  const filtered = hasEmailOutboundFilters(search);

  const set = (patch: Partial<EmailOutboundSearch>) =>
    void navigate({ search: (current) => ({ ...current, ...patch }), replace: true });

  return (
    <Page>
      <div className={styles.content}>
        <p className={styles.intro}>{copy.intro}</p>
        <div className={styles.filters} role="group" aria-label={copy.filtersLabel}>
          <SelectField
            label={copy.apiKeyLabel}
            value={search.apiKeyId ?? ''}
            onChange={(event) => set({ apiKeyId: event.target.value || undefined })}
            options={[
              { value: '', label: copy.allApiKeys },
              ...(apiKeys.data?.apiKeys ?? []).map((apiKey) => ({
                value: apiKey.id,
                label: apiKey.name,
              })),
            ]}
            className={styles.filter}
          />
          <SelectField
            label={copy.senderLabel}
            value={search.senderId ?? ''}
            onChange={(event) => set({ senderId: event.target.value || undefined })}
            options={[
              { value: '', label: copy.allSenders },
              ...(senders.data?.senders ?? []).map((sender) => ({
                value: sender.id,
                label: sender.address,
              })),
            ]}
            className={styles.filter}
          />
          <SelectField
            label={copy.statusLabel}
            value={search.status ?? ''}
            onChange={(event) =>
              set({
                status:
                  EMAIL_OUTBOUND_STATUSES.find((status) => status === event.target.value) ??
                  undefined,
              })
            }
            options={[
              { value: '', label: copy.allStatuses },
              ...EMAIL_OUTBOUND_STATUSES.map((status) => ({
                value: status,
                label: copy.status[status],
              })),
            ]}
            className={styles.filter}
          />
          <TextField
            label={copy.fromLabel}
            type="date"
            value={search.from ?? ''}
            onChange={(event) => set({ from: event.target.value || undefined })}
            className={styles.dateFilter}
          />
          <TextField
            label={copy.toLabel}
            type="date"
            value={search.to ?? ''}
            onChange={(event) => set({ to: event.target.value || undefined })}
            error={invalidRange ? copy.rangeInvalid : undefined}
            className={styles.dateFilter}
          />
        </div>
        {filtered ? (
          <div className={styles.resetRow}>
            <Button
              variant="ghost"
              onClick={() =>
                void navigate({
                  search: {
                    apiKeyId: undefined,
                    senderId: undefined,
                    status: undefined,
                    from: undefined,
                    to: undefined,
                  },
                  replace: true,
                })
              }
            >
              {copy.resetFilters}
            </Button>
          </div>
        ) : null}

        {list.isPending ? (
          <ListSkeleton />
        ) : list.isError && emails.length === 0 ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={copy.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : emails.length === 0 ? (
          filtered ? (
            <p className={styles.noMatch}>{copy.noMatch}</p>
          ) : (
            <EmptyState
              illustration={<EmailSentIllustration />}
              title={copy.emptyTitle}
              body={copy.emptyBody}
            />
          )
        ) : (
          <>
            <ul className={styles.list} aria-label={copy.listLabel}>
              {emails.map((email) => (
                <EmailRow key={email.id} email={email} />
              ))}
            </ul>
            {list.isFetchNextPageError ? (
              <Notice tone="danger" role="alert">
                {isApiError(list.error) ? list.error.message : t.api.network}
              </Notice>
            ) : null}
            {list.hasNextPage ? (
              <div className={styles.more}>
                <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage ? copy.loadingMore : copy.loadMore}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Page>
  );
}

function EmailRow({ email }: { email: EmailOutboundEntry }) {
  const shown = email.recipients.slice(0, SHOWN_RECIPIENTS);
  const hidden = Math.max(0, email.recipientCount - shown.length);
  const metadata = Object.entries(email.metadata ?? {}).slice(0, 4);
  const facts = [
    email.source === 'test' ? copy.testSource : (email.apiKey?.name ?? copy.deletedKey),
    email.sender.address,
    email.template ? copy.template(email.template.slug, email.template.version) : null,
    `${copy.createdAt(formatDateTimeInline(email.createdAt))}${
      email.sentAt ? `, ${copy.sentAt(formatDateTimeInline(email.sentAt))}` : ''
    }`,
  ].filter(Boolean);
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <Icon icon={Mail} size={20} className={styles.itemIcon} />
        <p className={styles.subject} dir="auto">
          {email.subject}
        </p>
        <StatusBadge
          tone={STATUS_TONE[email.status]}
          label={copy.status[email.status]}
          className={styles.status}
        />
      </div>
      <div className={styles.itemBody}>
        <p className={styles.recipients} aria-label={copy.recipientsLabel}>
          {shown.map((recipient) => (
            <code key={recipient} className={styles.recipient}>
              {recipient}
            </code>
          ))}
          {hidden > 0 ? (
            <span className={styles.moreRecipients}>{copy.moreRecipients(hidden)}</span>
          ) : null}
        </p>
        <p className={styles.meta}>{facts.join(' · ')}</p>
        {email.failure ? (
          <p className={styles.failure}>
            {email.failure.message}
            {email.failure.smtpCode ? ` (${copy.smtpCode(email.failure.smtpCode)})` : ''}
          </p>
        ) : null}
        {metadata.length > 0 ? (
          <ul className={styles.metadata} aria-label={copy.metadataLabel}>
            {metadata.map(([key, value]) => (
              <li key={key} className={styles.metaChip}>
                <span className={styles.metaKey}>{key}</span>
                <span dir="auto">{String(value)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
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
