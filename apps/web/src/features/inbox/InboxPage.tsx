import { InboxScreen } from './InboxScreen';
import { useInboxStream } from './use-inbox-stream';
import { useInboxRoute } from './use-inbox-tab';

/** Halaman /inbox: tab & chat terbuka dari URL, pembaruan real-time lewat WebSocket. */
export function InboxPage() {
  const { tab, onTabChange, chatId, openChat, closeChat, detailOpen, openDetail, closeDetail } =
    useInboxRoute();
  const streamStatus = useInboxStream();
  return (
    <InboxScreen
      tab={tab}
      onTabChange={onTabChange}
      chatId={chatId}
      onOpenChat={openChat}
      onCloseChat={closeChat}
      hpDetailOpen={detailOpen}
      onOpenHpDetail={openDetail}
      onCloseHpDetail={closeDetail}
      streamStatus={streamStatus}
    />
  );
}
