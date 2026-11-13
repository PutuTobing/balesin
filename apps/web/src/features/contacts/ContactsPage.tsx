import { ContactsIllustration } from '../../components/illustrations/illustrations';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';

export function ContactsPage() {
  return (
    <Page>
      <EmptyState
        illustration={<ContactsIllustration />}
        title={t.contacts.emptyTitle}
        body={t.contacts.emptyBody}
      />
    </Page>
  );
}
