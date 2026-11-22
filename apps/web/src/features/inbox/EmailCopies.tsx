import { EMAIL_MAX_EXTRA_RECIPIENTS, type Conversation } from '@balesin/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ReplyAll } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { AddressChips } from '../../components/ui/AddressChips';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
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
import { rejectionText, type EmailCopiesState } from './use-email-copies';

const k = t.inbox.emailCopies;
const MAX = EMAIL_MAX_EXTRA_RECIPIENTS;

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
  const { copies, setCopies, open, setOpen, drafts, setDraft, errors, setError } = state;
  const canInitiate = useCan('inbox.initiate');
  const isHp = useMediaQuery(media.hp);
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
  const context = useMemo(
    () => ({ customer, own: ownAddresses, others: otherAddresses }),
    [customer, ownAddresses, otherAddresses],
  );
  // Aturan alamat juga dipakai `finalize` saat kirim (ketikan yang belum jadi chip).
  const { contextRef } = state;
  useEffect(() => {
    contextRef.current = context;
  }, [contextRef, context]);
  const known = useMemo(() => threadAddresses(loaded, customer), [loaded, customer]);
  const replyAll = useMemo(
    () => lastReplyAll(loaded).filter((address) => address !== customer),
    [loaded, customer],
  );
  const fresh = useMemo(() => newCopies(copies, known), [copies, known]);
  const flagged = useMemo(() => new Set(fresh), [fresh]);
  const [announcement, setAnnouncement] = useState('');
  const id = useId();
  const total = copies.cc.length + copies.bcc.length;
  const full = total >= MAX;

  /** Hasil satu kolom: galat hanya untuk kolom itu (kolom lain tidak ikut berubah). */
  const apply = (field: CopyField, result: AddResult) => {
    setCopies({ cc: result.cc, bcc: result.bcc });
    setError(field, rejectionText(result));
    return leftoverInput(result);
  };

  const commit = (field: CopyField) => (raw: string) =>
    apply(field, addCopies(copies, field, splitAddressInput(raw), context));

  const remove = (field: CopyField) => (address: string) => {
    setCopies((current) => ({
      ...current,
      [field]: current[field].filter((item) => item !== address),
    }));
    // Galat batas/penolakan lama tidak berlaku lagi; ketikan salah yang masih ada tetap ditandai.
    if (drafts[field].trim() === '') setError(field, null);
  };

  const fillReplyAll = () => {
    const result = addCopies(copies, 'cc', replyAll, context);
    apply('cc', result);
    setOpen(true);
    setAnnouncement(k.replyAllDone(result.added.length));
    requestAnimationFrame(() => state.ccRef.current?.focus());
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) requestAnimationFrame(() => state.ccRef.current?.focus());
  };

  const fieldsId = `${id}-isian`;
  const metaId = `${id}-keterangan`;
  const warning =
    fresh.length > 0 && !canInitiate ? (
      isHp ? (
        <Notice tone="warning" className={styles.notice}>
          {k.newNoInitiateShort}
        </Notice>
      ) : (
        <Notice tone="warning" title={k.newNoInitiateTitle} className={styles.notice}>
          {k.newNoInitiateBody(fresh.length)}
        </Notice>
      )
    ) : null;

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
        // Semua isi (kolom, keterangan, peringatan) dalam satu area gulir: di HP tingginya dibatasi
        // supaya riwayat chat tetap terlihat saat keyboard terbuka (review 9.0 P1).
        <div id={fieldsId} className={styles.fields}>
          {(['cc', 'bcc'] as const).map((field) => (
            <AddressChips
              key={field}
              ref={field === 'cc' ? state.ccRef : state.bccRef}
              prefix={k[field]}
              inputLabel={k.fieldLabel(k[field])}
              addresses={copies[field]}
              onCommit={commit(field)}
              onRemove={remove(field)}
              draft={drafts[field]}
              onDraftChange={(value, reason) => setDraft(field, value, reason)}
              error={errors[field] ?? null}
              flagged={flagged}
              flagLabel={k.newBadge}
              flagDescription={k.newBadgeLabel}
              removeLabel={k.remove}
              removedAnnouncement={k.removed}
              placeholder={k.placeholderShort}
              inputDisabled={full}
              disabled={disabled}
              describedBy={metaId}
            />
          ))}
          <p id={metaId} className={styles.meta}>
            <span className={styles.count} data-full={full ? '' : undefined}>
              {full ? k.full(MAX) : k.count(total, MAX)}
            </span>
            <span>{k.bccNote}</span>
          </p>
          {warning}
          {fresh.length > 0 && canInitiate ? (
            <p className={styles.meta}>{k.newInitiate(fresh.length)}</p>
          ) : null}
        </div>
      ) : (
        warning
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
