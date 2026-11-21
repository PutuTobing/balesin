import { InboxScreen } from './InboxScreen';
import { useInboxTab } from './use-inbox-tab';

/**
 * Keadaan memuat /inbox: layar Inbox yang sama persis, hanya isi daftar chat yang
 * berupa kerangka. Tab aktif tetap dibaca dari URL.
 */
export function InboxSkeleton() {
  const { tab, onTabChange } = useInboxTab();
  return <InboxScreen tab={tab} onTabChange={onTabChange} loading />;
}
