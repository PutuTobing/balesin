import {
  EMAIL_HOURLY_LIMIT_DEFAULT,
  EMAIL_HOURLY_LIMIT_MAX,
  EMAIL_SENDER_BLOCKED_LABELS,
  parseEmailSenderId,
  updateEmailSenderLimitRequestSchema,
  type EmailSenderSettings,
  type EmailSenderState,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pause, Play } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline, formatTime } from '../../lib/format';
import { useCan } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { emailSendersQuery, storeEmailSender } from './email-sender-queries';
import { parseLimit } from './parse-limit';
import styles from './SendingLimits.module.css';

const copy = t.sendingLimits;

const STATE_TONE: Record<EmailSenderState, StatusTone> = {
  ok: 'success',
  throttled: 'warning',
  paused: 'warning',
  blocked: 'danger',
  disabled: 'neutral',
};

/**
 * Pengaturan → Batas kirim → "Email per pengirim" (tahap 9.1, KONTRAK-API-EMAIL-KIRIM §8.1):
 * batas per jam (menaikkan = konfirmasi identitas, menurunkan tidak), jeda (arah aman, tanpa
 * konfirmasi), lanjutkan (`sending.resume` + konfirmasi; juga melepas `blocked`/`throttled`).
 */
export function EmailSendersCard() {
  const senders = useQuery(emailSendersQuery);
  return (
    <section className={styles.card} aria-labelledby="batas-email">
      <div className={styles.cardHead}>
        <h2 id="batas-email" className={styles.cardTitle}>
          {copy.emailTitle}
        </h2>
        <p className={styles.hint}>{copy.emailHint}</p>
      </div>
      {senders.isPending ? (
        <SkeletonRegion className={styles.senders}>
          {[0, 1].map((index) => (
            <Skeleton key={index} className={styles.senderSkeleton} />
          ))}
        </SkeletonRegion>
      ) : senders.isError ? (
        <Notice
          tone="danger"
          role="alert"
          title={copy.emailLoadFailed}
          actions={
            <Button onClick={() => void senders.refetch()} loading={senders.isFetching}>
              {t.common.retry}
            </Button>
          }
        >
          {isApiError(senders.error) ? senders.error.message : t.api.network}
        </Notice>
      ) : senders.data.senders.length === 0 ? (
        <div className={styles.emptySenders}>
          <p className={styles.statusTitle}>{copy.emailEmptyTitle}</p>
          <p className={styles.statusBody}>{copy.emailEmptyBody}</p>
          <Button asChild>
            <Link to="/pengaturan/channel">{copy.emailEmptyAction}</Link>
          </Button>
        </div>
      ) : (
        <ul className={styles.senders} aria-label={copy.emailListLabel}>
          {senders.data.senders.map((sender) => (
            <SenderRow key={sender.id} sender={sender} />
          ))}
        </ul>
      )}
    </section>
  );
}

function stateText(sender: EmailSenderSettings): string | null {
  switch (sender.state) {
    case 'throttled':
      return sender.throttledUntil
        ? copy.emailThrottled(formatTime(sender.throttledUntil))
        : copy.emailThrottledNoTime;
    case 'paused':
      if (!sender.pausedAt) return null;
      return sender.pausedBy
        ? copy.emailPausedBy(sender.pausedBy.name, formatDateTimeInline(sender.pausedAt))
        : copy.emailPausedAt(formatDateTimeInline(sender.pausedAt));
    case 'blocked':
      return sender.blockedReason ? EMAIL_SENDER_BLOCKED_LABELS[sender.blockedReason] : null;
    case 'disabled':
      return copy.emailDisabled;
    default:
      return null;
  }
}

type Message = { tone: 'success' | 'info' | 'danger'; text: string };

