import {
  MAIL_FOLDER_ROLE_NAMES,
  MAIL_PROVIDER_CARDS,
  type MailAccount,
  type MailAccountListResponse,
  type MailSidebarResponse,
} from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { Menu, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  LoadFailedIllustration,
  MailboxIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { cx } from '../../lib/cx';
import { media, useMediaQuery } from '../../lib/media';
import { usePageTitle } from '../../lib/use-page-title';
import { MailFolders } from './MailFolders';
import { PROVIDER_ICONS } from './mail-format';
import { mailAccountsQuery, mailSidebarQuery } from './mail-queries';
import { isMailView } from './mail-search';
import { MailSkeleton } from './MailSkeleton';
import { useMailStream } from './use-mail-stream';
import styles from './Mail.module.css';

const m = t.mail;
const routeApi = getRouteApi('/_app/email');

/**
 * Menu Email (Fase 9 tahap 9A, PRD §4.3/§4.9/§8). Desktop: kolom folder · daftar email · panel
 * baca. Tablet & HP: kolom folder menjadi laci. Daftar & panel baca diisi bagian 2 (daftar/baca);
 * untuk sekarang menampilkan keadaan yang jujur. Belum ada akun → ajakan menghubungkan akun.
 */
export function MailPage() {
  usePageTitle(m.title);
  useMailStream();
  const accounts = useQuery(mailAccountsQuery);
  const sidebar = useQuery(mailSidebarQuery);

  if (accounts.data && sidebar.data) {
    if (accounts.data.accounts.length === 0 && sidebar.data.accounts.length === 0) {
      return <MailEmpty list={accounts.data} />;
    }
    return <MailScreen accounts={accounts.data} sidebar={sidebar.data} />;
  }
  if (accounts.isPending || sidebar.isPending) return <MailSkeleton />;
  const error = accounts.error ?? sidebar.error;
  return (
    <div className={styles.fullState}>
      <EmptyState
        headingLevel={1}
        illustration={<LoadFailedIllustration />}
        title={m.loadFailedTitle}
        body={isApiError(error) ? error.message : t.api.network}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              void accounts.refetch();
              void sidebar.refetch();
            }}
          >
            {t.common.retry}
          </Button>
        }
      />
    </div>
  );
}

