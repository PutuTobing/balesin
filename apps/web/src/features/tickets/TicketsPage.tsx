import { TicketsIllustration } from '../../components/illustrations/illustrations';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';

export function TicketsPage() {
  return (
    <Page>
      <EmptyState
        illustration={<TicketsIllustration />}
        title={t.tickets.emptyTitle}
        body={t.tickets.emptyBody}
      />
    </Page>
  );
}
