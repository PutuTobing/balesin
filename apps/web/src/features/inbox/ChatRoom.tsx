import {
  CHANNEL_CAPABILITIES,
  CHANNEL_TYPE_LABELS,
  type Conversation,
  type Message,
} from '@balesin/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ChevronRight } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { useLock } from '../../lib/use-lock';
import { useCan, useSession } from '../auth/session';
import { ChatActionsContext, type ChatActions } from './chat-actions';
import { ChatFooter } from './ChatFooter';
import { HandlingActions } from './HandlingActions';
import { newClientMessageId, noteSendError, useOutbox } from './outbox';
import { OutboxRows } from './OutboxRows';
import { replyWindowOpen, windowExpiry } from './inbox-time';
import styles from './Chat.module.css';
import { contactIdentity, summaryIdentity, untrustedNameLabel } from './contact-identity';
import {
  contactQuery,
  conversationQuery,
  flattenMessages,
  forgetConversation,
  goneQuery,
  inboxKeys,
  isNotFound,
  messagesQuery,
  storeConversation,
  agentsQuery,
  storeMessage,
} from './inbox-queries';
import { ContactAvatar, WindowCountdown } from './InboxBits';
import { MessageTimeline } from './MessageTimeline';
import { useMinuteClock } from './use-minute-clock';
import { useColdBlocked } from './use-reopen-blocked';

/** Jarak dari dasar riwayat yang masih dianggap "sedang di pesan terbaru". */
const NEAR_BOTTOM_PX = 96;

interface ChatRoomProps {
  conversationId: string;
  /** HP: tombol kembali ke daftar. */
  onBack?: () => void;
  /** Tombol tampil/sembunyikan panel detail (desktop/tablet). */
  detailToggle?: ReactNode;
  /** HP: kepala chat menjadi tombol pembuka detail (layar bertumpuk). */
  onOpenDetail?: () => void;
  /** HP: chat dibuka dari daftar → fokus ke judul chat. */
  focusTitle?: boolean;
  /** Chat tidak lagi boleh dilihat setelah sebuah tindakan (mis. dikembalikan ke antrian). */
  onClosed?: () => void;
  refetchInterval: number;
}

/**
 * Ruang chat BACA-SAJA (Fase 2 butir 5): kepala chat (nama, nomor, sesi 24 jam) + riwayat pesan
 * yang dimuat mundur dengan kursor saat digulir ke atas. Kirim pesan menyusul (butir 6), jadi
 * tidak ada composer. Membuka chat menandainya sudah dibaca.
 */
export function ChatRoom({
  conversationId,
  onBack,
  detailToggle,
  onOpenDetail,
  focusTitle = false,
  onClosed,
  refetchInterval,
}: ChatRoomProps) {
  const queryClient = useQueryClient();
  const forgotten = useQuery(goneQuery(conversationId)).data;
  const conversationResult = useQuery({
    ...conversationQuery(conversationId, queryClient),
    enabled: !forgotten,
    refetchInterval,
  });
  const notFound = isNotFound(conversationResult.error);
  const gone = forgotten || notFound;
  const conversation = gone ? undefined : conversationResult.data?.conversation;

  // Cakupan hilang (dialihkan/dihapus): buang data lama, jangan tetap ditampilkan.
  useEffect(() => {
    if (notFound) forgetConversation(queryClient, conversationId);
  }, [notFound, queryClient, conversationId]);

  useMarkRead(conversation);

  if (gone) {
    return (
      <ChatState onBack={onBack} detailToggle={detailToggle}>
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={t.inbox.chat.notFoundTitle}
          body={t.inbox.chat.notFoundBody}
          actions={onBack ? <Button onClick={onBack}>{t.inbox.chat.back}</Button> : undefined}
        />
      </ChatState>
    );
  }

  if (!conversation) {
    if (conversationResult.isError) {
      const error = conversationResult.error;
      return (
        <ChatState onBack={onBack} detailToggle={detailToggle}>
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={t.inbox.chat.failedTitle}
            body={isApiError(error) ? error.message : t.api.network}
            actions={
              <Button
                onClick={() => void conversationResult.refetch()}
                loading={conversationResult.isFetching}
              >
                {t.common.retry}
              </Button>
            }
          />
        </ChatState>
      );
    }
    return (
      <ChatState onBack={onBack} detailToggle={detailToggle}>
        <MessagesSkeleton />
      </ChatState>
    );
  }

  return (
    <div className={styles.room}>
      <ChatBody
        key={conversation.id}
        conversation={conversation}
        refetchInterval={refetchInterval}
        header={{ onBack, detailToggle, onOpenDetail, focusTitle }}
        onClosed={onClosed}
      />
    </div>
  );
}

