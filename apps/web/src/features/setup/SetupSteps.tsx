import {
  DEFAULT_PRODUCT_NAME,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  PASSWORD_RULES_HINT,
  SMTP_SECURITY_LABELS,
} from '@balesin/shared';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { BrandLogo } from '../../brand/BrandLogo';
import { BrandContext, defaultBrand } from '../../brand/brand';
import { Button } from '../../components/ui/Button';
import { PasswordField, SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { PasswordStrength, type ServerPasswordCheck } from '../../components/ui/PasswordStrength';
import { RichText } from '../../components/ui/RichText';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { kilobytes } from '../../lib/format';
import { isLogoType, readLogoFile } from '../../lib/logo-file';
import { describedBy, scopeErrors, type FieldErrors } from '../../lib/form';
import { EmailGuide } from '../email-settings/EmailGuide';
import { EmailSettingsFields } from '../email-settings/EmailSettingsFields';
import { EmailTestPanel, type RunEmailTest } from '../email-settings/EmailTestPanel';
import { emailFormFingerprint, toEmailInput } from '../email-settings/email-form';
import { estimatePasswordStrength } from '../../lib/password-strength';
import styles from './Setup.module.css';
import {
  emailConnectionVerified,
  type LogoDraft,
  type SetupStep,
  type WizardState,
} from './wizard-state';

type Patch = (patch: Partial<Omit<WizardState, 'step' | 'furthest'>>) => void;

interface StepProps {
  state: WizardState;
  patch: Patch;
  disabled: boolean;
}

/** Error isian yang diubah (dan isian terkait) dihapus, supaya pesan lama tidak tertinggal. */
function clearErrors(errors: FieldErrors, keys: string[]): FieldErrors {
  if (!keys.some((key) => key in errors)) return errors;
  const next = { ...errors };
  for (const key of keys) delete next[key];
  return next;
}

// ── Token ───────────────────────────────────────────────────────────────────

export function TokenStep({ state, patch, disabled }: StepProps) {
  return (
    <div className={styles.stack}>
      {state.tokenFromLink && state.tokenVerified ? (
        <Notice tone="success">{t.setup.steps.token.fromLink}</Notice>
      ) : null}
      <PasswordField
        size="lg"
        label={t.setup.steps.token.label}
        hint={t.setup.steps.token.hint}
        value={state.setupToken}
        onChange={(event) =>
          patch({ setupToken: event.target.value, tokenVerified: false, errors: {} })
        }
        error={state.errors.setupToken}
        autoComplete="off"
        className={styles.mono}
        disabled={disabled}
      />
    </div>
  );
}

// ── Organisasi ──────────────────────────────────────────────────────────────

const TIME_ZONES = Object.entries(t.setup.timezones).map(([value, label]) => ({ value, label }));

export function OrganizationStep({ state, patch, disabled }: StepProps) {
  const errors = scopeErrors(state.errors, 'organization');
  const set = (organization: Partial<WizardState['organization']>) =>
    patch({
      organization: { ...state.organization, ...organization },
      errors: clearErrors(
        state.errors,
        Object.keys(organization).map((key) => `organization.${key}`),
      ),
    });
  return (
    <div className={styles.stack}>
      <TextField
        size="lg"
        label={t.setup.steps.organization.name}
        placeholder={t.setup.steps.organization.namePlaceholder}
        value={state.organization.name}
        onChange={(event) => set({ name: event.target.value })}
        error={errors.name}
        autoComplete="organization"
        disabled={disabled}
      />
      <SelectField
        size="lg"
        label={t.setup.steps.organization.timezone}
        hint={t.setup.steps.organization.timezoneHint}
        value={state.organization.timezone}
        onChange={(event) => set({ timezone: event.target.value })}
        error={errors.timezone}
        options={TIME_ZONES}
        disabled={disabled}
      />
    </div>
  );
}

// ── Owner ───────────────────────────────────────────────────────────────────

type ServerCheck = ServerPasswordCheck;

const CHECK_DELAY_MS = 700;

export function OwnerStep({ state, patch, disabled }: StepProps) {
  const errors = scopeErrors(state.errors, 'owner');
  const set = (owner: Partial<WizardState['owner']>) => {
    const keys = Object.keys(owner).map((key) => `owner.${key}`);
    // Password berubah → pesan "ulangi password tidak sama" juga tidak berlaku lagi.
    if ('password' in owner) keys.push('owner.repeat');
    patch({ owner: { ...state.owner, ...owner }, errors: clearErrors(state.errors, keys) });
  };
  const strengthId = useId();
  const check = useServerPasswordCheck(state);

  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <TextField
          size="lg"
          label={t.setup.steps.owner.name}
          value={state.owner.name}
          onChange={(event) => set({ name: event.target.value })}
          error={errors.name}
          autoComplete="name"
          disabled={disabled}
        />
        <TextField
          size="lg"
          type="email"
          inputMode="email"
          label={t.setup.steps.owner.email}
          hint={t.setup.steps.owner.emailHint}
          value={state.owner.email}
          onChange={(event) => set({ email: event.target.value })}
          error={errors.email}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
        />
      </div>
      <div className={styles.passwordBlock}>
        <PasswordField
          size="lg"
          label={t.setup.steps.owner.password}
          hint={PASSWORD_RULES_HINT}
          value={state.owner.password}
          onChange={(event) => set({ password: event.target.value })}
          error={errors.password}
          autoComplete="new-password"
          aria-describedby={strengthId}
          disabled={disabled}
        />
        <PasswordStrength id={strengthId} password={state.owner.password} check={check} />
      </div>
      <PasswordField
        size="lg"
        label={t.setup.steps.owner.repeat}
        value={state.owner.repeat}
        onChange={(event) => set({ repeat: event.target.value })}
        error={errors.repeat}
        autoComplete="new-password"
        disabled={disabled}
      />
    </div>
  );
}

