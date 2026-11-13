import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ArrowLeft, Check } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { BrandLogo } from '../../brand/BrandLogo';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { brandingQuery, queryKeys, setupStatusQuery, storeSession } from '../../lib/api/queries';
import { cx } from '../../lib/cx';
import type { FieldErrors } from '../../lib/form';
import { media, useMediaQuery } from '../../lib/media';
import { usePageTitle } from '../../lib/use-page-title';
import { SetupBlocked } from './SetupBlocked';
import styles from './Setup.module.css';
import {
  BrandingStep,
  EmailStep,
  OrganizationStep,
  OwnerStep,
  SummaryStep,
  TokenStep,
} from './SetupSteps';
import { readSetupTokenFromHash } from './setup-token';
import {
  OPTIONAL_STEPS,
  SETUP_STEPS,
  buildCompleteRequest,
  initialWizardState,
  mapCompleteError,
  nextStep,
  previousStep,
  stepIndex,
  validateBranding,
  validateEmail,
  validateOrganization,
  validateOwner,
  validateToken,
  wizardReducer,
  type SetupStep,
  type WizardState,
} from './wizard-state';

/** Wizard setup pertama kali (PRD §3.1). Status setup sudah dimuat penjaga rute. */
export function SetupPage() {
  usePageTitle(t.setup.documentTitle);
  const { data: status } = useSuspenseQuery(setupStatusQuery);
  const [conflict, setConflict] = useState(false);

  if (!status.setupTokenConfigured) return <SetupBlocked kind="no-token" />;
  if (conflict) return <SetupBlocked kind="done" />;
  return (
    <SetupWizard canStoreSecrets={status.canStoreSecrets} onConflict={() => setConflict(true)} />
  );
}

const STEP_COPY: Record<SetupStep, { nav: string; title: string; body: string }> = {
  token: t.setup.steps.token,
  organization: t.setup.steps.organization,
  owner: t.setup.steps.owner,
  branding: t.setup.steps.branding,
  email: t.setup.steps.email,
  summary: t.setup.steps.summary,
};

