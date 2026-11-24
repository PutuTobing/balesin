import {
  CONTACT_EXPORT_PARTIAL_REASON,
  type Contact,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { useCan } from '../auth/session';
import { IdentityDialog } from '../identity/IdentityDialog';
import styles from './ContactPanel.module.css';
import { forgetConversation, inboxKeys } from './inbox-queries';

const p = t.inbox.panel;

/**
 * Data pribadi kontak (UU PDP): ekspor JSON (`contacts.export`) dan hapus permanen
 * (`contacts.delete`, konfirmasi identitas). Setelah dihapus semua chat kontak itu dibuang dari
 * layar dan chat ini ditutup.
 */
export function ContactPrivacy({
  contact,
  conversationId,
  onDeleted,
}: {
  contact: Contact;
  /** Chat yang sedang terbuka (panel detail inbox); kosong di halaman Kontak. */
  conversationId?: string;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const canExport = useCan('contacts.export');
  const canDelete = useCan('contacts.delete');
  const [deleting, setDeleting] = useState(false);
  const [done, setDone] = useState(false);
  /** Tahap 9.0: alasan ekspor tidak lengkap (akses per channel), `null` = lengkap. */
  const [partial, setPartial] = useState<string | null>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);

  const exportData = useMutation({
    mutationFn: () => endpoints.inbox.exportContact(contact.id),
    onMutate: () => {
      setDone(false);
      setPartial(null);
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `kontak-${String(contact.number)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPartial(data.partial ? (data.partialReason ?? CONTACT_EXPORT_PARTIAL_REASON) : null);
      setDone(true);
    },
  });

  if (!canExport && !canDelete) return null;

  const remove = async (confirmation: IdentityConfirmation) => {
    await endpoints.inbox.deleteContact(contact.id, confirmation);
    setDeleting(false);
    queryClient.removeQueries({ queryKey: inboxKeys.contact(contact.id) });
    if (conversationId) forgetConversation(queryClient, conversationId);
    // Chat kontak ini ikut terhapus: daftar chat & kontak dimuat ulang.
    void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
    void queryClient.invalidateQueries({ queryKey: ['crm', 'contacts'] });
    onDeleted?.();
  };

  return (
    <section className={styles.section} aria-labelledby="detail-data-pribadi">
      <h3 id="detail-data-pribadi" className={styles.sectionTitle}>
        {p.privacy}
      </h3>
      <p className={styles.hint}>{p.privacyHint}</p>
      <div className={styles.privacyActions}>
        {canExport ? (
          <Button
            onClick={() =>
              // JSON berisi data pribadi: jangan dibiarkan di cache mutasi setelah diunduh.
              exportData.mutate(undefined, { onSuccess: () => exportData.reset() })
            }
            loading={exportData.isPending}
          >
            {exportData.isPending ? null : <Icon icon={Download} size={16} />}
            {exportData.isPending ? p.exporting : p.exportContact}
          </Button>
        ) : null}
        {canDelete ? (
          // Pola Detail anggota/channel: merah penuh hanya di dialog konfirmasi.
          <Button ref={deleteRef} className={styles.dangerText} onClick={() => setDeleting(true)}>
            <Icon icon={Trash2} size={16} />
            {p.deleteContact}
          </Button>
        ) : null}
      </div>
      {done && partial ? (
        <Notice tone="warning" role="status" title={p.exportedPartial}>
          {partial}
        </Notice>
      ) : done ? (
        <Notice tone="success" role="status">
          {p.exported}
        </Notice>
      ) : null}
      {exportData.isError ? (
        <Notice tone="danger" role="alert">
          {isApiError(exportData.error) ? exportData.error.message : t.api.network}
        </Notice>
      ) : null}
      {canDelete ? (
        <IdentityDialog
          open={deleting}
          title={p.deleteContactTitle}
          body={p.deleteContactBody}
          confirmLabel={p.deleteContactConfirm}
          pendingLabel={p.deletingContact}
          variant="danger"
          requireCode
          onConfirm={remove}
          onCancel={() => setDeleting(false)}
          returnFocusRef={deleteRef}
        />
      ) : null}
    </section>
  );
}
