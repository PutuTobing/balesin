import {
  SENDING_LIMIT_BOUNDS,
  pauseSendingRequestSchema,
  updateSendingLimitsRequestSchema,
  type IdentityConfirmation,
  type SendingLimits,
  type UpdateSendingLimitsRequest,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonPause, Play } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { FormActions } from '../../components/ui/FormActions';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useCan } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { BroadcastSettingsCard } from '../broadcast/BroadcastSettingsCard';
import { EmailSendersCard } from './EmailSendersCard';
import { inboxKeys, sendingLimitsQuery } from '../inbox/inbox-queries';
import { parseLimit } from './parse-limit';
import styles from './SendingLimits.module.css';

const copy = t.sendingLimits;

type LimitKey = keyof typeof SENDING_LIMIT_BOUNDS;
const LIMIT_KEYS: LimitKey[] = ['dailyPerOrganization', 'dailyPerUser', 'perConversationPerMinute'];
type LimitValues = Record<LimitKey, string>;

/** Nilai tersimpan dengan pemisah ribuan ("5.000"); `parseLimit` membuang titiknya lagi. */
const valuesFrom = (limits: SendingLimits): LimitValues => ({
  dailyPerOrganization: limits.dailyPerOrganization.toLocaleString('id-ID'),
  dailyPerUser: limits.dailyPerUser.toLocaleString('id-ID'),
  perConversationPerMinute: limits.perConversationPerMinute.toLocaleString('id-ID'),
});

/**
 * Pengaturan → Batas kirim & rem darurat (SECURITY.md §5). Tarik rem tanpa konfirmasi identitas
 * (arah aman, harus cepat); ubah batas dan lanjutkan pengiriman dengan konfirmasi identitas.
 * Perubahan dari pengguna lain tiba lewat event `sending.changed` (cache yang sama dengan inbox).
 */
export function SendingLimitsPage() {
  const limits = useQuery(sendingLimitsQuery);
  return (
    <Page>
      <div className={styles.content}>
        <p className={styles.intro}>{copy.intro}</p>
        {limits.data ? (
          <>
            <BrakeCard limits={limits.data.limits} />
            <LimitsCard limits={limits.data.limits} />
            <EmailSendersCard />
            <BroadcastSettingsCard />
          </>
        ) : limits.isPending ? (
          <PageSkeleton />
        ) : (
          <Notice
            tone="danger"
            role="alert"
            title={copy.loadFailedTitle}
            actions={
              <Button onClick={() => void limits.refetch()} loading={limits.isFetching}>
                {t.common.retry}
              </Button>
            }
          >
            {isApiError(limits.error) ? limits.error.message : t.api.network}
          </Notice>
        )}
      </div>
    </Page>
  );
}

/** Simpan jawaban server ke cache bersama inbox (banner, composer, menu Pengaturan). */
function useStoreLimits() {
  const queryClient = useQueryClient();
  return (limits: SendingLimits) => {
    queryClient.setQueryData(inboxKeys.sendingLimits, { limits });
    queryClient.setQueryData(inboxKeys.sendingStatus, { paused: limits.paused !== null });
    if (!limits.paused) queryClient.setQueryData(inboxKeys.sendingPaused, false);
  };
}

// ── Rem darurat ─────────────────────────────────────────────────────────────