function SetupWizard({
  canStoreSecrets,
  onConflict,
}: {
  canStoreSecrets: boolean;
  onConflict: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [linkToken] = useState(() => readSetupTokenFromHash(router.history.location.hash));
  const [state, dispatch] = useReducer(wizardReducer, linkToken, initialWizardState);
  const [busy, setBusy] = useState(false);
  const isDesktop = useMediaQuery(media.desktop);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);

  const patch = useCallback(
    (value: Partial<Omit<WizardState, 'step' | 'furthest'>>) =>
      dispatch({ type: 'patch', patch: value }),
    [],
  );
  const goto = (step: SetupStep) => dispatch({ type: 'goto', step });
  const fail = (step: SetupStep, errors: FieldErrors, banner: string | null = null) =>
    dispatch({ type: 'fail', step, errors, banner });

  // Ganti langkah → fokus ke judul langkah, supaya pembaca layar dan keyboard mulai dari atas.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
    headingRef.current?.scrollIntoView({ block: 'nearest' });
  }, [state.step]);

  /** Error API di langkah mana pun: 409 = setup sudah selesai, 403 = token tidak berlaku. */
  const handleApiError = (step: SetupStep, error: unknown): void => {
    if (!isApiError(error)) {
      fail(step, {}, t.api.network);
      return;
    }
    if (error.status === 409) {
      onConflict();
      return;
    }
    if (error.status === 403 && error.code === 'FORBIDDEN') {
      patch({ tokenVerified: false });
      fail('token', { setupToken: error.message });
      return;
    }
    fail(step, {}, error.message);
  };

  const verifyToken = async () => {
    if (validateToken(state).setupToken) return;
    setBusy(true);
    try {
      await endpoints.setup.verifyToken(state.setupToken);
      patch({ tokenVerified: true });
      goto('organization');
    } catch (error) {
      handleApiError('token', error);
    } finally {
      setBusy(false);
    }
  };

  // Token dari tautan (`#token=…`): hapus dari alamat, lalu langsung diperiksa (sekali saja).
  const linkHandled = useRef(false);
  const verifyLinkToken = useEffectEvent(() => void verifyToken());
  useEffect(() => {
    if (linkToken === null || linkHandled.current) return;
    linkHandled.current = true;
    const { location } = router.history;
    router.history.replace(location.pathname + location.search, location.state);
    verifyLinkToken();
  }, [linkToken, router]);

  const advance = async (step: SetupStep) => {
    switch (step) {
      case 'token': {
        const errors = validateToken(state);
        if (Object.keys(errors).length > 0) return fail(step, errors);
        if (state.tokenVerified) return goto('organization');
        return verifyToken();
      }
      case 'organization': {
        const errors = validateOrganization(state);
        if (Object.keys(errors).length > 0) return fail(step, errors);
        return goto('owner');
      }
      case 'owner': {
        const errors = validateOwner(state);
        if (Object.keys(errors).length > 0) return fail(step, errors);
        setBusy(true);
        try {
          const check = await endpoints.setup.checkPassword({
            setupToken: state.setupToken,
            password: state.owner.password,
            email: state.owner.email.trim(),
            name: state.owner.name.trim(),
            organizationName: state.organization.name.trim(),
          });
          if (!check.acceptable) {
            return fail(step, {
              'owner.password': check.message ?? t.setup.steps.owner.strength.weak,
            });
          }
          return goto('branding');
        } catch (error) {
          return handleApiError(step, error);
        } finally {
          setBusy(false);
        }
      }
      case 'branding': {
        const errors = validateBranding(state);
        if (Object.keys(errors).length > 0) return fail(step, errors);
        return goto('email');
      }
      case 'email': {
        if (!canStoreSecrets) return goto('summary');
        const errors = validateEmail({ ...state, email: { ...state.email, skipped: false } });
        if (Object.keys(errors).length > 0) return fail(step, errors);
        patch({ email: { ...state.email, skipped: false } });
        return goto('summary');
      }
      case 'summary':
        return complete();
    }
  };

  const complete = async () => {
    setBusy(true);
    try {
      const session = await endpoints.setup.complete(buildCompleteRequest(state, canStoreSecrets));
      storeSession(queryClient, session);
      // Sama dengan jawaban server setelah setup selesai (docs/KONTRAK-API-AUTH.md).
      queryClient.setQueryData(queryKeys.setupStatus, {
        needsSetup: false,
        setupTokenConfigured: false,
        canStoreSecrets: false,
      });
      // Merek baru (nama, logo) dimuat dulu supaya Inbox langsung tampil dengan merek itu.
      await queryClient.fetchQuery({ ...brandingQuery, staleTime: 0 }).catch(() => undefined);
      await router.navigate({ to: '/inbox', replace: true });
    } catch (error) {
      setBusy(false);
      if (!isApiError(error)) return fail('summary', {}, t.api.network);
      const failure = mapCompleteError(error);
      if (failure.kind === 'conflict') return onConflict();
      fail(failure.step, failure.errors, failure.banner);
    }
  };

  const skip = (step: SetupStep) => {
    if (step === 'branding') {
      patch({ branding: { productName: '', primaryColor: '', logo: null } });
    }
    if (step === 'email') patch({ email: { ...state.email, skipped: true } });
    goto(nextStep(step));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) void advance(state.step);
  };

  const index = stepIndex(state.step);
  const copy = STEP_COPY[state.step];
  const optional = OPTIONAL_STEPS.has(state.step);
  const canSkip = optional && !(state.step === 'email' && !canStoreSecrets);
  const isSummary = state.step === 'summary';
  const fieldErrorCount = Object.keys(state.errors).length;

  return (
    <div className={styles.screen}>
      <aside className={styles.sidebar}>
        <BrandLogo className={styles.logo} />
        <div className={styles.sidebarIntro}>
          <p className={styles.eyebrow}>{t.setup.eyebrow}</p>
          <p className={styles.intro}>{t.setup.intro}</p>
        </div>
        <StepNav state={state} onSelect={goto} disabled={busy} />
      </aside>

      <header className={styles.topbar}>
        <BrandLogo className={styles.topLogo} />
        <div className={styles.progress}>
          <span className={styles.progressText}>
            {t.setup.stepOf(index + 1, SETUP_STEPS.length)}
          </span>
          <span className={styles.progressBars} aria-hidden="true">
            {SETUP_STEPS.map((step, position) => (
              <span
                key={step}
                className={styles.progressBar}
                data-on={position <= index ? '' : undefined}
              />
            ))}
          </span>
        </div>
      </header>

      <main className={styles.main}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={styles.content}>
            <div className={styles.stepHead}>
              {/* HP/tablet: nomor langkah sudah tampil di bilah atas; di sini cukup label "Opsional". */}
              {optional || isDesktop ? (
                <p className={styles.stepCount}>
                  <span className={styles.stepCountText}>
                    {t.setup.stepOf(index + 1, SETUP_STEPS.length)}
                  </span>
                  {optional ? (
                    <span className={styles.optionalBadge}>{t.setup.optional}</span>
                  ) : null}
                </p>
              ) : null}
              <h1 ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
                {copy.title}
              </h1>
              <p className={styles.stepBody}>{copy.body}</p>
            </div>

            {state.banner ? (
              <Notice tone="danger" role="alert">
                {state.banner}
              </Notice>
            ) : null}
            {fieldErrorCount > 0 ? (
              <p className="sr-only" role="alert">
                {t.form.fixErrors(fieldErrorCount)}
              </p>
            ) : null}

            {state.step === 'token' ? (
              <TokenStep state={state} patch={patch} disabled={busy} />
            ) : null}
            {state.step === 'organization' ? (
              <OrganizationStep state={state} patch={patch} disabled={busy} />
            ) : null}
            {state.step === 'owner' ? (
              <OwnerStep state={state} patch={patch} disabled={busy} />
            ) : null}
            {state.step === 'branding' ? (
              <BrandingStep state={state} patch={patch} disabled={busy} />
            ) : null}
            {state.step === 'email' ? (
              <EmailStep
                state={state}
                patch={patch}
                disabled={busy}
                canStoreSecrets={canStoreSecrets}
              />
            ) : null}
            {isSummary ? (
              <SummaryStep
                state={state}
                onEdit={goto}
                canStoreSecrets={canStoreSecrets}
                disabled={busy}
              />
            ) : null}
          </div>

          <div className={styles.actions}>
            {index > 0 ? (
              <Button
                size="lg"
                variant="ghost"
                onClick={() => goto(previousStep(state.step))}
                disabled={busy}
                className={styles.back}
              >
                <Icon icon={ArrowLeft} size={16} />
                {t.setup.back}
              </Button>
            ) : null}
            <span className={styles.spacer} />
            {canSkip ? (
              <Button size="lg" onClick={() => skip(state.step)} disabled={busy}>
                {t.setup.skip}
              </Button>
            ) : null}
            <Button
              type="submit"
              size="lg"
              variant="primary"
              loading={busy}
              className={styles.next}
            >
              {busy
                ? isSummary
                  ? t.setup.steps.summary.submitting
                  : t.setup.checking
                : isSummary
                  ? t.setup.steps.summary.submit
                  : t.setup.next}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

function StepNav({
  state,
  onSelect,
  disabled,
}: {
  state: WizardState;
  onSelect: (step: SetupStep) => void;
  disabled: boolean;
}) {
  const current = stepIndex(state.step);
  return (
    <nav aria-label={t.setup.stepsLabel}>
      <ol className={styles.steps}>
        {SETUP_STEPS.map((step, position) => {
          const done = position < current || (position <= state.furthest && position !== current);
          const isCurrent = position === current;
          const reachable = position <= state.furthest && !isCurrent;
          const content = (
            <>
              <span className={styles.stepMarker} aria-hidden="true">
                {done ? <Icon icon={Check} size={16} /> : position + 1}
              </span>
              <span className={styles.stepLabel}>
                {STEP_COPY[step].nav}
                {OPTIONAL_STEPS.has(step) ? (
                  <span className={styles.stepOptional}>{t.setup.optional}</span>
                ) : null}
              </span>
              <span className="sr-only">
                {isCurrent ? `, ${t.setup.stepCurrent}` : done ? `, ${t.setup.stepDone}` : ''}
              </span>
            </>
          );
          return (
            <li
              key={step}
              className={cx(styles.stepItem, isCurrent && styles.stepItemCurrent)}
              data-state={isCurrent ? 'current' : done ? 'done' : 'todo'}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {reachable ? (
                <button
                  type="button"
                  className={styles.stepButton}
                  onClick={() => onSelect(step)}
                  disabled={disabled}
                >
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
