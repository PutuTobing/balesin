import type { Message } from '@balesin/shared';
import { Bot, Forward, Info, Megaphone, Reply } from 'lucide-react';
import { Fragment, memo } from 'react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import styles from './Chat.module.css';
import { DeliveryIcon } from './ConversationItem';
import { dayKey, formatClockTime, formatDayLabel } from './inbox-time';
import { linkHost, messageBody } from './message-content';
import { buildTimeline } from './timeline';

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
  reaction: string | undefined;
  byId: Map<string, Message>;
}) {
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

  return (
    <li className={styles.row} data-dir={outbound ? 'out' : 'in'}>
      <div className={styles.bubbleWrap}>
        <div className={styles.bubble}>
          <span className="sr-only">{c.senders[message.senderKind]}: </span>
          {senderLabel ? (
            <p className={styles.sender}>
              <Icon icon={message.senderKind === 'bot' ? Bot : Megaphone} size={16} />
              {senderLabel}
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
          {body.label ? (
            <p className={styles.attachment}>
              {body.icon ? <Icon icon={body.icon} size={16} /> : null}
              <span dir="auto">{body.label}</span>
            </p>
          ) : null}
          {body.detail ? (
            <p className={styles.detail} dir="auto">
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
          {outbound && message.status === 'failed' ? (
            <p className={styles.failed}>
              {message.errorCode !== null
                ? c.failedCode(message.errorCode)
                : c.deliveryStatus.failed}
            </p>
          ) : null}
        </div>
        {reaction ? (
          <span className={styles.reaction}>
            <span aria-hidden="true">{reaction}</span>
            <span className="sr-only">{c.reaction(reaction)}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
}

function quoteText(message: Message): string {
  const body = messageBody(message);
  return body.text ?? body.label ?? c.replyTo;
}
