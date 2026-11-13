import {
  SMTP_PLAINTEXT_LOGIN_WARNING,
  SMTP_PRESETS,
  isPlaintextSmtpLogin,
  SMTP_SECURITY_LABELS,
  SMTP_SECURITY_MODES,
  emailAddressSchema,
  emailDomainOf,
  smtpSecuritySchema,
  type DetectEmailHostResponse,
  type EmailHostSuggestion,
  type EmailSettingsView,
  type SmtpPresetId,
} from '@balesin/shared';
import { Check, LoaderCircle, Sparkles } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { PasswordField, SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import type { FieldErrors } from '../../lib/form';
import styles from './EmailSettings.module.css';
import {
  applyPreset,
  canKeepStoredPassword,
  updateEmailForm,
  type EmailFormValues,
} from './email-form';

const DETECT_DELAY_MS = 600;

export type DetectHost = (
  emailAddress: string,
  signal: AbortSignal,
) => Promise<DetectEmailHostResponse>;

interface EmailSettingsFieldsProps {
  /** Awalan id elemen supaya unik bila ada dua form di halaman. */
  idPrefix: string;
  values: EmailFormValues;
  onChange: (values: EmailFormValues) => void;
  errors: FieldErrors;
  /** Pengaturan tersimpan (halaman Pengaturan): untuk petunjuk password tersamar. */
  saved?: EmailSettingsView | null;
  detectHost: DetectHost;
  disabled?: boolean;
  /** `lg`: kontrol 44px (wizard setup). */
  size?: 'md' | 'lg';
}

type Detection =
  | { state: 'idle' }
  | { state: 'loading'; domain: string }
  | { state: 'done'; result: DetectEmailHostResponse };

/** Isian email pengirim: preset, pengirim, server SMTP (docs/PENGATURAN-UI.md §1). */
export function EmailSettingsFields({
  idPrefix,
  values,
  onChange,
  errors,
  saved,
  detectHost,
  disabled = false,
  size = 'md',
}: EmailSettingsFieldsProps) {
  const set = (patch: Partial<EmailFormValues>) => onChange(updateEmailForm(values, patch));
  const preset = SMTP_PRESETS.find((candidate) => candidate.id === values.preset);
  const detection = useHostDetection(values.fromAddress, detectHost);
  const appliedRef = useRef<string | null>(null);

  // Saran pertama langsung dipakai bila host masih kosong (pengguna tetap bisa menggantinya).
  useEffect(() => {
    if (detection.state !== 'done') return;
    const [first] = detection.result.suggestions;
    if (!first || values.host.trim() !== '' || appliedRef.current === detection.result.domain) {
      return;
    }
    appliedRef.current = detection.result.domain;
    onChange(applySuggestion(values, first));
  }, [detection, values, onChange]);

  const keepPassword = canKeepStoredPassword(values, saved);
  const passwordLabel = preset?.requiresAppPassword
    ? t.emailSettings.appPassword
    : t.emailSettings.password;
  const passwordHint = keepPassword
    ? saved?.passwordHint
      ? t.emailSettings.passwordKeep(saved.passwordHint)
      : t.emailSettings.passwordKeepNoHint
    : saved?.hasPassword
      ? t.emailSettings.passwordReenter
      : undefined;

  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className={styles.fields}>
      <fieldset className={styles.group} disabled={disabled}>
        <legend className={styles.legend}>{t.emailSettings.presetLabel}</legend>
        <RadioGroup.Root
          className={styles.presets}
          value={values.preset}
          onValueChange={(value) => onChange(applyPreset(values, value as SmtpPresetId))}
          aria-label={t.emailSettings.presetLabel}
          aria-describedby={id('preset-petunjuk')}
          disabled={disabled}
        >
          {SMTP_PRESETS.map((option) => (
            <RadioGroup.Item key={option.id} value={option.id} className={styles.preset}>
              <span className={styles.presetRadio} aria-hidden="true">
                <RadioGroup.Indicator className={styles.presetDot} />
              </span>
              <span className={styles.presetLabel}>{option.label}</span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        {preset ? (
          <p id={id('preset-petunjuk')} className={styles.presetHint}>
            {preset.hint}
          </p>
        ) : null}
      </fieldset>

      <div className={styles.group}>
        <div className={styles.row}>
          <TextField
            id={id('nama-pengirim')}
            size={size}
            label={t.emailSettings.fromName}
            placeholder={t.emailSettings.fromNamePlaceholder}
            value={values.fromName}
            onChange={(event) => set({ fromName: event.target.value })}
            error={errors.fromName}
            autoComplete="organization"
            disabled={disabled}
          />
          <TextField
            id={id('alamat-pengirim')}
            size={size}
            type="email"
            inputMode="email"
            label={t.emailSettings.fromAddress}
            placeholder={t.emailSettings.fromAddressPlaceholder}
            value={values.fromAddress}
            onChange={(event) => set({ fromAddress: event.target.value })}
            error={errors.fromAddress}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
          />
        </div>
        <DetectionNotice
          detection={detection}
          values={values}
          onApply={(suggestion) => onChange(applySuggestion(values, suggestion))}
          disabled={disabled}
        />
        <TextField
          id={id('balas-ke')}
          size={size}
          type="email"
          inputMode="email"
          label={t.emailSettings.replyTo}
          optional
          hint={t.emailSettings.replyToHint}
          value={values.replyTo}
          onChange={(event) => set({ replyTo: event.target.value })}
          error={errors.replyTo}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
        />
      </div>

      <fieldset className={styles.group} disabled={disabled}>
        <legend className={styles.legend}>{t.emailSettings.server}</legend>
        <div className={styles.hostRow}>
          <TextField
            id={id('host')}
            size={size}
            label={t.emailSettings.host}
            placeholder={t.emailSettings.hostPlaceholder}
            value={values.host}
            onChange={(event) => set({ host: event.target.value })}
            error={errors.host}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <TextField
            id={id('port')}
            size={size}
            className={styles.port}
            label={t.emailSettings.port}
            inputMode="numeric"
            value={values.port}
            onChange={(event) => set({ port: event.target.value.replace(/\D/g, '').slice(0, 5) })}
            error={errors.port}
            autoComplete="off"
          />
        </div>
        <SelectField
          id={id('keamanan')}
          size={size}
          label={t.emailSettings.security}
          value={values.security}
          onChange={(event) => set({ security: smtpSecuritySchema.parse(event.target.value) })}
          error={errors.security}
          options={SMTP_SECURITY_MODES.map((mode) => ({
            value: mode,
            label: SMTP_SECURITY_LABELS[mode],
          }))}
        />
        <div className={styles.row}>
          <TextField
            id={id('username')}
            size={size}
            label={t.emailSettings.username}
            hint={t.emailSettings.usernameHint}
            value={values.username}
            onChange={(event) => set({ username: event.target.value })}
            error={errors.username}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <PasswordField
            id={id('password')}
            size={size}
            label={passwordLabel}
            hint={passwordHint}
            placeholder={keepPassword ? (saved?.passwordHint ?? '••••••••') : undefined}
            value={values.password}
            onChange={(event) => set({ password: event.target.value })}
            error={errors.password}
            // Password akun email pihak lain: jangan ditawari isi otomatis dari pengelola password.
            autoComplete="new-password"
          />
        </div>
        {isPlaintextSmtpLogin(values) ? (
          <Notice tone="warning" role="status">
            {SMTP_PLAINTEXT_LOGIN_WARNING}
          </Notice>
        ) : null}
      </fieldset>
    </div>
  );
}

function applySuggestion(values: EmailFormValues, suggestion: EmailHostSuggestion) {
  return {
    ...values,
    preset: suggestion.presetId,
    host: suggestion.host,
    port: String(suggestion.port),
    security: suggestion.security,
  };
}

function isSuggestionApplied(values: EmailFormValues, suggestion: EmailHostSuggestion) {
  return (
    values.host.trim().toLowerCase() === suggestion.host &&
    values.port.trim() === String(suggestion.port) &&
    values.security === suggestion.security
  );
}

/** Cari saran server SMTP dari domain alamat pengirim (setelah pengguna berhenti mengetik). */
function useHostDetection(fromAddress: string, detectHost: DetectHost): Detection {
  const [found, setFound] = useState<{
    domain: string;
    result: DetectEmailHostResponse | null;
  } | null>(null);
  const runDetect = useEffectEvent(detectHost);

  const valid = emailAddressSchema.safeParse(fromAddress);
  const address = valid.success ? valid.data : null;
  const parsedDomain = address ? emailDomainOf(address) : null;
  // Alamat yang sudah terisi saat form dibuka (pengaturan tersimpan) tidak perlu dideteksi lagi.
  const [initialDomain] = useState(parsedDomain);
  const domain = parsedDomain === initialDomain ? null : parsedDomain;

  useEffect(() => {
    if (!domain || !address) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setFound({ domain, result: null });
      runDetect(address, controller.signal).then(
        (result) => setFound({ domain, result }),
        // Deteksi hanya bantuan: gagal (mis. batas permintaan) = tanpa saran, isi manual.
        () => {
          if (!controller.signal.aborted) setFound(null);
        },
      );
    }, DETECT_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // Hanya domain yang menentukan saran; alamat lengkap ikut dikirim apa adanya.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  if (!domain || found?.domain !== domain) return { state: 'idle' };
  return found.result ? { state: 'done', result: found.result } : { state: 'loading', domain };
}

function DetectionNotice({
  detection,
  values,
  onApply,
  disabled,
}: {
  detection: Detection;
  values: EmailFormValues;
  onApply: (suggestion: EmailHostSuggestion) => void;
  disabled: boolean;
}) {
  if (detection.state === 'idle') return null;
  if (detection.state === 'loading') {
    return (
      <p className={styles.detect} role="status">
        <Icon icon={LoaderCircle} size={16} className={styles.spin} />
        {t.emailSettings.detecting}
      </p>
    );
  }
  const { suggestions, domain } = detection.result;
  const [first] = suggestions;
  if (!first) {
    return (
      <p className={styles.detect} role="status">
        {t.emailSettings.noSuggestion(domain)}
      </p>
    );
  }
  const applied = isSuggestionApplied(values, first);
  return (
    <div className={styles.suggestion} role="status">
      <Icon icon={Sparkles} size={16} className={styles.suggestionIcon} />
      <div className={styles.suggestionText}>
        <p className={styles.suggestionTitle}>{first.description}</p>
        <p className={styles.suggestionValue}>
          <code>
            {first.host}:{first.port}
          </code>{' '}
          · {SMTP_SECURITY_LABELS[first.security]}
        </p>
      </div>
      {applied ? (
        <span className={cx(styles.suggestionApplied)}>
          <Icon icon={Check} size={16} />
          {t.emailSettings.suggestionUsed}
        </span>
      ) : (
        <Button onClick={() => onApply(first)} disabled={disabled}>
          {t.emailSettings.useSuggestion}
        </Button>
      )}
    </div>
  );
}
