import { ReportsIllustration } from '../../components/illustrations/illustrations';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';

export function ReportsPage() {
  return (
    <Page title={t.nav.reports} parent={{ to: '/lainnya', label: t.nav.more }}>
      <EmptyState
        illustration={<ReportsIllustration />}
        title={t.reports.emptyTitle}
        body={t.reports.emptyBody}
      />
    </Page>
  );
}