/** Tandai dibaca saat chat terbuka & terlihat, dan setiap ada pesan masuk baru selama terbuka. */
function useMarkRead(conversation: Conversation | undefined) {
  const queryClient = useQueryClient();
  const marked = useRef<string | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const { mutate } = useMutation({
    mutationFn: (conversationId: string) => endpoints.inbox.markRead(conversationId),
    onSuccess: ({ conversation: updated }) => {
      storeConversation(queryClient, updated);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
    },
    // Gagal menandai dibaca tidak mengganggu membaca; dicoba lagi pada pesan berikutnya.
    onError: () => {
      marked.current = null;
    },
  });

  const id = conversation?.id;
  const unread = conversation?.unreadCount ?? 0;
  const lastMessageAt = conversation?.lastMessageAt;
  useEffect(() => {
    if (!id || unread === 0 || !visible) return;
    const key = `${id}|${lastMessageAt}`;
    if (marked.current === key) return;
    marked.current = key;
    mutate(id);
  }, [id, unread, lastMessageAt, visible, mutate]);
}

function ChatState({
  onBack,
  detailToggle,
  children,
}: {
  onBack?: () => void;
  detailToggle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.room}>
      <header className={styles.header}>
        {onBack ? <IconButton label={t.inbox.chat.back} icon={ArrowLeft} onClick={onBack} /> : null}
        <div className={styles.headerText} />
        {detailToggle}
      </header>
      <div className={styles.stateBody}>{children}</div>
    </div>
  );
}

function ChatHeader({
  conversation,
  onBack,
  detailToggle,
  onOpenDetail,
  focusTitle,
  actions,
}: HeaderProps & { conversation: Conversation; actions?: ReactNode }) {
  const now = useMinuteClock();
  const contact = useQuery(contactQuery(conversation.contact.id)).data?.contact;
  const identity = contact ? contactIdentity(contact) : summaryIdentity(conversation.contact);
  // HP: subjudul cukup nomor/@username (penanda "dari WhatsApp" ada di layar detail).
  const channelType = conversation.channel.type;
  const untrusted = untrustedNameLabel(identity, channelType);
  // Penanda "dari <channel>" sudah menyebut jenis channel: jangan tulis dua kali (K10).
  const showUntrusted = untrusted !== null && !onOpenDetail;
  const sub = [
    channelType !== 'whatsapp' && !showUntrusted ? CHANNEL_TYPE_LABELS[channelType] : null,
    identity.handle,
    showUntrusted ? untrusted : null,
  ].filter(Boolean);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle]);
  return (
    // Nama = nomor (tanpa handle terpisah): nomor tidak boleh terpotong (lihat Chat.module.css).
    <header className={styles.header} data-number-name={identity.handle === null ? '' : undefined}>
      {onBack ? <IconButton label={t.inbox.chat.back} icon={ArrowLeft} onClick={onBack} /> : null}
      <div className={styles.identity}>
        <ContactAvatar name={identity.name} size="sm" className={styles.headerAvatar} />
        <div className={styles.headerText}>
          <h2 ref={titleRef} tabIndex={-1} className={styles.name} dir="auto">
            {identity.name}
          </h2>
          {sub.length > 0 ? <p className={styles.sub}>{sub.join(' · ')}</p> : null}
        </div>
        {onOpenDetail ? (
          <Icon icon={ChevronRight} size={16} className={styles.identityChevron} />
        ) : null}
        {onOpenDetail ? (
          // Area tekan selebar identitas (≥ 44px); judul tetap heading untuk pembaca layar.
          <button
            type="button"
            className={styles.identityButton}
            aria-label={t.inbox.chat.openDetail(identity.name)}
            onClick={onOpenDetail}
          />
        ) : null}
      </div>
      <WindowCountdown
        expiresAt={windowExpiry(conversation)}
        now={now}
        showEnd
        className={styles.headerCountdown}
      />
      {actions}
      {detailToggle}
    </header>
  );
}

