import {
  notificationPreferencesSchema,
  type NotificationPreferences,
  type NotificationPreferencesResponse,
  type NotificationSettings,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { FormActions } from '../../components/ui/FormActions';
import { Checkbox } from '../../components/ui/Checkbox';
import { TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { RichText } from '../../components/ui/RichText';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useCan } from '../auth/session';
import styles from './Notifications.module.css';
import { PushSetupError, enablePush, releasePush } from './push-device';
import {
  notificationKeys,
  notificationPreferencesQuery,
  notificationSettingsQuery,
  usePushDevice,
  type PushDeviceState,
} from './use-push-device';

const copy = t.notifications;

function errorMessage(error: unknown): string {
  if (error instanceof PushSetupError) {
    if (error.reason === 'dismissed') return copy.permissionDismissed;
    if (error.reason === 'denied') return copy.blockedBody;
    if (error.reason === 'worker') return copy.workerMissing;
    return copy.subscribeFailed;
  }
  return isApiError(error) ? error.message : t.api.network;
}

/**
 * Pengaturan → Notifikasi: perangkat ini (izin browser + langganan push), preferensi pengguna, dan
 * — untuk Owner — isi notifikasi organisasi (nama kontak / cuplikan, bawaan mati).
 */
export function NotificationsPage() {
  const canOrganization = useCan('organization.manage');
  const preferences = useQuery(notificationPreferencesQuery);
  return (
    <Page>
      <div className={styles.content}>
        <DeviceCard devices={preferences.data?.devices ?? null} />
        {preferences.data ? (
          <PreferencesCard data={preferences.data} />
        ) : preferences.isPending ? (
          <CardSkeleton />
        ) : (
          <Notice
            tone="danger"
            role="alert"
            title={copy.prefsFailedTitle}
            actions={
              <Button onClick={() => void preferences.refetch()} loading={preferences.isFetching}>
                {t.common.retry}
              </Button>
            }
          >
            {errorMessage(preferences.error)}
          </Notice>
        )}
        {canOrganization ? <OrganizationCard /> : null}
      </div>
    </Page>
  );
}

// ── Perangkat ini ───────────────────────────────────────────────────────────

function deviceStatus(state: PushDeviceState): { tone: StatusTone; label: string } {
  if (state.support === 'ios-install') return { tone: 'warning', label: copy.statusNeedsInstall };
  if (state.support !== 'supported') return { tone: 'neutral', label: copy.statusUnsupported };
  if (state.permission === 'denied') return { tone: 'danger', label: copy.statusBlocked };
  if (state.subscribed) return { tone: 'success', label: copy.statusOn };
  return { tone: 'neutral', label: copy.statusOff };
}

function DeviceCard({ devices }: { devices: number | null }) {
  const queryClient = useQueryClient();
  const device = usePushDevice();
  const [busy, setBusy] = useState<'enable' | 'disable' | 'test' | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const status = deviceStatus(device);

  type Result = { tone: 'success' | 'info'; text: string };
  const run = async (kind: 'enable' | 'disable' | 'test', action: () => Promise<Result>) => {
    setBusy(kind);
    setResult(null);
    setError(null);
    try {
      setResult(await action());
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
      device.refresh();
      void queryClient.invalidateQueries({ queryKey: notificationKeys.preferences });
    }
  };

  const enable = () =>
    run('enable', async () => {
      await enablePush();
      return { tone: 'success', text: copy.enabled };
    });
  const disable = () =>
    run('disable', async () => {
      await releasePush({ server: true });
      return { tone: 'success', text: copy.disabled };
    });
  const test = () =>
    run('test', async () => {
      const { devices: sent } = await endpoints.notifications.test();
      return sent === 0
        ? { tone: 'info', text: copy.testNoDevice }
        : { tone: 'success', text: copy.testSent(sent) };
    });

  return (
    <section className={styles.card} aria-labelledby="notifikasi-perangkat">
      <div className={styles.cardHeadRow}>
        <div className={styles.cardHead}>
          <h2 id="notifikasi-perangkat" className={styles.cardTitle}>
            {copy.deviceTitle}
          </h2>
          <p className={styles.hint}>{copy.deviceHint}</p>
        </div>
        <StatusBadge tone={status.tone} label={status.label} />
      </div>

      {device.support === 'ios-install' ? (
        <Notice tone="info" title={copy.iosTitle}>
          <RichText text={copy.iosBody} />
        </Notice>
      ) : device.support === 'unsupported' ? (
        <Notice tone="info" title={copy.unsupportedTitle}>
          {copy.unsupportedBody}
        </Notice>
      ) : device.permission === 'denied' ? (
        <Notice tone="warning" title={copy.blockedTitle}>
          {copy.blockedBody}
        </Notice>
      ) : (
        <p className={styles.body}>{device.subscribed ? copy.onBody : copy.offBody}</p>
      )}

      {devices !== null ? <p className={styles.hint}>{copy.devices(devices)}</p> : null}

      {result ? (
        <Notice tone={result.tone} role="status">
          {result.text}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {errorMessage(error)}
        </Notice>
      ) : null}

      {device.support === 'supported' && device.permission !== 'denied' ? (
        <FormActions>
          {device.subscribed ? (
            <>
              <Button loading={busy === 'disable'} onClick={() => void disable()}>
                {busy === 'disable' ? copy.disabling : copy.disable}
              </Button>
              <Button variant="primary" loading={busy === 'test'} onClick={() => void test()}>
                {busy === 'test' ? null : <Icon icon={Send} size={16} />}
                {busy === 'test' ? copy.testing : copy.test}
              </Button>
            </>
          ) : device.subscribed === false ? (
            <Button variant="primary" loading={busy === 'enable'} onClick={() => void enable()}>
              {busy === 'enable' ? null : <Icon icon={BellRing} size={16} />}
              {busy === 'enable' ? copy.enabling : copy.enable}
            </Button>
          ) : (
            <Skeleton className={styles.skeletonButton} />
          )}
        </FormActions>
      ) : null}
    </section>
  );
}

// ── Preferensi ──────────────────────────────────────────────────────────────

function PreferencesCard({ data }: { data: NotificationPreferencesResponse }) {
  const queryClient = useQueryClient();
  const canQueue = useCan('inbox.assign');
  const [values, setValues] = useState<NotificationPreferences>(data.preferences);
  const [quiet, setQuiet] = useState(data.preferences.quietHours !== null);
  const [start, setStart] = useState(data.preferences.quietHours?.start ?? '21:00');
  const [end, setEnd] = useState(data.preferences.quietHours?.end ?? '07:00');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const change = (next: Partial<NotificationPreferences>) => {
    setValues((current) => ({ ...current, ...next }));
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    setFailure(null);
    const parsed = notificationPreferencesSchema.safeParse({
      ...values,
      quietHours: quiet ? { start, end } : null,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const response = await endpoints.notifications.updatePreferences(parsed.data);
      queryClient.setQueryData(notificationKeys.preferences, response);
      setSaved(true);
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        setErrors(apiFieldErrors(caught.details));
      } else {
        setFailure(caught);
      }
    } finally {
      setSaving(false);
    }
  };

  const quietError = errors['quietHours'] ?? errors['quietHours.start'] ?? errors['quietHours.end'];

  return (
    <section className={styles.card} aria-labelledby="notifikasi-preferensi">
      <div className={styles.cardHead}>
        <h2 id="notifikasi-preferensi" className={styles.cardTitle}>
          {copy.prefsTitle}
        </h2>
        <p className={styles.hint}>{copy.prefsHint}</p>
      </div>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.options}>
          {canQueue ? (
            <Checkbox
              checked={values.queue}
              onChange={(event) => change({ queue: event.target.checked })}
            >
              <OptionText label={copy.queue} hint={copy.queueHint} />
            </Checkbox>
          ) : null}
          <Checkbox
            checked={values.assignedMessage}
            onChange={(event) => change({ assignedMessage: event.target.checked })}
          >
            <OptionText label={copy.assignedMessage} />
          </Checkbox>
          <Checkbox
            checked={values.assignedToMe}
            onChange={(event) => change({ assignedToMe: event.target.checked })}
          >
            <OptionText label={copy.assignedToMe} hint={copy.assignedToMeHint} />
          </Checkbox>
          <Checkbox
            checked={quiet}
            onChange={(event) => {
              setQuiet(event.target.checked);
              setSaved(false);
            }}
          >
            <OptionText label={copy.quietHours} hint={copy.quietHoursHint(data.timezone)} />
          </Checkbox>
        </div>
        {quiet ? (
          <div className={styles.quiet}>
            <TextField
              label={copy.quietStart}
              type="time"
              value={start}
              onChange={(event) => {
                setStart(event.target.value);
                setSaved(false);
              }}
              error={quietError}
              className={styles.timeField}
            />
            <TextField
              label={copy.quietEnd}
              type="time"
              value={end}
              onChange={(event) => {
                setEnd(event.target.value);
                setSaved(false);
              }}
              className={styles.timeField}
            />
          </div>
        ) : null}
        {saved ? (
          <Notice tone="success" role="status">
            {copy.prefsSaved}
          </Notice>
        ) : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {errorMessage(failure)}
          </Notice>
        ) : null}
        <FormActions>
          <Button type="submit" variant="primary" loading={saving}>
            {saving ? copy.saving : copy.savePrefs}
          </Button>
        </FormActions>
      </form>
    </section>
  );
}

