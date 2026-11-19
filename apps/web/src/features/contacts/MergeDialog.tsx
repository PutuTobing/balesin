import type { Contact, IdentityConfirmation, MergeContactResponse } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { RadioGroup } from 'radix-ui';
import { useState, type RefObject } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { formatDate } from '../../lib/format';
import { IdentityDialog } from '../identity/IdentityDialog';
import { contactIdentity, formatPhone, formatUsername } from '../inbox/contact-identity';
import { inboxKeys, storeContact } from '../inbox/inbox-queries';
import { olderContact, refreshContactLists } from './contact-queries';
import styles from './Contacts.module.css';

const c = t.contacts;

/** Pengenal yang membedakan dua kontak bernama sama: nomor, email, @username, channel. */
function contactIdentifiers(contact: Contact): string[] {
  const items = [
    formatPhone(contact.phone),
    contact.email ?? null,
    formatUsername(contact.waUsername),
    contact.channelHandle ?? null,
  ].filter((item): item is string => Boolean(item));
  const channel = c.channelLabels[contact.channelType] ?? contact.channelType;
  return items.length > 0 ? [...new Set(items)] : [c.noIdentifier(channel)];
}

/**
 * Gabung kontak "mungkin duplikat" (`contacts.delete`: Owner/Admin). Langkah 1: pilih kontak yang
 * DIPERTAHANKAN (bawaan: yang lebih lama). Langkah 2: konfirmasi identitas → `POST
 * /contacts/:dipertahankan/merge { sourceContactId }`. Kontak lainnya dihapus server.
 */
export function MergeDialog({
  open,
  current,
  other,
  onCancel,
  onMerged,
  returnFocusRef,
}: {
  open: boolean;
  current: Contact;
  other: Contact;
  onCancel: () => void;
  onMerged: (kept: Contact, result: MergeContactResponse) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const recommended = olderContact(current, other);
  const [keepId, setKeepId] = useState(recommended.id);
  const [confirming, setConfirming] = useState(false);
  const kept = keepId === current.id ? current : other;
  const removed = kept.id === current.id ? other : current;

  const cancel = () => {
    setConfirming(false);
    setKeepId(recommended.id);
    onCancel();
  };

  const merge = async (confirmation: IdentityConfirmation) => {
    const result = await endpoints.crm.merge(kept.id, removed.id, confirmation);
    setConfirming(false);
    queryClient.removeQueries({ queryKey: inboxKeys.contact(removed.id) });
    storeContact(queryClient, result.contact);
    refreshContactLists(queryClient);
    // Percakapan kontak yang dihapus pindah: daftar chat & tiket ikut dimuat ulang.
    void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
    void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    onMerged(result.contact, result);
  };

  return (
    <>
      <Dialog
        open={open && !confirming}
        title={c.mergeTitle}
        description={c.mergeBody}
        onRequestClose={cancel}
      >
        <RadioGroup.Root
          className={styles.mergeOptions}
          value={keepId}
          onValueChange={setKeepId}
          aria-label={c.mergeKeepLabel}
        >
          {[current, other].map((contact) => {
            const identity = contactIdentity(contact);
            return (
              <RadioGroup.Item key={contact.id} value={contact.id} className={styles.mergeOption}>
                <span className={styles.radio}>
                  <RadioGroup.Indicator className={styles.radioDot} />
                </span>
                <span className={styles.mergeText}>
                  <span className={styles.mergeName} dir="auto">
                    {identity.name}
                  </span>
                  <span className={styles.mergeMeta}>
                    {contactIdentifiers(contact).join(' · ')}
                  </span>
                  <span className={styles.mergeMeta}>
                    {c.createdOn(formatDate(contact.createdAt))}
                  </span>
                  {contact.id === recommended.id ? (
                    <span className={styles.recommended}>{c.mergeRecommended}</span>
                  ) : null}
                </span>
              </RadioGroup.Item>
            );
          })}
        </RadioGroup.Root>
        <p className={styles.hint}>{c.mergeMoves}</p>
        <DialogActions>
          <Button onClick={cancel}>{c.mergeCancel}</Button>
          <Button variant="primary" onClick={() => setConfirming(true)}>
            {c.mergeContinue}
          </Button>
        </DialogActions>
      </Dialog>
      <IdentityDialog
        open={open && confirming}
        title={c.mergeConfirmTitle}
        body={c.mergeConfirmBody(contactIdentity(kept).name, contactIdentity(removed).name)}
        confirmLabel={c.mergeConfirm}
        pendingLabel={c.merging}
        variant="danger"
        requireCode
        onConfirm={merge}
        onCancel={cancel}
        returnFocusRef={returnFocusRef}
      />
    </>
  );
}
