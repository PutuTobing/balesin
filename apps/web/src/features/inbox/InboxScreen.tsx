import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, useState, type MouseEvent, type Ref } from 'react';
import { useBrand } from '../../brand/brand';
import { ChatIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/IconButton';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Inbox.module.css';
import { INBOX_TABS, parseInboxTab, type InboxTab } from './inbox-search';
import { useDetailPanel } from './use-detail-panel';

const DETAIL_PANEL_ID = 'inbox-detail';
const SKELETON_ROWS = 7;
/** Elemen yang memakai Escape untuk dirinya sendiri; panel detail tidak ikut tertutup. */
const ESCAPE_OWNERS = '[role="menu"], [role="dialog"], input, textarea, [contenteditable="true"]';

export interface InboxScreenProps {
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  /**
   * Daftar chat sedang menunggu data. Hanya ISI daftar yang berganti jadi kerangka;
   * judul, kolom cari, tab, ruang chat, dan panel detail tetap sama dan tetap bisa
   * dipakai, jadi tidak ada yang melompat saat data tiba.
   */
  loading?: boolean;
}

/**
 * Tampilan Inbox (DESIGN.md §2). Desktop: daftar 360px · ruang chat · panel detail 340px
 * yang bisa disembunyikan. Tablet: daftar + ruang chat, detail melayang. HP: daftar saja;
 * ruang chat dan detail menjadi layar bertumpuk saat chat dibuka.
 */
export function InboxScreen({ tab, onTabChange, loading = false }: InboxScreenProps) {
  usePageTitle(t.inbox.title);
  const detail = useDetailPanel();
  const { open: detailOpen, overlay: detailOverlay, setOpen: setDetailPanelOpen } = detail;

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

  // Panel melayang (tablet) ditutup dengan Escape walau fokus tidak ada di dalam panel,
  // mis. saat dibuka dengan mouse atau sentuhan.
  useEffect(() => {
    if (!detailOverlay || !detailOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target instanceof Element ? event.target : null;
      // Escape milik lapisan di atasnya (menu, dialog) atau kolom yang sedang diketik.
      if (target?.closest(ESCAPE_OWNERS)) return;

      // Fokus dikembalikan ke tombol pembuka hanya bila tadinya di dalam panel atau
      // tidak di mana-mana; fokus pengguna di tempat lain tidak direbut.
      const active = document.activeElement;
      const panel = document.getElementById(DETAIL_PANEL_ID);
      moveFocusAfterToggle.current =
        !active || active === document.body || Boolean(panel?.contains(active));
      setDetailPanelOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [detailOverlay, detailOpen, setDetailPanelOpen]);

  return (
    <div className={styles.inbox} data-detail={detailOpen ? 'open' : 'closed'}>
      <ConversationList tab={tab} onTabChange={onTabChange} loading={loading} />

      <section className={styles.chat} aria-label={t.inbox.chat.label}>
        {detailOpen ? null : (
          <IconButton
            ref={showDetailRef}
            label={t.inbox.detail.show}
            icon={PanelRightOpen}
            tooltipSide="left"
            className={styles.showDetail}
            aria-expanded={false}
            onClick={(event) => setDetailOpen(true, isKeyboardClick(event))}
          />
        )}
        <EmptyState
          illustration={<ChatIllustration />}
          title={t.inbox.chat.emptyTitle}
          body={t.inbox.chat.emptyBody}
        />
      </section>

      {detailOpen ? (
        <DetailPanel
          hideButtonRef={hideDetailRef}
          onHide={(viaKeyboard) => setDetailOpen(false, viaKeyboard)}
        />
      ) : null}
    </div>
  );
}

/** Klik dari keyboard (Enter/Spasi) tidak membawa hitungan klik penunjuk. */
function isKeyboardClick(event: MouseEvent<HTMLElement>): boolean {
  return event.detail === 0;
}

interface ConversationListProps {
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  loading: boolean;
}

function ConversationList({ tab, onTabChange, loading }: ConversationListProps) {
  const { mascotName } = useBrand();
  const isHp = useMediaQuery(media.hp);
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const empty = t.inbox.empty[tab];

  return (
    <section className={styles.list} aria-label={t.inbox.listLabel}>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => onTabChange(parseInboxTab(value))}
        className={styles.listInner}
      >
        <header className={styles.listHeader}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{t.inbox.title}</h1>
          </div>
          <div className={styles.searchRow}>
            <SearchField
              value={query}
              onChange={setQuery}
              label={t.inbox.searchLabel}
              placeholder={t.inbox.searchPlaceholder}
              clearLabel={t.inbox.clearSearch}
            />
          </div>
          <Tabs.List className={styles.tabs} aria-label={t.inbox.tabsLabel}>
            {INBOX_TABS.map((id) => (
              <Tabs.Trigger key={id} value={id} className={styles.tab}>
                <span className={styles.tabLabel}>{t.inbox.tabs[id]}</span>
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </header>

        <Tabs.Content value={tab} className={styles.listBody}>
          {loading ? (
            <ConversationRowsSkeleton />
          ) : searching ? (
            <EmptyState
              compact={!isHp}
              align={isHp ? 'center' : 'top'}
              title={t.inbox.searchEmpty.title(query.trim())}
              body={t.inbox.searchEmpty.body}
              actions={<Button onClick={() => setQuery('')}>{t.inbox.clearSearch}</Button>}
            />
          ) : (
            <EmptyState
              compact={!isHp}
              align={isHp ? 'center' : 'top'}
              // Di desktop ilustrasi ada di ruang chat; di HP daftar adalah seluruh layar.
              illustration={isHp ? <ChatIllustration /> : undefined}
              title={empty.title}
              body={empty.body(mascotName)}
            />
          )}
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

/** Kerangka baris chat: avatar, nama, cuplikan pesan, jam. */
function ConversationRowsSkeleton() {
  return (
    <SkeletonRegion className={styles.skeletonRows}>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className={styles.skeletonRow}>
          <Skeleton className={styles.skeletonAvatar} />
          <div className={styles.skeletonLines}>
            <Skeleton className={styles.skeletonName} />
            <Skeleton className={styles.skeletonSnippet} />
          </div>
          <Skeleton className={styles.skeletonTime} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

interface DetailPanelProps {
  hideButtonRef: Ref<HTMLButtonElement>;
  onHide: (viaKeyboard: boolean) => void;
}

function DetailPanel({ hideButtonRef, onHide }: DetailPanelProps) {
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
      <p className={styles.detailEmpty}>{t.inbox.detail.emptyBody}</p>
    </aside>
  );
}