/** Pemeriksaan password ke server saat pengguna berhenti mengetik (sudah ≥ 10 karakter). */
function useServerPasswordCheck(state: WizardState): ServerCheck {
  const [check, setCheck] = useState<ServerCheck>({ state: 'idle' });
  const { password, email, name } = state.owner;
  const organizationName = state.organization.name;
  const setupToken = state.setupToken;
  const long = estimatePasswordStrength(password).missing === 0;

  useEffect(() => {
    if (!long) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCheck({ state: 'checking', password });
      endpoints.setup
        .checkPassword(
          {
            setupToken,
            password,
            email: email.trim() || undefined,
            name: name.trim() || undefined,
            organizationName: organizationName.trim() || undefined,
          },
          controller.signal,
        )
        .then(
          (result) => setCheck({ state: 'done', password, ...result }),
          () => {
            // Gagal memeriksa (jaringan, batas): tombol Lanjut tetap memeriksa ulang.
            if (!controller.signal.aborted) setCheck({ state: 'idle' });
          },
        );
    }, CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [long, password, email, name, organizationName, setupToken]);

  if (!long || (check.state !== 'idle' && check.password !== password)) return { state: 'idle' };
  return check;
}

// ── Branding ────────────────────────────────────────────────────────────────

export function BrandingStep({ state, patch, disabled }: StepProps) {
  const errors = scopeErrors(state.errors, 'branding');
  const set = (branding: Partial<WizardState['branding']>) =>
    patch({
      branding: { ...state.branding, ...branding },
      errors: clearErrors(
        state.errors,
        Object.keys(branding).map((key) => `branding.${key}`),
      ),
    });

  // Langkah ini sudah berlabel "Opsional", jadi isiannya tidak diberi penanda lagi.
  return (
    <div className={styles.stack}>
      <TextField
        size="lg"
        label={t.setup.steps.branding.productName}
        hint={t.setup.steps.branding.productNameHint(DEFAULT_PRODUCT_NAME)}
        value={state.branding.productName}
        onChange={(event) => set({ productName: event.target.value })}
        error={errors.productName}
        autoComplete="off"
        disabled={disabled}
      />
      <LogoPicker
        logo={state.branding.logo}
        error={errors.logo ?? errors['logo.dataBase64'] ?? errors['logo.contentType']}
        onChange={(logo, error) => {
          const next = { ...state.errors };
          delete next['branding.logo'];
          if (error) next['branding.logo'] = error;
          patch({ branding: { ...state.branding, logo }, errors: next });
        }}
        disabled={disabled}
        productName={state.branding.productName.trim() || DEFAULT_PRODUCT_NAME}
      />
    </div>
  );
}

