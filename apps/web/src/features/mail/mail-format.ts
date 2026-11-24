import {
  MAIL_FOLDER_ROLE_ORDER,
  MAIL_TEST_MESSAGES,
  MAIL_UNSYNCED_FOLDER_ROLES,
  type MailFolder,
  type MailFolderRole,
  type MailProvider,
  type MailSyncState,
  type MailSyncWindowDays,
  type MailTestCode,
} from '@balesin/shared';
import {
  Archive,
  Cloud,
  File,
  Folder,
  HardDriveDownload,
  Inbox,
  Mail,
  Plug,
  Send,
  Server,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { formatDateTime, formatDateTimeInline } from '../../lib/format';

const m = t.mail;

/**
 * Ikon penyedia: lucide netral, BUKAN logo merek pihak lain (docs/design/email/README.md). Nama
 * penyedia selalu ditulis di sampingnya.
 */
export const PROVIDER_ICONS: Readonly<Record<MailProvider, LucideIcon>> = {
  cpanel: Server,
  imap: Plug,
  microsoft: Cloud,
  google: Mail,
  pop3: HardDriveDownload,
};

/** Ikon folder berperan (RFC 6154); folder sendiri memakai `Folder`. */
const FOLDER_ICONS: Partial<Record<MailFolderRole, LucideIcon>> = {
  inbox: Inbox,
  drafts: File,
  sent: Send,
  archive: Archive,
  junk: ShieldAlert,
  trash: Trash2,
};

export function folderIcon(role: MailFolderRole | null): LucideIcon {
  return (role && FOLDER_ICONS[role]) ?? Folder;
}

/**
 * Folder yang tampil di kolom kiri, urutan kontrak §6: peran (Kotak masuk, Draf, Terkirim, Arsip,
 * Spam, Sampah) lalu folder sendiri urut abjad. `\All`/`\Flagged` dan folder yang tidak bisa
 * dipilih disembunyikan.
 */
export function visibleFolders(folders: readonly MailFolder[]): MailFolder[] {
  const hidden = MAIL_UNSYNCED_FOLDER_ROLES as readonly string[];
  const rank = (folder: MailFolder) =>
    folder.role ? MAIL_FOLDER_ROLE_ORDER.indexOf(folder.role) : MAIL_FOLDER_ROLE_ORDER.length;
  return folders
    .filter((folder) => folder.selectable && !(folder.role && hidden.includes(folder.role)))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.role ? 0 : a.path.localeCompare(b.path, 'id', { sensitivity: 'base' })),
    );
}

/** Status sinkron yang butuh tindakan orang (titik peringatan di kolom kiri & daftar akun). */
export function needsAttention(state: MailSyncState): boolean {
  return state === 'auth_failed' || state === 'error' || state === 'owner_inactive';
}

export function syncBusy(state: MailSyncState): boolean {
  return state === 'initial_sync' || state === 'syncing';
}

export function syncTone(state: MailSyncState): StatusTone {
  switch (state) {
    case 'ready':
      return 'success';
    case 'auth_failed':
      return 'danger';
    case 'error':
    case 'owner_inactive':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function syncStateLabel(state: MailSyncState): string {
  return m.syncStates[state] ?? state;
}

/** "baru saja", "3 menit lalu", "2 jam lalu", lalu "Kemarin, 09.15" / "13 Nov 2026, 22.03". */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return iso;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return m.time.justNow;
  if (minutes < 60) return m.time.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 12) return m.time.hours(hours);
  return formatDateTimeInline(iso, new Date(now));
}

/** Pesan galat sinkron dari server; bila kosong, dari daftar kode tes tetap. */
export function syncErrorMessage(code: string | null, message: string | null): string | null {
  if (message) return message;
  if (!code) return null;
  return code in MAIL_TEST_MESSAGES ? MAIL_TEST_MESSAGES[code as MailTestCode] : null;
}

/** Nilai `<select>` jendela sinkron ↔ nilai API (`null` = semua email). */
export function windowValue(days: MailSyncWindowDays): string {
  return days === null ? 'all' : String(days);
}

export function parseWindow(value: string): MailSyncWindowDays {
  if (value === '30') return 30;
  if (value === '365') return 365;
  if (value === 'all') return null;
  return 90;
}

export const WINDOW_OPTIONS = ['30', '90', '365', 'all'].map((value) => ({
  value,
  label: m.windows[value] ?? value,
}));

/** Ukuran kotak surat: "812 MB", "2 GB". */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toLocaleString('id-ID', { maximumFractionDigits: digits })} ${units[unit] ?? 'B'}`;
}

/** Domain alamat email (setelah `@` terakhir), huruf kecil. */
export function emailDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0
    ? ''
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Waktu lengkap "Hari ini, 09.15" untuk kolom "Terakhir sinkron" di halaman akun. */
export function syncedAt(iso: string | null): string {
  return iso ? formatDateTime(iso) : m.detail.never;
}
