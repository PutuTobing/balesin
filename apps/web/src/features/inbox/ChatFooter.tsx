import { Link } from '@tanstack/react-router';
import { CHANNEL_CAPABILITIES, type Conversation, type Message } from '@balesin/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import { useState, type ReactNode } from 'react';
import { endpoints } from '../../lib/api/endpoints';
import { formatClock } from '../../lib/format';
import type { Lock } from '../../lib/use-lock';
import { useCan, useSession } from '../auth/session';
import { Composer } from './Composer';
import { TemplateSendDialog } from './TemplateSendDialog';
import styles from './Composer.module.css';
import { forgetConversation, inboxKeys, storeConversation } from './inbox-queries';
import { useSendingPaused } from './use-sending-paused';
import { replyWindowOpen, windowExpiry, windowState } from './inbox-time';
import { useMinuteClock } from './use-minute-clock';
import {
  COLD_NOTE_ID,
  RESOLVED_NOTE_ID,
  useColdBlocked,
  useReopenBlocked,
} from './use-reopen-blocked';

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
  const canInitiate = useCan('inbox.initiate');
  const reopenBlocked = useReopenBlocked(conversation);
  const coldBlocked = useColdBlocked(conversation);
  const now = useMinuteClock();
  const { paused, reason } = useSendingPaused();
  const selfId = useSession()?.user.id ?? null;
  const isHp = useMediaQuery(media.hp);
  const canManageLimits = useCan('sending.limits.manage');
  const window = windowState(windowExpiry(conversation), now);
  const [templateOpen, setTemplateOpen] = useState(false);
  const windowOpen = replyWindowOpen(conversation, now);
  // Template Meta hanya untuk WhatsApp; Messenger/Instagram menunggu pesan pelanggan berikutnya.
  const templates = CHANNEL_CAPABILITIES[conversation.channel.type].templates;

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
    // Chat selesai: tanpa composer & tanpa pemilih template. Mengirim pesan baru ke chat selesai =
    // memulai percakapan (izin `inbox.initiate`, audit akhir A1/A6) — yang tidak punya izin itu
    // diberi tahu jalurnya. Error kirim yang baru terjadi (mis. 403/429 dari server saat chat
    // diselesaikan orang lain) tetap tampil apa adanya.
    return (
      <>
        {hasNotices ? <div className={styles.notices}>{notices}</div> : null}
        <FooterNote
          id={RESOLVED_NOTE_ID}
          action={
            isHp ? (
              <ReopenButton conversation={conversation} onError={onError} blocked={reopenBlocked} />
            ) : null
          }
        >
          {canInitiate ? k.resolved : reopenBlocked ? k.resolvedStale : k.resolvedNoInitiate}
        </FooterNote>
      </>
    );
  }
  if (!windowOpen) {
    // Di luar sesi 24 jam hanya template Meta yang disetujui yang bisa dikirim: composer diganti
    // penjelasan + satu aksi nyata "Kirim template".
    const none = window.kind === 'none';
    return (
      <>
        {hasNotices ? <div className={styles.notices}>{notices}</div> : null}
        <div className={styles.closed}>
          <div className={styles.closedText} role="status">
            <p className={styles.closedTitle}>{none ? k.windowNoneTitle : k.windowClosedTitle}</p>
            <p className={styles.closedBody} id={coldBlocked ? COLD_NOTE_ID : undefined}>
              {!templates
                ? k.windowClosedNoTemplateBody
                : coldBlocked
                  ? // Pelanggan diam > 7 hari & tanpa `inbox.initiate`: template = mulai percakapan.
                    k.coldNoInitiate
                  : none
                    ? k.windowNoneBody
                    : k.windowClosedBody}
            </p>
          </div>
          {templates ? (
            <Button
              variant="primary"
              disabled={paused || lock.locked || coldBlocked}
              aria-describedby={
                [paused ? PAUSED_NOTICE_ID : null, coldBlocked ? COLD_NOTE_ID : null]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              onClick={() => setTemplateOpen(true)}
            >
              <Icon icon={LayoutTemplate} size={16} />
              {k.sendTemplate}
            </Button>
          ) : null}
        </div>
        {templateOpen ? (
          <TemplateSendDialog conversation={conversation} onClose={() => setTemplateOpen(false)} />
        ) : null}
      </>
    );
  }

  if (coldBlocked && !CHANNEL_CAPABILITIES[conversation.channel.type].customerWindow) {
    // Email/Telegram (tanpa jendela 24 jam) yang pelanggannya diam > 7 hari: pesan apa pun = mulai
    // percakapan (audit akhir P2-R2). Tanpa `inbox.initiate` kotak tulis diganti penjelasan.
    return (
      <>
        {hasNotices ? <div className={styles.notices}>{notices}</div> : null}
        <FooterNote id={COLD_NOTE_ID}>{k.coldNoInitiate}</FooterNote>
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

function FooterNote({
  children,
  action,
  id,
}: {
  children: string;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className={styles.closed}>
      <p id={id} className={styles.closedBody} role="status">
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
  blocked,
}: {
  conversation: Conversation;
  onError: (error: unknown) => void;
  /** Tanpa izin memulai percakapan & pelanggan diam ≥ 24 jam: nonaktif, alasannya di catatan. */
  blocked: boolean;
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
    <Button
      variant="secondary"
      loading={reopen.isPending}
      disabled={blocked}
      aria-describedby={blocked ? RESOLVED_NOTE_ID : undefined}
      onClick={() => reopen.mutate()}
    >
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
