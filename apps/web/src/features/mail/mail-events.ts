import type {
  InboxStreamEvent,
  MailAccountListResponse,
  MailSettingsAccountListResponse,
  MailSidebarResponse,
  MailStreamEvent,
} from '@balesin/shared';
import type { QueryClient } from '@tanstack/react-query';
import { refetchSession } from '../../lib/api/queries';
import { mailKeys, markAttachmentCached, removeListedMessages } from './mail-queries';
import { emitMailSignal } from './mail-signals';

/** Event `mail.*` dari soket bersama (KONTRAK-API-EMAIL §10: ID & angka saja). */
export function isMailEvent(event: InboxStreamEvent): event is MailStreamEvent {
  return event.type.startsWith('mail.');
}

/** Selang gabung penyegaran kolom kiri: banyak event folder berturut-turut = satu permintaan. */
const SIDEBAR_REFRESH_MS = 1_000;
const sidebarTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

function scheduleSidebarRefresh(queryClient: QueryClient): void {
  if (sidebarTimers.has(queryClient)) return;
  sidebarTimers.set(
    queryClient,
    setTimeout(() => {
      sidebarTimers.delete(queryClient);
      void queryClient.invalidateQueries({ queryKey: mailKeys.sidebar });
    }, SIDEBAR_REFRESH_MS),
  );
}

/** Sama untuk daftar email: email baru/berubah berturut-turut = satu muat ulang. */
const LIST_REFRESH_MS = 1_000;
const listTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

function scheduleListRefresh(queryClient: QueryClient): void {
  if (listTimers.has(queryClient)) return;
  listTimers.set(
    queryClient,
    setTimeout(() => {
      listTimers.delete(queryClient);
      void queryClient.invalidateQueries({ queryKey: mailKeys.messageLists });
    }, LIST_REFRESH_MS),
  );
}

/**
 * Terapkan event Email ke cache TanStack Query. Event hanya membawa ID & angka: status sinkron dan
 * hitungan folder ditambal langsung; selain itu data dimuat ulang lewat REST (server menegakkan
 * hak per akun lagi).
 */
export function applyMailEvent(queryClient: QueryClient, event: MailStreamEvent): void {
  switch (event.type) {
    case 'mail.account.status': {
      const sync = {
        state: event.syncState,
        lastSyncedAt: event.lastSyncedAt,
        lastErrorCode: event.errorCode,
        initialProgress: event.initialProgress,
      };
      const patchFull = <T extends { id: string; redacted: boolean }>(account: T): T => {
        if (account.id !== event.accountId) return account;
        if (account.redacted) {
          return {
            ...account,
            sync: {
              state: sync.state,
              lastSyncedAt: sync.lastSyncedAt,
              lastErrorCode: sync.lastErrorCode,
            },
          };
        }
        const full = account as T & { sync: Record<string, unknown> };
        return { ...full, sync: { ...full.sync, ...sync } };
      };
      queryClient.setQueryData<MailAccountListResponse>(
        mailKeys.accounts,
        (data) => data && { ...data, accounts: data.accounts.map(patchFull) },
      );
      queryClient.setQueryData<MailSettingsAccountListResponse>(
        mailKeys.settingsAccounts,
        (data) => data && { ...data, accounts: data.accounts.map(patchFull) },
      );
      queryClient.setQueryData<MailSidebarResponse>(
        mailKeys.sidebar,
        (data) =>
          data && {
            ...data,
            accounts: data.accounts.map((entry) =>
              entry.account.id === event.accountId
                ? { ...entry, account: { ...entry.account, sync: { state: event.syncState } } }
                : entry,
            ),
          },
      );
      // Pesan galat & tes terakhir hanya ada di REST.
      void queryClient.invalidateQueries({ queryKey: mailKeys.account(event.accountId) });
      // Sinkron awal/selesai: folder bisa bertambah.
      scheduleSidebarRefresh(queryClient);
      return;
    }
    case 'mail.folder.counts':
      queryClient.setQueryData<MailSidebarResponse>(
        mailKeys.sidebar,
        (data) =>
          data && {
            ...data,
            accounts: data.accounts.map((entry) =>
              entry.account.id === event.accountId
                ? {
                    ...entry,
                    folders: entry.folders.map((folder) =>
                      folder.id === event.folderId
                        ? {
                            ...folder,
                            unreadCount: event.unreadCount,
                            totalCount: event.totalCount,
                          }
                        : folder,
                    ),
                  }
                : entry,
            ),
          },
      );
      // Hitungan gabungan (Semua kotak masuk/Belum dibaca) dihitung server.
      scheduleSidebarRefresh(queryClient);
      return;
    case 'mail.message.created':
      scheduleListRefresh(queryClient);
      scheduleSidebarRefresh(queryClient);
      return;
    case 'mail.message.updated':
      scheduleListRefresh(queryClient);
      scheduleSidebarRefresh(queryClient);
      void queryClient.invalidateQueries({ queryKey: mailKeys.message(event.messageId) });
      // Isi siap/berubah: token tampilan lama menunjuk isi lama.
      if (event.fields.includes('body')) {
        void queryClient.invalidateQueries({ queryKey: ['mail', 'view', event.messageId] });
      }
      return;
    case 'mail.message.deleted':
      removeListedMessages(queryClient, [event.messageId]);
      scheduleSidebarRefresh(queryClient);
      void queryClient.invalidateQueries({ queryKey: mailKeys.message(event.messageId) });
      return;
    case 'mail.access.changed':
      // Hak berubah: menu Email bisa tampil/hilang (`navigation.mail`), daftar akun berubah.
      void refetchSession(queryClient).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: mailKeys.all });
      return;
    case 'mail.resync':
      void queryClient.invalidateQueries({ queryKey: mailKeys.all });
      return;
    case 'mail.attachment.ready':
      markAttachmentCached(queryClient, event.attachmentId);
      emitMailSignal({ type: 'attachment.ready', attachmentId: event.attachmentId });
      return;
    case 'mail.attachment.failed':
      emitMailSignal({
        type: 'attachment.failed',
        attachmentId: event.attachmentId,
        code: event.code,
      });
      return;
    case 'mail.action.failed':
      // Server mengembalikan perubahan lokal: muat ulang daftar & detail yang terdampak.
      void queryClient.invalidateQueries({ queryKey: mailKeys.messageLists });
      for (const id of event.messageIds) {
        void queryClient.invalidateQueries({ queryKey: mailKeys.message(id) });
      }
      scheduleSidebarRefresh(queryClient);
      emitMailSignal({ type: 'action.failed', messageIds: event.messageIds });
      return;
  }
}
