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
import { BrandLogo } from '../../brand/BrandLogo';
import { BrandContext, defaultBrand } from '../../brand/brand';
import { brandThemeVariables } from '../../brand/brand-theme';
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
          <SkeletonRegion className={styles.card}>
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonLine} />
            <Skeleton className={styles.skeletonLine} />
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
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={pending} disabled={lock.locked}>
          {pending ? b.saving : b.save}
        </Button>
      </div>
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
  const previewUrl =
    choice.kind === 'new'
      ? choice.draft.dataUrl
      : choice.kind === 'keep' && settings.logo
        ? settings.logo.url
        : null;

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
        <div className={styles.logoPreview}>
          {previewUrl ? (
            <img src={previewUrl} alt={setupCopy.logoPreviewAlt} />
          ) : (
            // Tanpa logo: tanda bawaan dengan nama aplikasi, persis seperti di halaman masuk.
            <BrandContext value={{ ...defaultBrand, productName }}>
              <BrandLogo className={styles.logoMark} />
            </BrandContext>
          )}
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
  error,
  disabled,
  onChange,
}: {
  value: string;
  productName: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const preview = previewColors(value);
  const pickerId = useId();
  const hex = normalizeColor(value);
  // Warna sah tetapi kurang terbaca di mode gelap → mode gelap memakai warna bawaan.
  const darkFallback = preview.custom && brandThemeVariables(hex, 'dark') === null;
  const shownError = error ?? (preview.lowContrast ? BRAND_COLOR_LOW_CONTRAST_MESSAGE : undefined);

  return (
    <section className={styles.card} aria-labelledby="merek-warna">
      <div>
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
            value={preview.custom ? hex : preview.primary}
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
          <Button variant="ghost" onClick={() => onChange('')} disabled={disabled}>
            <Icon icon={RotateCcw} size={16} />
            {b.colorDefault}
          </Button>
        </div>
      ) : null}
      {darkFallback ? <Notice tone="info">{b.colorDarkNote}</Notice> : null}

      {/* Pratinjau dalam tema terang (tampilan halaman masuk & email); mode gelap: catatan di atas. */}
      <div className={styles.preview} data-theme="light" aria-labelledby="merek-pratinjau">
        <p id="merek-pratinjau" className={styles.previewTitle}>
          {b.previewTitle}
          {preview.custom ? null : (
            <span className={styles.previewNote}> · {b.previewDefaultColor}</span>
          )}
        </p>
        <div className={styles.previewBody}>
          <span className={styles.previewName}>{productName}</span>
          <span
            className={styles.previewButton}
            style={{ background: preview.primary, color: preview.onPrimary }}
            aria-hidden="true"
          >
            {b.previewButton}
          </span>
          <span
            className={styles.previewLink}
            style={{ color: preview.primary }}
            aria-hidden="true"
          >
            {b.previewLink}
          </span>
        </div>
      </div>
    </section>
  );
}
