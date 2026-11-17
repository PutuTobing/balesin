import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, PanelRightClose, PanelRightOpen, SquarePen } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useBrand } from '../../brand/brand';
import { ChatIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/IconButton';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import { usePageTitle } from '../../lib/use-page-title';
import { useCan, useSession } from '../auth/session';
import { ChatRoom } from './ChatRoom';
import { ContactPanel } from './ContactPanel';
import { ConversationList } from './ConversationList';
import styles from './Inbox.module.css';
import {
  TAB_STATUS,
  filterChips,
  hasFilters,
  type AgentOption,
  searchTerm,
  type ConversationParams,
  type InboxFilters,
} from './inbox-filters';
import {
  agentsQuery,
  countsQuery,
  inboxChannelsQuery,
  inboxKeys,
  reviveConversation,
  tagsQuery,
} from './inbox-queries';
import type { InboxTab } from './inbox-search';
import { InboxFilterMenu } from './InboxFilterMenu';
import { NewConversationDialog } from './NewConversationDialog';
import { useDetailPanel } from './use-detail-panel';
import { fallbackRefetchInterval } from './use-inbox-stream';
import type { StreamStatus } from './inbox-stream';

const DETAIL_PANEL_ID = 'inbox-detail';
/** Elemen yang memakai Escape untuk dirinya sendiri; panel detail tidak ikut tertutup. */
const ESCAPE_OWNERS = '[role="menu"], [role="dialog"], input, textarea, [contenteditable="true"]';
/** Jeda ketikan sebelum pencarian dikirim ke server. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface InboxScreenProps {
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  /** Percakapan yang sedang dibuka (`?chat=`). */
  chatId?: string | null;
  onOpenChat?: (conversationId: string, options?: { push?: boolean }) => void;
  onCloseChat?: () => void;
  /**
   * Daftar chat sedang menunggu rute siap. Hanya ISI daftar yang berganti jadi kerangka;
   * judul, kolom cari, tab, ruang chat, dan panel detail tetap sama dan tidak ada yang
   * melompat saat data tiba. Selama kerangka tidak ada permintaan data.
   */
  loading?: boolean;
  /** Status sambungan real-time (menentukan penyegaran cadangan lewat REST). */
  streamStatus?: StreamStatus;
  /** HP: panel detail sebagai layar bertumpuk di atas chat (`&detail=1`). */
  hpDetailOpen?: boolean;
  onOpenHpDetail?: () => void;
  onCloseHpDetail?: () => void;
}

/**
 * Tampilan Inbox (DESIGN.md §2). Desktop: daftar 360px · ruang chat · panel detail 340px
 * yang bisa disembunyikan. Tablet: daftar + ruang chat, detail melayang. HP: daftar saja;
 * ruang chat menjadi layar bertumpuk (navigasi bawah disembunyikan) saat chat dibuka.
 */
