import { CSAT_SCORE_LABELS, csatSettingsValuesSchema, type CsatSettings } from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { EmptyState } from '../../components/ui/EmptyState';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTime } from '../../lib/format';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { csatKey, csatSettingsQuery } from './csat-queries';
import styles from './Reports.module.css';

const c = t.csat;
/**
 * Pengaturan → CSAT (`settings.workspace.manage`): saklar (bawaan mati), pertanyaan & terima kasih
 * (tanpa tautan — dikirim otomatis ke semua pelanggan), jarak antar-survei, pratinjau pesan.
 */
export function CsatSettingsPage() {
  const settings = useQuery(csatSettingsQuery);
  return (
    <Page>
      <div className={styles.settingsPage}>
        <p className={styles.intro}>{c.intro}</p>
        {settings.isPending ? (
          <SkeletonRegion className={styles.card}>
            <Skeleton className={styles.skeletonLabel} />
            <Skeleton className={styles.skeletonChart} />
          </SkeletonRegion>
        ) : settings.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={c.loadFailedTitle}
            body={isApiError(settings.error) ? settings.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void settings.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : (
          <CsatForm settings={settings.data.csat} />
        )}
      </div>
    </Page>
  );
}

function CsatForm({ settings }: { settings: CsatSettings }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [question, setQuestion] = useState(settings.question);
  const [thanks, setThanks] = useState(settings.thanks);
  const [interval, setIntervalText] = useState(String(settings.minIntervalHours));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof endpoints.reports.updateCsat>[0]) =>
      endpoints.reports.updateCsat(body),
    onMutate: () => setSaved(false),
    onSuccess: (data) => {
      queryClient.setQueryData(csatKey, data);
      setSaved(true);
    },
    onError: (error) => {
      if (isApiError(error) && error.details.length > 0) setErrors(apiFieldErrors(error.details));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const hours = /^\d{1,4}$/.test(interval.trim()) ? Number(interval.trim()) : Number.NaN;
    const parsed = csatSettingsValuesSchema.safeParse({
      enabled,
      question,
      thanks,
      minIntervalHours: hours,
    });
    if (!parsed.success) {
      const next = zodFieldErrors(parsed.error);
      if (Number.isNaN(hours)) next.minIntervalHours = c.intervalHint;
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };

  return (
    <div className={styles.csatLayout}>
      <form className={styles.card} onSubmit={submit} noValidate>
        <div>
          <Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)}>
            {c.enabled}
          </Checkbox>
          <p className={styles.hint}>{c.enabledHint}</p>
        </div>
        <TextAreaField
          label={c.question}
          hint={c.questionHint}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          error={errors.question}
          maxLength={300}
          rows={3}
        />
        <TextAreaField
          label={c.thanks}
          hint={c.thanksHint}
          value={thanks}
          onChange={(event) => setThanks(event.target.value)}
          error={errors.thanks}
          maxLength={300}
          rows={3}
        />
        <TextField
          label={c.interval}
          hint={c.intervalHint}
          value={interval}
          onChange={(event) => setIntervalText(event.target.value)}
          error={errors.minIntervalHours}
          inputMode="numeric"
          maxLength={3}
        />
        {save.isError && !(isApiError(save.error) && save.error.details.length > 0) ? (
          <Notice tone="danger" role="alert">
            {isApiError(save.error) ? save.error.message : t.api.network}
          </Notice>
        ) : saved ? (
          <Notice tone="success" role="status">
            {c.saved}
          </Notice>
        ) : null}
        <div className={styles.formFoot}>
          {settings.updatedAt ? (
            <p className={styles.hint}>{c.lastUpdated(formatDateTime(settings.updatedAt))}</p>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" loading={save.isPending}>
            {save.isPending ? c.saving : c.save}
          </Button>
        </div>
      </form>
      <section className={styles.card} aria-labelledby="csat-pratinjau">
        <h2 id="csat-pratinjau" className={styles.cardTitle}>
          {c.preview}
        </h2>
        <div className={styles.previewChat}>
          <p className={styles.previewBubble} dir="auto">
            {question}
          </p>
          <div className={styles.previewList} aria-hidden="true">
            <p className={styles.previewListTitle}>{c.previewChoose}</p>
            {([5, 4, 3, 2, 1] as const).map((score) => (
              <p key={score} className={styles.previewOption}>
                {score} — {CSAT_SCORE_LABELS[score]}
              </p>
            ))}
          </div>
          <p className={styles.previewBubble} dir="auto">
            {thanks}
          </p>
        </div>
      </section>
    </div>
  );
}
