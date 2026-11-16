import type { Conversation } from '@balesin/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import styles from './Chat.module.css';
import { contactIdentity, summaryIdentity } from './contact-identity';
import {
  contactQuery,
  conversationQuery,
  flattenMessages,
  forgetConversation,
  inboxKeys,
  isNotFound,
  messagesQuery,
  storeConversation,
} from './inbox-queries';
import { ContactAvatar, WindowCountdown } from './InboxBits';
import { MessageTimeline } from './MessageTimeline';
import { useMinuteClock } from './use-minute-clock';

/** Jarak dari dasar riwayat yang masih dianggap "sedang di pesan terbaru". */
const NEAR_BOTTOM_PX = 96;

interface ChatRoomProps {
  conversationId: string;
  /** HP: tombol kembali ke daftar. */
  onBack?: () => void;
  /** Tombol tampil/sembunyikan panel detail (desktop/tablet). */
  detailToggle?: ReactNode;
  refetchInterval: number;
}

/**
 * Ruang chat BACA-SAJA (Fase 2 butir 5): kepala chat (nama, nomor, sesi 24 jam) + riwayat pesan
 * yang dimuat mundur dengan kursor saat digulir ke atas. Kirim pesan menyusul (butir 6), jadi
 * tidak ada composer. Membuka chat menandainya sudah dibaca.
 */
export function ChatRoom({ conversationId, onBack, detailToggle, refetchInterval }: ChatRoomProps) {
  const queryClient = useQueryClient();
  const conversationResult = useQuery({
    ...conversationQuery(conversationId, queryClient),
    refetchInterval,
  });
  const gone = isNotFound(conversationResult.error);
  const conversation = gone ? undefined : conversationResult.data?.conversation;

  // Cakupan hilang (dialihkan/dihapus): buang data lama, jangan tetap ditampilkan.
  useEffect(() => {
    if (gone) forgetConversation(queryClient, conversationId);
  }, [gone, queryClient, conversationId]);

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
      <ChatHeader conversation={conversation} onBack={onBack} detailToggle={detailToggle} />
      <ChatHistory
        key={conversation.id}
        conversation={conversation}
        refetchInterval={refetchInterval}
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
}: {
  conversation: Conversation;
  onBack?: () => void;
  detailToggle?: ReactNode;
}) {
  const now = useMinuteClock();
  const contact = useQuery(contactQuery(conversation.contact.id)).data?.contact;
  const identity = contact ? contactIdentity(contact) : summaryIdentity(conversation.contact);
  const sub = [identity.handle, identity.fromWhatsApp ? t.inbox.item.fromWhatsApp : null].filter(
    Boolean,
  );
  return (
    <header className={styles.header}>
      {onBack ? <IconButton label={t.inbox.chat.back} icon={ArrowLeft} onClick={onBack} /> : null}
      <ContactAvatar name={identity.name} size="sm" />
      <div className={styles.headerText}>
        <h2 className={styles.name} dir="auto">
          {identity.name}
        </h2>
        {sub.length > 0 ? <p className={styles.sub}>{sub.join(' · ')}</p> : null}
      </div>
      <WindowCountdown expiresAt={conversation.windowExpiresAt} now={now} showEnd />
      {detailToggle}
    </header>
  );
}

function ChatHistory({
  conversation,
  refetchInterval,
}: {
  conversation: Conversation;
  refetchInterval: number;
}) {
  const query = useInfiniteQuery({ ...messagesQuery(conversation.id), refetchInterval });
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
        {messages.length === 0 ? (
          <p className={styles.historyNote}>{t.inbox.chat.noMessages}</p>
        ) : (
          <MessageTimeline messages={messages} />
        )}
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