/**
 * Riwayat + dasar ruang chat (composer) dengan aksi pesan bersama: balas-kutip, reaksi, kirim
 * ulang. Error kirim terakhir ditampilkan sekali di atas composer (429 → hitung mundur).
 */
interface HeaderProps {
  onBack?: () => void;
  detailToggle?: ReactNode;
  onOpenDetail?: () => void;
  focusTitle?: boolean;
}

function ChatBody({
  conversation,
  refetchInterval,
  header,
  onClosed,
}: {
  conversation: Conversation;
  refetchInterval: number;
  header: HeaderProps;
  onClosed?: () => void;
}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const canReply = useCan('inbox.reply');
  const now = useMinuteClock();
  // `GET /inbox/agents` hanya untuk pemegang `inbox.assign` (Teknisi: tanpa nama agen lain).
  const canAssign = useCan('inbox.assign');
  const agents = useQuery({ ...agentsQuery, enabled: canAssign }).data?.agents;
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [error, setError] = useState<unknown>(null);
  /** Error terakhir berasal dari tindakan penanganan (judul berbeda dari gagal kirim). */
  const [handlingFailed, setHandlingFailed] = useState(false);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const lock = useLock();
  const { lockFor } = lock;

  const onError = useCallback(
    (next: unknown) => {
      setHandlingFailed(false);
      setError(next);
      if (isApiError(next) && next.status === 429) lockFor(next.retryAfterSeconds ?? 30);
      if (next) noteSendError(queryClient, conversation.id, next);
    },
    [lockFor, queryClient, conversation.id],
  );

  // Gagal kirim pesan: item outbox sudah menjelaskan + "Kirim ulang". Hanya batas (429, berlaku
  // untuk percakapan) yang tampil sekali di atas composer; 423 = banner rem darurat.
  const onSendError = useCallback(
    (next: unknown) => {
      if (isApiError(next) && next.status === 429) onError(next);
      else if (next) noteSendError(queryClient, conversation.id, next);
    },
    [onError, queryClient, conversation.id],
  );

  // Email/Telegram yang pelanggannya diam > 7 hari & tanpa `inbox.initiate`: tidak ada kotak tulis,
  // jadi "Balas" (kutip) di menu pesan juga tidak ditawarkan (audit akhir P2-R2).
  const coldBlocked =
    useColdBlocked(conversation) && !CHANNEL_CAPABILITIES[conversation.channel.type].customerWindow;
  const replyable =
    canReply &&
    conversation.status !== 'resolved' &&
    !coldBlocked &&
    replyWindowOpen(conversation, now);

  const actions = useMemo<ChatActions>(
    () => ({
      canReply: replyable,
      canQuote: CHANNEL_CAPABILITIES[conversation.channel.type].quoteReply,
      canReact: CHANNEL_CAPABILITIES[conversation.channel.type].messageTypes.includes('reaction'),
      canRetry: canReply,
      selfId: session?.user.id ?? null,
      retrying,
      agentName: (userId) => agents?.find((agent) => agent.id === userId)?.name ?? null,
      onReply: (message) => setReplyTo(message),
      onReact: (message, emoji) => {
        setError(null);
        endpoints.inbox
          .send(conversation.id, {
            type: 'reaction',
            clientMessageId: newClientMessageId(),
            targetMessageId: message.id,
            emoji,
          })
          .then(({ message: sent }) => storeMessage(queryClient, conversation.id, sent))
          .catch(onError);
      },
      onStar: (message, starred) => {
        endpoints.inbox
          .star(message.id, starred)
          .then(({ message: updated }) => {
            storeMessage(queryClient, conversation.id, updated);
            void queryClient.invalidateQueries({
              queryKey: ['inbox', 'messages-only', conversation.id],
            });
          })
          .catch(onError);
      },
      onRetry: (message) => {
        setError(null);
        setRetrying((current) => new Set(current).add(message.id));
        endpoints.inbox
          .retry(message.id)
          .then(({ message: sent }) => storeMessage(queryClient, conversation.id, sent))
          .catch(onError)
          .finally(() =>
            setRetrying((current) => {
              const next = new Set(current);
              next.delete(message.id);
              return next;
            }),
          );
      },
    }),
    [
      replyable,
      canReply,
      conversation.channel.type,
      session?.user.id,
      retrying,
      agents,
      conversation.id,
      queryClient,
      onError,
    ],
  );

  return (
    <ChatActionsContext.Provider value={actions}>
      <ChatHeader
        conversation={conversation}
        {...header}
        actions={
          <HandlingActions
            conversation={conversation}
            onClosed={onClosed}
            onError={(next) => {
              setError(next);
              setHandlingFailed(next !== null);
              if (isApiError(next) && next.status === 429) lockFor(next.retryAfterSeconds ?? 30);
            }}
          />
        }
      />
      <ChatHistory
        conversation={conversation}
        refetchInterval={refetchInterval}
        onError={onSendError}
      />
      <ChatFooter
        conversation={conversation}
        replyTo={replyable ? replyTo : null}
        onCancelReply={() => setReplyTo(null)}
        error={error}
        errorTitle={handlingFailed ? t.inbox.handling.failedTitle : undefined}
        onError={onError}
        onSendError={onSendError}
        lock={lock}
      />
    </ChatActionsContext.Provider>
  );
}

