import { getRouteApi, useRouter } from '@tanstack/react-router';
import { useCallback, useRef } from 'react';
import { DEFAULT_INBOX_TAB, parseInboxTab, type InboxTab } from './inbox-search';

const routeApi = getRouteApi('/_app/inbox');

export interface InboxRoute {
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  /** Percakapan yang sedang dibuka (`?chat=`), atau `null`. */
  chatId: string | null;
  /**
   * Buka percakapan. `push` (HP): masuk riwayat browser supaya tombol/gesture kembali menutup
   * chat. Desktop mengganti alamat saja supaya berpindah chat tidak menumpuk riwayat.
   */
  openChat: (conversationId: string, options?: { push?: boolean }) => void;
  /** Tutup percakapan (kembali ke daftar). */
  closeChat: () => void;
  /** HP: panel detail sebagai layar bertumpuk (`&detail=1`). */
  detailOpen: boolean;
  openDetail: () => void;
  closeDetail: () => void;
}

/** Tab aktif & chat terbuka dari URL (`/inbox?tab=…&chat=…`). Khusus rute /inbox. */
export function useInboxRoute(): InboxRoute {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const router = useRouter();
  // Chat dibuka dari daftar dengan entri riwayat baru: "kembali" = langkah mundur browser,
  // bukan entri baru (yang membuat tombol kembali browser membuka chat itu lagi).
  const pushedFromList = useRef(false);
  const pushedDetail = useRef(false);

  const onTabChange = useCallback(
    (next: InboxTab) => {
      void navigate({
        search: (prev) => ({ ...prev, tab: next === DEFAULT_INBOX_TAB ? undefined : next }),
        // Ganti tab tidak menumpuk riwayat browser.
        replace: true,
      });
    },
    [navigate],
  );

  const openChat = useCallback(
    (conversationId: string, options: { push?: boolean } = {}) => {
      pushedFromList.current = options.push === true;
      void navigate({
        search: (prev) => ({ ...prev, chat: conversationId }),
        replace: options.push !== true,
      });
    },
    [navigate],
  );

  const closeChat = useCallback(() => {
    if (pushedFromList.current) {
      pushedFromList.current = false;
      router.history.back();
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, chat: undefined, detail: undefined }),
      replace: true,
    });
  }, [navigate, router]);

  const openDetail = useCallback(() => {
    pushedDetail.current = true;
    void navigate({ search: (prev) => ({ ...prev, detail: 1 as const }) });
  }, [navigate]);

  const closeDetail = useCallback(() => {
    if (pushedDetail.current) {
      pushedDetail.current = false;
      router.history.back();
      return;
    }
    void navigate({ search: (prev) => ({ ...prev, detail: undefined }), replace: true });
  }, [navigate, router]);

  return {
    tab: parseInboxTab(search.tab),
    onTabChange,
    chatId: search.chat ?? null,
    openChat,
    closeChat,
    detailOpen: search.detail === 1 && search.chat !== undefined,
    openDetail,
    closeDetail,
  };
}

/** Tab aktif Inbox dari URL dan cara menggantinya (dipakai kerangka memuat). */
export function useInboxTab(): { tab: InboxTab; onTabChange: (tab: InboxTab) => void } {
  const { tab, onTabChange } = useInboxRoute();
  return { tab, onTabChange };
}
