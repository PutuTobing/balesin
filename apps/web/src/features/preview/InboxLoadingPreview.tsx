import { useState } from 'react';
import { InboxScreen } from '../inbox/InboxScreen';
import { DEFAULT_INBOX_TAB, type InboxTab } from '../inbox/inbox-search';

/**
 * Khusus pengembangan: Inbox yang daftar chatnya terus memuat, supaya keadaan itu bisa
 * difoto dan dibandingkan dengan layar jadi. Tidak ikut ke build produksi.
 */
export function InboxLoadingPreview() {
  const [tab, setTab] = useState<InboxTab>(DEFAULT_INBOX_TAB);
  return <InboxScreen tab={tab} onTabChange={setTab} loading />;
}
