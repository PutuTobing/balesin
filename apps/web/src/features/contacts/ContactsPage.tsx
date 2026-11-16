import { useNavigate } from '@tanstack/react-router';
import { ContactsIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';

/**
 * Daftar kontak belum dibangun (Fase berikutnya): keadaan "sedang disiapkan" yang jujur, tanpa
 * tanggal, dan jalan keluar ke tempat data kontak sudah bisa dikelola (panel detail chat).
 */
export function ContactsPage() {
  const navigate = useNavigate();
  return (
    <Page>
      <EmptyState
        illustration={<ContactsIllustration />}
        title={t.contacts.emptyTitle}
        body={t.contacts.emptyBody}
        actions={
          <Button variant="primary" onClick={() => void navigate({ to: '/inbox' })}>
            {t.contacts.openInbox}
          </Button>
        }
      />
    </Page>
  );
}
