import { BroadcastIllustration } from '../../components/illustrations/illustrations';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';

export function BroadcastPage() {
  return (
    <Page>
      <EmptyState
        illustration={<BroadcastIllustration />}
        title={t.broadcast.emptyTitle}
        body={t.broadcast.emptyBody}
      />
    </Page>
  );
}