function BrakeCard({ limits }: { limits: SendingLimits }) {
  const store = useStoreLimits();
  const canResume = useCan('sending.resume');
  const [asking, setAsking] = useState<'pause' | 'resume' | null>(null);
  const [done, setDone] = useState<'paused' | 'resumed' | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const paused = limits.paused;

  const resume = async (confirmation: IdentityConfirmation) => {
    try {
      const response = await endpoints.sendingLimits.resume(confirmation);
      store(response.limits);
      setAsking(null);
      setDone('resumed');
      setFailure(null);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setAsking(null);
      setFailure(caught);
    }
  };

  return (
    <section
      className={styles.card}
      aria-labelledby="batas-rem"
      data-state={paused ? 'paused' : 'running'}
    >
      <h2 id="batas-rem" className={styles.cardTitle}>
        {copy.brakeTitle}
      </h2>
      {paused ? (
        <div className={styles.status} role="status">
          <span className={styles.statusIcon} data-tone="danger" aria-hidden="true">
            <Icon icon={OctagonPause} size={20} />
          </span>
          <div className={styles.statusText}>
            <p className={styles.statusTitle}>{copy.pausedTitle}</p>
            <p className={styles.statusBody}>
              {paused.by
                ? copy.pausedBy(paused.by.name, formatDateTimeInline(paused.at))
                : copy.pausedBySystem(formatDateTimeInline(paused.at))}
            </p>
            {paused.reason ? (
              <p className={styles.statusBody} dir="auto">
                {copy.pausedReason(paused.reason)}
              </p>
            ) : null}
            <p className={styles.statusBody}>{copy.pausedHint}</p>
          </div>
        </div>
      ) : (
        <div className={styles.status} role="status">
          <span className={styles.statusIcon} data-tone="success" aria-hidden="true">
            <Icon icon={Play} size={20} />
          </span>
          <div className={styles.statusText}>
            <p className={styles.statusTitle}>{copy.runningTitle}</p>
            <p className={styles.statusBody}>{copy.runningBody}</p>
          </div>
        </div>
      )}
      {done ? (
        <Notice tone={done === 'paused' ? 'warning' : 'success'} role="status">
          {done === 'paused' ? copy.paused : copy.resumed}
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : null}
      <FormActions meta={paused && !canResume ? copy.resumeNotAllowed : undefined}>
        {paused ? (
          canResume ? (
            <Button
              ref={buttonRef}
              variant="primary"
              onClick={() => {
                setDone(null);
                setAsking('resume');
              }}
            >
              {copy.resume}
            </Button>
          ) : null
        ) : (
          <Button
            ref={buttonRef}
            className={styles.dangerText}
            onClick={() => {
              setDone(null);
              setAsking('pause');
            }}
          >
            <Icon icon={OctagonPause} size={16} />
            {copy.pause}
          </Button>
        )}
      </FormActions>
      {asking === 'pause' ? (
        <PauseDialog
          onClose={() => {
            setAsking(null);
            requestAnimationFrame(() => buttonRef.current?.focus());
          }}
          onPaused={(next) => {
            store(next);
            setAsking(null);
            setDone('paused');
            setFailure(null);
          }}
        />
      ) : null}
      <IdentityDialog
        open={asking === 'resume'}
        title={copy.resumeTitle}
        body={copy.resumeBody}
        confirmLabel={copy.resume}
        pendingLabel={copy.resuming}
        variant="primary"
        // Pemegang `sending.resume` (Owner/Admin) selalu peran wajib 2FA.
        requireCode
        returnFocusRef={buttonRef}
        onCancel={() => setAsking(null)}
        onConfirm={resume}
      />
    </section>
  );
}

function PauseDialog({
  onClose,
  onPaused,
}: {
  onClose: () => void;
  onPaused: (limits: SendingLimits) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = pauseSendingRequestSchema.safeParse(reason.trim() ? { reason } : {});
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? null);
      return;
    }
    setError(null);
    setFailure(null);
    setPending(true);
    try {
      const response = await endpoints.sendingLimits.pause(parsed.data);
      onPaused(response.limits);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open title={copy.pauseTitle} description={copy.pauseBody} onRequestClose={onClose}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <TextAreaField
          label={copy.reasonLabel}
          hint={copy.reasonHint}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          error={error ?? undefined}
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
            {pending ? copy.pausing : copy.pauseConfirm}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ── Batas ───────────────────────────────────────────────────────────────────

function LimitsCard({ limits }: { limits: SendingLimits }) {
  const store = useStoreLimits();
  const [values, setValues] = useState<LimitValues>(() => valuesFrom(limits));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirming, setConfirming] = useState<UpdateSendingLimitsRequest | null>(null);
  const [saved, setSaved] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  const ratio = limits.sentLast24Hours / Math.max(1, limits.dailyPerOrganization);
  const tone = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'normal';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    setFailure(null);
    const parsed = updateSendingLimitsRequestSchema.safeParse({
      dailyPerOrganization: parseLimit(values.dailyPerOrganization),
      dailyPerUser: parseLimit(values.dailyPerUser),
      perConversationPerMinute: parseLimit(values.perConversationPerMinute),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const same = LIMIT_KEYS.every((key) => parsed.data[key] === limits[key]);
    setUnchanged(same);
    if (!same) setConfirming(parsed.data);
  };

  const persist = async (body: UpdateSendingLimitsRequest, confirmation: IdentityConfirmation) => {
    try {
      const response = await endpoints.sendingLimits.update({ ...body, confirmation });
      store(response.limits);
      setValues(valuesFrom(response.limits));
      setConfirming(null);
      setSaved(true);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(null);
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        setErrors(apiFieldErrors(caught.details));
      } else {
        setFailure(caught);
      }
    }
  };

  return (
    <section className={styles.card} aria-labelledby="batas-pesan">
      <div className={styles.cardHead}>
        <h2 id="batas-pesan" className={styles.cardTitle}>
          {copy.limitsTitle}
        </h2>
        <p className={styles.hint}>{copy.limitsHint}</p>
      </div>
      <div className={styles.usage}>
        <p className={styles.usageText}>
          {copy.usage(limits.sentLast24Hours, limits.dailyPerOrganization)}
        </p>
        <div
          className={styles.meter}
          role="meter"
          aria-label={copy.usageLabel}
          aria-valuemin={0}
          aria-valuemax={limits.dailyPerOrganization}
          aria-valuenow={Math.min(limits.sentLast24Hours, limits.dailyPerOrganization)}
          data-tone={tone}
        >
          <span className={styles.meterFill} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      </div>
      <form className={styles.form} onSubmit={submit} noValidate>
        {LIMIT_KEYS.map((key) => {
          const bounds = SENDING_LIMIT_BOUNDS[key];
          return (
            <TextField
              key={key}
              label={copy[key]}
              hint={copy.fieldHint(bounds.default, bounds.min, bounds.max)}
              value={values[key]}
              onChange={(event) => {
                setValues((current) => ({ ...current, [key]: event.target.value }));
                setSaved(false);
                setUnchanged(false);
              }}
              error={errors[key]}
              inputMode="numeric"
              autoComplete="off"
              maxLength={9}
              className={styles.numberField}
            />
          );
        })}
        {saved ? (
          <Notice tone="success" role="status">
            {copy.saved}
          </Notice>
        ) : null}
        {unchanged ? (
          <Notice tone="info" role="status">
            {copy.unchanged}
          </Notice>
        ) : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <FormActions>
          <Button ref={submitRef} type="submit" variant="primary">
            {copy.save}
          </Button>
        </FormActions>
      </form>
      <IdentityDialog
        open={confirming !== null}
        title={copy.confirmTitle}
        body={copy.confirmBody}
        confirmLabel={copy.save}
        pendingLabel={copy.saving}
        variant="primary"
        requireCode
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(null)}
        onConfirm={(confirmation) =>
          confirming ? persist(confirming, confirmation) : Promise.resolve()
        }
      />
    </section>
  );
}

function PageSkeleton() {
  return (
    <SkeletonRegion className={styles.skeleton}>
      {[0, 1].map((index) => (
        <div key={index} className={styles.card}>
          <Skeleton className={styles.skeletonTitle} />
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonButton} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