function OptionText({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className={styles.optionText}>
      <span className={styles.optionLabel}>{label}</span>
      {hint ? <span className={styles.optionHint}>{hint}</span> : null}
    </span>
  );
}

// ── Organisasi (Owner) ──────────────────────────────────────────────────────

function OrganizationCard() {
  const settings = useQuery(notificationSettingsQuery);
  return (
    <section className={styles.card} aria-labelledby="notifikasi-organisasi">
      <div className={styles.cardHeadRow}>
        <div className={styles.cardHead}>
          <h2 id="notifikasi-organisasi" className={styles.cardTitle}>
            {copy.orgTitle}
          </h2>
          <p className={styles.hint}>{copy.orgHint}</p>
        </div>
        <StatusBadge tone="neutral" label={copy.ownerOnly} />
      </div>
      {settings.data ? (
        <OrganizationForm settings={settings.data.settings} />
      ) : settings.isPending ? (
        <SkeletonRegion className={styles.skeleton}>
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLine} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          role="alert"
          title={copy.orgFailedTitle}
          actions={
            <Button onClick={() => void settings.refetch()} loading={settings.isFetching}>
              {t.common.retry}
            </Button>
          }
        >
          {errorMessage(settings.error)}
        </Notice>
      )}
    </section>
  );
}