function MailScreen({
  accounts,
  sidebar,
}: {
  accounts: MailAccountListResponse;
  sidebar: MailSidebarResponse;
}) {
  const search = routeApi.useSearch();
  const selected = search.f ?? 'semua';
  const desktop = useMediaQuery(media.desktop);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const headingId = useId();
  const canConnect = accounts.canConnectPersonal || accounts.canManageShared;
  const drawer = !desktop;
  const open = drawer && drawerOpen;

  const closeDrawer = () => {
    setDrawerOpen(false);
    requestAnimationFrame(() => menuRef.current?.focus());
  };

  // Laci terbuka: fokus masuk ke laci, Escape menutup.
  useEffect(() => {
    if (!open) return;
    drawerRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const heading = headingFor(selected, sidebar);

  return (
    <div className={styles.mail} data-drawer={open ? 'open' : 'closed'}>
      <aside
        ref={drawerRef}
        id="kolom-folder-email"
        className={styles.folders}
        aria-label={m.foldersLabel}
        // Laci tertutup di HP/tablet: tidak bisa difokus atau dibaca.
        inert={drawer && !drawerOpen ? true : undefined}
      >
        <MailFolders
          sidebar={sidebar}
          accounts={accounts.accounts}
          selected={selected}
          canConnect={canConnect}
          headingId={headingId}
          onNavigate={drawer ? () => setDrawerOpen(false) : undefined}
          closeButton={
            drawer ? (
              <IconButton
                label={m.closeFolders}
                icon={X}
                className={styles.drawerClose}
                onClick={closeDrawer}
              />
            ) : null
          }
        />
      </aside>
      {open ? (
        <button
          type="button"
          className={styles.scrim}
          aria-label={m.closeFolders}
          tabIndex={-1}
          onClick={closeDrawer}
        />
      ) : null}

      {/* Laci terbuka: isi di belakangnya tidak bisa difokus (fokus tetap di laci). */}
      <section className={styles.list} aria-label={m.list.label} inert={open ? true : undefined}>
        <header className={styles.listHead}>
          <IconButton
            ref={menuRef}
            label={m.openFolders}
            icon={Menu}
            className={styles.menuButton}
            aria-expanded={open}
            aria-controls="kolom-folder-email"
            onClick={() => setDrawerOpen(true)}
          />
          <div className={styles.listHeading}>
            <h1 className={styles.listTitle}>{heading.title}</h1>
            <p className={styles.listSub}>{heading.summary}</p>
          </div>
        </header>
        <ListPlaceholder accounts={accounts.accounts} />
      </section>

      <section
        className={styles.reading}
        aria-label={m.reading.label}
        inert={open ? true : undefined}
      >
        <EmptyState
          illustration={<MailboxIllustration />}
          title={m.reading.title}
          body={m.reading.body}
        />
      </section>
    </div>
  );
}

/** Judul & ringkasan kepala daftar untuk tampilan/folder yang dibuka. */
function headingFor(
  selected: string,
  sidebar: MailSidebarResponse,
): { title: string; summary: string } {
  if (isMailView(selected) || selected === '') {
    const view = isMailView(selected) ? selected : 'semua';
    const unread =
      view === 'semua'
        ? sidebar.unified.unreadCount
        : view === 'belum-dibaca'
          ? sidebar.unread.count
          : null;
    const title =
      view === 'semua'
        ? m.views.inboxes
        : view === 'belum-dibaca'
          ? m.views.unread
          : m.views.starred;
    return {
      title,
      summary:
        unread === null
          ? m.starredSummary(sidebar.starred.count, sidebar.accounts.length)
          : m.summary(unread, sidebar.accounts.length),
    };
  }
  for (const entry of sidebar.accounts) {
    const folder = entry.folders.find((item) => item.id === selected);
    if (folder) {
      const name = folder.role ? MAIL_FOLDER_ROLE_NAMES[folder.role] : folder.name;
      return {
        title: name,
        summary: `${entry.account.displayName} · ${m.folderSummary(folder.unreadCount, folder.totalCount)}`,
      };
    }
  }
  return {
    title: m.views.inboxes,
    summary: m.summary(sidebar.unified.unreadCount, sidebar.accounts.length),
  };
}

/** Tempat daftar email (bagian 2): progres sinkron awal, atau keterangan yang jujur. */
function ListPlaceholder({ accounts }: { accounts: readonly MailAccount[] }) {
  const initial = accounts.filter((account) => account.sync.state === 'initial_sync');
  if (initial.length > 0) {
    const done = initial.reduce((sum, item) => sum + (item.sync.initialProgress?.done ?? 0), 0);
    const total = initial.reduce((sum, item) => sum + (item.sync.initialProgress?.total ?? 0), 0);
    const ratio = total > 0 ? Math.min(1, done / total) : 0;
    return (
      <div className={styles.listState} role="status">
        <p className={styles.listStateTitle}>{m.list.initialTitle}</p>
        <p className={styles.listStateBody}>{m.list.initialBody(done, total)}</p>
        {total > 0 ? (
          <progress className={styles.progress} max={total} value={done}>
            {Math.round(ratio * 100)}%
          </progress>
        ) : null}
      </div>
    );
  }
  return (
    <div className={styles.listState}>
      <p className={styles.listStateTitle}>{m.list.title}</p>
      <p className={styles.listStateBody}>{m.list.body}</p>
    </div>
  );
}

/** Belum ada akun (PRD §8): ajakan menghubungkan akun pertama, kartu penyedia, catatan hak. */
function MailEmpty({ list }: { list: MailAccountListResponse }) {
  const canConnect = list.canConnectPersonal || list.canManageShared;
  if (!canConnect) {
    return (
      <div className={styles.fullState}>
        <EmptyState
          headingLevel={1}
          illustration={<MailboxIllustration />}
          title={m.empty.noAccessTitle}
          body={m.empty.noAccessBody}
        />
      </div>
    );
  }
  return (
    <div className={styles.fullState}>
      <EmptyState
        headingLevel={1}
        className={styles.emptyWide}
        illustration={<MailboxIllustration />}
        title={m.empty.title}
        body={m.empty.body}
        actions={
          <div className={styles.emptyActions}>
            <ul className={styles.providerTiles} aria-label={m.empty.providersLabel}>
              {MAIL_PROVIDER_CARDS.map((card) => {
                const content = (
                  <>
                    <span
                      className={styles.tileIcon}
                      data-available={card.available ? '' : undefined}
                    >
                      <Icon icon={PROVIDER_ICONS[card.id]} size={20} />
                    </span>
                    <span className={styles.tileName}>{m.providers[card.id]}</span>
                    {card.available ? null : (
                      <span className={styles.tileNote}>{card.note ?? m.wizard.soon}</span>
                    )}
                  </>
                );
                return (
                  <li key={card.id}>
                    {card.available && (card.id === 'cpanel' || card.id === 'imap') ? (
                      <Link
                        to="/pengaturan/akun-email"
                        search={{ tambah: card.id }}
                        className={cx(styles.tile, styles.tileLink)}
                      >
                        {content}
                      </Link>
                    ) : (
                      <span className={styles.tile}>{content}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <Button variant="primary" asChild>
              <Link to="/pengaturan/akun-email" search={{ tambah: 'baru' }}>
                <Icon icon={Plus} size={16} />
                {m.empty.action}
              </Link>
            </Button>
            <p className={styles.emptyNote}>
              {list.canManageShared ? m.empty.noteManager : m.empty.notePersonalOnly}
            </p>
          </div>
        }
      />
    </div>
  );
}
