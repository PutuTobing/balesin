import { EMAIL_MAX_EXTRA_RECIPIENTS, type Conversation } from '@balesin/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ReplyAll } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { AddressChips } from '../../components/ui/AddressChips';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { useCan } from '../auth/session';
import styles from './EmailCopies.module.css';
import {
  addCopies,
  lastReplyAll,
  leftoverInput,
  newCopies,
  splitAddressInput,
  threadAddresses,
  type AddResult,
  type CopyField,
} from './email-recipients';
import { flattenMessages, inboxChannelsQuery, messagesQuery } from './inbox-queries';
import type { EmailCopiesState } from './use-email-copies';

const k = t.inbox.emailCopies;
const MAX = EMAIL_MAX_EXTRA_RECIPIENTS;

/** Penjelasan penolakan pertama (satu baris; alamat tidak sah tetap di kolom untuk diperbaiki). */
function rejectionText(result: AddResult): string | null {
  const first = result.rejected[0];
  if (!first) return null;
  switch (first.reason) {
    case 'invalid':
      return k.invalid(first.address);
    case 'customer':
      return k.customer;
    case 'self':
      return k.self;
    case 'otherChannel':
      return k.otherChannel;
    case 'limit':
      return k.limit(MAX);
  }
}

/**
 * Kepala penerima di atas kotak tulis channel Email: "Kepada <pelanggan>", tombol "Balas semua"
 * (Cc dari email masuk terakhir) dan "Cc/Bcc" yang membuka isian chip. Alamat yang belum pernah ada
 * di utas ditandai "baru"; tanpa izin `inbox.initiate` diberi penjelasan sebelum kirim (server tetap
 * penentu — galatnya tampil apa adanya di pesan yang gagal).
 */
export function EmailCopiesBar({
  conversation,
  state,
  disabled = false,
}: {
  conversation: Conversation;
  state: EmailCopiesState;
  disabled?: boolean;
}) {
  const { copies, setCopies, open, setOpen } = state;
  const canInitiate = useCan('inbox.initiate');
  const messages = useInfiniteQuery(messagesQuery(conversation.id)).data;
  const loaded = useMemo(() => flattenMessages(messages), [messages]);
  const channels = useQuery(inboxChannelsQuery).data?.channels;
  const ownAddresses = useMemo(
    () => channels?.find((channel) => channel.id === conversation.channel.id)?.emailAddresses ?? [],
    [channels, conversation.channel.id],
  );
  const otherAddresses = useMemo(
    () =>
      (channels ?? [])
        .filter((channel) => channel.id !== conversation.channel.id)
        .flatMap((channel) => channel.emailAddresses ?? []),
    [channels, conversation.channel.id],
  );
  const customer = conversation.contact.channelHandle?.toLowerCase() ?? null;
  const known = useMemo(() => threadAddresses(loaded, customer), [loaded, customer]);
  const replyAll = useMemo(
    () => lastReplyAll(loaded).filter((address) => address !== customer),
    [loaded, customer],
  );
  const fresh = useMemo(() => newCopies(copies, known), [copies, known]);
  const flagged = useMemo(() => new Set(fresh), [fresh]);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const ccRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const total = copies.cc.length + copies.bcc.length;
  const full = total >= MAX;

  const context = { customer, own: ownAddresses, others: otherAddresses };

  const commit = (field: CopyField) => (raw: string) => {
    const result = addCopies(copies, field, splitAddressInput(raw), context);
    return apply(result);
  };

  const apply = (result: AddResult) => {
    setCopies({ cc: result.cc, bcc: result.bcc });
    setError(rejectionText(result));
    return leftoverInput(result);
  };

  const remove = (field: CopyField) => (address: string) => {
    setCopies((current) => ({
      ...current,
      [field]: current[field].filter((item) => item !== address),
    }));
    setError(null);
  };

  const fillReplyAll = () => {
    const result = addCopies(copies, 'cc', replyAll, context);
    apply(result);
    setOpen(true);
    setAnnouncement(k.replyAllDone(result.added.length));
    requestAnimationFrame(() => ccRef.current?.focus());
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setError(null);
    if (next) requestAnimationFrame(() => ccRef.current?.focus());
  };

  const fieldsId = `${id}-isian`;
  const metaId = `${id}-keterangan`;
  const errorId = `${id}-galat`;
  const describedBy = [metaId, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={styles.copies}>
      <div className={styles.bar}>
        <p className={styles.to}>
          <span className={styles.toLabel}>{k.to}</span>
          <span className={styles.toAddress} title={customer ?? undefined}>
            {conversation.contact.channelHandle ?? conversation.contact.displayName}
          </span>
        </p>
        <div className={styles.actions}>
          {replyAll.length > 0 ? (
            <button
              type="button"
              className={styles.action}
              aria-label={k.replyAllLabel(replyAll.length)}
              disabled={disabled || full}
              onClick={fillReplyAll}
            >
              <Icon icon={ReplyAll} size={16} />
              <span>{k.replyAll}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={styles.action}
            aria-expanded={open}
            aria-controls={open ? fieldsId : undefined}
            aria-label={total > 0 ? k.toggleLabelCount(total) : k.toggleLabel}
            data-active={total > 0 ? '' : undefined}
            disabled={disabled}
            onClick={toggle}
          >
            {total > 0 ? k.toggleCount(total) : k.toggle}
          </button>
        </div>
      </div>
      {open ? (
        <div id={fieldsId} className={styles.fields}>
          <AddressChips
            ref={ccRef}
            prefix={k.cc}
            inputLabel={k.fieldLabel(k.cc)}
            addresses={copies.cc}
            onCommit={commit('cc')}
            onRemove={remove('cc')}
            flagged={flagged}
            flagLabel={k.newBadge}
            flagDescription={k.newBadgeLabel}
            removeLabel={k.remove}
            removedAnnouncement={k.removed}
            placeholder={k.placeholderShort}
            inputDisabled={full}
            disabled={disabled}
            invalid={error !== null}
            describedBy={describedBy}
          />
          <AddressChips
            prefix={k.bcc}
            inputLabel={k.fieldLabel(k.bcc)}
            addresses={copies.bcc}
            onCommit={commit('bcc')}
            onRemove={remove('bcc')}
            flagged={flagged}
            flagLabel={k.newBadge}
            flagDescription={k.newBadgeLabel}
            removeLabel={k.remove}
            removedAnnouncement={k.removed}
            placeholder={k.placeholderShort}
            inputDisabled={full}
            disabled={disabled}
            describedBy={describedBy}
          />
          {error ? (
            <p id={errorId} className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <p id={metaId} className={styles.meta}>
            <span className={styles.count} data-full={full ? '' : undefined}>
              {full ? k.full(MAX) : k.count(total, MAX)}
            </span>
            <span>{k.bccNote}</span>
          </p>
        </div>
      ) : null}
      {fresh.length > 0 && !canInitiate ? (
        <Notice tone="warning" title={k.newNoInitiateTitle} className={styles.notice}>
          {k.newNoInitiateBody(fresh.length)}
        </Notice>
      ) : fresh.length > 0 && open ? (
        <p className={styles.meta}>{k.newInitiate(fresh.length)}</p>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
