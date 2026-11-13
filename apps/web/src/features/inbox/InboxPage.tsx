import { InboxScreen } from './InboxScreen';
import { useInboxTab } from './use-inbox-tab';

/** Halaman /inbox. */
export function InboxPage() {
  const { tab, onTabChange } = useInboxTab();
  return <InboxScreen tab={tab} onTabChange={onTabChange} />;
}