function ChatHistory({
  conversation,
  refetchInterval,
  onError,
}: {
  conversation: Conversation;
  refetchInterval: number;
  onError: (error: unknown) => void;
}) {
  const query = useInfiniteQuery({ ...messagesQuery(conversation.id), refetchInterval });
  const outbox = useOutbox(conversation.id);
  const messages = useMemo(() => flattenMessages(query.data), [query.data]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const edges = useRef<{ first: string | null; last: string | null; height: number; top: number }>({
    first: null,
    last: null,
    height: 0,
    top: 0,
  });
  const [unseen, setUnseen] = useState(false);

  // Posisi gulir: pertama kali → ke pesan terbaru; pesan lama ditambahkan di atas → posisi
  // baca tetap; pesan baru di bawah → ikut turun bila sedang di bawah, selain itu tampilkan
  // tombol "Ke pesan terbaru".
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const first = messages[0]?.id ?? null;
    const last = messages.at(-1)?.id ?? null;
    const previous = edges.current;
    if (previous.last === null) {
      box.scrollTop = box.scrollHeight;
    } else if (first !== previous.first && last === previous.last) {
      box.scrollTop = previous.top + (box.scrollHeight - previous.height);
    } else if (last !== previous.last) {
      if (atBottom.current) box.scrollTop = box.scrollHeight;
      else setUnseen(true);
    }
    edges.current = { first, last, height: box.scrollHeight, top: box.scrollTop };
  }, [messages]);

  // Pesan yang baru saja dikirim dari sini selalu terlihat.
  const outboxCount = useRef(outbox.length);
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box && outbox.length > outboxCount.current) {
      box.scrollTop = box.scrollHeight;
      setUnseen(false);
    }
    outboxCount.current = outbox.length;
  }, [outbox.length]);

  // Kiriman gagal: baris "Belum terkirim" + "Kirim ulang" dirender sesudahnya, dan pemberitahuan
  // galat di footer memperkecil riwayat — tetap menempel di dasar supaya tombolnya terlihat utuh
  // (kritikus CH2).
  const failedCount = outbox.filter((item) => item.state === 'failed').length;
  const failedSeen = useRef(failedCount);
  useEffect(() => {
    const grew = failedCount > failedSeen.current;
    failedSeen.current = failedCount;
    if (!grew) return;
    atBottom.current = true;
    const frame = requestAnimationFrame(() => {
      const box = scrollRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [failedCount]);

  // Tinggi riwayat berubah (footer bertambah/berkurang, keyboard HP, isi baru di bawah): bila
  // sedang di dasar, tetap di dasar.
  const ready = !query.isPending;
  useEffect(() => {
    const box = scrollRef.current;
    if (!ready || !box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(box);
    for (const child of Array.from(box.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [ready]);

  const onScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
    edges.current = { ...edges.current, height: box.scrollHeight, top: box.scrollTop };
    if (atBottom.current) setUnseen(false);
  };

  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = query;
  const canLoadOlder = hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
  useEffect(() => {
    const sentinel = topRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !canLoadOlder || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
      },
      { root, rootMargin: '240px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadOlder, fetchNextPage]);

  const jumpToLatest = () => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    setUnseen(false);
  };

  if (query.isPending) return <MessagesSkeleton />;

  if (query.isError && !query.data) {
    return (
      <div className={styles.stateBody}>
        <EmptyState
          compact
          title={t.inbox.chat.messagesFailedTitle}
          body={isApiError(query.error) ? query.error.message : t.api.network}
          actions={
            <Button onClick={() => void query.refetch()} loading={query.isFetching}>
              {t.common.retry}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.historyWrap}>
      <div
        ref={scrollRef}
        className={styles.history}
        onScroll={onScroll}
        role="region"
        aria-label={t.inbox.chat.history}
        // Bisa difokus supaya riwayat bisa digulir dengan keyboard.
        tabIndex={0}
      >
        <div ref={topRef} className={styles.historyTop}>
          {isFetchingNextPage ? (
            <p className={styles.historyNote} role="status">
              {t.inbox.chat.loadingOlder}
            </p>
          ) : isFetchNextPageError ? (
            <Notice
              tone="danger"
              role="alert"
              actions={<Button onClick={() => void fetchNextPage()}>{t.common.retry}</Button>}
            >
              {t.inbox.chat.olderFailed}
            </Notice>
          ) : hasNextPage ? (
            <Button variant="ghost" onClick={() => void fetchNextPage()}>
              {t.inbox.chat.loadOlder}
            </Button>
          ) : messages.length > 0 ? (
            <p className={styles.historyNote}>{t.inbox.chat.start}</p>
          ) : null}
        </div>
        {messages.length === 0 && outbox.length === 0 ? (
          <p className={styles.historyNote}>{t.inbox.chat.noMessages}</p>
        ) : (
          <MessageTimeline messages={messages} />
        )}
        <OutboxRows items={outbox} onError={onError} />
      </div>
      {unseen ? (
        <button type="button" className={styles.jump} onClick={jumpToLatest}>
          <Icon icon={ArrowDown} size={16} />
          {t.inbox.chat.newMessages}
        </button>
      ) : null}
    </div>
  );
}

/** Kerangka riwayat pesan: gelembung bergantian kiri/kanan. */
function MessagesSkeleton() {
  const widths = ['w60', 'w40', 'w72', 'w48', 'w56'] as const;
  return (
    <SkeletonRegion className={styles.skeleton}>
      {widths.map((width, index) => (
        <div key={width} className={styles.skeletonRow} data-dir={index % 2 ? 'out' : 'in'}>
          <Skeleton className={`${styles.skeletonBubble} ${styles[width]}`} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
