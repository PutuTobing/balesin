import {
  API_ROUTES,
  MAIL_ACTION_MIN_LEVEL,
  MAIL_FOLDER_ROLE_NAMES,
  type MailAccessLevel,
  type MailAction,
  type MailAddressView,
  type MailFolderRole,
  type MailMessageSummary,
  type MailSidebarResponse,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import type { MailMessageListParams } from '../../lib/api/endpoints-mail';
import { isMailView } from './mail-search';

/**
 * Logika daftar & panel baca menu Email (9A bagian 2): parameter daftar dari `?f=`, pengelompokan
 * per hari, teks pengirim/penerima, dan aksi yang tersedia per hak & folder. Murni (tanpa React)
 * supaya mudah dites.
 */

const r = t.mail.reading;

/** Ukuran halaman daftar (kontrak §7: 1–100, bawaan 50). */
export const MAIL_PAGE_SIZE = 50;

/** `?f=` → parameter `GET /mail/messages`. Kosong/tidak dikenal = Semua kotak masuk. */
export function listParams(selected: string | undefined): MailMessageListParams {
  if (selected === undefined || selected === '' || selected === 'semua') return { view: 'inboxes' };
  if (isMailView(selected)) {
    return { view: selected === 'belum-dibaca' ? 'unread' : 'starred' };
  }
  return { view: 'folder', folderId: selected };
}

/** Tampilan gabungan (lintas akun): penanda akun tampil di setiap baris. */
export function isUnifiedView(params: MailMessageListParams): boolean {
  return params.view !== 'folder';
}

export type DayGroup = 'today' | 'yesterday' | 'week' | 'older';

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Kelompok hari kalender lokal: Hari ini · Kemarin · Minggu ini (2–6 hari) · Lebih lama. */
export function dayGroup(iso: string, now: Date = new Date()): DayGroup {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'older';
  const days = Math.round((startOfDay(now) - startOfDay(new Date(time))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  return 'older';
}

export interface MessageGroup {
  group: DayGroup;
  messages: MailMessageSummary[];
}

/** Daftar (sudah urut terbaru) → kelompok hari berurutan; kelompok kosong tidak ada. */
export function groupMessages(
  messages: readonly MailMessageSummary[],
  now: Date = new Date(),
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const message of messages) {
    const group = dayGroup(message.receivedAt, now);
    const last = groups.at(-1);
    if (last && last.group === group) last.messages.push(message);
    else groups.push({ group, messages: [message] });
  }
  return groups;
}

/** Nama tampil pengirim/penerima: nama, atau alamat bila tanpa nama. */
export function addressName(address: MailAddressView | null): string {
  if (!address) return t.mail.list.noSender;
  const name = address.name?.trim();
  return name ? name : address.address;
}

/** "Nama <alamat>" hanya bila nama berbeda dari alamat. */
export function addressLabel(address: MailAddressView): string {
  const name = address.name?.trim();
  return name && name.toLowerCase() !== address.address.toLowerCase()
    ? `${name} <${address.address}>`
    : address.address;
}

/** Chip alias "ke billing@": bagian lokal alamat tujuan + "@". */
export function aliasChip(deliveredTo: string | null): string | null {
  if (!deliveredTo) return null;
  const at = deliveredTo.lastIndexOf('@');
  if (at <= 0) return null;
  return t.mail.list.toChip(`${deliveredTo.slice(0, at)}@`);
}

/** Nama folder untuk teks UI (peran → nama Indonesia). */
export function folderLabel(folder: { role: MailFolderRole | null; name: string }): string {
  return folder.role ? MAIL_FOLDER_ROLE_NAMES[folder.role] : folder.name;
}

/** Folder satu akun dari kolom kiri. */
export function accountFolders(sidebar: MailSidebarResponse | undefined, accountId: string) {
  return sidebar?.accounts.find((entry) => entry.account.id === accountId)?.folders ?? [];
}

const LEVEL_RANK: Record<MailAccessLevel, number> = { read: 1, send: 2, manage: 3 };

export function canDo(level: MailAccessLevel, action: MailAction): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[MAIL_ACTION_MIN_LEVEL[action]];
}

export interface ReaderActions {
  archive: boolean;
  trash: boolean;
  deletePermanently: boolean;
  spam: boolean;
  notSpam: boolean;
  move: boolean;
}

/**
 * Aksi yang tampil di panel baca (kontrak §9): hanya yang bisa berhasil untuk hak & folder email
 * ini. Di Sampah/Spam "Hapus" menjadi "Hapus permanen" (hak Kelola); Arsip tidak diarsipkan lagi.
 */
export function readerActions(input: {
  level: MailAccessLevel;
  folderRole: MailFolderRole | null;
}): ReaderActions {
  const { level, folderRole } = input;
  const inBin = folderRole === 'trash' || folderRole === 'junk';
  return {
    archive: canDo(level, 'archive') && folderRole !== 'archive' && folderRole !== 'sent',
    trash: canDo(level, 'trash') && !inBin,
    deletePermanently: canDo(level, 'delete_permanently') && inBin,
    spam:
      canDo(level, 'spam') &&
      folderRole !== 'junk' &&
      folderRole !== 'sent' &&
      folderRole !== 'drafts',
    notSpam: canDo(level, 'not_spam') && folderRole === 'junk',
    move: canDo(level, 'move'),
  };
}

/** Aksi yang memindah email keluar dari folder yang sedang dibuka. */
export const LEAVING_ACTIONS: ReadonlySet<MailAction> = new Set([
  'move',
  'archive',
  'trash',
  'spam',
  'not_spam',
  'delete_permanently',
]);

/** Pemberitahuan setelah aksi pindah berhasil. */
export function actionFlash(action: MailAction, folderName?: string): string | null {
  switch (action) {
    case 'archive':
      return r.flash.archived;
    case 'trash':
      return r.flash.trashed;
    case 'delete_permanently':
      return r.flash.deleted;
    case 'spam':
      return r.flash.spam;
    case 'not_spam':
      return r.flash.notSpam;
    case 'move':
      return folderName ? r.flash.moved(folderName) : null;
    default:
      return null;
  }
}

export type AttachmentKind = 'pdf' | 'image' | 'sheet' | 'doc' | 'archive' | 'other';

/** Jenis lampiran untuk ikon & label (dari jenis yang dinyatakan + akhiran nama). */
export function attachmentKind(contentType: string, filename: string): AttachmentKind {
  const type = contentType.toLowerCase();
  const ext = filename.toLowerCase().split('.').at(-1) ?? '';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || type.includes('spreadsheet')) return 'sheet';
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext) || /zip|rar|7z|compressed/.test(type)) {
    return 'archive';
  }
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext) || type.includes('word')) return 'doc';
  return 'other';
}

/** Awalan dokumen tampilan ber-token (`/api/v1/mail/view/`). */
const VIEW_PREFIX = API_ROUTES.mail.view.slice(0, API_ROUTES.mail.view.indexOf(':token'));

/**
 * Hanya dokumen tampilan ber-token milik aplikasi ini yang boleh dimuat ke iframe (pertahanan
 * berlapis: URL datang dari jawaban API, tetap diperiksa sebelum jadi `src`).
 */
export function isViewUrl(url: string): boolean {
  return (
    url.startsWith(VIEW_PREFIX) &&
    /^[A-Za-z0-9_-]+$/.test(url.slice(VIEW_PREFIX.length)) &&
    !url.startsWith('//')
  );
}

/** Label jenis di kartu lampiran: akhiran berkas ("PDF", "XLSX", "ZIP") seperti mockup, atau jenisnya. */
export function attachmentTypeLabel(filename: string, kind: AttachmentKind): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1) : '';
  if (/^[a-z0-9]{2,5}$/i.test(ext)) return ext.toUpperCase();
  return t.mail.reading.attachments.kinds[kind] ?? t.mail.reading.attachments.kinds.other ?? '';
}