function SenderRow({ sender }: { sender: EmailSenderSettings }) {
  const queryClient = useQueryClient();
  const canResume = useCan('sending.resume');
  const [limit, setLimit] = useState(sender.hourlyLimit.toLocaleString('id-ID'));
  const [limitError, setLimitError] = useState<string | null>(null);
  const [raising, setRaising] = useState<number | null>(null);
  const [asking, setAsking] = useState<'pause' | 'resume' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);

  const store = (next: EmailSenderSettings) => {
    storeEmailSender(queryClient, next);
    setLimit(next.hourlyLimit.toLocaleString('id-ID'));
  };
  const fail = (caught: unknown) =>
    setMessage({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });

  const submitLimit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setMessage(null);
    const parsed = updateEmailSenderLimitRequestSchema.safeParse({
      hourlyLimit: parseLimit(limit),
    });
    if (!parsed.success) {
      setLimitError(copy.emailLimitInvalid(EMAIL_HOURLY_LIMIT_MAX));
      return;
    }
    setLimitError(null);
    const next = parsed.data.hourlyLimit;
    if (next === sender.hourlyLimit) {
      setMessage({ tone: 'info', text: copy.emailLimitUnchanged });
      return;
    }
    if (next > sender.hourlyLimit) {
      setRaising(next);
      return;
    }
    setSaving(true);
    try {
      const { sender: updated } = await endpoints.emailSenders.updateLimit(sender.id, {
        hourlyLimit: next,
      });
      store(updated);
      setMessage({ tone: 'success', text: copy.emailLimitSaved(sender.name) });
    } catch (caught) {
      fail(caught);
    } finally {
      setSaving(false);
    }
  };

  const raise = async (confirmation: IdentityConfirmation) => {
    if (raising === null) return;
    try {
      const { sender: updated } = await endpoints.emailSenders.updateLimit(sender.id, {
        hourlyLimit: raising,
        confirmation,
      });
      store(updated);
      setRaising(null);
      setMessage({ tone: 'success', text: copy.emailLimitSaved(sender.name) });
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setRaising(null);
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        setLimitError(caught.details[0]?.message ?? caught.message);
      } else {
        fail(caught);
      }
    }
  };

  const resume = async (confirmation: IdentityConfirmation) => {
    try {
      const { sender: updated } = await endpoints.emailSenders.resume(sender.id, confirmation);
      store(updated);
      setAsking(null);
      setMessage({ tone: 'success', text: copy.emailResumed(sender.name) });
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setAsking(null);
      fail(caught);
    }
  };

  const ratio = sender.sentLastHour / Math.max(1, sender.hourlyLimit);
  const tone = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'normal';
  const explanation = stateText(sender);
  const channelId = parseEmailSenderId(sender.id)?.id;
  const needsChannel = sender.state === 'blocked' || sender.state === 'disabled';
  // Ditahan server email: pengiriman lanjut sendiri setelah jeda dari server; "Lanjutkan" di sini
  // hanya akan mengabaikan permintaan server (akun bisa diblokir penyedia), jadi tidak ditawarkan.
  const resumable = sender.state === 'paused' || sender.state === 'blocked';
  const pausable = sender.state === 'ok' || sender.state === 'throttled';
  const limitChanged = parseLimit(limit) !== sender.hourlyLimit;

  return (
    <li className={styles.sender} data-state={sender.state}>
      <div className={styles.senderHead}>
        <div className={styles.senderName}>
          <p className={styles.statusTitle} dir="auto">
            {sender.name}
          </p>
          <p className={styles.senderAddress}>
            <code>{sender.address}</code>
            <span aria-hidden="true"> · </span>
            <span>{copy.emailSmtp[sender.smtpMode]}</span>
          </p>
        </div>
        <StatusBadge tone={STATE_TONE[sender.state]} label={copy.emailState[sender.state]} />
      </div>

      {explanation ? (
        <div className={styles.senderState} data-tone={STATE_TONE[sender.state]}>
          <p>{explanation}</p>
          {sender.state === 'blocked' ? <p>{copy.emailBlockedHint}</p> : null}
          {needsChannel && channelId ? (
            <Link
              to="/pengaturan/channel/lain/$channelId"
              params={{ channelId }}
              className={styles.inlineLink}
            >
              {copy.emailOpenChannel}
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className={styles.usage}>
        <p className={styles.usageText}>
          {copy.emailUsage(sender.sentLastHour, sender.hourlyLimit)}
          <span className={styles.usageQueued}> · {copy.emailQueued(sender.queued)}</span>
        </p>
        <div
          className={styles.meter}
          role="meter"
          aria-label={copy.emailUsageLabel(sender.name)}
          aria-valuemin={0}
          aria-valuemax={sender.hourlyLimit}
          aria-valuenow={Math.min(sender.sentLastHour, sender.hourlyLimit)}
          data-tone={tone}
        >
          <span className={styles.meterFill} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      </div>

      <form className={styles.senderForm} onSubmit={(event) => void submitLimit(event)} noValidate>
        <TextField
          label={copy.emailLimitLabel}
          hint={copy.emailLimitHint(EMAIL_HOURLY_LIMIT_DEFAULT, EMAIL_HOURLY_LIMIT_MAX)}
          value={limit}
          onChange={(event) => {
            setLimit(event.target.value);
            setLimitError(null);
            setMessage(null);
          }}
          error={limitError}
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          className={styles.senderLimit}
        />
        <div className={styles.senderActions}>
          {pausable ? (
            <Button
              ref={actionRef}
              aria-label={copy.emailPauseFor(sender.name)}
              onClick={() => {
                setMessage(null);
                setAsking('pause');
              }}
            >
              <Icon icon={Pause} size={16} />
              {copy.emailPause}
            </Button>
          ) : null}
          {resumable && canResume ? (
            <Button
              ref={pausable ? undefined : actionRef}
              variant="primary"
              aria-label={copy.emailResumeFor(sender.name)}
              onClick={() => {
                setMessage(null);
                setAsking('resume');
              }}
            >
              <Icon icon={Play} size={16} />
              {copy.emailResume}
            </Button>
          ) : null}
          <Button
            ref={saveRef}
            type="submit"
            variant={limitChanged ? 'primary' : 'secondary'}
            disabled={!limitChanged && !saving}
            loading={saving}
            aria-label={copy.emailLimitSaveFor(sender.name)}
          >
            {copy.emailLimitSave}
          </Button>
        </div>
      </form>
      {resumable && !canResume ? <p className={styles.hint}>{copy.emailResumeNotAllowed}</p> : null}
      {message ? (
        <Notice tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>
          {message.text}
        </Notice>
      ) : null}

      {asking === 'pause' ? (
        <PauseSenderDialog
          sender={sender}
          onClose={() => {
            setAsking(null);
            requestAnimationFrame(() => actionRef.current?.focus());
          }}
          onPaused={(next) => {
            store(next);
            setAsking(null);
            setMessage({ tone: 'success', text: copy.emailPausedDone(sender.name) });
          }}
        />
      ) : null}
      <IdentityDialog
        open={asking === 'resume'}
        title={copy.emailResumeTitle(sender.name)}
        body={copy.emailResumeBody}
        confirmLabel={copy.emailResume}
        pendingLabel={copy.emailResuming}
        variant="primary"
        requireCode
        returnFocusRef={actionRef}
        onCancel={() => setAsking(null)}
        onConfirm={resume}
      />
      <IdentityDialog
        open={raising !== null}
        title={copy.emailRaiseTitle}
        body={copy.emailRaiseBody(sender.name, sender.hourlyLimit, raising ?? sender.hourlyLimit)}
        confirmLabel={copy.emailLimitSave}
        pendingLabel={copy.saving}
        variant="primary"
        requireCode
        returnFocusRef={saveRef}
        onCancel={() => setRaising(null)}
        onConfirm={raise}
      />
    </li>
  );
}

function PauseSenderDialog({
  sender,
  onClose,
  onPaused,
}: {
  sender: EmailSenderSettings;
  onClose: () => void;
  onPaused: (sender: EmailSenderSettings) => void;
}) {
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    setPending(true);
    try {
      const { sender: updated } = await endpoints.emailSenders.pause(
        sender.id,
        reason.trim() || undefined,
      );
      onPaused(updated);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      title={copy.emailPauseTitle(sender.name)}
      description={copy.emailPauseBody}
      onRequestClose={onClose}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <TextAreaField
          label={copy.reasonLabel}
          hint={copy.reasonHint}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={200}
          dir="auto"
        />
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{copy.cancel}</Button>
          <Button type="submit" variant="danger" loading={pending}>
            {pending ? copy.emailPausing : copy.emailPauseConfirm}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
