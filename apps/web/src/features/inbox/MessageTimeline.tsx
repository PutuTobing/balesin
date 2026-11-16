import type { Message } from '@balesin/shared';
import {
  Bot,
  CircleAlert,
  Forward,
  Info,
  Megaphone,
  MoreHorizontal,
  Reply,
  RotateCcw,
  User,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Fragment, memo, useState, type MouseEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { QUICK_REACTIONS, useChatActions } from './chat-actions';
import { t } from '../../i18n/id';
import styles from './Chat.module.css';
import { DeliveryIcon } from './ConversationItem';
import { dayKey, formatClockTime, formatDayLabel } from './inbox-time';
import { linkHost, messageBody } from './message-content';
import { MessageMedia } from './MessageMedia';
import { buildTimeline, isActionable, type MessageReactions } from './timeline';

const c = t.inbox.chat;

/** Riwayat pesan lama → baru, dikelompokkan per hari. */
export const MessageTimeline = memo(function MessageTimeline({
  messages,
}: {
  messages: Message[];
}) {
  const { rows, reactions, byId } = buildTimeline(messages);
  const now = new Date();
  return (
    <ol className={styles.timeline}>
      {rows.map((message, index) => {
        const previous = rows[index - 1];
        const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
        return (
          <Fragment key={message.id}>
            {newDay ? (
              <li className={styles.day}>
                <span>{formatDayLabel(message.createdAt, now)}</span>
              </li>
            ) : null}
            <MessageRow message={message} reaction={reactions.get(message.id)} byId={byId} />
          </Fragment>
        );
      })}
    </ol>
  );
});

function MessageRow({
  message,
  reaction,
  byId,
}: {
  message: Message;
  reaction: MessageReactions | undefined;
  byId: Map<string, Message>;
}) {
  const actions = useChatActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const time = formatClockTime(message.createdAt);

  if (message.type === 'system') {
    const body = messageBody(message);
    return (
      <li className={styles.system}>
        <Icon icon={Info} size={16} />
        <span dir="auto">{body.text ?? body.label}</span>
        <time dateTime={message.createdAt} className={styles.systemTime}>
          {time}
        </time>
      </li>
    );
  }

  if (message.type === 'reaction') {
    // Reaksi ke pesan yang belum/tidak dimuat.
    return (
      <li className={styles.row} data-dir={message.direction === 'outbound' ? 'out' : 'in'}>
        <p className={styles.reactionLine}>
          <span className="sr-only">{c.senders[message.senderKind]}: </span>
          {c.reactionToOlder(message.reaction?.emoji ?? '')}
          <time dateTime={message.createdAt} className={styles.systemTime}>
            {time}
          </time>
        </p>
      </li>
    );
  }

  const outbound = message.direction === 'outbound';
  const body = messageBody(message);
  const senderLabel =
    message.senderKind === 'bot'
      ? c.senders.bot
      : message.senderKind === 'broadcast'
        ? c.senders.broadcast
        : null;
  const quoted = message.replyTo?.messageId ? byId.get(message.replyTo.messageId) : undefined;
  const host = linkHost(message.referral?.sourceUrl);
  const agent =
    outbound && message.senderKind === 'agent'
      ? message.senderUserId && message.senderUserId === actions.selfId
        ? t.inbox.actions.you
        : (message.senderName ?? actions.agentName(message.senderUserId))
      : null;
  const actionable = actions.canReply && isActionable(message);
  const media = message.mediaAvailable ? <MessageMedia message={message} /> : null;
  const visualMedia =
    media !== null &&
    (message.media?.kind === 'image' ||
      message.media?.kind === 'sticker' ||
      message.media?.kind === 'video');
  /** Layar sentuh: ketuk gelembung membuka menu aksi (tanpa tombol "⋯" di setiap gelembung). */
  const openFromBubble = (event: MouseEvent<HTMLDivElement>) => {
    if (!actionable || !window.matchMedia('(hover: none)').matches) return;
    if ((event.target as Element).closest('button, a, audio, video, input')) return;
    setMenuOpen(true);
  };

  return (
    <li className={styles.row} data-dir={outbound ? 'out' : 'in'}>
      <div className={styles.bubbleLine}>
        <div className={styles.bubbleWrap}>
          <div
            className={styles.bubble}
            data-media={visualMedia ? '' : undefined}
            data-actionable={actionable ? '' : undefined}
            onClick={openFromBubble}
          >
            <span className="sr-only">{agent ?? c.senders[message.senderKind]}: </span>
            {senderLabel ? (
              <p className={styles.sender}>
                <Icon icon={message.senderKind === 'bot' ? Bot : Megaphone} size={16} />
                {senderLabel}
              </p>
            ) : agent ? (
              <p className={styles.sender} aria-hidden="true">
                <Icon icon={User} size={16} />
                {agent}
              </p>
            ) : null}
            {message.forwarded ? (
              <p className={styles.tag}>
                <Icon icon={Forward} size={16} />
                {c.forwarded}
              </p>
            ) : null}
            {message.replyTo ? (
              <div className={styles.quote}>
                <Icon icon={Reply} size={16} />
                <span className={styles.quoteText} dir="auto">
                  {quoted ? quoteText(quoted) : c.replyToUnknown}
                </span>
              </div>
            ) : null}
            {message.referral ? (
              <div className={styles.referral}>
                <p className={styles.tag}>{c.referral}</p>
                {message.referral.headline ? (
                  <p className={styles.referralTitle} dir="auto">
                    {message.referral.headline}
                  </p>
                ) : null}
                {message.referral.body ? (
                  <p className={styles.referralBody} dir="auto">
                    {message.referral.body}
                  </p>
                ) : null}
                {message.referral.sourceUrl ? (
                  // Tautan iklan TIDAK tepercaya: teks biasa (bukan tautan), host ditonjolkan.
                  <p className={styles.referralUrl}>
                    {host ? <strong>{c.referralLink(host)}</strong> : null}
                    <span className={styles.url}>{message.referral.sourceUrl}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
            {media}
            {/* Media tampil (termasuk kartu dokumen): label jenis tidak diulang. */}
            {body.label && !media ? (
              <p className={styles.attachment}>
                {body.icon ? <Icon icon={body.icon} size={16} /> : null}
                <span dir="auto">{body.label}</span>
              </p>
            ) : null}
            {body.detail ? (
              <p
                className={styles.detail}
                dir="auto"
                title={message.type === 'unsupported' ? (message.rawType ?? undefined) : undefined}
              >
                {body.detail}
              </p>
            ) : null}
            {body.text ? (
              <p className={styles.text} dir="auto">
                {body.text}
              </p>
            ) : null}
            <p className={styles.meta}>
              <time dateTime={message.createdAt}>{time}</time>
              {outbound && message.status ? (
                <DeliveryIcon status={message.status} className={styles.status} />
              ) : null}
            </p>
          </div>
          {reaction?.in || reaction?.out ? (
            <span className={styles.reactions}>
              {reaction.in ? (
                <span className={styles.reaction}>
                  <span aria-hidden="true">{reaction.in}</span>
                  <span className="sr-only">
                    {c.reaction(reaction.in)} ({t.inbox.actions.customer})
                  </span>
                </span>
              ) : null}
              {reaction.out ? (
                <span className={styles.reaction} data-own="">
                  <span aria-hidden="true">{reaction.out}</span>
                  <span className="sr-only">
                    {c.reaction(reaction.out)} ({t.inbox.actions.you})
                  </span>
                </span>
              ) : null}
            </span>
          ) : null}
          {outbound && message.status === 'failed' ? (
            // Di bawah gelembung (di atas --bg): kontras cukup di kedua tema, dan kalimat penyebab +
            // solusi dari server tidak melebarkan gelembung.
            <div className={styles.failedBlock}>
              <p className={styles.failed}>
                <Icon icon={CircleAlert} size={16} />
                <span>{failureText(message)}</span>
              </p>
              {message.failure?.retryable && actions.canRetry ? (
                <Button
                  size="md"
                  variant="ghost"
                  className={styles.retry}
                  loading={actions.retrying.has(message.id)}
                  onClick={() => actions.onRetry(message)}
                >
                  {actions.retrying.has(message.id) ? null : <Icon icon={RotateCcw} size={16} />}
                  {actions.retrying.has(message.id)
                    ? t.inbox.compose.sending
                    : t.inbox.compose.resend}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {actionable ? (
          <MessageMenu
            message={message}
            ownReaction={reaction?.out}
            time={time}
            open={menuOpen}
            onOpenChange={setMenuOpen}
          />
        ) : null}
      </div>
    </li>
  );
}

/** Menu aksi pesan: reaksi cepat dan balas-kutip. */
function MessageMenu({
  message,
  ownReaction,
  time,
  open,
  onOpenChange,
}: {
  message: Message;
  ownReaction?: string;
  time: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = useChatActions();
  const a = t.inbox.actions;
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={styles.messageMenuButton}
          aria-label={time ? a.openAt(time) : a.open}
        >
          <Icon icon={MoreHorizontal} size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles.messageMenu}
          side="top"
          align={message.direction === 'outbound' ? 'end' : 'start'}
          sideOffset={4}
          collisionPadding={8}
        >
          <DropdownMenu.Group className={styles.reactionRow} aria-label={a.react}>
            {QUICK_REACTIONS.map((emoji) => (
              <DropdownMenu.Item
                key={emoji}
                className={styles.reactionItem}
                data-active={ownReaction === emoji ? '' : undefined}
                aria-label={a.reactWith(emoji)}
                onSelect={() => actions.onReact(message, emoji)}
              >
                {emoji}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
          <DropdownMenu.Separator className={styles.menuSeparator} />
          <DropdownMenu.Item className={styles.menuItem} onSelect={() => actions.onReply(message)}>
            <Icon icon={Reply} size={16} />
            {a.reply}
          </DropdownMenu.Item>
          {ownReaction ? (
            <DropdownMenu.Item
              className={styles.menuItem}
              onSelect={() => actions.onReact(message, '')}
            >
              <span className={styles.menuEmoji} aria-hidden="true">
                {ownReaction}
              </span>
              {a.removeReaction}
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Penyebab + solusi dari server (`failure.message`); kode Meta hanya cadangan. */
function failureText(message: Message): string {
  if (message.failure?.message) return message.failure.message;
  return message.errorCode !== null ? c.failedCode(message.errorCode) : c.deliveryStatus.failed;
}

function quoteText(message: Message): string {
  const body = messageBody(message);
  return body.text ?? body.label ?? c.replyTo;
}
