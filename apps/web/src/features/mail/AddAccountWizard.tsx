import {
  MAIL_DEFAULT_SYNC_WINDOW_DAYS,
  MAIL_PORT_NOT_ALLOWED_MESSAGE,
  MAIL_PRESETS,
  MAIL_PROVIDER_CARDS,
  createMailAccountRequestSchema,
  emailAddressSchema,
  mailPortAllowed,
  testMailAccountRequestSchema,
  type DetectMailAccountResponse,
  type IdentityConfirmation,
  type MailAccount,
  type MailAccountColor,
  type MailAccountKind,
  type MailAvailableProvider,
  type MailProviderCard,
  type MailSyncWindowDays,
  type TestMailAccountResponse,
} from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Check, Lock, Sparkles, UsersRound, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { AvatarPicker } from './AvatarPicker';
import type { AvatarDraft } from './avatar-file';
import { GrantsEditor } from './GrantsEditor';
import { ColorPicker } from './MailControls';
import { CredentialFields, ServerCards } from './ServerFields';
import { TestResults } from './TestResults';
import { onlyConnectionFailures } from './test-rows';
import {
  PROVIDER_ICONS,
  WINDOW_OPTIONS,
  emailDomain,
  parseWindow,
  windowValue,
} from './mail-format';
import { mailProvidersQuery, useRequireCode } from './mail-queries';
import {
  WIZARD_STEPS,
  createBody,
  initialServerValues,
  resultFromSaveFailure,
  serverBody,
  stepOfField,
  testPassed,
  testSignature,
  unsupportedSuggestion,
  usableSuggestion,
  type GrantDraft,
  type ServerValues,
  type WizardStep,
} from './wizard-state';
import styles from './Wizard.module.css';

const m = t.mail;
const w = t.mail.wizard;

interface Detection {
  emailAddress: string;
  result: DetectMailAccountResponse | null;
  error: unknown;
}

interface TestState {
  pending: boolean;
  result: TestMailAccountResponse | null;
  error: unknown;
  /** Sidik isian saat dites (`testSignature`). */
  signature: string | null;
}

const EMPTY_TEST: TestState = { pending: false, result: null, error: null, signature: null };

/**
 * Wizard "Hubungkan akun email" (mockup tab Tambah akun, kontrak §4): Penyedia → Detail akun → Tes
 * koneksi → Akses & tampilan. Satu `<dialog>`; semua langkah tetap terpasang (yang tidak aktif
 * `hidden`) supaya password di isian tak terkendali bertahan sampai disimpan, lalu dikosongkan.
 * Password tidak pernah masuk state, cache Query, atau `useMutation`. Akun bersama = konfirmasi
 * identitas (dialog di luar `<form>`).
 */
