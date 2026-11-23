import {
  MAIL_FOLDER_ROLE_NAMES,
  MAIL_PROVIDER_CARDS,
  type MailAccount,
  type MailAccountListResponse,
  type MailMessageSummary,
  type MailSidebarResponse,
} from '@balesin/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useRouter } from '@tanstack/react-router';
import { Menu, Plus, SquarePen, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  LoadFailedIllustration,
  MailboxIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { cx } from '../../lib/cx';
import { media, useMediaQuery } from '../../lib/media';
import { usePageTitle } from '../../lib/use-page-title';
import { useCan } from '../auth/session';
import { ComposeHost } from './compose/ComposeHost';
import { openCompose, useComposeStore } from './compose/compose-store';
import { MailFolders } from './MailFolders';
import { MailList } from './MailList';
import { MailReader, type ReaderFlash } from './MailReader';
import { PROVIDER_ICONS } from './mail-format';
import { MAIL_PAGE_SIZE, listParams } from './mail-list';
import { mailAccountsQuery, mailMessagesQuery, mailSidebarQuery } from './mail-queries';
import { isMailView } from './mail-search';
import { onMailSignal } from './mail-signals';
import { MailSkeleton } from './MailSkeleton';
import { accountsNeedingVerification, verificationLocked } from './mail-verify-banner';
import { useMailStream } from './use-mail-stream';
import styles from './Mail.module.css';

const m = t.mail;
const routeApi = getRouteApi('/_app/email');

/**
 * Menu Email (Fase 9 tahap 9A, PRD §4.3/§4.9/§8). Desktop: kolom folder · daftar email · panel
 * baca. Tablet: kolom folder menjadi laci, daftar + panel baca. HP: daftar layar penuh → baca
 * layar penuh (bertumpuk, tombol kembali). Belum ada akun → ajakan menghubungkan akun.
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

/** Pemberitahuan hasil aksi di atas daftar: sukses hilang sendiri, gagal tetap sampai ditutup. */
const FLASH_MS = 5_000;

function MailScreen({
  accounts,
  sidebar,
}: {
  accounts: MailAccountListResponse;
  sidebar: MailSidebarResponse;
}) {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const router = useRouter();
  const selected = search.f ?? 'semua';
  const messageId = search.m ?? null;
  const desktop = useMediaQuery(media.desktop);
  const isHp = useMediaQuery(media.hp);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const headingId = useId();
  const canConnect = accounts.canConnectPersonal || accounts.canManageShared;
  const drawer = !desktop;
  const open = drawer && drawerOpen;
  const params = useMemo(() => listParams(selected), [selected]);
  const [flash, setFlash] = useState<ReaderFlash | null>(null);
  const compose = useComposeStore();
  // 9B: "Tulis" hanya bila ada akun ber-hak kirim (server tetap memeriksa).
  const canCompose =
    useCan('mail.send') && accounts.accounts.some((account) => account.myLevel !== 'read');
  const currentAccountId =
    sidebar.accounts.find((entry) => entry.folders.some((folder) => folder.id === selected))
      ?.account.id ?? null;
  const startCompose = useCallback(() => {
    if (drawerOpen) setDrawerOpen(false);
    openCompose({ kind: 'new', accountId: currentAccountId });
  }, [currentAccountId, drawerOpen]);
  const composeFullscreen = isHp && compose.windows.some((window) => window.mode !== 'minimized');

  // "1 dari N" + naik/turun di panel baca (desktop): urutan daftar yang sudah dimuat.
  const listed = useInfiniteQuery({ ...mailMessagesQuery(params, MAIL_PAGE_SIZE), enabled: false });
  const ordered = useMemo(
    () => listed.data?.pages.flatMap((page) => page.messages) ?? [],
    [listed.data],
  );

  // HP: email dibuka dari daftar dengan entri riwayat baru, jadi "kembali" = langkah mundur
  // browser (gesture kembali HP), bukan entri baru. Fokus kembali ke baris yang tadi dibuka.
  const pushedFromList = useRef(false);
  const lastOpened = useRef<string | null>(null);
  const [focusTitle, setFocusTitle] = useState(false);

  const openMessage = useCallback(
    (message: MailMessageSummary) => {
      // Salinan draf MILIKKU di folder Draf: buka jendela tulis, bukan panel baca.
      if (message.draftId) {
        openCompose({ kind: 'draft', draftId: message.draftId, subject: message.subject });
        return;
      }
      if (message.id === messageId) return;
      pushedFromList.current = isHp;
      lastOpened.current = message.id;
      setFocusTitle(isHp);
      void navigate({ search: (prev) => ({ ...prev, m: message.id }), replace: !isHp });
    },
    [isHp, messageId, navigate],
  );

  const closeMessage = useCallback(() => {
    if (pushedFromList.current) {
      pushedFromList.current = false;
      router.history.back();
      return;
    }
    void navigate({ search: (prev) => ({ ...prev, m: undefined }), replace: true });
  }, [navigate, router]);

  useEffect(() => {
    if (messageId || !isHp || !lastOpened.current) return;
    const id = lastOpened.current;
    lastOpened.current = null;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [messageId, isHp]);

  // Sukses hilang sendiri; gagal tetap tampil sampai ditutup.
  useEffect(() => {
    if (flash?.tone !== 'success') return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // Server mengembalikan aksi yang gagal diterapkan ke server email.
  useEffect(
    () =>
      onMailSignal((signal) => {
        if (signal.type === 'action.failed') {
          setFlash({ tone: 'danger', text: m.actionFailed });
        }
      }),
    [],
  );

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
  const reading = messageId !== null;

  return (
    <div
      className={styles.mail}
      data-drawer={open ? 'open' : 'closed'}
      data-reading={reading ? 'open' : 'closed'}
      // HP: email terbuka = layar penuh bertumpuk; kerangka aplikasi menyembunyikan navigasi bawah.
      data-hp-immersive={(reading && isHp) || composeFullscreen ? '' : undefined}
    >
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
          onCompose={canCompose ? startCompose : undefined}
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

      {/* Laci terbuka: isi di belakangnya tidak bisa difokus (fokus tetap di laci). HP: daftar
          tersembunyi selama email dibaca. */}
      <section
        className={styles.list}
        aria-label={m.list.label}
        inert={open || (isHp && reading) ? true : undefined}
      >
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
        <VerifyBanner accounts={accounts.accounts} />
        {flash ? (
          <div className={styles.flash}>
            <Notice
              tone={flash.tone}
              role={flash.tone === 'danger' ? 'alert' : 'status'}
              actions={
                flash.tone === 'danger' ? (
                  <Button onClick={() => setFlash(null)}>{t.common.close}</Button>
                ) : undefined
              }
            >
              {flash.text}
            </Notice>
          </div>
        ) : null}
        <MailList
          key={`${params.view}:${params.folderId ?? ''}`}
          params={params}
          accounts={accounts.accounts}
          selectedId={messageId}
          onOpen={openMessage}
        />
      </section>

      <section
        className={styles.reading}
        aria-label={m.reading.label}
        inert={open ? true : undefined}
      >
        {messageId ? (
          <MailReader
            key={messageId}
            messageId={messageId}
            sidebar={sidebar}
            onBack={isHp ? closeMessage : undefined}
            onLeave={closeMessage}
            onFlash={setFlash}
            focusTitle={focusTitle}
            canCompose={canCompose}
            position={desktop ? positionOf(ordered, messageId) : null}
            onStep={(id) =>
              void navigate({ search: (prev) => ({ ...prev, m: id }), replace: true })
            }
          />
        ) : (
          <EmptyState title={m.reading.title} body={m.reading.body} />
        )}
      </section>
      {canCompose && !open ? (
        <button type="button" className={styles.fab} onClick={startCompose}>
          <Icon icon={SquarePen} size={20} />
          {m.compose.fab}
        </button>
      ) : null}
      <ComposeHost
        isHp={isHp}
        onOpenMessage={(id) =>
          void navigate({ search: (prev) => ({ ...prev, m: id }), replace: !isHp })
        }
      />
    </div>
  );
}

/**
 * Banner "Verifikasi alamat … supaya bisa mengirim email" (KONTRAK-API-EMAIL-TULIS §3.4) untuk akun
 * berperingatan `identity_unverified`/`system_sender_conflict` yang bisa kuverifikasi (hak Kelola).
 * Tautan ke halaman akun → Alamat pengirim. "Nanti saja" menyembunyikannya sampai menu dibuka lagi;
 * banner hilang sendiri setelah alamatnya terverifikasi (WS `mail.identity.updated`).
 */
function VerifyBanner({ accounts }: { accounts: readonly MailAccount[] }) {
  const [dismissed, setDismissed] = useState(false);
  const pending = accountsNeedingVerification(accounts);
  const first = pending[0];
  if (dismissed || !first) return null;
  const locked = verificationLocked(pending);
  const vb = m.verifyBanner;
  return (
    <div className={styles.flash}>
      <Notice
        tone="warning"
        title={
          locked
            ? vb.locked
            : pending.length === 1
              ? vb.one(first.displayName)
              : vb.many(pending.length)
        }
        actions={
          <>
            <Button asChild>
              <Link
                to="/pengaturan/akun-email/$accountId"
                params={{ accountId: first.id }}
                hash="alamat-pengirim"
              >
                {pending.length === 1 ? vb.open : vb.openFirst(first.displayName)}
              </Link>
            </Button>
            <Button variant="ghost" onClick={() => setDismissed(true)}>
              {vb.dismiss}
            </Button>
          </>
        }
      >
        {locked
          ? vb.lockedBody
          : pending.length > 1
            ? pending.map((account) => account.displayName).join(' · ')
            : null}
      </Notice>
    </div>
  );
}

/** Posisi email terbuka di daftar yang dimuat (untuk "1 dari N" + sebelumnya/berikutnya). */
function positionOf(
  messages: readonly MailMessageSummary[],
  messageId: string,
): { index: number; total: number; previous: string | null; next: string | null } | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  return {
    index: index + 1,
    total: messages.length,
    previous: messages[index - 1]?.id ?? null,
    next: messages[index + 1]?.id ?? null,
  };
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
