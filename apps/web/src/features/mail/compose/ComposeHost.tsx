import {
  MAIL_OUTBOX_HOLD_MESSAGES,
  MAIL_SEND_FAILURE_MESSAGES,
  type MailOutboxHoldReason,
  type MailSendFailureReason,
} from '@balesin/shared';
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Icon } from '../../../components/ui/Icon';
import { t } from '../../../i18n/id';
import { isApiError } from '../../../lib/api/client';
import { endpoints } from '../../../lib/api/endpoints';
import { useCountdown } from '../../../lib/use-countdown';
import { onMailSignal } from '../mail-signals';
import {
  clearComposeNotice,
  dismissSendToast,
  openCompose,
  patchSendToast,
  useComposeStore,
  type SendToastState,
} from './compose-store';
import { ComposeWindow } from './ComposeWindow';
import styles from './Compose.module.css';

const c = t.mail.compose;
const s = c.toast;

/** Toast "Terkirim" hilang sendiri; gagal/tertahan tetap sampai ditutup. */
const SENT_TOAST_MS = 5_000;
/** Cadangan bila event WS `mail.outbox.updated` tidak sampai. */
const OUTBOX_POLL_MS = 3_000;
/** Tombol Batalkan hilang 1 dtk sebelum `sendAfter` (kontrak §9.1: tidak menjanjikan pembatalan yang kalah balapan). */
const UNDO_MARGIN_MS = 1_000;

interface ComposeHostProps {
  /** HP: jendela tulis layar penuh. */
  isHp: boolean;
  onOpenMessage: (messageId: string) => void;
}

/**
 * Lapisan jendela tulis + toast kirim di menu Email. Jendela: desktop mengambang di kanan bawah
 * (satu terbuka, sisanya diperkecil), HP layar penuh. Toast: "Email akan dikirim dari … · Batalkan
 * (hitung mundur) · Kirim sekarang", lalu Mengirim → Terkirim / Gagal (event WS, cadangan tanya
 * ulang).
 */