export function AddAccountWizard({
  initialProvider,
  canShared,
  canPersonal,
  onClose,
  onCreated,
}: {
  initialProvider: MailAvailableProvider | null;
  canShared: boolean;
  canPersonal: boolean;
  onClose: () => void;
  /** Akun tersimpan; `warning` = foto gagal diunggah (akun tetap terhubung). */
  onCreated: (account: MailAccount, warning: string | null) => void;
}) {
  const session = useSession();
  const requireCode = useRequireCode();
  const providers = useQuery(mailProvidersQuery).data?.providers ?? MAIL_PROVIDER_CARDS;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const imapPasswordRef = useRef<HTMLInputElement>(null);
  const smtpPasswordRef = useRef<HTMLInputElement>(null);
  const stepRefs = useRef<(HTMLHeadingElement | null)[]>([]);
  const titleId = useId();

  const [step, setStep] = useState<WizardStep>(1);
  const [emailAddress, setEmailAddress] = useState('');
  const [provider, setProvider] = useState<MailAvailableProvider | null>(initialProvider);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [values, setValues] = useState<ServerValues | null>(null);
  /** Kunci isian awal langkah 2 (alamat + penyedia + hasil deteksi) yang sudah diterapkan. */
  const appliedRef = useRef<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [test, setTest] = useState<TestState>(EMPTY_TEST);
  const [kind, setKind] = useState<MailAccountKind>(canShared ? 'shared' : 'personal');
  const [grants, setGrants] = useState<GrantDraft[]>([]);
  const [color, setColor] = useState<MailAccountColor>('tagBlue');
  const [syncWindow, setSyncWindow] = useState<MailSyncWindowDays>(MAIL_DEFAULT_SYNC_WINDOW_DAYS);
  const [avatar, setAvatar] = useState<AvatarDraft | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [invalidTick, setInvalidTick] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLElement>('input')?.focus();
    return () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  }, []);

  // Langkah berganti: fokus ke judul langkah (pembaca layar mendengar langkah baru).
  const [stepTick, setStepTick] = useState(0);
  useEffect(() => {
    if (stepTick === 0) return;
    stepRefs.current[step - 1]?.focus();
  }, [stepTick, step]);

  // Isian ditolak: fokus ke isian pertama yang salah di langkah yang terbuka.
  useEffect(() => {
    if (invalidTick === 0) return;
    const field = formRef.current?.querySelector<HTMLElement>(
      `[data-step="${step}"] [aria-invalid="true"]`,
    );
    field?.focus();
  }, [invalidTick, step]);

  const go = (next: WizardStep) => {
    setStep(next);
    setStepTick((tick) => tick + 1);
  };

  const invalid = (fieldErrors: FieldErrors, at?: WizardStep) => {
    setErrors(fieldErrors);
    const first = Object.keys(fieldErrors)[0];
    const target = at ?? (first ? stepOfField(first) : step);
    if (target !== step) go(target);
    setInvalidTick((tick) => tick + 1);
  };

  const secret = (ref: { current: HTMLInputElement | null }) => {
    const value = ref.current?.value ?? '';
    return value.length > 0 ? value : undefined;
  };
  const clearSecrets = () => {
    if (imapPasswordRef.current) imapPasswordRef.current.value = '';
    if (smtpPasswordRef.current) smtpPasswordRef.current.value = '';
  };

  const setValue = <K extends keyof ServerValues>(key: K, value: ServerValues[K]) => {
    setValues((current) => (current ? { ...current, [key]: value } : current));
    setErrors({});
  };

  const domain = emailDomain(emailAddress);
  const suggestion =
    detection && detection.emailAddress === emailAddress.trim().toLowerCase() && detection.result
      ? usableSuggestion(detection.result.suggestions)
      : null;
  const unsupported =
    detection?.result && !suggestion ? unsupportedSuggestion(detection.result.suggestions) : null;
  const signature = values ? testSignature(emailAddress, values) : null;
  const testValid = test.signature !== null && test.signature === signature;
  const passed = testValid && testPassed(test.result);

  // ── Langkah 1: alamat + penyedia ─────────────────────────────────────────

  const detect = async (address: string): Promise<Detection> => {
    setDetecting(true);
    try {
      const result = await endpoints.mail.detect(address);
      const next: Detection = { emailAddress: address, result, error: null };
      setDetection(next);
      const usable = usableSuggestion(result.suggestions);
      if (usable && (usable.provider === 'cpanel' || usable.provider === 'imap')) {
        setProvider(usable.provider);
      }
      return next;
    } catch (caught) {
      const next: Detection = { emailAddress: address, result: null, error: caught };
      setDetection(next);
      return next;
    } finally {
      setDetecting(false);
    }
  };

  const validEmail = () => {
    const parsed = emailAddressSchema.safeParse(emailAddress);
    return parsed.success ? parsed.data : null;
  };

  const detectNow = async () => {
    const address = validEmail();
    if (!address) {
      invalid({ emailAddress: emailError() }, 1);
      return;
    }
    if (detection?.emailAddress !== address) await detect(address);
  };

  const emailError = () => {
    const parsed = emailAddressSchema.safeParse(emailAddress);
    return parsed.success ? '' : (parsed.error.issues[0]?.message ?? '');
  };

  const toDetails = async () => {
    const address = validEmail();
    if (!address) {
      invalid({ emailAddress: emailError() }, 1);
      return;
    }
    let found = detection?.emailAddress === address ? detection : null;
    if (!found) found = await detect(address);
    const usable = found.result ? usableSuggestion(found.result.suggestions) : null;
    const chosen: MailAvailableProvider | null =
      provider ??
      (usable && (usable.provider === 'cpanel' || usable.provider === 'imap')
        ? usable.provider
        : null);
    if (!chosen) {
      invalid({ provider: w.pickProvider }, 1);
      return;
    }
    if (chosen !== provider) setProvider(chosen);
    const key = JSON.stringify([address, chosen, usable]);
    if (appliedRef.current !== key) {
      appliedRef.current = key;
      setValues(initialServerValues(address, chosen, usable, session?.organization.name ?? ''));
      setTest(EMPTY_TEST);
    }
    setErrors({});
    go(2);
  };

  // ── Langkah 2 → 3: tes Masuk & Keluar ────────────────────────────────────

  const runTest = async () => {
    if (!values) return;
    const passwords = { imap: secret(imapPasswordRef), smtp: secret(smtpPasswordRef) };
    const body = {
      emailAddress: emailAddress.trim().toLowerCase(),
      ...serverBody(values, passwords),
      syncWindowDays: syncWindow,
      targets: ['incoming', 'outgoing'] as ('incoming' | 'outgoing')[],
    };
    const parsed = testMailAccountRequestSchema.safeParse(body);
    const fieldErrors: FieldErrors = parsed.success ? {} : zodFieldErrors(parsed.error);
    // Nama tampilan & pengirim dicek sekarang supaya galatnya muncul di langkah yang sama.
    const names = createMailAccountRequestSchema
      .pick({ displayName: true, fromName: true })
      .safeParse({ displayName: values.displayName, fromName: values.fromName });
    if (!names.success) Object.assign(fieldErrors, zodFieldErrors(names.error));
    if (!passwords.imap) fieldErrors['imap.password'] ??= w.passwordRequired;
    if (!values.sameCredentials && !passwords.smtp) {
      fieldErrors['smtp.password'] ??= w.passwordRequired;
    }
    if (parsed.success) {
      const { imap, smtp } = parsed.data;
      if (imap && !mailPortAllowed('imap', imap.port, imap.security)) {
        fieldErrors['imap.port'] ??= MAIL_PORT_NOT_ALLOWED_MESSAGE;
      }
      if (smtp && !mailPortAllowed('smtp', smtp.port, smtp.security)) {
        fieldErrors['smtp.port'] ??= MAIL_PORT_NOT_ALLOWED_MESSAGE;
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      invalid(fieldErrors, 2);
      return;
    }
    const tested = testSignature(emailAddress, values);
    setErrors({});
    setTest({ pending: true, result: null, error: null, signature: tested });
    go(3);
    try {
      const result = await endpoints.mail.test(body);
      setTest({ pending: false, result, error: null, signature: tested });
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR' && caught.details.length > 0) {
        setTest(EMPTY_TEST);
        invalid(apiFieldErrors(caught.details));
        return;
      }
      setTest({ pending: false, result: null, error: caught, signature: null });
    }
  };

  // ── Langkah 4: simpan ────────────────────────────────────────────────────

  const draftBody = () => {
    if (!values || !provider) return null;
    const passwords = {
      imap: secret(imapPasswordRef) ?? '',
      smtp: secret(smtpPasswordRef),
    };
    return createBody(
      {
        kind,
        provider,
        emailAddress: emailAddress.trim().toLowerCase(),
        values,
        color,
        syncWindowDays: syncWindow,
        grants,
      },
      passwords,
    );
  };

  const handleSaveError = (caught: unknown) => {
    if (!isApiError(caught)) {
      setSaveError(caught);
      return;
    }
    if (caught.code === 'CHANNEL_REQUEST_FAILED') {
      // Tes ulang di server gagal: tampilkan sebabnya di langkah Tes koneksi.
      setTest({
        pending: false,
        result: resultFromSaveFailure(test.result, caught.details),
        error: null,
        signature,
      });
      go(3);
      return;
    }
    const reason = caught.details.find((detail) => detail.reason)?.reason;
    if (
      caught.status === 409 &&
      (reason === 'address_is_inbox_channel' || reason === 'address_already_connected')
    ) {
      invalid({ emailAddress: caught.message }, 1);
      return;
    }
    const fieldErrors = apiFieldErrors(
      caught.details.filter(
        (detail) => detail.field.length > 0 && !detail.field.startsWith('confirmation'),
      ),
    );
    if (caught.code === 'VALIDATION_ERROR' && Object.keys(fieldErrors).length > 0) {
      invalid(fieldErrors);
      return;
    }
    setSaveError(caught);
  };

  const send = async (confirmation?: IdentityConfirmation) => {
    const body = draftBody();
    if (!body) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { account } = await endpoints.mail.create({
        ...body,
        ...(confirmation ? { confirmation } : {}),
      });
      let warning: string | null = null;
      if (avatar) {
        try {
          await endpoints.mail.setAvatar(account.id, avatar.base64);
        } catch {
          warning = w.avatarFailed;
        }
      }
      clearSecrets();
      setConfirming(false);
      onCreated(account, warning);
    } catch (caught) {
      if (confirmation && isConfirmationError(caught)) throw caught;
      setConfirming(false);
      handleSaveError(caught);
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const body = draftBody();
    if (!body) return;
    const parsed = createMailAccountRequestSchema.safeParse(body);
    if (!parsed.success) {
      invalid(zodFieldErrors(parsed.error));
      return;
    }
    setSaveError(null);
    if (kind === 'shared') setConfirming(true);
    else void send();
  };

  // ── Navigasi ─────────────────────────────────────────────────────────────

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving || detecting || test.pending) return;
    if (step === 1) void toDetails();
    else if (step === 2) void runTest();
    else if (step === 3) {
      if (passed) go(4);
      else void runTest();
    } else save();
  };

  const back = () => {
    if (step === 1) onClose();
    else go((step - 1) as WizardStep);
  };

  const primaryLabel =
    step === 1
      ? detecting
        ? w.detecting
        : w.next
      : step === 2
        ? w.test
        : step === 3
          ? test.pending
            ? w.testing
            : passed
              ? w.next
              : w.retest
          : saving
            ? w.saving
            : w.save;

  const kindLocked = kind === 'shared' ? !canShared : !canPersonal;
  const guideText = provider ? MAIL_PRESETS[provider].guide : MAIL_PRESETS.imap.guide;

  const guideToggle = (className: string) => (
    <Button
      variant="ghost"
      className={cx(styles.guideButton, className)}
      aria-expanded={guideOpen}
      onClick={() => setGuideOpen((open) => !open)}
    >
      <Icon icon={BookOpen} size={16} />
      {guideOpen ? w.guideHide : w.guide}
    </Button>
  );

  return (
    <>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          if (!saving && !confirming) onClose();
        }}
      >
        <form ref={formRef} className={styles.frame} onSubmit={submit} noValidate>
          <header className={styles.head}>
            <div className={styles.headRow}>
              <h2 id={titleId} className={styles.title}>
                {w.title}
              </h2>
              <IconButton
                label={w.close}
                icon={X}
                className={styles.close}
                disabled={saving}
                onClick={onClose}
              />
            </div>
            <Stepper step={step} onGo={(target) => go(target)} disabled={saving || test.pending} />
          </header>

          <div className={styles.body}>
            {guideOpen && step < 4 ? (
              <Notice tone="info" title={w.guideTitle}>
                <p>{guideText}</p>
                <p>{w.guideAppPassword}</p>
              </Notice>
            ) : null}

            {/* Langkah 1: alamat + penyedia */}
            <section className={styles.step} data-step="1" hidden={step !== 1}>
              <StepHeading
                index={0}
                setRef={(element) => {
                  stepRefs.current[0] = element;
                }}
              />
              <TextField
                label={w.emailLabel}
                hint={w.emailHint}
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={254}
                size="lg"
                value={emailAddress}
                onChange={(event) => {
                  setEmailAddress(event.target.value);
                  setErrors({});
                }}
                onBlur={() => {
                  const address = validEmail();
                  if (address && detection?.emailAddress !== address && !detecting) {
                    void detect(address);
                  }
                }}
                error={errors.emailAddress}
                trailing={
                  <IconButton
                    label={detecting ? w.detecting : w.detect}
                    icon={Sparkles}
                    className={cx(styles.detectButton, detecting && styles.pulsing)}
                    disabled={detecting}
                    onClick={() => void detectNow()}
                  />
                }
              />
              <fieldset className={styles.providers}>
                <legend className={styles.divider}>
                  <span>{w.orPick}</span>
                </legend>
                <div className={styles.providerGrid}>
                  {providers.map((card) => (
                    <ProviderCard
                      key={card.id}
                      card={card}
                      selected={provider === card.id}
                      matched={suggestion?.provider === card.id ? domain : null}
                      onSelect={() => {
                        if (card.id === 'cpanel' || card.id === 'imap') {
                          setProvider(card.id);
                          setErrors({});
                        }
                      }}
                    />
                  ))}
                </div>
                {errors.provider ? (
                  <p className={styles.fieldError} role="alert">
                    {errors.provider}
                  </p>
                ) : null}
              </fieldset>
            </section>

            {/* Langkah 2: detail akun & server */}
            <section className={styles.step} data-step="2" hidden={step !== 2}>
              <StepHeading
                index={1}
                setRef={(element) => {
                  stepRefs.current[1] = element;
                }}
              />
              {detection?.error ? (
                <Notice tone="warning">{w.detectFailed}</Notice>
              ) : suggestion ? (
                <Notice tone="success" title={w.detectedTitle(domain)}>
                  {suggestion.description || w.detectedBody}
                </Notice>
              ) : unsupported ? (
                <Notice tone="warning" title={w.unsupportedTitle}>
                  {unsupported.description}
                </Notice>
              ) : detection?.result ? (
                <Notice tone="info" title={w.notDetectedTitle}>
                  {w.notDetectedBody}
                </Notice>
              ) : null}
              {values ? (
                <>
                  <div className={styles.row}>
                    <TextField
                      label={w.displayName}
                      hint={w.displayNameHint}
                      value={values.displayName}
                      onChange={(event) => setValue('displayName', event.target.value)}
                      error={errors.displayName}
                      maxLength={60}
                      autoComplete="off"
                    />
                    <TextField
                      label={w.fromName}
                      hint={w.fromNameHint}
                      value={values.fromName}
                      onChange={(event) => setValue('fromName', event.target.value)}
                      error={errors.fromName}
                      maxLength={80}
                      autoComplete="off"
                    />
                  </div>
                  <CredentialFields
                    values={values}
                    set={setValue}
                    errors={errors}
                    imapPasswordRef={imapPasswordRef}
                    passwordHint={w.passwordHint}
                    onSecretChange={() => setErrors({})}
                  />
                  <ServerCards
                    values={values}
                    set={setValue}
                    errors={errors}
                    smtpPasswordRef={smtpPasswordRef}
                    passwordHint={w.passwordHint}
                    onSecretChange={() => setErrors({})}
                  />
                </>
              ) : null}
            </section>

            {/* Langkah 3: tes koneksi */}
            <section className={styles.step} data-step="3" hidden={step !== 3}>
              <StepHeading
                index={2}
                setRef={(element) => {
                  stepRefs.current[2] = element;
                }}
              />
              <div aria-live="polite" className={styles.stack}>
                <TestResults
                  result={testValid ? test.result : null}
                  pending={test.pending}
                  emailAddress={emailAddress.trim().toLowerCase()}
                />
                {test.error ? (
                  <Notice tone="danger" role="alert" title={w.failedTitle}>
                    {isApiError(test.error) ? test.error.message : t.api.network}
                  </Notice>
                ) : !test.pending && testValid && test.result ? (
                  passed ? (
                    <Notice tone="info">
                      {syncWindow === null
                        ? w.syncNoticeAll(
                            test.result.incoming?.details?.estimatedInitialSync ?? null,
                          )
                        : w.syncNotice(
                            m.windows[windowValue(syncWindow)] ?? '',
                            test.result.incoming?.details?.estimatedInitialSync ?? null,
                          )}
                    </Notice>
                  ) : (
                    <Notice tone="danger" role="alert" title={w.failedTitle}>
                      {onlyConnectionFailures(test.result) ? w.fixHintConnection : w.fixHint}
                    </Notice>
                  )
                ) : null}
              </div>
            </section>

            {/* Langkah 4: akses & tampilan */}
            <section className={styles.step} data-step="4" hidden={step !== 4}>
              <StepHeading
                index={3}
                setRef={(element) => {
                  stepRefs.current[3] = element;
                }}
              />
              <fieldset className={styles.kinds}>
                <legend className="sr-only">{w.kindLabel}</legend>
                <KindCard
                  value="shared"
                  current={kind}
                  onSelect={setKind}
                  icon={UsersRound}
                  title={w.sharedTitle}
                  body={canShared ? w.sharedBody : w.sharedLocked}
                  disabled={!canShared}
                />
                <KindCard
                  value="personal"
                  current={kind}
                  onSelect={setKind}
                  icon={Lock}
                  title={w.personalTitle}
                  body={canPersonal ? w.personalBody : w.personalLocked}
                  disabled={!canPersonal}
                />
              </fieldset>
              {kind === 'shared' && canShared ? (
                <section className={styles.subsection} aria-labelledby={`${titleId}-akses`}>
                  <h3 id={`${titleId}-akses`} className={styles.subTitle}>
                    {m.access.listLabel}
                  </h3>
                  <GrantsEditor grants={grants} onChange={setGrants} disabled={saving} />
                  {errors.access ? <p className={styles.fieldError}>{errors.access}</p> : null}
                </section>
              ) : null}
              <div className={styles.row}>
                <ColorPicker
                  label={w.colorLabel}
                  hint={w.colorHint}
                  value={color}
                  onChange={setColor}
                  disabled={saving}
                />
                <SelectField
                  label={w.windowLabel}
                  hint={w.windowHint}
                  value={windowValue(syncWindow)}
                  onChange={(event) => setSyncWindow(parseWindow(event.target.value))}
                  options={WINDOW_OPTIONS}
                  disabled={saving}
                />
              </div>
              <AvatarPicker
                displayName={values?.displayName ?? ''}
                color={color}
                value={avatar?.dataUrl ?? null}
                onPick={setAvatar}
                disabled={saving}
              />
              {kindLocked ? (
                <Notice tone="warning">
                  {kind === 'shared' ? w.sharedLocked : w.personalLocked}
                </Notice>
              ) : null}
              {saveError ? (
                <Notice tone="danger" role="alert">
                  {isApiError(saveError) ? saveError.message : t.api.network}
                </Notice>
              ) : null}
            </section>

            {step < 4 ? guideToggle(styles.guideInBody ?? '') : null}
          </div>

          <footer className={styles.foot}>
            {step < 4 ? guideToggle(styles.guideInFoot ?? '') : <span />}
            <div className={styles.footButtons}>
              <Button disabled={saving} onClick={back}>
                {step === 1 ? w.cancel : w.back}
              </Button>
              <Button
                ref={submitRef}
                type="submit"
                variant="primary"
                loading={saving || detecting || test.pending}
                disabled={step === 4 && kindLocked}
              >
                {primaryLabel}
              </Button>
            </div>
          </footer>
        </form>
      </dialog>
      <IdentityDialog
        open={confirming}
        title={w.confirmTitle}
        body={w.confirmBody}
        confirmLabel={w.save}
        pendingLabel={w.saving}
        requireCode={requireCode}
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(false)}
        onConfirm={(confirmation) => send(confirmation)}
      />
    </>
  );
}

