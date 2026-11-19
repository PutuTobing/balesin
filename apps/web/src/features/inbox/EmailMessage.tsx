import { EMAIL_SENDER_VERIFICATION_LABELS, type Message } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, FileCode2, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Icon } from '../../components/ui/Icon';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import styles from './EmailMessage.module.css';

const e = t.inbox.email;

/**
 * Bagian khusus pesan Email di gelembung: subjek, hasil verifikasi pengirim (`fail` = peringatan
 * keras; `unverified` = netral; `pass` = tenang), lampiran yang dilewati, dan tombol versi HTML.
 * Semua isi dari pelanggan dirender sebagai teks.
 */
export function EmailHeader({ message }: { message: Message }) {
  const email = message.email;
  const [htmlOpen, setHtmlOpen] = useState(false);
  if (!email) return null;
  const inbound = message.direction === 'inbound';
  const verification = email.senderVerification ?? (email.authWarning ? 'fail' : 'unverified');
  return (
    <div className={styles.email}>
      {email.subject ? (
        <p className={styles.subject} dir="auto">
          <span className="sr-only">{e.subject}: </span>
          {email.subject}
        </p>
      ) : null}
      {inbound ? (
        verification === 'fail' ? (
          <p className={styles.fail} role="note">
            <Icon icon={CircleAlert} size={16} />
            <span>{EMAIL_SENDER_VERIFICATION_LABELS.fail}</span>
          </p>
        ) : (
          <p className={styles.verification} data-state={verification}>
            <Icon icon={verification === 'pass' ? ShieldCheck : ShieldQuestion} size={16} />
            <span>{EMAIL_SENDER_VERIFICATION_LABELS[verification]}</span>
          </p>
        )
      ) : null}
      {email.skippedAttachments > 0 ? (
        <p className={styles.note}>{e.skippedAttachments(email.skippedAttachments)}</p>
      ) : null}
      {email.hasHtml ? (
        <>
          <Button variant="ghost" className={styles.htmlButton} onClick={() => setHtmlOpen(true)}>
            <Icon icon={FileCode2} size={16} />
            {e.viewHtml}
          </Button>
          {htmlOpen ? (
            <EmailHtmlDialog
              messageId={message.id}
              subject={email.subject}
              onClose={() => setHtmlOpen(false)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Versi HTML email (SUDAH disanitasi server) HANYA di `<iframe sandbox srcdoc>` tanpa
 * `allow-scripts` dan `allow-same-origin`: skrip tidak jalan dan dokumen tidak bisa menyentuh
 * aplikasi, cookie, atau penyimpanan. Tautan di dalamnya tidak bisa membuka jendela (tanpa
 * `allow-popups`).
 */
function EmailHtmlDialog({
  messageId,
  subject,
  onClose,
}: {
  messageId: string;
  subject: string | null;
  onClose: () => void;
}) {
  const html = useQuery({
    queryKey: ['inbox', 'email-html', messageId],
    queryFn: ({ signal }) => endpoints.emailHtml(messageId, signal),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  return (
    <Dialog open title={e.htmlTitle} description={subject ?? undefined} onRequestClose={onClose}>
      <div className={styles.frameWrap}>
        {html.isPending ? (
          <SkeletonRegion className={styles.frameSkeleton}>
            <Skeleton className={styles.skeletonLine} />
            <Skeleton className={styles.skeletonLine} />
          </SkeletonRegion>
        ) : html.isError ? (
          <p className={styles.note} role="alert">
            {isApiError(html.error) && html.error.status === 404
              ? e.htmlMissing
              : isApiError(html.error)
                ? html.error.message
                : t.api.network}
          </p>
        ) : (
          <iframe
            title={e.htmlFrameTitle}
            className={styles.frame}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={html.data.html}
          />
        )}
      </div>
      <p className={styles.note}>{e.htmlNote}</p>
      <DialogActions>
        <Button variant="primary" onClick={onClose}>
          {t.common.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
