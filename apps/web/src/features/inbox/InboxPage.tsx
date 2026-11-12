import { getRouteApi } from '@tanstack/react-router';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
import { useBrand } from '../../brand/brand';
import { ChatIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/IconButton';
import { SearchField } from '../../components/ui/SearchField';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Inbox.module.css';
import { DEFAULT_INBOX_TAB, INBOX_TABS, parseInboxTab, type InboxTab } from './inbox-search';
import { useDetailPanel } from './use-detail-panel';

const routeApi = getRouteApi('/inbox');
const DETAIL_PANEL_ID = 'inbox-detail';

/**
 * Inbox (DESIGN.md §2). Desktop: daftar 360px · ruang chat · panel detail 340px yang
 * bisa disembunyikan. Tablet: daftar + ruang chat, detail melayang. HP: daftar saja;
 * ruang chat dan detail menjadi layar bertumpuk saat chat dibuka.
 */
export function InboxPage() {
  usePageTitle(t.inbox.title);
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const tab = parseInboxTab(search.tab);
  const detail = useDetailPanel();

  const showDetailRef = useRef<HTMLButtonElement>(null);
  const hideDetailRef = useRef<HTMLButtonElement>(null);
  const moveFocusAfterToggle = useRef(false);

  const setDetailOpen = (open: boolean, viaKeyboard: boolean) => {
    moveFocusAfterToggle.current = viaKeyboard;
    detail.setOpen(open);
  };

  // Tombol yang ditekan ikut hilang saat panel dibuka/ditutup. Untuk pengguna keyboard,
  // fokus dipindah ke tombol pasangannya supaya tidak jatuh ke awal halaman.
  useEffect(() => {
    if (!moveFocusAfterToggle.current) return;
    moveFocusAfterToggle.current = false;
    (detail.open ? hideDetailRef : showDetailRef).current?.focus();
  }, [detail.open]);

  const changeTab = (next: InboxTab) => {
    void navigate({
      search: next === DEFAULT_INBOX_TAB ? {} : { tab: next },
      replace: true,
    });
  };

  return (
    <div className={styles.inbox} data-detail={detail.open ? 'open' : 'closed'}>
      <ConversationList tab={tab} onTabChange={changeTab} />

      <section className={styles.chat} aria-label={t.inbox.chat.label}>
        {detail.open ? null : (
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

      {detail.open ? (
        <DetailPanel
          hideButtonRef={hideDetailRef}
          onHide={(viaKeyboard) => setDetailOpen(false, viaKeyboard)}
          closeOnEscape={detail.overlay}
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
}

function ConversationList({ tab, onTabChange }: ConversationListProps) {
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
                {t.inbox.tabs[id]}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </header>

        <Tabs.Content value={tab} className={styles.listBody}>
          {searching ? (
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

interface DetailPanelProps {
  hideButtonRef: Ref<HTMLButtonElement>;
  onHide: (viaKeyboard: boolean) => void;
  closeOnEscape: boolean;
}

function DetailPanel({ hideButtonRef, onHide, closeOnEscape }: DetailPanelProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (closeOnEscape && event.key === 'Escape') onHide(true);
  };

  return (
    <aside
      id={DETAIL_PANEL_ID}
      className={styles.detail}
      aria-label={t.inbox.detail.label}
      onKeyDown={onKeyDown}
    >
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
