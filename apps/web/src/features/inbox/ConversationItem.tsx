import type { Conversation, MessageDeliveryStatus } from '@balesin/shared';
import { Check, CheckCheck, CircleAlert, Clock, type LucideIcon } from 'lucide-react';
import { memo } from 'react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { summaryIdentity } from './contact-identity';
import { formatListTime } from './inbox-time';
import { ContactAvatar, WindowCountdown } from './InboxBits';
import styles from './ConversationList.module.css';
import { previewContent } from './message-content';

const statusIcons: Record<MessageDeliveryStatus, LucideIcon> = {
  pending: Clock,
  sent: Check,
  delivered: CheckCheck,
  read: CheckCheck,
  played: CheckCheck,
  failed: CircleAlert,
};

/** Ikon status kirim pesan keluar (centang) — dipakai di daftar dan gelembung pesan. */
export function DeliveryIcon({
  status,
  className,
}: {
  status: MessageDeliveryStatus;
  className?: string;
}) {
  return (
    <span className={className} data-status={status}>
      <Icon icon={statusIcons[status]} size={16} />
      <span className="sr-only">{t.inbox.chat.deliveryStatus[status]}</span>
    </span>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  selected: boolean;
  /** Satu-satunya baris yang dicapai dengan Tab (baris lain lewat panah atas/bawah). */
  tabStop: boolean;
  /** Tampilkan status percakapan (hanya di tab "Semua"; tab lain sudah menyatakannya). */
  showStatus: boolean;
  now: number;
  onOpen: (conversationId: string) => void;
}

/**
 * Satu baris daftar chat. Semua isi dari pelanggan (nama, cuplikan) dirender sebagai teks dengan
 * `dir="auto"`; nomor selalu tampil di samping nama yang bukan nomor itu sendiri.
 */
export const ConversationItem = memo(function ConversationItem({
  conversation,
  selected,
  tabStop,
  showStatus,
  now,
  onOpen,
}: ConversationItemProps) {
  const identity = summaryIdentity(conversation.contact);
  const preview = previewContent(conversation.lastMessage);
  const unread = conversation.unreadCount;
  const last = conversation.lastMessage;
  // Nomor/@username di awal baris meta (tidak pernah terpotong); sisanya boleh mengalah.
  // Urutan: nomor · agen (atau status bila belum ada agen, hanya di tab Semua) · channel.
  // Nomor dan agen tidak pernah terpotong; nama channel yang mengalah lebih dulu.
  // Tab Semua: chat selesai tetap menyebut statusnya ("Selesai · Agus").
  const statusLabel = t.inbox.item.status[conversation.status];
  const who = conversation.assignee
    ? showStatus && conversation.status === 'resolved'
      ? `${statusLabel} · ${conversation.assignee.name}`
      : conversation.assignee.name
    : showStatus
      ? statusLabel
      : null;
  const parts = [identity.handle, who].filter((part): part is string => Boolean(part));

  return (
    <li className={styles.itemWrap}>
      <button
        type="button"
        className={styles.item}
        aria-current={selected ? 'true' : undefined}
        tabIndex={tabStop ? 0 : -1}
        data-unread={unread > 0 ? '' : undefined}
        data-conversation-id={conversation.id}
        onClick={() => onOpen(conversation.id)}
      >
        <ContactAvatar name={identity.name} />
        <span className={styles.lines}>
          <span className={styles.line}>
            <span className={styles.nameWrap}>
              {identity.fromWhatsApp ? (
                // Seperti WhatsApp: "~" = nama dari profil pelanggan, belum diberi nama oleh tim.
                <span
                  className={styles.fromWa}
                  aria-hidden="true"
                  title={t.inbox.item.fromWhatsAppHint}
                >
                  ~
                </span>
              ) : null}
              <span className={styles.name} dir="auto">
                {identity.name}
              </span>
              {identity.fromWhatsApp ? (
                <span className="sr-only"> ({t.inbox.item.fromWhatsApp})</span>
              ) : null}
            </span>
            <time className={styles.time} dateTime={conversation.lastMessageAt}>
              {formatListTime(conversation.lastMessageAt, new Date(now))}
            </time>
          </span>
          <span className={styles.line}>
            <span className={styles.snippet}>
              {last?.direction === 'outbound' && last.status ? (
                <DeliveryIcon status={last.status} className={styles.snippetStatus} />
              ) : null}
              {preview.icon ? (
                <Icon icon={preview.icon} size={16} className={styles.snippetIcon} />
              ) : null}
              <span className={styles.snippetText} dir="auto">
                {preview.text}
              </span>
            </span>
            {/* Sesi 24 jam di baris cuplikan: baris meta utuh untuk nomor + agen/status. */}
            <WindowCountdown
              expiresAt={conversation.windowExpiresAt}
              now={now}
              className={styles.countdown}
            />
            {unread > 0 ? (
              <span className={styles.unread}>
                <span aria-hidden="true">{t.inbox.item.unreadShort(unread)}</span>
                <span className="sr-only">{t.inbox.item.unread(unread)}</span>
              </span>
            ) : null}
          </span>
          <span className={styles.line}>
            <span className={styles.meta}>
              {identity.handle ? <span className={styles.handle}>{identity.handle}</span> : null}
              {who ? (
                <span className={styles.metaWho}>
                  {identity.handle ? ' · ' : ''}
                  {who}
                </span>
              ) : null}
              <span className={styles.metaRest}>
                {parts.length > 0 ? ' · ' : ''}
                {conversation.channel.name}
              </span>
            </span>
          </span>
        </span>
      </button>
    </li>
  );
});
