import type { EmailSettingsResponse } from '@balesin/shared';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useBrand } from '../../brand/brand';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { emailSettingsQuery, queryKeys } from '../../lib/api/queries';
import { formatTime } from '../../lib/format';
import { apiFieldErrors, type FieldErrors } from '../../lib/form';
import { media, useMediaQuery } from '../../lib/media';
import { useSession } from '../auth/session';
import styles from './EmailSettings.module.css';
import { EmailSettingsFields } from './EmailSettingsFields';
import { EmailStatusBadge } from './EmailStatusBadge';
import { EmailTestPanel, type RunEmailTest } from './EmailTestPanel';
import {
  emailFormFromView,
  emptyEmailForm,
  isEmailFormDirty,
  toEmailInput,
  type EmailFormValues,
} from './email-form';

/** Pengaturan → Email pengirim (khusus Owner). Data dimuat oleh loader rute. */
export function EmailSettingsPage() {
  const { data } = useSuspenseQuery(emailSettingsQuery);
  return (
    <Page>
      <EmailSettingsScreen data={data} />
    </Page>
  );
}

function EmailSettingsScreen({ data }: { data: EmailSettingsResponse }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const { productName } = useBrand();
  const isDesktop = useMediaQuery(media.desktop);
  const saved = data.source === 'database' ? data.settings : null;

  const [values, setValues] = useState<EmailFormValues>(() =>
    data.settings ? emailFormFromView(data.settings) : { ...emptyEmailForm, fromName: productName },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [justSaved, setJustSaved] = useState(false);

  const save = useMutation({
    mutationFn: endpoints.emailSettings.save,
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.emailSettings, response);
      // Password tidak pernah dikirim balik: kolomnya dikosongkan, petunjuk tersamar tampil.
      if (response.settings) setValues(emailFormFromView(response.settings));
      setJustSaved(true);
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        setErrors(apiFieldErrors(error.details));
      }
    },
  });

  const change = (next: EmailFormValues) => {
    setValues(next);
    setJustSaved(false);
    if (Object.keys(errors).length > 0) setErrors({});
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = toEmailInput(values, saved);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.input);
  };

  const runTest: RunEmailTest = async (kind, to) => {
    // Isian sama dengan yang tersimpan → uji pengaturan tersimpan (status ikut tercatat).
    const useStored = data.source === 'database' && !isEmailFormDirty(values, saved);
    let settings;
    if (!useStored) {
      const result = toEmailInput(values, saved);
      if (!result.ok) {
        setErrors(result.errors);
        return null;
      }
      settings = result.input;
    }
    setErrors({});
    try {
      return kind === 'connection'
        ? await endpoints.emailSettings.testConnection(settings)
        : await endpoints.emailSettings.sendTest(to ?? '', settings);
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        setErrors(apiFieldErrors(error.details, 'settings.'));
        return null;
      }
      throw error;
    } finally {
      if (useStored) void queryClient.invalidateQueries({ queryKey: queryKeys.emailSettings });
    }
  };

  const saveError =
    save.error && !(isApiError(save.error) && save.error.code === 'VALIDATION_ERROR')
      ? isApiError(save.error)
        ? save.error.message
        : t.api.network
      : null;
  const errorCount = Object.keys(errors).length;

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <StatusSummary data={data} />
        {!data.canStoreSecrets ? (
          <Notice tone="warning" title={t.emailSettings.noMasterKeyTitle}>
            {t.emailSettings.noMasterKeyBody}
          </Notice>
        ) : null}
        {data.source === 'env' ? <Notice tone="info">{t.emailSettings.envNotice}</Notice> : null}

        <form className={styles.card} onSubmit={submit} noValidate>
          <EmailSettingsFields
            idPrefix="email"
            values={values}
            onChange={change}
            errors={errors}
            saved={saved}
            detectHost={endpoints.emailSettings.detectHost}
            disabled={save.isPending}
          />
          <EmailTestPanel
            defaultRecipient={session?.user.email ?? ''}
            run={runTest}
            disabled={save.isPending}
            note={
              data.source === 'database' && isEmailFormDirty(values, saved)
                ? t.emailSettings.unsavedTest
                : undefined
            }
          />
          {saveError ? (
            <Notice tone="danger" role="alert">
              {saveError}
            </Notice>
          ) : null}
          {errorCount > 0 ? (
            <p className="sr-only" role="alert">
              {t.form.fixErrors(errorCount)}
            </p>
          ) : null}
          <div className={styles.formFooter}>
            {justSaved ? (
              <span className={styles.savedNote} role="status">
                <Icon icon={CircleCheck} size={16} />
                {t.emailSettings.saved}
              </span>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={!data.canStoreSecrets}
            >
              {save.isPending ? t.emailSettings.saving : t.emailSettings.save}
            </Button>
          </div>
        </form>
      </div>

      <details className={styles.guide} open={isDesktop} key={isDesktop ? 'lebar' : 'sempit'}>
        <summary className={styles.guideTitle}>{t.emailSettings.guideTitle}</summary>
        <ol className={styles.guideList}>
          {t.emailSettings.guide.map((step) => (
            <li key={step} className={styles.guideItem}>
              {step}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function StatusSummary({ data }: { data: EmailSettingsResponse }) {
  return (
    <dl className={styles.statusCard}>
      <div className={styles.statusItem}>
        <dt className={styles.statusLabel}>{t.emailSettings.status}</dt>
        <dd className={styles.statusValue}>
          <EmailStatusBadge status={data.status} />
        </dd>
      </div>
      <div className={styles.statusItem}>
        <dt className={styles.statusLabel}>{t.emailSettings.lastTest}</dt>
        <dd className={styles.statusValue}>
          {data.lastTest ? formatTime(data.lastTest.testedAt) : t.emailSettings.neverTested}
        </dd>
      </div>
      <div className={styles.statusItem}>
        <dt className={styles.statusLabel}>{t.emailSettings.source}</dt>
        <dd className={styles.statusValue}>{t.emailSettings.sources[data.source]}</dd>
      </div>
    </dl>
  );
}
