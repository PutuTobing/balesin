import {
  MAIL_FOLDER_ROLE_NAMES,
  type MailAccount,
  type MailSidebarResponse,
} from '@balesin/shared';
import { Link } from '@tanstack/react-router';
import {
  ChevronDown,
  CircleAlert,
  Layers,
  Lock,
  Mail,
  Plus,
  RefreshCw,
  Settings,
  SquarePen,
  Star,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Tooltip } from '../../components/ui/Tooltip';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { AccountMark } from './AccountMark';
import { folderIcon, needsAttention, relativeTime, syncBusy, visibleFolders } from './mail-format';
import type { MailView } from './mail-search';
import styles from './Mail.module.css';

const m = t.mail;

type SidebarAccount = MailSidebarResponse['accounts'][number];

interface MailFoldersProps {
  sidebar: MailSidebarResponse;
  /** Akun lengkap (jenis, status sinkron) dari `GET /mail/accounts`. */
  accounts: readonly MailAccount[];
  /** Tampilan atau ID folder yang sedang dibuka. */
  selected: string;
  canConnect: boolean;
  /** Dipanggil setelah memilih (HP/tablet: laci ditutup). */
  onNavigate?: () => void;
  /** Tombol tutup laci (HP/tablet). */
  closeButton?: ReactNode;
  headingId: string;
  /** Tombol "Tulis email" (9B); tanpa hak kirim di akun mana pun = tidak tampil. */
  onCompose?: () => void;
}

/**
 * Kolom folder menu Email (PRD §4.3): Semua kotak masuk, Belum dibaca, Berbintang, lalu per akun
 * (titik warna/foto, nama, jumlah belum dibaca) dengan folder + jumlahnya. Di desktop kolom tetap;
 * di tablet & HP menjadi laci.
 */