/** Judul langkah untuk pembaca layar (tampilan langkah ada di penunjuk langkah). */
function StepHeading({
  index,
  setRef,
}: {
  index: number;
  setRef: (element: HTMLHeadingElement | null) => void;
}) {
  return (
    <h3 ref={setRef} tabIndex={-1} className="sr-only">
      {w.stepOf(index + 1, WIZARD_STEPS)}: {w.steps[index]}
    </h3>
  );
}

/** Penunjuk langkah: selesai (centang, bisa diklik untuk kembali), sedang, berikutnya. */
function Stepper({
  step,
  onGo,
  disabled,
}: {
  step: WizardStep;
  onGo: (step: WizardStep) => void;
  disabled: boolean;
}) {
  return (
    <ol className={styles.stepper} aria-label={w.stepsLabel}>
      {w.steps.map((name, index) => {
        const number = (index + 1) as WizardStep;
        const state = number < step ? 'done' : number === step ? 'current' : 'next';
        const content = (
          <>
            <span className={styles.stepNumber} aria-hidden="true">
              {state === 'done' ? <Icon icon={Check} size={16} /> : number}
            </span>
            <span className={styles.stepName}>{name}</span>
            {state === 'done' ? <span className="sr-only">, {w.stepDone}</span> : null}
          </>
        );
        return (
          <li
            key={name}
            className={styles.stepItem}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            {state === 'done' ? (
              <button
                type="button"
                className={styles.stepButton}
                disabled={disabled}
                onClick={() => onGo(number)}
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
  );
}

function ProviderCard({
  card,
  selected,
  matched,
  onSelect,
}: {
  card: MailProviderCard;
  selected: boolean;
  /** Domain yang cocok dengan hasil deteksi (penanda "Cocok untuk @…"). */
  matched: string | null;
  onSelect: () => void;
}) {
  const usable = card.available && (card.id === 'cpanel' || card.id === 'imap');
  return (
    <label className={styles.providerCard} data-disabled={usable ? undefined : ''}>
      <input
        type="radio"
        name="penyedia-email"
        value={card.id}
        checked={selected}
        disabled={!usable}
        onChange={onSelect}
        className={styles.cardInput}
      />
      <span className={styles.cardTick} aria-hidden="true">
        <Icon icon={Check} size={16} />
      </span>
      <span className={styles.providerIcon} data-available={usable ? '' : undefined}>
        <Icon icon={PROVIDER_ICONS[card.id]} size={20} />
      </span>
      <span className={styles.providerName}>{card.name}</span>
      <span className={styles.providerBody}>{card.description}</span>
      {matched ? (
        <span className={styles.tag} data-tone="success">
          {w.matchPrefix} <span className={styles.tagDomain}>@{matched}</span>
        </span>
      ) : !usable ? (
        <span className={styles.tag}>{card.note ?? w.soon}</span>
      ) : null}
    </label>
  );
}

function KindCard({
  value,
  current,
  onSelect,
  icon,
  title,
  body,
  disabled,
}: {
  value: MailAccountKind;
  current: MailAccountKind;
  onSelect: (kind: MailAccountKind) => void;
  icon: typeof Lock;
  title: string;
  body: ReactNode;
  disabled: boolean;
}) {
  return (
    <label className={styles.kindCard} data-disabled={disabled ? '' : undefined}>
      <input
        type="radio"
        name="jenis-akun-email"
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className={styles.cardInput}
      />
      <span className={styles.cardTick} aria-hidden="true">
        <Icon icon={Check} size={16} />
      </span>
      <span className={styles.kindIcon} aria-hidden="true">
        <Icon icon={icon} size={20} />
      </span>
      <span className={styles.kindText}>
        <span className={styles.providerName}>{title}</span>
        <span className={styles.providerBody}>{body}</span>
      </span>
    </label>
  );
}
