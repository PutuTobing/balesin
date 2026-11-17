import { Link } from '@tanstack/react-router';
import type { Conversation, Message } from '@balesin/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import type { ReactNode } from 'react';
import { endpoints } from '../../lib/api/endpoints';
import { formatClock } from '../../lib/format';
import type { Lock } from '../../lib/use-lock';
import { useCan, useSession } from '../auth/session';
import { Composer } from './Composer';
import styles from './Composer.module.css';
import { forgetConversation, inboxKeys, storeConversation } from './inbox-queries';
import { useSendingPaused } from './use-sending-paused';
import { windowState } from './inbox-time';
import { useMinuteClock } from './use-minute-clock';

const k = t.inbox.compose;
const PAUSED_NOTICE_ID = 'rem-darurat-ditarik';

interface ChatFooterProps {
  conversation: Conversation;
  replyTo: Message | null;
  onCancelReply: () => void;
  error: unknown;
  /** Judul kotak error (bawaan: gagal kirim). */
  errorTitle?: string;
  onError: (error: unknown) => void;
  onSendError: (error: unknown) => void;
  lock: Lock;
}

/**
 * Dasar ruang chat: rem darurat, error kirim terbaru (pola `FormErrorNotice`, 429 dengan hitung
 * mundur), bilah "Ambil chat", lalu composer — atau penjelasan bila tidak bisa membalas (jendela 24
 * jam habis, chat selesai, tanpa izin).
 */
export function ChatFooter({
  conversation,
  replyTo,
  onCancelReply,
  error,
  errorTitle,
  onError,
  onSendError,
  lock,
}: ChatFooterProps) {
  const canReply = useCan('inbox.reply');
  const canAssign = useCan('inbox.assign');
  const now = useMinuteClock();
  const { paused, reason } = useSendingPaused();
  const selfId = useSession()?.user.id ?? null;
  const isHp = useMediaQuery(media.hp);
  const canManageLimits = useCan('sending.limits.manage');
  const window = windowState(conversation.windowExpiresAt, now);
  const windowOpen = window.kind === 'open' || window.kind === 'expiring';

  const notices = (
    <>
      {paused ? (
        <Notice
          id={PAUSED_NOTICE_ID}
          tone="warning"
          role="status"
          title={k.pausedTitle}
          actions={
            canManageLimits ? (
              <Link to="/pengaturan/batas-kirim" className={styles.noticeLink}>
                {k.pausedManage}
              </Link>
            ) : undefined
          }
        >
          {k.pausedBody}
          {reason ? ` ${k.pausedReason(reason)}` : null}
        </Notice>
      ) : null}
      {error ? (
        <FormErrorNotice
          error={error}
          lock={lock}
          lockedTitle={k.limitedTitle}
          failedTitle={errorTitle ?? k.failedTitle}
          actions={
            lock.locked ? null : (
              <Button variant="ghost" onClick={() => onError(null)}>
                {t.common.close}
              </Button>
            )
          }
        />
      ) : null}
    </>
  );
  const hasNotices = paused || Boolean(error);

  if (!canReply) {
    return <FooterNote>{k.readOnly}</FooterNote>;
  }
  if (conversation.status === 'resolved') {
    return (
      <FooterNote
        action={isHp ? <ReopenButton conversation={conversation} onError={onError} /> : null}
      >
        {k.resolved}
      </FooterNote>
    );
  }
  if (!windowOpen) {
    const none = window.kind === 'none';
    return (
      <>
        {hasNotices ? <div className={styles.notices}>{notices}</div> : null}
        <div className={styles.closed} role="status">
          <div className={styles.closedText}>
            <p className={styles.closedTitle}>{none ? k.windowNoneTitle : k.windowClosedTitle}</p>
            <p className={styles.closedBody}>{none ? k.windowNoneBody : k.windowClosedBody}</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {hasNotices ? <div className={styles.notices}>{notices}</div> : null}
      {canAssign &&
      (conversation.status === 'unserved' ||
        conversation.status === 'bot' ||
        (conversation.assignee !== null && conversation.assignee.id !== selfId)) ? (
        <ClaimBar conversation={conversation} selfId={selfId} onError={onError} />
      ) : null}
      <Composer
        conversation={conversation}
        replyTo={replyTo}
        onCancelReply={onCancelReply}
        onError={onError}
        onSendError={onSendError}
        locked={lock.locked}
        lockLabel={lock.locked ? formatClock(lock.secondsLeft) : null}
        pausedNoticeId={paused ? PAUSED_NOTICE_ID : undefined}
      />
    </>
  );
}

function FooterNote({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className={styles.closed}>
      <p className={styles.closedBody} role="status">
        {children}
      </p>
      {action}
    </div>
  );
}

/** HP: "Buka lagi" juga di dasar layar chat selesai (desktop: tombol di kepala chat). */
function ReopenButton({
  conversation,
  onError,
}: {
  conversation: Conversation;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const reopen = useMutation({
    mutationFn: () => endpoints.inbox.reopen(conversation.id),
    onMutate: () => onError(null),
    onSuccess: ({ conversation: updated }) => {
      if (updated) storeConversation(queryClient, updated);
      else forgetConversation(queryClient, conversation.id);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
    },
    onError,
  });
  return (
    <Button variant="secondary" loading={reopen.isPending} onClick={() => reopen.mutate()}>
      {reopen.isPending ? t.inbox.handling.working : t.inbox.handling.reopen}
    </Button>
  );
}

/**
 * Bilah penanganan di atas composer: "Ambil chat" (antrian terbuka), "Ambil alih" (dari bot, atau
 * chat yang sedang ditangani agen lain — supaya dua orang tidak membalas tanpa sadar). Tombol
 * sekunder: "Kirim" tetap satu-satunya tombol utama di dasar layar.
 */
function ClaimBar({
  conversation,
  selfId,
  onError,
}: {
  conversation: Conversation;
  selfId: string | null;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const other =
    conversation.assignee !== null && conversation.assignee.id !== selfId
      ? conversation.assignee
      : null;
  const bot = conversation.status === 'bot';
  const claim = useMutation({
    mutationFn: () =>
      other && selfId
        ? endpoints.inbox.assign(conversation.id, selfId)
        : endpoints.inbox.claim(conversation.id),
    onMutate: () => onError(null),
    onSuccess: ({ conversation: updated }) => {
      if (updated) storeConversation(queryClient, updated);
      else forgetConversation(queryClient, conversation.id);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
    },
    onError: (error) => {
      onError(error);
      // Sudah diambil orang lain (409): tampilkan keadaan terbaru.
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversation.id) });
    },
  });
  return (
    <div className={styles.handling}>
      <span className={styles.handlingLong}>
        {other ? k.handledBy(other.name) : bot ? k.withBot : k.unassigned}
      </span>
      {/* Ringkas saat kotak tulis terfokus (keyboard HP terbuka): satu baris saja. */}
      <span className={styles.handlingShort} aria-hidden="true">
        {other ? k.handledBy(other.name) : bot ? k.withBotShort : k.unassignedShort}
      </span>
      <Button variant="secondary" loading={claim.isPending} onClick={() => claim.mutate()}>
        {claim.isPending ? k.claiming : other || bot ? k.takeOver : k.claim}
      </Button>
    </div>
  );
}