function LogoPicker({
  logo,
  error,
  onChange,
  disabled,
  productName,
}: {
  logo: LogoDraft | null;
  error: string | undefined;
  onChange: (logo: LogoDraft | null, error?: string) => void;
  disabled: boolean;
  productName: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const hintId = useId();
  const errorId = useId();

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!isLogoType(file.type)) {
      onChange(logo, t.setup.steps.branding.logoType);
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      onChange(logo, t.setup.steps.branding.logoTooLarge(kilobytes(file.size)));
      return;
    }
    try {
      onChange(await readLogoFile(file, t.setup.steps.branding.logoUnreadable));
    } catch {
      onChange(logo, t.setup.steps.branding.logoUnreadable);
    }
  };

  return (
    <div className={styles.logoField} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles.fieldLabel}>
        {t.setup.steps.branding.logo}
      </span>
      <div className={styles.logoBox}>
        <div className={styles.logoPreview}>
          {logo ? (
            <img src={logo.dataUrl} alt={t.setup.steps.branding.logoPreviewAlt} />
          ) : (
            // Pratinjau persis seperti yang tampil di halaman masuk (BrandLogo dengan nama ini).
            <BrandContext value={{ ...defaultBrand, productName }}>
              <BrandLogo className={styles.logoPreviewMark} />
            </BrandContext>
          )}
        </div>
        <div className={styles.logoMeta}>
          {logo ? (
            <p className={styles.logoName}>
              {t.setup.steps.branding.logoSelected(logo.name, kilobytes(logo.size))}
            </p>
          ) : null}
          <div className={styles.logoActions}>
            <Button
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
              aria-describedby={describedBy(error ? errorId : hintId)}
            >
              <Icon icon={ImagePlus} size={16} />
              {logo ? t.setup.steps.branding.logoReplace : t.setup.steps.branding.logoChoose}
            </Button>
            {logo ? (
              <Button variant="ghost" onClick={() => onChange(null)} disabled={disabled}>
                <Icon icon={Trash2} size={16} />
                {t.setup.steps.branding.logoRemove}
              </Button>
            ) : null}
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={LOGO_CONTENT_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void pick(event)}
        />
      </div>
      {error ? (
        <p id={errorId} className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : (
        <p id={hintId} className={styles.fieldHint}>
          {t.setup.steps.branding.logoHint}
        </p>
      )}
    </div>
  );
}

// ── Email ───────────────────────────────────────────────────────────────────

