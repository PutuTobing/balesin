import { MAIL_ACTION_FAILED_MESSAGE, type MailAction } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { LEAVING_ACTIONS } from './mail-list';
import { mailKeys, patchMessageFlags, removeListedMessages } from './mail-queries';

export type MailActionOutcome = { ok: true } | { ok: false; message: string };

const FLAG_PATCHES: Partial<Record<MailAction, { isRead?: boolean; isStarred?: boolean }>> = {
  mark_read: { isRead: true },
  mark_unread: { isRead: false },
  star: { isStarred: true },
  unstar: { isStarred: false },
};

/**
 * Aksi dua arah (kontrak §9) dengan pembaruan optimistis: bendera langsung berubah dan email yang
 * dipindah langsung hilang dari daftar; server menerapkannya ke IMAP di belakang. Gagal (seluruhnya
 * atau sebagian) → daftar & detail dimuat ulang dari server dan pesannya dikembalikan ke pemanggil.
 */
export function useMailActions() {
  const queryClient = useQueryClient();
  return useCallback(
    async (
      action: MailAction,
      messageIds: readonly string[],
      targetFolderId?: string,
    ): Promise<MailActionOutcome> => {
      const ids = [...messageIds];
      const patch = FLAG_PATCHES[action];
      if (patch) patchMessageFlags(queryClient, ids, patch);
      if (LEAVING_ACTIONS.has(action)) removeListedMessages(queryClient, ids);
      const resync = () => {
        void queryClient.invalidateQueries({ queryKey: mailKeys.messageLists });
        for (const id of ids)
          void queryClient.invalidateQueries({ queryKey: mailKeys.message(id) });
      };
      try {
        const response = await endpoints.mail.act({
          messageIds: ids,
          action,
          ...(targetFolderId ? { targetFolderId } : {}),
        });
        // Hitungan folder berubah (event WS juga datang; ini cadangan).
        void queryClient.invalidateQueries({ queryKey: mailKeys.sidebar });
        const failed = response.results.find((result) => !result.ok);
        if (failed) {
          resync();
          return { ok: false, message: failed.error?.message ?? MAIL_ACTION_FAILED_MESSAGE };
        }
        return { ok: true };
      } catch (error) {
        resync();
        return { ok: false, message: isApiError(error) ? error.message : t.api.network };
      }
    },
    [queryClient],
  );
}
