import {
  BROADCAST_SETTING_BOUNDS,
  updateBroadcastSettingsRequestSchema,
  type BroadcastRate,
  type BroadcastSettings,
  type BroadcastSettingsValues,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { zodFieldErrors } from '../../lib/form';
import { useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { broadcastKeys, broadcastSettingsQuery } from './broadcast-queries';
import styles from './Broadcast.module.css';

const s = t.broadcast.settings;
type NumberKey = 'approvalThreshold' | 'maxRatePerSecond' | 'quotaReservePercent';
type BrakeKey =
  | 'failureSpikePercent'
  | 'failureSpikeMinSample'
  | 'spikeMultiplier'
  | 'spikeMinPerMinute'
  | 'spikeAbsolutePerMinute';
const BRAKE_KEYS: readonly BrakeKey[] = [
  'failureSpikePercent',
  'failureSpikeMinSample',
  'spikeMultiplier',
  'spikeMinPerMinute',
  'spikeAbsolutePerMinute',
];
const RATE_FIELDS = ['marketing', 'utility', 'authentication'] as const;

interface RateRow {
  key: number;
  country: string;
  callingCode: string;
  marketing: string;
  utility: string;
  authentication: string;
}

interface Form {
  approvalThreshold: string;
  maxRatePerSecond: string;
  quotaReservePercent: string;
  autoBrakeEnabled: boolean;
  brake: Record<BrakeKey, string>;
  currency: string;
  rates: RateRow[];
  source: string;
}

let rowSeq = 0;
const rateRow = (rate?: BroadcastRate): RateRow => {
  rowSeq += 1;
  return {
    key: rowSeq,
    country: rate?.country ?? '',
    callingCode: rate?.callingCode ?? '',
    marketing: rate ? String(rate.marketing) : '',
    utility: rate ? String(rate.utility) : '',
    authentication: rate ? String(rate.authentication) : '',
  };
};

function formFrom(settings: BroadcastSettingsValues): Form {
  return {
    approvalThreshold: String(settings.approvalThreshold),
    maxRatePerSecond: String(settings.maxRatePerSecond),
    quotaReservePercent: String(settings.quotaReservePercent),
    autoBrakeEnabled: settings.autoBrake.enabled,
    brake: Object.fromEntries(
      BRAKE_KEYS.map((key) => [key, String(settings.autoBrake[key])]),
    ) as Record<BrakeKey, string>,
    currency: settings.rates.currency,
    rates: settings.rates.rates.map(rateRow),
    source: settings.rates.source,
  };
}

const num = (value: string) => (value.trim() === '' ? Number.NaN : Number(value));

function valuesFrom(form: Form): unknown {
  return {
    approvalThreshold: num(form.approvalThreshold),
    maxRatePerSecond: num(form.maxRatePerSecond),
    quotaReservePercent: num(form.quotaReservePercent),
    autoBrake: {
      enabled: form.autoBrakeEnabled,
      ...Object.fromEntries(BRAKE_KEYS.map((key) => [key, num(form.brake[key])])),
    },
    rates: {
      currency: form.currency.trim().toUpperCase(),
      rates: form.rates.map((row) => ({
        country: row.country.trim().toUpperCase(),
        callingCode: row.callingCode.trim(),
        marketing: num(row.marketing),
        utility: num(row.utility),
        authentication: num(row.authentication),
      })),
      source: form.source.trim(),
    },
  };
}

/**
 * Pengaturan → Batas kirim → Broadcast (`sending.limits.manage`): ambang persetujuan, kecepatan,
 * cadangan kuota CS, rem otomatis, tarif perkiraan. Simpan dengan konfirmasi identitas; melonggarkan
 * pelindung hanya Owner (server 403 `broadcast.settings.loosen`, dijelaskan di kartu).
 */
export function BroadcastSettingsCard() {
  const query = useQuery(broadcastSettingsQuery);
  if (query.data) return <SettingsForm settings={query.data.settings} />;
  return (
    <section className={styles.card} aria-labelledby="pengaturan-broadcast">
      <h2 id="pengaturan-broadcast" className={styles.cardTitle}>
        {s.title}
      </h2>
      {query.isPending ? (
        <Skeleton className={styles.skeletonField} />
      ) : (
        <Notice
          tone="danger"
          role="alert"
          actions={
            <Button onClick={() => void query.refetch()} loading={query.isFetching}>
              {t.common.retry}
            </Button>
          }
        >
          {s.loadFailed}
        </Notice>
      )}
    </section>
  );
}

function SettingsForm({ settings }: { settings: BroadcastSettings }) {
  const queryClient = useQueryClient();
  const role = useSession()?.user.role;
  const [form, setForm] = useState<Form>(() => formFrom(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<BroadcastSettingsValues | null>(null);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const change = (next: Partial<Form>) => {
    setForm((current) => ({ ...current, ...next }));
    setSaved(false);
  };
  const changeRate = (key: number, next: Partial<RateRow>) =>
    change({ rates: form.rates.map((row) => (row.key === key ? { ...row, ...next } : row)) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const parsed = updateBroadcastSettingsRequestSchema.safeParse(valuesFrom(form));
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const { confirmation: _, ...values } = parsed.data;
    setPending(values);
  };

  const persist = async (confirmation: IdentityConfirmation) => {
    if (!pending) return;
    try {
      const response = await endpoints.broadcasts.updateSettings({ ...pending, confirmation });
      queryClient.setQueryData(broadcastKeys.settings, response);
      setForm(formFrom(response.settings));
      setPending(null);
      setSaved(true);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setPending(null);
      if (isApiError(caught) && caught.details.length > 0) {
        setErrors(
          Object.fromEntries(caught.details.map((detail) => [detail.field, detail.message])),
        );
      } else {
        setFailure(caught);
      }
    }
  };

  const numberField = (key: NumberKey, label: string, hint?: string) => {
    const bounds = BROADCAST_SETTING_BOUNDS[key];
    return (
      <TextField
        label={label}
        hint={hint ?? t.sendingLimits.fieldHint(bounds.default, bounds.min, bounds.max)}
        value={form[key]}
        onChange={(event) => change({ [key]: event.target.value })}
        error={errors[key]}
        inputMode="numeric"
        maxLength={7}
        className={styles.numberField}
      />
    );
  };

  return (
    <section className={styles.card} aria-labelledby="pengaturan-broadcast">
      <div className={styles.cardHead}>
        <h2 id="pengaturan-broadcast" className={styles.cardTitle}>
          {s.title}
        </h2>
        <p className={styles.hint}>{s.hint}</p>
      </div>
      {role !== 'owner' ? (
        <Notice tone="info" role="status">
          {s.ownerOnly}
        </Notice>
      ) : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        {numberField('approvalThreshold', s.approvalThreshold, s.approvalThresholdHint)}
        {numberField('maxRatePerSecond', s.maxRatePerSecond)}
        {numberField('quotaReservePercent', s.quotaReservePercent, s.quotaReserveHint)}

        <fieldset className={styles.fieldset}>
          <legend className={styles.groupLabel}>{s.autoBrakeTitle}</legend>
          <Checkbox
            checked={form.autoBrakeEnabled}
            onChange={(event) => change({ autoBrakeEnabled: event.target.checked })}
          >
            {s.autoBrakeEnabled}
          </Checkbox>
          <div className={styles.numberGrid}>
            {BRAKE_KEYS.map((key) => (
              <TextField
                key={key}
                label={s[key]}
                value={form.brake[key]}
                onChange={(event) =>
                  change({ brake: { ...form.brake, [key]: event.target.value } })
                }
                error={errors[`autoBrake.${key}`]}
                inputMode="numeric"
                maxLength={7}
              />
            ))}
          </div>
          <p className={styles.hint}>{s.spikeHint}</p>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.groupLabel}>{s.ratesTitle}</legend>
          <TextField
            label={s.currency}
            value={form.currency}
            onChange={(event) => change({ currency: event.target.value })}
            error={errors['rates.currency']}
            maxLength={3}
            className={styles.tiny}
          />
          <div className={styles.rateTable} role="group" aria-label={s.ratesLabel}>
            {form.rates.map((row, position) => {
              const country = row.country || String(position + 1);
              return (
                <div key={row.key} className={styles.rateRow}>
                  <TextField
                    label={s.rateCountry}
                    value={row.country}
                    onChange={(event) => changeRate(row.key, { country: event.target.value })}
                    error={errors[`rates.rates.${position}.country`]}
                    maxLength={2}
                  />
                  <TextField
                    label={s.rateCallingCode}
                    value={row.callingCode}
                    onChange={(event) => changeRate(row.key, { callingCode: event.target.value })}
                    error={errors[`rates.rates.${position}.callingCode`]}
                    inputMode="numeric"
                    maxLength={4}
                  />
                  {RATE_FIELDS.map((field) => (
                    <TextField
                      key={field}
                      label={
                        field === 'marketing'
                          ? s.rateMarketing
                          : field === 'utility'
                            ? s.rateUtility
                            : s.rateAuthentication
                      }
                      value={row[field]}
                      onChange={(event) => changeRate(row.key, { [field]: event.target.value })}
                      error={errors[`rates.rates.${position}.${field}`]}
                      inputMode="decimal"
                      maxLength={9}
                    />
                  ))}
                  <IconButton
                    label={s.removeRate(country)}
                    icon={Trash2}
                    onClick={() =>
                      change({ rates: form.rates.filter((item) => item.key !== row.key) })
                    }
                  />
                </div>
              );
            })}
          </div>
          {form.rates.length < 50 ? (
            <Button
              variant="ghost"
              className={styles.alignStart}
              onClick={() => change({ rates: [...form.rates, rateRow()] })}
            >
              <Icon icon={Plus} size={16} />
              {s.addRate}
            </Button>
          ) : null}
          <TextAreaField
            label={s.ratesSource}
            hint={s.ratesSourceHint}
            value={form.source}
            onChange={(event) => change({ source: event.target.value })}
            error={errors['rates.source']}
            rows={2}
            maxLength={300}
          />
        </fieldset>

        {settings.updatedBy && settings.updatedAt ? (
          <p className={styles.hint}>
            {s.updatedBy(settings.updatedBy.name, formatDateTimeInline(settings.updatedAt))}
          </p>
        ) : null}
        {saved ? (
          <Notice tone="success" role="status">
            {s.saved}
          </Notice>
        ) : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <div className={styles.actionsRow}>
          <Button ref={saveRef} type="submit" variant="primary">
            {s.save}
          </Button>
        </div>
      </form>
      <IdentityDialog
        open={pending !== null}
        title={s.confirmTitle}
        body={s.confirmBody}
        confirmLabel={s.save}
        pendingLabel={s.saving}
        requireCode
        returnFocusRef={saveRef}
        onCancel={() => setPending(null)}
        onConfirm={persist}
      />
    </section>
  );
}
