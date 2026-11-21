import type { ChannelWebhookResponse } from '@balesin/shared';
import type { ReactNode } from 'react';
import { useBrand } from '../../brand/brand';
import { CopyButton } from '../../components/ui/CopyButton';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { formatDateTime } from '../../lib/format';
import styles from './Channels.module.css';

const copy = t.channels.webhook;

/**
 * URL webhook + verify token dengan tombol Salin, field yang wajib dilanggan, peringatan bila URL
 * bukan https publik, dan anjuran "Require App Secret Proof" (docs/KONTRAK-API-CHANNEL.md
 * langkah 7). Dipakai langkah Webhook di wizard dan kartu Webhook di halaman nomor.
 */
export function WebhookPanel({
  webhook,
  actions,
  context,
}: {
  webhook: ChannelWebhookResponse;
  /** Wizard menunjuk halaman nomor; halaman nomor menunjuk kartu Kredensial Meta di bawahnya. */
  context: 'wizard' | 'detail';
  /** Aksi tambahan di bawah verify token (mis. "Buat ulang verify token"). */
  actions?: ReactNode;
}) {
  const { productName } = useBrand();
  return (
    <div className={styles.copyRows}>
      {webhook.warning ? (
        <Notice tone="warning" title={copy.warningTitle}>
          {webhook.warning}
        </Notice>
      ) : null}
      <CopyRow
        id={`webhook-url-${webhook.channelId}`}
        label={copy.callbackUrl}
        value={webhook.callbackUrl}
        copyLabel={copy.copyUrlLabel}
        announcement={copy.copiedUrl}
      />
      <CopyRow
        id={`webhook-token-${webhook.channelId}`}
        label={copy.verifyToken}
        value={webhook.verifyToken}
        copyLabel={copy.copyTokenLabel}
        announcement={copy.copiedToken}
        meta={copy.rotatedAt(formatDateTime(webhook.verifyTokenRotatedAt))}
      />
      {actions}
      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>{copy.fieldsTitle}</h3>
        <p className={styles.hint}>{copy.fieldsHint}</p>
        <ul className={styles.fieldChips}>
          {webhook.subscribeFields.map((field) => (
            <li key={field} className={styles.fieldChip}>
              {field}
            </li>
          ))}
        </ul>
      </div>
      <Notice tone="info" title={copy.proofTitle}>
        {copy.proofBody(productName)}
      </Notice>
      {copy.notes.map((note, index) => (
        <div key={note.title} className={styles.subSection}>
          <h3 className={styles.subTitle}>{note.title}</h3>
          <p className={styles.hint}>
            {index === copy.notes.length - 1
              ? `${note.body} ${copy.fixAppSecret[context]}`
              : note.body}
          </p>
        </div>
      ))}
    </div>
  );
}

function CopyRow({
  id,
  label,
  value,
  copyLabel,
  announcement,
  meta,
}: {
  id: string;
  label: string;
  value: string;
  copyLabel: string;
  announcement: string;
  meta?: string;
}) {
  return (
    <div className={styles.copyRow}>
      <span id={`${id}-label`} className={styles.copyLabel}>
        {label}
      </span>
      <div className={styles.copyBox}>
        {/* Teks biasa yang bisa dipilih (bukan isian), supaya bisa disalin manual bila clipboard ditolak. */}
        <code className={styles.copyValue} aria-labelledby={`${id}-label`}>
          {value}
        </code>
        <CopyButton
          text={value}
          label={copy.copy}
          copiedLabel={copy.copied}
          announcement={announcement}
          ariaLabel={copyLabel}
        />
      </div>
      {meta ? <span className={styles.copyMeta}>{meta}</span> : null}
    </div>
  );
}