function OrganizationForm({ settings }: { settings: NotificationSettings }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await endpoints.notifications.updateSettings(values);
      queryClient.setQueryData(notificationKeys.settings, response);
      setSaved(true);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <div className={styles.options}>
        <Checkbox
          checked={values.contactName}
          onChange={(event) => {
            setValues((current) => ({ ...current, contactName: event.target.checked }));
            setSaved(false);
          }}
        >
          <OptionText label={copy.contactName} hint={copy.contactNameHint} />
        </Checkbox>
        <Checkbox
          checked={values.preview}
          onChange={(event) => {
            setValues((current) => ({ ...current, preview: event.target.checked }));
            setSaved(false);
          }}
        >
          <OptionText label={copy.preview} hint={copy.previewHint} />
        </Checkbox>
      </div>
      {saved ? (
        <Notice tone="success" role="status">
          {copy.orgSaved}
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {errorMessage(failure)}
        </Notice>
      ) : null}
      <FormActions>
        <Button type="submit" variant="primary" loading={saving}>
          {saving ? copy.saving : copy.saveOrg}
        </Button>
      </FormActions>
    </form>
  );
}

function CardSkeleton() {
  return (
    <SkeletonRegion className={styles.card}>
      <Skeleton className={styles.skeletonTitle} />
      <Skeleton className={styles.skeletonLine} />
      <Skeleton className={styles.skeletonLine} />
      <Skeleton className={styles.skeletonButton} />
    </SkeletonRegion>
  );
}
