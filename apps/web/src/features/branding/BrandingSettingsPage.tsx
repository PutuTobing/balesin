import {
  BRAND_COLOR_LOW_CONTRAST_MESSAGE,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  type BrandingSettings,
  type UpdateBrandingRequest,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { TextField } from '../../components/ui/Field';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { FormActions } from '../../components/ui/FormActions';
import { BrandLogo } from '../../brand/BrandLogo';
import { BrandContext, defaultBrand } from '../../brand/brand';
import { brandThemeVariables, darkerUsableColor } from '../../brand/brand-theme';
import { color, type ThemeName } from '@balesin/shared/design-tokens';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { queryKeys } from '../../lib/api/queries';
import { kilobytes } from '../../lib/format';
import { apiFieldErrors, describedBy, type FieldErrors } from '../../lib/form';
import { isLogoType, readLogoFile } from '../../lib/logo-file';
import { useLock } from '../../lib/use-lock';
import { brandingSettingsKey, brandingSettingsQuery } from './branding-queries';
import {
  buildBrandingUpdate,
  draftFrom,
  logoPreviewUrl,
  normalizeColor,
  previewColors,
  type BrandingDraft,
} from './branding-form';
import styles from './Branding.module.css';

const b = t.brandingSettings;
const setupCopy = t.setup.steps.branding;

/**
 * Pengaturan → Merek (`organization.manage`, Owner; docs/KONTRAK-API-AUTH.md "Pengaturan → Merek"):
 * nama aplikasi, logo, warna utama, dan nama maskot. Isian kosong = kembali ke bawaan. Setelah
 * tersimpan, `GET /branding` dimuat ulang sehingga nama, warna, favicon, dan manifest langsung
 * berganti.
 */
export function BrandingSettingsPage() {
  const settings = useQuery(brandingSettingsQuery);
  return (
    <Page>
      <div className={styles.page}>
        {settings.isPending ? (
          // Susunan sama dengan isi akhir (teks pembuka + 3 kartu), tanpa lompatan saat data datang.
          <SkeletonRegion className={styles.form}>
            <Skeleton className={styles.skeletonLine} />
            {(['nama', 'logo', 'warna'] as const).map((card) => (
              <div key={card} className={styles.card}>
                <Skeleton className={styles.skeletonTitle} />
                {card === 'logo' ? (
                  <Skeleton className={styles.skeletonTile} />
                ) : (
                  <>
                    <Skeleton className={styles.skeletonField} />
                    <Skeleton className={styles.skeletonField} />
                  </>
                )}
              </div>
            ))}
          </SkeletonRegion>
        ) : settings.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={b.loadFailed}
            body={isApiError(settings.error) ? settings.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void settings.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : (
          <BrandingForm settings={settings.data.branding} />
        )}
      </div>
    </Page>
  );
}

function BrandingForm({ settings }: { settings: BrandingSettings }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BrandingDraft>(() => draftFrom(settings));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'noChanges' | null>(null);
  const lock = useLock();

  const update = (patch: Partial<BrandingDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors({});
    setNotice(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setNotice(null);
    const built = buildBrandingUpdate(settings, draft);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    if (built.empty) {
      setNotice('noChanges');
      return;
    }
    setPending(true);
    try {
      await save(built.body);
    } catch (caught) {
      if (isApiError(caught) && caught.details.length > 0)
        setErrors(apiFieldErrors(caught.details));
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setFailure(caught);
    } finally {
      setPending(false);
    }
  };

  const save = async (body: UpdateBrandingRequest) => {
    const data = await endpoints.branding.update(body);
    queryClient.setQueryData(brandingSettingsKey, data);
    // Isian mulai lagi dari data tersimpan (nilai yang dibakukan server, logo baru).
    setDraft(draftFrom(data.branding));
    setNotice('saved');
    // Nama, warna, logo, favicon & manifest di seluruh aplikasi.
    await queryClient.invalidateQueries({ queryKey: queryKeys.branding });
  };

  const fieldFailure = isApiError(failure) && failure.details.length > 0;
  const productFallback = settings.defaults.productName;
  const mascotFallback = settings.defaults.mascotName;

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <p className={styles.intro}>{b.intro}</p>

      <section className={styles.card} aria-labelledby="merek-nama">
        <h2 id="merek-nama" className={styles.cardTitle}>
          {b.namesTitle}
        </h2>
        <TextField
          label={b.productName}
          hint={b.productNameHint(productFallback)}
          value={draft.productName}
          onChange={(event) => update({ productName: event.target.value })}
          error={errors.productName}
          placeholder={productFallback}
          maxLength={40}
          autoComplete="off"
          disabled={pending}
        />
        <TextField
          label={b.mascotName}
          hint={b.mascotNameHint(
            mascotFallback,
            t.inbox.empty.semua.body(draft.mascotName.trim() || mascotFallback),
          )}
          value={draft.mascotName}
          onChange={(event) => update({ mascotName: event.target.value })}
          error={errors.mascotName}
          placeholder={mascotFallback}
          maxLength={30}
          autoComplete="off"
          disabled={pending}
        />
      </section>

      <LogoSection
        settings={settings}
        draft={draft}
        error={errors.logo ?? errors['logo.dataBase64'] ?? errors['logo.contentType']}
        disabled={pending}
        onChange={(logo, error) => {
          setDraft((current) => ({ ...current, logo }));
          setNotice(null);
          setErrors(error ? { logo: error } : {});
        }}
      />

      <ColorSection
        value={draft.primaryColor}
        productName={draft.productName.trim() || productFallback}
        logoUrl={logoPreviewUrl(settings, draft)}
        error={errors.primaryColor}
        disabled={pending}
        onChange={(primaryColor) => update({ primaryColor })}
      />

      {failure && !fieldFailure ? (
        <FormErrorNotice error={failure} lock={lock} lockedTitle={b.lockedTitle} />
      ) : fieldFailure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : notice === 'saved' ? (
        <Notice tone="success" role="status">
          {b.saved}
        </Notice>
      ) : notice === 'noChanges' ? (
        <p className={styles.hint} role="status">
          {b.noChanges}
        </p>
      ) : null}
      <FormActions>
        <Button type="submit" variant="primary" loading={pending} disabled={lock.locked}>
          {pending ? b.saving : b.save}
        </Button>
      </FormActions>
    </form>
  );
}

function LogoSection({
  settings,
  draft,
  error,
  disabled,
  onChange,
}: {
  settings: BrandingSettings;
  draft: BrandingDraft;
  error: string | undefined;
  disabled: boolean;
  onChange: (logo: BrandingDraft['logo'], error?: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const errorId = useId();
  const choice = draft.logo;
  const productName = draft.productName.trim() || settings.defaults.productName;
  const previewUrl = logoPreviewUrl(settings, draft);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!isLogoType(file.type)) {
      onChange(choice, setupCopy.logoType);
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      onChange(choice, setupCopy.logoTooLarge(kilobytes(file.size)));
      return;
    }
    try {
      onChange({ kind: 'new', draft: await readLogoFile(file, setupCopy.logoUnreadable) });
    } catch {
      onChange(choice, setupCopy.logoUnreadable);
    }
  };

  const status =
    choice.kind === 'new'
      ? setupCopy.logoSelected(choice.draft.name, kilobytes(choice.draft.size))
      : choice.kind === 'remove'
        ? b.logoWillRemove
        : settings.logo
          ? b.logoCurrent(kilobytes(settings.logo.byteSize))
          : b.logoNone;
  const hasLogo = previewUrl !== null;

  return (
    <section className={styles.card} aria-labelledby="merek-logo">
      <h2 id="merek-logo" className={styles.cardTitle}>
        {b.logoTitle}
      </h2>
      <div className={styles.logoBox}>
        {/* Hasil sebenarnya di kedua tema (logo gelap di mode gelap memakai pelat terang). */}
        <div className={styles.tiles}>
          {THEMES.map((theme) => (
            <div key={theme} data-theme={theme} className={styles.logoTile}>
              <span className={styles.tileLabel}>{b.themeLabel[theme]}</span>
              <LogoImage src={previewUrl} productName={productName} />
            </div>
          ))}
        </div>
        <div className={styles.logoMeta}>
          <p className={styles.logoStatus} role="status">
            {status}
          </p>
          <div className={styles.logoActions}>
            <Button
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
              aria-describedby={describedBy(error ? errorId : hintId)}
            >
              <Icon icon={ImagePlus} size={16} />
              {hasLogo ? setupCopy.logoReplace : setupCopy.logoChoose}
            </Button>
            {choice.kind === 'keep' && settings.logo ? (
              <Button
                variant="ghost"
                onClick={() => onChange({ kind: 'remove' })}
                disabled={disabled}
              >
                <Icon icon={Trash2} size={16} />
                {setupCopy.logoRemove}
              </Button>
            ) : choice.kind !== 'keep' ? (
              <Button
                variant="ghost"
                onClick={() => onChange({ kind: 'keep' })}
                disabled={disabled}
              >
                <Icon icon={Undo2} size={16} />
                {b.logoUndo}
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
          data-testid="merek-logo-berkas"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void pick(file);
          }}
        />
      </div>
      {error ? (
        <p id={errorId} className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : (
        <p id={hintId} className={styles.hint}>
          {setupCopy.logoHint} {b.logoIconsNote}
        </p>
      )}
    </section>
  );
}

function ColorSection({
  value,
  productName,
  logoUrl,
  error,
  disabled,
  onChange,
}: {
  value: string;
  productName: string;
  logoUrl: string | null;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const preview = previewColors(value);
  const pickerId = useId();
  const hex = normalizeColor(value);
  const validHex = /^#[0-9a-f]{6}$/.test(hex);
  const shownError = error ?? (preview.lowContrast ? BRAND_COLOR_LOW_CONTRAST_MESSAGE : undefined);
  // Warna efektif tiap tema: warna merek bila lolos kontras di tema itu, selain itu bawaan.
  const effective = (theme: ThemeName) => {
    const vars = preview.custom ? brandThemeVariables(hex, theme) : null;
    return {
      primary: vars?.['--primary'] ?? color[theme].primary.toLowerCase(),
      onPrimary: vars?.['--on-primary'] ?? color[theme].onPrimary.toLowerCase(),
      custom: vars !== null,
    };
  };
  const light = effective('light');
  const dark = effective('dark');
  const suggestion = preview.custom && !light.custom ? darkerUsableColor(hex) : null;

  return (
    <section className={styles.card} aria-labelledby="merek-warna">
      <div className={styles.cardHead}>
        <h2 id="merek-warna" className={styles.cardTitle}>
          {b.colorTitle}
        </h2>
        <p className={styles.hint}>{b.colorHint}</p>
      </div>
      <div className={styles.colorRow}>
        <div className={styles.picker}>
          <label htmlFor={pickerId} className={styles.pickerLabel}>
            {b.colorPicker}
          </label>
          <input
            id={pickerId}
            type="color"
            className={styles.swatch}
            // Kotak selalu sama dengan kode yang diketik, juga bila kodenya ditolak.
            value={validHex ? hex : preview.primary}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          />
        </div>
        <TextField
          label={b.colorCode}
          hint={b.colorCodeHint}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          error={shownError}
          maxLength={7}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          className={styles.codeField}
          disabled={disabled}
        />
      </div>
      {value.trim() ? (
        <div>
          <Button onClick={() => onChange('')} disabled={disabled}>
            <Icon icon={RotateCcw} size={16} />
            {b.colorDefault}
          </Button>
        </div>
      ) : null}
      {preview.custom && !light.custom && !dark.custom ? (
        <Notice
          tone="warning"
          actions={
            suggestion ? (
              <Button onClick={() => onChange(suggestion)} disabled={disabled}>
                <span
                  className={styles.suggestionDot}
                  style={{ background: suggestion }}
                  aria-hidden="true"
                />
                {b.colorUseSuggestion(suggestion)}
              </Button>
            ) : undefined
          }
        >
          {b.colorUnusedNote(suggestion)}
        </Notice>
      ) : preview.custom && !light.custom ? (
        <Notice tone="info">{b.colorLightNote}</Notice>
      ) : preview.custom && !dark.custom ? (
        <Notice tone="info">{b.colorDarkNote}</Notice>
      ) : null}

      <div className={styles.previewGroup}>
        <p className={styles.previewTitle}>{b.previewTitle}</p>
        <div className={styles.tiles}>
          {(
            [
              ['light', light],
              ['dark', dark],
            ] as const
          ).map(([theme, colors]) => (
            <div key={theme} data-theme={theme} className={styles.preview}>
              <span className={styles.tileLabel}>
                {b.themeLabel[theme]}
                {colors.custom ? null : <> · {b.previewDefaultColor}</>}
              </span>
              <LogoImage src={logoUrl} productName={productName} />
              <div className={styles.previewBody}>
                <span
                  className={styles.previewButton}
                  style={{ background: colors.primary, color: colors.onPrimary }}
                  aria-hidden="true"
                >
                  {b.previewButton}
                </span>
                <span
                  className={styles.previewLink}
                  style={{ color: colors.primary }}
                  aria-hidden="true"
                >
                  {b.previewLink}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const THEMES = ['light', 'dark'] as const;

/** Logo organisasi (dengan pelat yang sama dengan halaman masuk), atau tanda bawaan + nama. */
function LogoImage({ src, productName }: { src: string | null; productName: string }) {
  return src ? (
    <img src={src} alt={setupCopy.logoPreviewAlt} className={styles.orgLogo} />
  ) : (
    <BrandContext value={{ ...defaultBrand, productName }}>
      <BrandLogo className={styles.logoMark} />
    </BrandContext>
  );
}
