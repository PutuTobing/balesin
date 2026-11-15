import type { IdentityConfirmation } from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Check, CircleCheck, Info } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ChannelIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { PasswordField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { RichText } from '../../components/ui/RichText';
import { SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { channelSettingsQuery, storeChannel } from '../../lib/api/queries';
import { cx } from '../../lib/cx';
import { useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { addBlockedReason } from './channel-status';
import styles from './Channels.module.css';
import { ChannelListSkeleton } from './ChannelsSkeleton';
import { GuideSteps } from './GuideSteps';
import { TestPanel } from './TestPanel';
import { WebhookPanel } from './WebhookPanel';
import {
  AFTER_SAVE_STEP,
  SAVE_STEP,
  WIZARD_STEPS,
  canOpenStep,
  hasUnsavedInput,
  initialWizardState,
  mapServerFieldErrors,
  toCreateRequest,
  validateAll,
  validateStep,
  type WizardField,
  type WizardState,
} from './wizard-state';

const copy = t.channels.wizard;
const steps = copy.steps;

/**
 * Pengaturan → Channel → Tambah nomor (izin `channels.manage`). Wizard 9 langkah dari
 * docs/SETUP-META.md. Bila server tidak bisa menyimpan rahasia (`canStoreSecrets: false`) atau
 * batas nomor tercapai, wizard tidak dibuka sama sekali; keputusan itu diambil sekali saat halaman
 * dibuka (channel yang baru tersimpan di wizard ini tidak menutup wizard-nya sendiri).
 */
export function ChannelWizardPage() {
  const list = useQuery(channelSettingsQuery);
  const [blocked, setBlocked] = useState<ReturnType<typeof addBlockedReason> | undefined>(
    undefined,
  );
  if (list.data && blocked === undefined) setBlocked(addBlockedReason(list.data));

  return (
    <Page>
      {blocked === null ? (
        <ChannelWizard />
      ) : blocked ? (
        <EmptyState
          illustration={<ChannelIllustration />}
          title={
            blocked === 'noMasterKey'
              ? t.channels.list.noMasterKeyTitle
              : t.channels.list.limitTitle
          }
          body={
            blocked === 'noMasterKey' ? (
              <RichText text={t.channels.list.noMasterKeyBody} />
            ) : (
              t.channels.list.limitBody(list.data?.maxChannels ?? 0)
            )
          }
          actions={
            <Button asChild variant="primary">
              <Link to="/pengaturan/channel">{t.channels.detail.backToList}</Link>
            </Button>
          }
        />
      ) : list.isPending ? (
        <div className={styles.content}>
          <SkeletonRegion>
            <ChannelListSkeleton />
          </SkeletonRegion>
        </div>
      ) : (
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={t.channels.list.loadFailedTitle}
          body={isApiError(list.error) ? list.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void list.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      )}
    </Page>
  );
}

function ChannelWizard() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);
  // Naik setiap isian ditolak → fokus ke isian pertama yang salah (setelah fokus judul langkah).
  const [invalidTick, setInvalidTick] = useState(0);

  const step = WIZARD_STEPS[state.step] ?? 'business';
  const stepCopy = steps[step];

  // Ganti langkah → fokus ke judul langkah (pembaca layar dan keyboard mulai dari atas).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
    headingRef.current?.scrollIntoView({ block: 'nearest' });
  }, [state.step]);

  useEffect(() => {
    if (invalidTick === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalidTick]);

  // Isian belum tersimpan: pindah halaman di dalam aplikasi ditahan dengan dialog konfirmasi,
  // tutup tab / muat ulang minta konfirmasi browser. Ke halaman masuk (sesi habis) tidak ditahan.
  const unsaved = hasUnsavedInput(state);
  const unsavedRef = useRef(unsaved);
  useEffect(() => {
    unsavedRef.current = unsaved;
  }, [unsaved]);
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => unsavedRef.current && next.pathname !== '/masuk',
    enableBeforeUnload: false,
    withResolver: true,
  });
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const goto = (index: number) =>
    setState((current) => ({
      ...current,
      step: index,
      furthest: Math.max(current.furthest, index),
      errors: {},
    }));

  const fail = (index: number, errors: Record<string, string>) => {
    setState((current) => ({ ...current, step: index, errors, failure: null }));
    setInvalidTick((tick) => tick + 1);
  };

  const setValue = (field: WizardField, value: string) =>
    setState((current) => {
      const { [field]: _removed, ...errors } = current.errors;
      return { ...current, values: { ...current.values, [field]: value }, errors };
    });

  /**
   * Simpan channel. Dipanggil langsung (bukan `useMutation`) supaya token, App Secret, dan
   * konfirmasi identitas tidak tertinggal di cache mutasi.
   */
  const persist = async (identity: IdentityConfirmation) => {
    try {
      const created = await endpoints.channels.create({
        ...toCreateRequest(state.values),
        confirmation: identity,
      });
      storeChannel(queryClient, created.channel);
      setConfirming(false);
      setState((current) => ({
        ...current,
        // Rahasia tidak disimpan lebih lama dari yang perlu.
        values: { ...current.values, accessToken: '', appSecret: '' },
        created,
        errors: {},
        failure: null,
        step: AFTER_SAVE_STEP,
        furthest: Math.max(current.furthest, AFTER_SAVE_STEP),
      }));
    } catch (caught) {
      // Password/kode salah atau dibatasi: tetap di dialog, pesannya di sana.
      if (isConfirmationError(caught)) throw caught;
      setConfirming(false);
      const mapped =
        isApiError(caught) && (caught.code === 'VALIDATION_ERROR' || caught.code === 'CONFLICT')
          ? mapServerFieldErrors(caught.details)
          : null;
      if (mapped) {
        fail(mapped.step, mapped.errors);
        return;
      }
      setState((current) => ({ ...current, failure: caught }));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const errors = validateStep(state.step, state.values);
    if (Object.keys(errors).length > 0) {
      fail(state.step, errors);
      return;
    }
    if (state.step === SAVE_STEP && !state.created) {
      const all = validateAll(state.values);
      if (all.step !== null) {
        fail(all.step, all.errors);
        return;
      }
      setState((current) => ({ ...current, failure: null }));
      setConfirming(true);
      return;
    }
    if (step === 'billing' && state.created) {
      setBusy(true);
      void navigate({
        to: '/pengaturan/channel/$channelId',
        params: { channelId: state.created.channel.id },
      });
      return;
    }
    goto(state.step + 1);
  };

  const canGoBack = state.step > 0 && !(state.created && state.step <= AFTER_SAVE_STEP);
  const fieldErrorCount = Object.keys(state.errors).length;
  const failureMessage = state.failure
    ? isApiError(state.failure)
      ? state.failure.message
      : t.api.network
    : null;

  return (
    <div className={styles.wizard}>
      <StepNav state={state} onSelect={goto} />
      <form
        ref={formRef}
        className={cx(styles.card, styles.stepPanel)}
        onSubmit={submit}
        noValidate
      >
        <div className={styles.stepHead}>
          <div className={styles.progress}>
            <p className={styles.stepCount}>{copy.stepOf(state.step + 1, WIZARD_STEPS.length)}</p>
            {/* HP/tablet: bilah kemajuan menggantikan daftar langkah di samping. */}
            <span className={styles.progressBars} aria-hidden="true">
              {WIZARD_STEPS.map((item, index) => (
                <span
                  key={item}
                  className={styles.progressBar}
                  data-on={index <= state.step ? '' : undefined}
                />
              ))}
            </span>
          </div>
          <h2 id="wizard-judul-langkah" ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
            {stepCopy.title}
          </h2>
          <p className={styles.stepIntro}>{stepCopy.intro}</p>
        </div>

        {state.created && step === 'webhook' ? (
          <Notice tone="success" role="status">
            {copy.savedNote(state.created.channel.name)}
          </Notice>
        ) : null}
        {fieldErrorCount > 0 ? (
          <p className="sr-only" role="alert">
            {t.form.fixErrors(fieldErrorCount)}
          </p>
        ) : null}

        <GuideSteps steps={stepCopy.items} />

        {step === 'ids' ? (
          <div className={styles.fields}>
            <TextField
              label={steps.ids.name}
              placeholder={steps.ids.namePlaceholder}
              hint={steps.ids.nameHint}
              name="nama-channel"
              value={state.values.name}
              onChange={(event) => setValue('name', event.target.value)}
              error={state.errors.name}
              autoComplete="off"
            />
            <TextField
              label={steps.ids.phoneNumberId}
              hint={steps.ids.phoneNumberIdHint}
              name="phone-number-id"
              inputMode="numeric"
              value={state.values.phoneNumberId}
              onChange={(event) => setValue('phoneNumberId', event.target.value)}
              error={state.errors.phoneNumberId}
              autoComplete="off"
              spellCheck={false}
              inputClassName={styles.mono}
            />
            <TextField
              label={steps.ids.wabaId}
              hint={steps.ids.wabaIdHint}
              name="waba-id"
              inputMode="numeric"
              value={state.values.wabaId}
              onChange={(event) => setValue('wabaId', event.target.value)}
              error={state.errors.wabaId}
              autoComplete="off"
              spellCheck={false}
              inputClassName={styles.mono}
            />
          </div>
        ) : null}

        {step === 'token' ? (
          <PasswordField
            label={steps.token.label}
            hint={steps.token.hint}
            name="token-system-user"
            value={state.values.accessToken}
            onChange={(event) => setValue('accessToken', event.target.value)}
            error={state.errors.accessToken}
            autoComplete="off"
            inputClassName={styles.mono}
          />
        ) : null}

        {step === 'secret' ? (
          <>
            <PasswordField
              label={steps.secret.label}
              hint={steps.secret.hint}
              name="app-secret"
              value={state.values.appSecret}
              onChange={(event) => setValue('appSecret', event.target.value)}
              error={state.errors.appSecret}
              autoComplete="off"
              inputClassName={styles.mono}
            />
            <p className={styles.note}>
              <Icon icon={Info} size={16} className={styles.noteIcon} />
              <span>
                {copy.saveNote}
                {session && session.user.role !== 'owner' ? ` ${t.channels.ownersNotified}` : ''}
              </span>
            </p>
            {failureMessage ? (
              <Notice tone="danger" role="alert">
                {failureMessage}
              </Notice>
            ) : null}
          </>
        ) : null}

        {step === 'webhook' && state.created ? (
          <WebhookPanel webhook={state.created.webhook} />
        ) : null}

        {step === 'test' && state.created ? (
          <TestPanel
            channelId={state.created.channel.id}
            result={state.testResult}
            onResult={(testResult) => setState((current) => ({ ...current, testResult }))}
            showNumber
            failedHint={steps.test.failedHint}
            variant={state.testResult?.ok ? 'secondary' : 'primary'}
          />
        ) : null}

        {step === 'billing' ? (
          <p className={styles.note}>
            <Icon icon={CircleCheck} size={16} className={styles.noteIcon} />
            <span>{steps.billing.done}</span>
          </p>
        ) : null}

        <div className={styles.wizardActions}>
          {canGoBack ? (
            <Button variant="ghost" onClick={() => goto(state.step - 1)} disabled={busy}>
              <Icon icon={ArrowLeft} size={16} />
              {copy.back}
            </Button>
          ) : null}
          <span className={styles.spacer} />
          <Button
            ref={submitRef}
            type="submit"
            variant={step === 'test' && !state.testResult?.ok ? 'secondary' : 'primary'}
            loading={busy}
          >
            {state.step === SAVE_STEP && !state.created
              ? copy.save
              : step === 'billing'
                ? copy.finish
                : copy.next}
          </Button>
        </div>
      </form>

      <IdentityDialog
        open={confirming}
        title={copy.confirmTitle}
        body={copy.confirmBody}
        confirmLabel={copy.save}
        pendingLabel={copy.saving}
        variant="primary"
        // Pemegang `channels.manage` (Owner/Admin) selalu peran wajib 2FA.
        requireCode
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(false)}
        onConfirm={persist}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        title={copy.leave.title}
        body={copy.leave.body}
        cancelLabel={copy.leave.stay}
        confirmLabel={copy.leave.leave}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}

/** Daftar langkah (desktop): langkah yang sudah dicapai bisa diklik, kecuali isian yang sudah tersimpan. */
function StepNav({ state, onSelect }: { state: WizardState; onSelect: (step: number) => void }) {
  return (
    <nav className={styles.stepNav} aria-label={copy.stepsLabel}>
      <ol className={styles.steps}>
        {WIZARD_STEPS.map((item, index) => {
          const current = index === state.step;
          const done = !current && (index < state.step || index <= state.furthest);
          const content = (
            <>
              <span className={styles.stepMarker} aria-hidden="true">
                {done ? <Icon icon={Check} size={16} /> : index + 1}
              </span>
              <span>{steps[item].nav}</span>
              <span className="sr-only">
                {current ? `, ${copy.stepCurrent}` : done ? `, ${copy.stepDone}` : ''}
              </span>
            </>
          );
          return (
            <li
              key={item}
              className={styles.stepItem}
              data-state={current ? 'current' : done ? 'done' : 'todo'}
              aria-current={current ? 'step' : undefined}
            >
              {canOpenStep(state, index) ? (
                <button type="button" className={styles.stepButton} onClick={() => onSelect(index)}>
                  {content}
                </button>
              ) : (
                <span className={styles.stepButton}>{content}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
