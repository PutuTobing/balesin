import {
  DEFAULT_PRODUCT_NAME,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  PASSWORD_RULES_HINT,
  SMTP_SECURITY_LABELS,
  brandColorSchema,
  type LogoContentType,
} from '@balesin/shared';
import {
  MIN_TEXT_CONTRAST,
  color as tokenColor,
  contrastRatio,
} from '@balesin/shared/design-tokens';
import { ImagePlus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { DefaultSymbol } from '../../brand/BrandMark';
import { Button } from '../../components/ui/Button';
import { PasswordField, SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { formatRatio, kilobytes } from '../../lib/format';
import { describedBy, scopeErrors } from '../../lib/form';
import { EmailSettingsFields } from '../email-settings/EmailSettingsFields';
import { EmailTestPanel, type RunEmailTest } from '../email-settings/EmailTestPanel';
import { emailFormFingerprint, toEmailInput } from '../email-settings/email-form';
import { estimatePasswordStrength } from './password-strength';
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

/** Warna awal pemilih warna bila isian kosong (warna utama bawaan design system). */
const DEFAULT_PICKER_COLOR = tokenColor.light.primary.toLowerCase();

const TIME_ZONES = Object.entries(t.setup.timezones).map(([value, label]) => ({ value, label }));

export function OrganizationStep({ state, patch, disabled }: StepProps) {
  const errors = scopeErrors(state.errors, 'organization');
  const set = (organization: Partial<WizardState['organization']>) =>
    patch({ organization: { ...state.organization, ...organization } });
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

type ServerCheck =
  | { state: 'idle' }
  | { state: 'checking'; password: string }
  | { state: 'done'; password: string; acceptable: boolean; message: string | null };

const CHECK_DELAY_MS = 700;

export function OwnerStep({ state, patch, disabled }: StepProps) {
  const errors = scopeErrors(state.errors, 'owner');
  const set = (owner: Partial<WizardState['owner']>) =>
    patch({ owner: { ...state.owner, ...owner } });
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
        <StrengthMeter id={strengthId} password={state.owner.password} check={check} />
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

function StrengthMeter({
  id,
  password,
  check,
}: {
  id: string;
  password: string;
  check: ServerCheck;
}) {
  const strength = estimatePasswordStrength(password);
  const rejected = check.state === 'done' && !check.acceptable;
  const level = rejected ? 0 : strength.level;
  const copy = t.setup.steps.owner.strength;

  let text: string;
  if (password === '') text = copy.empty;
  else if (strength.missing > 0) text = copy.tooShort(strength.missing);
  else if (rejected) text = check.message ?? copy.weak;
  else if (check.state === 'checking') text = copy.checking;
  else text = [copy.weak, copy.weak, copy.good, copy.strong][strength.level] ?? copy.good;

  const accepted = check.state === 'done' && check.acceptable;
  const tone = rejected ? 'bad' : level >= 2 ? 'good' : level === 1 ? 'fair' : 'none';

  return (
    <div className={styles.strength} data-tone={tone}>
      <div className={styles.strengthBars} aria-hidden="true">
        {[1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={styles.strengthBar}
            data-on={(rejected && password !== '') || bar <= level ? '' : undefined}
          />
        ))}
      </div>
      <p id={id} className={styles.strengthText} aria-live="polite">
        <span className="sr-only">{copy.label}: </span>
        {text}
        {accepted ? <span className={styles.strengthAccepted}> {copy.accepted}</span> : null}
      </p>
    </div>
  );
}

// ── Branding ────────────────────────────────────────────────────────────────

export function BrandingStep({ state, patch, disabled }: StepProps) {
  const errors = scopeErrors(state.errors, 'branding');
  const set = (branding: Partial<WizardState['branding']>) =>
    patch({ branding: { ...state.branding, ...branding } });
  const colorParsed = brandColorSchema.safeParse(state.branding.primaryColor);
  const color = colorParsed.success ? colorParsed.data : null;
  const ratio = color ? contrastRatio(color, '#ffffff') : null;
  const colorNoticeId = useId();

  return (
    <div className={styles.stack}>
      <TextField
        size="lg"
        label={t.setup.steps.branding.productName}
        optional
        hint={t.setup.steps.branding.productNameHint(DEFAULT_PRODUCT_NAME)}
        value={state.branding.productName}
        onChange={(event) => set({ productName: event.target.value })}
        error={errors.productName}
        autoComplete="off"
        disabled={disabled}
      />

      <div className={styles.colorRow}>
        <TextField
          size="lg"
          label={t.setup.steps.branding.color}
          optional
          hint={t.setup.steps.branding.colorHint}
          value={state.branding.primaryColor}
          onChange={(event) => set({ primaryColor: event.target.value })}
          error={errors.primaryColor}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={7}
          className={styles.mono}
          aria-describedby={ratio !== null ? colorNoticeId : undefined}
          disabled={disabled}
          trailing={
            <>
              {state.branding.primaryColor ? (
                <button
                  type="button"
                  className={styles.colorClear}
                  onClick={() => set({ primaryColor: '' })}
                  aria-label={t.setup.steps.branding.colorReset}
                  title={t.setup.steps.branding.colorReset}
                  disabled={disabled}
                >
                  <Icon icon={X} size={16} />
                </button>
              ) : null}
              <label className={styles.colorPicker} title={t.setup.steps.branding.colorPick}>
                <span className="sr-only">{t.setup.steps.branding.colorPick}</span>
                <input
                  type="color"
                  className={styles.colorInput}
                  value={color ?? DEFAULT_PICKER_COLOR}
                  onChange={(event) => set({ primaryColor: event.target.value })}
                  disabled={disabled}
                />
                <span
                  className={cx(styles.colorSwatch, !color && styles.colorSwatchEmpty)}
                  // Warna pilihan pengguna (data), bukan warna desain: dipasang lewat CSSOM.
                  style={color ? { backgroundColor: color } : undefined}
                  aria-hidden="true"
                />
              </label>
            </>
          }
        />
      </div>

      {color && ratio !== null ? (
        <div className={styles.colorPreview}>
          <div className={styles.colorSample} data-theme="light" aria-hidden="true">
            <span className={styles.sampleLabel}>{t.setup.steps.branding.colorPreview}</span>
            <span className={styles.sampleButton} style={{ backgroundColor: color }}>
              {t.setup.steps.branding.colorPreviewButton}
            </span>
            <span className={styles.sampleLink} style={{ color }}>
              {t.setup.steps.branding.colorPreviewLink}
            </span>
          </div>
          <Notice
            id={colorNoticeId}
            tone={ratio >= MIN_TEXT_CONTRAST ? 'success' : 'warning'}
            role="status"
          >
            {ratio >= MIN_TEXT_CONTRAST
              ? t.setup.steps.branding.contrastOk(formatRatio(ratio))
              : t.setup.steps.branding.contrastLow(formatRatio(ratio))}
          </Notice>
        </div>
      ) : null}

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

function isLogoType(type: string): type is LogoContentType {
  return (LOGO_CONTENT_TYPES as readonly string[]).includes(type);
}

function readLogo(file: File): Promise<LogoDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t.setup.steps.branding.logoUnreadable));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma === -1 || !isLogoType(file.type)) {
        reject(new Error(t.setup.steps.branding.logoUnreadable));
        return;
      }
      resolve({
        contentType: file.type,
        dataBase64: dataUrl.slice(comma + 1),
        dataUrl,
        name: file.name,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
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
      onChange(await readLogo(file));
    } catch {
      onChange(logo, t.setup.steps.branding.logoUnreadable);
    }
  };

  return (
    <div className={styles.logoField} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles.fieldLabel}>
        {t.setup.steps.branding.logo}
        <span className={styles.optionalTag}>{t.form.optional}</span>
      </span>
      <div className={styles.logoBox}>
        <div className={styles.logoPreview}>
          {logo ? (
            <img src={logo.dataUrl} alt={t.setup.steps.branding.logoPreviewAlt} />
          ) : (
            <span className={styles.logoPlaceholder} aria-hidden="true">
              <DefaultSymbol fit="tight" className={styles.logoPlaceholderMark} />
              <span>{productName}</span>
            </span>
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
        {t.setup.steps.email.noMasterKeyBody}
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
      />
      <EmailTestPanel
        size="lg"
        defaultRecipient={state.owner.email.trim()}
        run={run}
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
  const { productName, primaryColor, logo } = state.branding;
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
        {
          label: copy.color,
          value: primaryColor ? (
            <span className={styles.summaryColor}>
              <span
                className={styles.summarySwatch}
                style={{ backgroundColor: primaryColor }}
                aria-hidden="true"
              />
              <code>{primaryColor.toLowerCase()}</code>
            </span>
          ) : (
            copy.defaultValue
          ),
        },
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