export function EmailStep({
  state,
  patch,
  disabled,
  canStoreSecrets,
}: StepProps & { canStoreSecrets: boolean }) {
  if (!canStoreSecrets) {
    return (
      <Notice tone="warning" title={t.setup.steps.email.noMasterKeyTitle}>
        <RichText text={t.setup.steps.email.noMasterKeyBody} />
      </Notice>
    );
  }

  const errors = scopeErrors(state.errors, 'email');
  const values = state.email.values;

  const run: RunEmailTest = async (kind, to) => {
    const result = toEmailInput(values);
    if (!result.ok) {
      patch({
        errors: Object.fromEntries(
          Object.entries(result.errors).map(([key, message]) => [`email.${key}`, message]),
        ),
      });
      return null;
    }
    patch({ errors: {} });
    const body = { setupToken: state.setupToken, settings: result.input };
    return kind === 'connection'
      ? endpoints.setup.testEmailConnection(body)
      : endpoints.setup.sendTestEmail({ ...body, to: to ?? '' });
  };

  return (
    <div className={styles.stack}>
      <EmailSettingsFields
        idPrefix="setup-email"
        size="lg"
        values={values}
        onChange={(next) =>
          patch({ email: { ...state.email, values: next, skipped: false }, errors: {} })
        }
        errors={errors}
        detectHost={(emailAddress, signal) =>
          endpoints.setup.detectEmailHost({ setupToken: state.setupToken, emailAddress }, signal)
        }
        disabled={disabled}
        guide={<EmailGuide context="setup" preset={values.preset} />}
      />
      <EmailTestPanel
        size="lg"
        defaultRecipient={state.owner.email.trim()}
        run={run}
        onFieldErrors={(errors) =>
          patch({
            errors: Object.fromEntries(
              Object.entries(errors).map(([key, message]) => [`email.${key}`, message]),
            ),
          })
        }
        disabled={disabled}
        onResult={(kind, result) => {
          if (kind === 'connection' || result.ok) {
            patch({
              email: {
                ...state.email,
                lastConnectionTest: { fingerprint: emailFormFingerprint(values), result },
              },
            });
          }
        }}
      />
      <p className={styles.fieldHint}>{t.setup.steps.email.skipNote}</p>
    </div>
  );
}

// ── Ringkasan ───────────────────────────────────────────────────────────────

export function SummaryStep({
  state,
  onEdit,
  canStoreSecrets,
  disabled,
}: {
  state: WizardState;
  onEdit: (step: SetupStep) => void;
  canStoreSecrets: boolean;
  disabled: boolean;
}) {
  const copy = t.setup.steps.summary;
  const timezone =
    t.setup.timezones[state.organization.timezone as keyof typeof t.setup.timezones] ??
    state.organization.timezone;
  const { productName, logo } = state.branding;
  const emailUsed = canStoreSecrets && !state.email.skipped;
  const email = state.email.values;

  const sections: {
    step: SetupStep;
    title: string;
    rows: { label: string; value: ReactNode }[];
  }[] = [
    {
      step: 'organization',
      title: copy.organization,
      rows: [
        { label: t.setup.steps.organization.name, value: state.organization.name },
        { label: copy.timezone, value: timezone },
      ],
    },
    {
      step: 'owner',
      title: copy.owner,
      rows: [
        { label: t.setup.steps.owner.name, value: state.owner.name },
        { label: t.setup.steps.owner.email, value: state.owner.email },
      ],
    },
    {
      step: 'branding',
      title: copy.branding,
      rows: [
        { label: copy.productName, value: productName.trim() || copy.defaultValue },
        { label: copy.logo, value: logo ? copy.logoAttached : copy.noLogo },
      ],
    },
    {
      step: 'email',
      title: copy.email,
      rows: emailUsed
        ? [
            { label: copy.sender, value: `${email.fromName.trim()} <${email.fromAddress.trim()}>` },
            {
              label: copy.server,
              value: `${email.host.trim()}:${email.port} · ${SMTP_SECURITY_LABELS[email.security]}`,
            },
            {
              label: t.emailSettings.status,
              value: emailConnectionVerified(state) ? (
                <StatusBadge tone="success" label={copy.emailTested} />
              ) : (
                <StatusBadge tone="warning" label={copy.emailUntested} />
              ),
            },
          ]
        : [{ label: t.emailSettings.status, value: copy.emailSkipped }],
    },
  ];

  return (
    <div className={styles.summary}>
      {sections.map((section) => (
        <section key={section.step} className={styles.summarySection}>
          <div className={styles.summaryHead}>
            <h2 className={styles.summaryTitle}>{section.title}</h2>
            <Button
              variant="ghost"
              onClick={() => onEdit(section.step)}
              disabled={disabled}
              aria-label={copy.editSection(section.title)}
              className={styles.summaryEdit}
            >
              {copy.edit}
            </Button>
          </div>
          <dl className={styles.summaryList}>
            {section.rows.map((row) => (
              <div key={row.label} className={styles.summaryRow}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
