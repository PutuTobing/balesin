import type { Conversation, Message } from '@balesin/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { formatClock } from '../../lib/format';
import type { Lock } from '../../lib/use-lock';
import { useCan } from '../auth/session';
import { Composer } from './Composer';
import styles from './Composer.module.css';
import { forgetConversation, inboxKeys, storeConversation } from './inbox-queries';
import { useSendingPaused } from './use-sending-paused';
import { windowState } from './inbox-time';
import { useMinuteClock } from './use-minute-clock';

const k = t.inbox.compose;

interface ChatFooterProps {
  conversation: Conversation;
  replyTo: Message | null;
  onCancelReply: () => void;
  error: unknown;
  onError: (error: unknown) => void;
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
  onError,
  lock,
}: ChatFooterProps) {
  const canReply = useCan('inbox.reply');
  const canAssign = useCan('inbox.assign');
  const now = useMinuteClock();
  const { paused, reason } = useSendingPaused();
  const window = windowState(conversation.windowExpiresAt, now);
  const windowOpen = window.kind === 'open' || window.kind === 'expiring';

  const notices = (
    <>
      {paused ? (
        <Notice tone="warning" role="status" title={k.pausedTitle}>
          {k.pausedBody}
          {reason ? ` ${k.pausedReason(reason)}` : null}
        </Notice>
      ) : null}
      {error ? (
        <FormErrorNotice
          error={error}
          lock={lock}
          lockedTitle={k.limitedTitle}
          failedTitle={k.failedTitle}
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
    return <FooterNote>{k.resolved}</FooterNote>;
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
          <div className={styles.closedAction}>
            <Button disabled aria-describedby="kirim-template-alasan">
              <Icon icon={MessageSquareText} size={16} />
              {k.sendTemplate}
            </Button>
            <p id="kirim-template-alasan" className={styles.closedHint}>
              {k.templateSoon}
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {hasNotices ? <div className={styles.notices}>{notices}</div> : null}
      {canAssign && (conversation.status === 'unserved' || conversation.status === 'bot') ? (
        <ClaimBar conversation={conversation} onError={onError} />
      ) : null}
      <Composer
        conversation={conversation}
        replyTo={replyTo}
        onCancelReply={onCancelReply}
        onError={onError}
        locked={lock.locked}
        lockLabel={lock.locked ? formatClock(lock.secondsLeft) : null}
      />
    </>
  );
}

function FooterNote({ children }: { children: string }) {
  return (
    <div className={styles.closed} role="status">
      <p className={styles.closedBody}>{children}</p>
    </div>
  );
}

/** "Ambil chat" (antrian terbuka) / "Ambil alih" (dari bot) — klaim atomik di server. */
function ClaimBar({
  conversation,
  onError,
}: {
  conversation: Conversation;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const bot = conversation.status === 'bot';
  const claim = useMutation({
    mutationFn: () => endpoints.inbox.claim(conversation.id),
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
      <span>{bot ? k.withBot : k.unassigned}</span>
      <Button variant="primary" loading={claim.isPending} onClick={() => claim.mutate()}>
        {claim.isPending ? k.claiming : bot ? k.takeOver : k.claim}
      </Button>
    </div>
  );
}
