import { emailSenderId, type EmailTemplate } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { SelectField } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { useLock } from '../../lib/use-lock';
import { inboxChannelsQuery } from '../inbox/inbox-queries';
import { Segments } from './EmailPreview';
import styles from './EmailTemplates.module.css';

const c = t.emailTemplates;

/**
 * Kirim tes ke alamat akun sendiri (penerima tidak bisa diisi — server selalu memakai alamat akun).
 * Pengirim = channel Email aktif. 10 kali per 10 menit: 429 mengunci tombol dengan hitung mundur.
 */
export function EmailTemplateTestCard({
  template,
  userEmail,
  dirty,
  values,
  onSaveDraft,
}: {
  template: EmailTemplate;
  userEmail: string;
  dirty: boolean;
  /** Contoh nilai variabel draf (dipakai untuk tes draf). */
  values: Record<string, string>;
  /** Simpan perubahan draf dulu; `false` = gagal (pesannya sudah tampil di editor). */
  onSaveDraft: () => Promise<boolean>;
}) {
  const channels = useQuery(inboxChannelsQuery);
  const senders = (channels.data?.channels ?? []).filter(
    (channel) => channel.type === 'email' && channel.enabled,
  );
  const [senderId, setSenderId] = useState('');
  const chosen = senderId || (senders[0] ? emailSenderId('channel', senders[0].id) : '');
  const hasPublished = template.published !== null;
  const [which, setWhich] = useState<'draft' | 'published'>('draft');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const lock = useLock();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const effectiveWhich = hasPublished ? which : 'draft';

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || lock.locked || !chosen) return;
    setPending(true);
    setSent(false);
    setFailure(null);
    try {
      if (effectiveWhich === 'draft' && dirty && !(await onSaveDraft())) return;
      await endpoints.emailTemplates.test(template.id, {
        senderId: chosen,
        which: effectiveWhich,
        ...(effectiveWhich === 'draft' && Object.keys(values).length > 0 ? { values } : {}),
      });
      setSent(true);
    } catch (caught) {
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setFailure(caught);
    } finally {
      setPending(false);
      requestAnimationFrame(() => buttonRef.current?.focus());
    }
  };

  return (
    <section className={styles.card} aria-labelledby="kirim-tes-template-email">
      <div className={styles.cardHead}>
        <h2 id="kirim-tes-template-email" className={styles.cardTitle}>
          {c.testTitle}
        </h2>
        <p className={styles.hint}>{c.testHint(userEmail)}</p>
      </div>
      {channels.isSuccess && senders.length === 0 ? (
        <Notice tone="info">{c.testNoSender}</Notice>
      ) : (
        <form className={styles.form} onSubmit={(event) => void send(event)} noValidate>
          <div className={styles.testFields}>
            <SelectField
              label={c.testSenderLabel}
              value={chosen}
              onChange={(event) => setSenderId(event.target.value)}
              disabled={!channels.isSuccess}
              options={senders.map((channel) => {
                const address = channel.emailAddresses?.[0];
                return {
                  value: emailSenderId('channel', channel.id),
                  label: address ? `${channel.name} · ${address}` : channel.name,
                };
              })}
              className={styles.testSender}
            />
            {hasPublished ? (
              <div className={styles.group}>
                <span className={styles.groupLabel} id="isi-kirim-tes">
                  {c.testWhichLabel}
                </span>
                <Segments
                  labelledBy="isi-kirim-tes"
                  value={which}
                  options={[
                    { value: 'draft', label: c.testWhich.draft },
                    { value: 'published', label: c.testWhich.published },
                  ]}
                  onChange={(value) => setWhich(value === 'published' ? 'published' : 'draft')}
                />
              </div>
            ) : null}
          </div>
          {effectiveWhich === 'draft' && dirty ? (
            <p className={styles.hint}>{c.testSaveFirst}</p>
          ) : null}
          {sent ? (
            <Notice tone="success" role="status">
              {c.testSent(userEmail)}
            </Notice>
          ) : null}
          <FormErrorNotice error={failure} lock={lock} lockedTitle={c.testLockedTitle} />
          <FormActions>
            <SubmitButton
              ref={buttonRef}
              size="md"
              variant="secondary"
              pending={pending}
              pendingLabel={c.testSending}
              lock={lock}
              disabled={!chosen}
            >
              <Icon icon={Send} size={16} />
              {c.testSend}
            </SubmitButton>
          </FormActions>
        </form>
      )}
    </section>
  );
}
