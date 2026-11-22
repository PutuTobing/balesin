import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { TextAreaField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { emailSendersQuery } from '../sending-limits/email-sender-queries';
import styles from './Integrations.module.css';

const copy = t.apiKeys;

/**
 * Akses email per API key (tahap 9.1): pengirim yang boleh dipakai (wajib ≥ 1, tanpa pilihan
 * "semua") + allowlist host URL lampiran (hanya bila key boleh mengirim).
 */
export function ApiKeyEmailFields({
  senderIds,
  onSenderIds,
  hosts,
  onHosts,
  showHosts,
  errors,
}: {
  senderIds: ReadonlySet<string>;
  onSenderIds: (next: Set<string>) => void;
  hosts: string;
  onHosts: (next: string) => void;
  showHosts: boolean;
  errors: { senders?: string; hosts?: string };
}) {
  const senders = useQuery(emailSendersQuery);
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(senderIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSenderIds(next);
  };

  return (
    <>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{copy.emailSendersLabel}</legend>
        <p className={styles.hint}>{copy.emailSendersHint}</p>
        {senders.isPending ? (
          <SkeletonRegion className={styles.options}>
            <Skeleton className={styles.skeletonLine} />
            <Skeleton className={styles.skeletonLine} />
          </SkeletonRegion>
        ) : senders.isError ? (
          <Notice
            tone="danger"
            role="alert"
            actions={
              <Button variant="ghost" onClick={() => void senders.refetch()}>
                {t.common.retry}
              </Button>
            }
          >
            {copy.emailSendersFailed}
          </Notice>
        ) : senders.data.senders.length === 0 ? (
          <Notice tone="warning">{copy.emailSendersEmpty}</Notice>
        ) : (
          <div className={styles.options}>
            {senders.data.senders.map((sender) => (
              <Checkbox
                key={sender.id}
                checked={senderIds.has(sender.id)}
                onChange={(event) => toggle(sender.id, event.target.checked)}
              >
                <span className={styles.optionText}>
                  <span dir="auto">{sender.name}</span>
                  <span className={styles.optionHint}>
                    <code className={styles.monoSmall}>{sender.address}</code>
                    {sender.state === 'disabled' ? ` · ${copy.emailSenderDisabled}` : ''}
                  </span>
                </span>
              </Checkbox>
            ))}
          </div>
        )}
        {errors.senders ? (
          <p className={styles.fieldError} role="alert">
            {errors.senders}
          </p>
        ) : null}
      </fieldset>
      {showHosts ? (
        <TextAreaField
          label={copy.emailHostsLabel}
          optional
          hint={copy.emailHostsHint}
          value={hosts}
          onChange={(event) => onHosts(event.target.value)}
          error={errors.hosts}
          rows={3}
          spellCheck={false}
          autoCapitalize="none"
          className={styles.monoField}
        />
      ) : null}
    </>
  );
}