export function MailFolders({
  sidebar,
  accounts,
  selected,
  canConnect,
  onNavigate,
  closeButton,
  headingId,
  onCompose,
}: MailFoldersProps) {
  const selectedAccountId = sidebar.accounts.find((entry) =>
    entry.folders.some((folder) => folder.id === selected),
  )?.account.id;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    // Akun pertama (dan akun folder yang sedang dibuka) terbuka; sisanya dilipat bila banyak.
    if (sidebar.accounts.length <= 2) return new Set();
    return new Set(
      sidebar.accounts
        .slice(1)
        .map((entry) => entry.account.id)
        .filter((id) => id !== selectedAccountId),
    );
  });
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={styles.foldersInner}>
      <div className={styles.foldersHead}>
        <h2 id={headingId} className={styles.foldersTitle}>
          {m.title}
        </h2>
        <Tooltip label={m.settingsLink}>
          <Link to="/pengaturan/akun-email" className={styles.headIcon} aria-label={m.settingsLink}>
            <Icon icon={Settings} size={20} />
          </Link>
        </Tooltip>
        {closeButton}
      </div>
      {onCompose ? (
        <div className={styles.composeSlot}>
          <Button variant="primary" className={styles.composeButton} onClick={onCompose}>
            <Icon icon={SquarePen} size={20} />
            {m.compose.button}
          </Button>
        </div>
      ) : null}
      <nav className={styles.foldersScroll} aria-labelledby={headingId}>
        <ul className={styles.folderList}>
          <ViewLink
            view="semua"
            icon={Layers}
            label={m.views.inboxes}
            count={sidebar.unified.unreadCount}
            selected={selected}
            onNavigate={onNavigate}
          />
          <ViewLink
            view="belum-dibaca"
            icon={Mail}
            label={m.views.unread}
            count={sidebar.unread.count}
            selected={selected}
            onNavigate={onNavigate}
          />
          <ViewLink
            view="berbintang"
            icon={Star}
            label={m.views.starred}
            count={sidebar.starred.count}
            selected={selected}
            onNavigate={onNavigate}
            muteCount
          />
        </ul>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>{m.accountsHeading}</span>
          {canConnect ? (
            <Tooltip label={m.addAccount}>
              <Link
                to="/pengaturan/akun-email"
                search={{ tambah: 'baru' }}
                className={styles.sectionAction}
                aria-label={m.addAccount}
              >
                <Icon icon={Plus} size={16} />
              </Link>
            </Tooltip>
          ) : null}
        </div>
        <ul className={styles.accountList}>
          {sidebar.accounts.map((entry) => (
            <AccountGroup
              key={entry.account.id}
              entry={entry}
              account={accounts.find((item) => item.id === entry.account.id)}
              open={!collapsed.has(entry.account.id)}
              onToggle={() => toggle(entry.account.id)}
              selected={selected}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      </nav>
      <SyncFooter accounts={accounts} />
    </div>
  );
}

function ViewLink({
  view,
  icon,
  label,
  count,
  selected,
  onNavigate,
  muteCount = false,
}: {
  view: MailView;
  icon: LucideIcon;
  label: string;
  count: number;
  selected: string;
  onNavigate?: () => void;
  /** Hitungan Berbintang bukan "belum dibaca": tampil abu-abu. */
  muteCount?: boolean;
}) {
  const active = selected === view;
  return (
    <li>
      <Link
        to="/email"
        search={view === 'semua' ? {} : { f: view }}
        activeOptions={{ exact: true }}
        className={styles.folderLink}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
      >
        <Icon icon={icon} size={20} className={styles.folderIcon} />
        <span className={styles.folderName}>{label}</span>
        {count > 0 ? <Count value={count} muted={muteCount} /> : null}
      </Link>
    </li>
  );
}

function AccountGroup({
  entry,
  account,
  open,
  onToggle,
  selected,
  onNavigate,
}: {
  entry: SidebarAccount;
  account: MailAccount | undefined;
  open: boolean;
  onToggle: () => void;
  selected: string;
  onNavigate?: () => void;
}) {
  const folders = visibleFolders(entry.folders);
  // Kedalaman folder sendiri relatif terhadap yang paling dangkal (awalan `INBOX.` tidak menjorok).
  const baseDepth = Math.min(
    ...folders.filter((folder) => !folder.role).map((folder) => folder.depth),
    Number.MAX_SAFE_INTEGER,
  );
  const listId = `folder-akun-${entry.account.id}`;
  const attention = needsAttention(entry.account.sync.state);
  const unread = folders.find((folder) => folder.role === 'inbox')?.unreadCount ?? 0;
  const personal = account?.kind === 'personal';
  return (
    <li className={styles.accountGroup}>
      <button
        type="button"
        className={styles.accountHead}
        aria-expanded={open}
        aria-controls={listId}
        aria-label={m.toggleAccount(entry.account.displayName, [
          ...(personal ? [m.personalNote] : []),
          ...(attention ? [m.attentionNote] : []),
          ...(unread > 0 ? [m.unreadLabel(unread)] : []),
        ])}
        onClick={onToggle}
      >
        <Icon
          icon={ChevronDown}
          size={16}
          className={cx(styles.chevron, !open && styles.chevronClosed)}
        />
        <AccountMark account={entry.account} size="sm" />
        <span className={styles.accountText}>
          <span className={styles.accountName}>
            <span className={styles.truncate}>{entry.account.displayName}</span>
            {personal ? <Icon icon={Lock} size={16} className={styles.lock} /> : null}
          </span>
          <span className={styles.accountAddress}>{entry.account.emailAddress}</span>
        </span>
        {attention ? (
          <Icon icon={CircleAlert} size={16} className={styles.attention} />
        ) : unread > 0 && !open ? (
          <span className={styles.count} aria-hidden="true">
            {m.count(unread)}
          </span>
        ) : null}
      </button>
      <ul id={listId} className={styles.subList} hidden={!open}>
        {folders.length === 0 ? (
          <li className={styles.noFolders}>{m.noFolders}</li>
        ) : (
          folders.map((folder) => {
            const active = selected === folder.id;
            const name = folder.role ? MAIL_FOLDER_ROLE_NAMES[folder.role] : folder.name;
            return (
              <li key={folder.id}>
                <Link
                  to="/email"
                  search={{ f: folder.id }}
                  activeOptions={{ exact: true }}
                  className={cx(styles.folderLink, styles.subLink)}
                  data-depth={folder.role ? 0 : Math.min(folder.depth - baseDepth, 3)}
                  aria-current={active ? 'page' : undefined}
                  onClick={onNavigate}
                >
                  <Icon icon={folderIcon(folder.role)} size={16} className={styles.folderIcon} />
                  <span className={styles.folderName}>{name}</span>
                  {folder.unreadCount > 0 && folder.role !== 'sent' ? (
                    <Count value={folder.unreadCount} />
                  ) : null}
                </Link>
              </li>
            );
          })
        )}
      </ul>
    </li>
  );
}

/** Angka di samping folder; pembaca layar mendengar "6 belum dibaca". */
function Count({ value, muted = false }: { value: number; muted?: boolean }) {
  return (
    <span className={cx(styles.count, muted && styles.countMuted)}>
      {m.count(value)}
      {muted ? null : <span className="sr-only">{m.unreadSuffix}</span>}
    </span>
  );
}

/** Dasar kolom: sinkron terakhir semua akun + jumlah akun yang perlu perhatian. */
function SyncFooter({ accounts }: { accounts: readonly MailAccount[] }) {
  if (accounts.length === 0) return null;
  const busy = accounts.some((account) => syncBusy(account.sync.state));
  const attention = accounts.filter((account) => needsAttention(account.sync.state)).length;
  const latest = accounts
    .map((account) => account.sync.lastSyncedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  return (
    <div className={styles.foldersFoot}>
      <p className={styles.footLine}>
        <Icon icon={RefreshCw} size={16} className={cx(styles.footIcon, busy && styles.spinning)} />
        {busy ? m.footer.syncing : latest ? m.footer.synced(relativeTime(latest)) : m.footer.never}
      </p>
      {attention > 0 ? (
        <Link to="/pengaturan/akun-email" className={styles.footWarn}>
          <Icon icon={CircleAlert} size={16} />
          {m.footer.attention(attention)}
        </Link>
      ) : null}
    </div>
  );
}
