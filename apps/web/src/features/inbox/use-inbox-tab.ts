import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';
import { DEFAULT_INBOX_TAB, parseInboxTab, type InboxTab } from './inbox-search';

const routeApi = getRouteApi('/inbox');

/** Tab aktif Inbox dari URL (`/inbox?tab=…`) dan cara menggantinya. Khusus rute /inbox. */
export function useInboxTab(): { tab: InboxTab; onTabChange: (tab: InboxTab) => void } {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();

  const onTabChange = useCallback(
    (next: InboxTab) => {
      void navigate({
        search: next === DEFAULT_INBOX_TAB ? {} : { tab: next },
        // Ganti tab tidak menumpuk riwayat browser.
        replace: true,
      });
    },
    [navigate],
  );

  return { tab: parseInboxTab(search.tab), onTabChange };
}
