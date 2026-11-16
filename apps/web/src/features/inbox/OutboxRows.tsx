import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Clock, FileText, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import styles from './Chat.module.css';
import { removeOutboxItem, sendOutboxItem, type OutboxItem } from './outbox';

const k = t.inbox.compose;

/**
 * Pesan yang sedang dikirim dari browser ini (optimistis), di bawah riwayat. Gagal → alasan dari
 * server + "Kirim ulang" (ID pesan sama: tidak tergandakan) atau "Hapus".
 */
export function OutboxRows({
  items,
  onError,
}: {
  items: OutboxItem[];
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  if (items.length === 0) return null;
  return (
    <ol className={styles.timeline} aria-label={k.sending}>
      {items.map((item) => (
        <li
          key={item.clientMessageId}
          className={`${styles.row} ${styles.outboxRow}`}
          data-dir="out"
        >
          <div className={styles.bubbleWrap}>
            <div className={styles.bubble}>
              {item.kind === 'media' ? (
                item.previewUrl ? (
                  <img src={item.previewUrl} alt="" className={styles.outboxThumb} />
                ) : (
                  <p className={styles.attachment}>
                    <Icon icon={FileText} size={16} />
                    <span dir="auto">{item.file?.name ?? t.inbox.content.document}</span>
                  </p>
                )
              ) : null}
              {item.text.trim() ? (
                <p className={styles.text} dir="auto">
                  {item.text}
                </p>
              ) : null}
              <p className={styles.outboxState} aria-live="polite">
                {item.state === 'sending' ? (
                  <>
                    <Icon icon={Clock} size={16} />
                    {item.kind === 'media' && !item.mediaId ? k.uploading : k.sending}
                  </>
                ) : (
                  <>
                    <Icon icon={CircleAlert} size={16} />
                    {k.notSent}
                  </>
                )}
              </p>
            </div>
            {item.state === 'failed' ? (
              <div className={styles.failedBlock}>
                <p className={styles.failed}>
                  <Icon icon={CircleAlert} size={16} />
                  <span>{isApiError(item.error) ? item.error.message : t.api.network}</span>
                </p>
                <div className={styles.outboxActions}>
                  <Button variant="ghost" onClick={() => removeOutboxItem(item)}>
                    <Icon icon={Trash2} size={16} />
                    {k.discard}
                  </Button>
                  <Button
                    variant="ghost"
                    className={styles.retry}
                    onClick={() => {
                      onError(null);
                      sendOutboxItem(queryClient, item).catch(onError);
                    }}
                  >
                    <Icon icon={RotateCcw} size={16} />
                    {k.resend}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