export function ComposeHost({ isHp, onOpenMessage }: ComposeHostProps) {
  const { windows, toasts, notice } = useComposeStore();

  useEffect(
    () =>
      onMailSignal((signal) => {
        if (signal.type !== 'outbox.updated') return;
        patchSendToast(signal.outboxId, {
          status: signal.status,
          message: toastMessage(signal.status, signal.holdReason, signal.failureReason),
        });
      }),
    [],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(clearComposeNotice, 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const maximized = !isHp && windows.some((window) => window.mode === 'maximized');
  const fullscreenKey = isHp
    ? [...windows].reverse().find((window) => window.mode !== 'minimized')?.key
    : undefined;

  return (
    <>
      {maximized ? <div className={styles.scrim} aria-hidden="true" /> : null}
      {windows.length > 0 ? (
        <div className={styles.windows} data-hp={isHp ? '' : undefined}>
          {windows.map((window) => (
            <ComposeWindow
              key={window.key}
              window={window}
              fullscreen={window.key === fullscreenKey}
              onOpenMessage={onOpenMessage}
            />
          ))}
        </div>
      ) : null}
      <div className={styles.toasts} role="region" aria-label={s.region}>
        {notice ? (
          <div className={styles.toast} role="status">
            <span className={styles.toastText}>{c.tooManyWindows}</span>
            <button
              type="button"
              className={styles.toastClose}
              aria-label={s.dismiss}
              onClick={clearComposeNotice}
            >
              <Icon icon={X} size={16} />
            </button>
          </div>
        ) : null}
        {toasts.map((toast) => (
          <SendToast key={toast.key} toast={toast} />
        ))}
      </div>
    </>
  );
}

function toastMessage(
  status: string,
  holdReason: string | null,
  failureReason: string | null,
): string | null {
  if ((status === 'failed' || status === 'delivery_unknown') && failureReason) {
    return MAIL_SEND_FAILURE_MESSAGES[failureReason as MailSendFailureReason] ?? null;
  }
  if (status === 'queued' && holdReason) {
    return MAIL_OUTBOX_HOLD_MESSAGES[holdReason as MailOutboxHoldReason] ?? null;
  }
  return null;
}

function SendToast({ toast }: { toast: SendToastState }) {
  const { outbox, status } = toast;
  // Lama masa batal dari jam server (selisih dua waktu server), dihitung mundur dengan jam lokal.
  const deadline = useMemo(() => {
    const window = Math.max(0, Date.parse(outbox.sendAfter) - Date.parse(outbox.createdAt));
    return { until: toast.createdAt + window, startedAt: toast.createdAt };
  }, [outbox.createdAt, outbox.sendAfter, toast.createdAt]);
  const remaining = useCountdown(status === 'pending' ? deadline : null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'pending') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [status]);
  const canUndo =
    (status === 'pending' && deadline.until - now > UNDO_MARGIN_MS) || status === 'canceling';
  const waiting = status === 'pending' || status === 'queued' || status === 'sending';

  // Cadangan WS: setelah masa batal lewat, tanya status ke server sampai final.
  useEffect(() => {
    if (!waiting || canUndo) return;
    const timer = window.setInterval(() => {
      void endpoints.mail
        .outboxItem(outbox.id)
        .then((response) => {
          const item = response.outbox;
          patchSendToast(outbox.id, {
            outbox: item,
            status: item.status,
            message:
              item.status === 'failed' || item.status === 'delivery_unknown'
                ? (item.failure?.message ?? null)
                : toastMessage(item.status, item.holdReason, null),
          });
        })
        .catch(() => undefined);
    }, OUTBOX_POLL_MS);
    return () => window.clearInterval(timer);
  }, [canUndo, outbox.id, waiting]);

  // Terkirim: hilang sendiri.
  useEffect(() => {
    if (status !== 'sent') return;
    const timer = window.setTimeout(() => dismissSendToast(outbox.id), SENT_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [outbox.id, status]);

  const undo = async () => {
    patchSendToast(outbox.id, { status: 'canceling', message: null });
    try {
      const response = await endpoints.mail.cancelOutbox(outbox.id);
      dismissSendToast(outbox.id);
      const draftId = response.draftId ?? outbox.draftId;
      if (draftId) openCompose({ kind: 'draft', draftId, subject: outbox.subject });
    } catch (error) {
      patchSendToast(outbox.id, {
        status: 'sending',
        message: isApiError(error) ? error.message : t.api.network,
      });
    }
  };

  const sendNow = async () => {
    try {
      const response = await endpoints.mail.sendOutboxNow(outbox.id);
      patchSendToast(outbox.id, { outbox: response.outbox, status: response.outbox.status });
    } catch (error) {
      patchSendToast(outbox.id, { message: isApiError(error) ? error.message : t.api.network });
    }
  };

  let text: string;
  if (status === 'canceling') text = s.canceling;
  else if (canUndo) text = s.willSend(outbox.identity.address);
  else if (status === 'sent') {
    text =
      outbox.rejectedRecipients.length > 0
        ? s.rejectedSome(outbox.rejectedRecipients.length)
        : outbox.sentCopy.state === 'failed'
          ? s.sentCopyFailed
          : s.sent;
  } else if (status === 'delivery_unknown') text = s.unknown;
  else if (status === 'failed') text = s.failed;
  else if (status === 'queued' && toast.message) text = s.held;
  else text = s.sending;

  // `delivery_unknown` (review 9B R4) = final seperti `failed`, tidak dicoba ulang.
  const failed = status === 'failed' || status === 'delivery_unknown';
  const final = status === 'sent' || failed || status === 'canceled';
  const showDismiss = final || (status === 'queued' && toast.message !== null);

  return (
    <div
      className={styles.toast}
      role={failed ? 'alert' : 'status'}
      data-tone={failed ? 'danger' : undefined}
    >
      <span className={styles.toastText}>
        {text}
        {toast.message && !canUndo ? (
          <span className={styles.toastDetail}>{toast.message}</span>
        ) : null}
      </span>
      {canUndo ? (
        <>
          <button
            type="button"
            className={styles.toastAction}
            aria-label={s.undoLabel(remaining)}
            disabled={status === 'canceling'}
            onClick={() => void undo()}
          >
            {s.undo}
          </button>
          <span className={styles.countdown} aria-hidden="true">
            {remaining}
          </span>
          <button
            type="button"
            className={styles.toastSecondary}
            disabled={status === 'canceling'}
            onClick={() => void sendNow()}
          >
            {s.sendNow}
          </button>
        </>
      ) : null}
      {status === 'failed' && outbox.draftId ? (
        <button
          type="button"
          className={styles.toastAction}
          onClick={() => {
            dismissSendToast(outbox.id);
            openCompose({ kind: 'draft', draftId: outbox.draftId ?? '', subject: outbox.subject });
          }}
        >
          {s.openDraft}
        </button>
      ) : null}
      {showDismiss ? (
        <button
          type="button"
          className={styles.toastClose}
          aria-label={s.dismiss}
          onClick={() => dismissSendToast(outbox.id)}
        >
          <Icon icon={X} size={16} />
        </button>
      ) : null}
    </div>
  );
}