export function InboxScreen({
  tab,
  onTabChange,
  chatId = null,
  onOpenChat,
  onCloseChat,
  loading: routeLoading = false,
  streamStatus = 'connecting',
  hpDetailOpen = false,
  onOpenHpDetail,
  onCloseHpDetail,
}: InboxScreenProps) {
  usePageTitle(t.inbox.title);
  const { mascotName } = useBrand();
  const isHp = useMediaQuery(media.hp);
  const queryClient = useQueryClient();
  const session = useSession();
  // Sesi baru saja berakhir (keluar / dicabut): jangan memuat apa pun lagi — permintaan baru hanya
  // akan ditolak 401 sementara aplikasi sedang pindah ke halaman masuk.
  const loading = routeLoading || session === null;
  const canManageChannels = useCan('channels.manage');
  const detail = useDetailPanel();
  const { open: detailOpen, overlay: detailOverlay, setOpen: setDetailPanelOpen } = detail;
  const refetchInterval = fallbackRefetchInterval(streamStatus);

  // ── Cari & saring ──
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  // Mengosongkan kolom langsung berlaku (tanpa menunggu jeda).
  const onSearchChange = (value: string) => {
    setSearch(value);
    if (value.trim() === '') setDebounced('');
  };
  const term = searchTerm(debounced);
  const typed = searchTerm(search);
  const [filters, setFilters] = useState<InboxFilters>({});

  const params: ConversationParams = {
    status: TAB_STATUS[tab],
    ...filters,
    q: term.query ?? undefined,
  };
  const counts = useQuery({
    ...countsQuery({ ...filters, q: term.query ?? undefined }),
    enabled: !loading,
    refetchInterval,
  }).data;
  const channels = useQuery({ ...inboxChannelsQuery, enabled: !loading }).data?.channels ?? [];
  // Daftar agen (`GET /inbox/agents`, izin `inbox.assign` di server): Owner/Admin/Supervisor/CS.
  const canAssign = useCan('inbox.assign');
  const canInitiate = useCan('inbox.initiate');
  const [startOpen, setStartOpen] = useState(false);
  const agentList = useQuery({ ...agentsQuery, enabled: !loading && canAssign }).data?.agents;
  const isTechnician = session?.user.role === 'teknisi';
  const agents = useMemo<AgentOption[] | null>(() => {
    if (isTechnician) return null;
    // Yang nonaktif tetap ada (saringan percakapan lama); diri sendiri = "Ditangani saya".
    return (agentList ?? [])
      .filter((agent) => agent.id !== session?.user.id)
      .map((agent) => ({ id: agent.id, name: agent.name }));
  }, [isTechnician, agentList, session?.user.id]);
  const tags = useQuery({ ...tagsQuery, enabled: !loading }).data?.tags;
  const filterOptions = { channels, agents, tags };
  const chips = filterChips(filters, filterOptions, session?.user.id);
  const inboxEmpty =
    counts !== undefined && counts.counts.all === 0 && !hasFilters(filters) && !term.query;

  // ── Panel detail ──
  const showDetailRef = useRef<HTMLButtonElement>(null);
  const hideDetailRef = useRef<HTMLButtonElement>(null);
  const moveFocusAfterToggle = useRef(false);

  const setDetailOpen = (open: boolean, viaKeyboard: boolean) => {
    moveFocusAfterToggle.current = viaKeyboard;
    setDetailPanelOpen(open);
  };

  // Tombol yang ditekan ikut hilang saat panel dibuka/ditutup. Untuk pengguna keyboard,
  // fokus dipindah ke tombol pasangannya supaya tidak jatuh ke awal halaman.
  useEffect(() => {
    if (!moveFocusAfterToggle.current) return;
    moveFocusAfterToggle.current = false;
    (detailOpen ? hideDetailRef : showDetailRef).current?.focus();
  }, [detailOpen]);

  // Panel melayang (tablet) ditutup dengan Escape walau fokus tidak ada di dalam panel.
  useEffect(() => {
    if (!detailOverlay || !detailOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(ESCAPE_OWNERS)) return;
      const active = document.activeElement;
      const panel = document.getElementById(DETAIL_PANEL_ID);
      moveFocusAfterToggle.current =
        !active || active === document.body || Boolean(panel?.contains(active));
      setDetailPanelOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [detailOverlay, detailOpen, setDetailPanelOpen]);

  const showDetailButton = (floating: boolean) =>
    detailOpen || isHp ? null : (
      <IconButton
        ref={showDetailRef}
        label={t.inbox.detail.show}
        icon={PanelRightOpen}
        tooltipSide="left"
        className={floating ? styles.showDetail : undefined}
        aria-expanded={false}
        onClick={(event) => setDetailOpen(true, isKeyboardClick(event))}
      />
    );

  const chatOpen = chatId !== null && !loading;
  const hpDetail = isHp && chatOpen && hpDetailOpen;

  // HP, keyboard & pembaca layar: membuka chat dari daftar memindah fokus ke judul chat; kembali
  // ke daftar mengembalikan fokus ke baris chat yang tadi dibuka.
  const [focusChatTitle, setFocusChatTitle] = useState(false);
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (chatOpen || !isHp || !lastOpened.current) return;
    const id = lastOpened.current;
    lastOpened.current = null;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [chatOpen, isHp]);
  const openFromList = (id: string) => {
    reviveConversation(queryClient, id);
    if (isHp) {
      lastOpened.current = id;
      setFocusChatTitle(true);
    }
    onOpenChat?.(id, { push: isHp });
  };

  return (
    <div
      className={styles.inbox}
      data-detail={detailOpen ? 'open' : 'closed'}
      data-chat={chatOpen ? 'open' : 'closed'}
      // HP: chat terbuka = layar penuh bertumpuk; kerangka aplikasi menyembunyikan navigasi bawah.
      data-hp-immersive={chatOpen ? '' : undefined}
      data-hp-detail={hpDetail ? 'open' : undefined}
    >
      <ConversationList
        className={styles.listColumn}
        tab={tab}
        onTabChange={onTabChange}
        loading={loading}
        search={search}
        onSearchChange={onSearchChange}
        query={term.query}
        searchTooShort={typed.tooShort}
        filters={filters}
        onFiltersChange={setFilters}
        chips={chips}
        filterControl={
          <span className={styles.listTools}>
            {canInitiate ? (
              <IconButton
                label={t.inbox.newConversation.open}
                icon={SquarePen}
                onClick={() => setStartOpen(true)}
              />
            ) : null}
            <InboxFilterMenu filters={filters} onChange={setFilters} options={filterOptions} />
          </span>
        }
        params={params}
        counts={loading ? undefined : counts}
        inboxEmpty={inboxEmpty}
        selectedId={chatId}
        onOpen={openFromList}
        refetchInterval={refetchInterval}
      />

      {startOpen ? (
        <NewConversationDialog
          onClose={() => setStartOpen(false)}
          onStarted={(conversationId) => {
            setStartOpen(false);
            void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
            void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
            openFromList(conversationId);
          }}
        />
      ) : null}

      <section className={styles.chat} aria-label={t.inbox.chat.label}>
        {chatOpen ? (
          <ChatRoom
            key={chatId}
            conversationId={chatId}
            onBack={isHp ? onCloseChat : undefined}
            onClosed={onCloseChat}
            onOpenDetail={isHp ? onOpenHpDetail : undefined}
            focusTitle={focusChatTitle}
            detailToggle={showDetailButton(false)}
            refetchInterval={refetchInterval}
          />
        ) : (
          <>
            {showDetailButton(true)}
            {inboxEmpty ? (
              <EmptyState
                illustration={<ChatIllustration />}
                title={t.inbox.chat.inboxEmptyTitle}
                body={t.inbox.chat.inboxEmptyBody(mascotName)}
                actions={
                  canManageChannels && channels.length === 0 ? (
                    <Button asChild variant="primary">
                      <Link to="/pengaturan/channel">{t.inbox.chat.connectChannel}</Link>
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                illustration={<ChatIllustration />}
                title={t.inbox.chat.emptyTitle}
                body={t.inbox.chat.emptyBody}
              />
            )}
          </>
        )}
      </section>

      {hpDetail ? (
        // HP: layar bertumpuk ketiga (daftar → chat → detail); kembali = tutup detail.
        <aside className={styles.detail} aria-label={t.inbox.detail.label}>
          <header className={styles.detailHeader} data-hp="">
            <IconButton
              label={t.inbox.detail.backToChat}
              icon={ArrowLeft}
              onClick={() => onCloseHpDetail?.()}
            />
            <h2 className={styles.detailTitle}>{t.inbox.detail.title}</h2>
          </header>
          <ContactPanel conversationId={chatId} onClosed={onCloseChat} />
        </aside>
      ) : null}

      {detailOpen && !isHp ? (
        <DetailPanel
          hideButtonRef={hideDetailRef}
          onHide={(viaKeyboard) => setDetailOpen(false, viaKeyboard)}
        >
          {chatOpen ? (
            <ContactPanel conversationId={chatId} onClosed={onCloseChat} />
          ) : (
            <p className={styles.detailEmpty}>{t.inbox.detail.emptyBody}</p>
          )}
        </DetailPanel>
      ) : null}
    </div>
  );
}

/** Klik dari keyboard (Enter/Spasi) tidak membawa hitungan klik penunjuk. */
function isKeyboardClick(event: MouseEvent<HTMLElement>): boolean {
  return event.detail === 0;
}

interface DetailPanelProps {
  hideButtonRef: Ref<HTMLButtonElement>;
  onHide: (viaKeyboard: boolean) => void;
  children: ReactNode;
}

function DetailPanel({ hideButtonRef, onHide, children }: DetailPanelProps) {
  return (
    <aside id={DETAIL_PANEL_ID} className={styles.detail} aria-label={t.inbox.detail.label}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>{t.inbox.detail.title}</h2>
        <IconButton
          ref={hideButtonRef}
          label={t.inbox.detail.hide}
          icon={PanelRightClose}
          tooltipSide="left"
          aria-expanded
          aria-controls={DETAIL_PANEL_ID}
          onClick={(event) => onHide(isKeyboardClick(event))}
        />
      </header>
      {children}
    </aside>
  );
}
