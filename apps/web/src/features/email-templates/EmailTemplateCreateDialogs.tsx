import {
  EMAIL_TEMPLATE_PRESETS,
  createEmailTemplateRequestSchema,
  type EmailTemplate,
  type EmailTemplatePresetKey,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { slugFromName } from './email-template-form';
import {
  emailTemplatePresetsQuery,
  setEmailTemplateFlash,
  storeEmailTemplate,
} from './email-template-queries';
import styles from './EmailTemplates.module.css';

const c = t.emailTemplates;

/** Buat dari kosong: nama + slug (otomatis dari nama sampai diubah sendiri) + keterangan. */
export function EmailTemplateCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (template: EmailTemplate) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    const parsed = createEmailTemplateRequestSchema.safeParse({
      name,
      slug,
      ...(description.trim() ? { description } : {}),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const { template } = await endpoints.emailTemplates.create(parsed.data);
      storeEmailTemplate(queryClient, template);
      setEmailTemplateFlash(c.created);
      onCreated(template);
    } catch (caught) {
      if (isApiError(caught) && caught.details.length > 0) {
        setErrors(apiFieldErrors(caught.details));
      } else {
        setFailure(caught);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open title={c.createTitle} description={c.createBody} onRequestClose={onClose}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label={c.nameLabel}
          hint={c.nameHint}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!slugTouched) setSlug(slugFromName(event.target.value));
          }}
          error={errors.name}
          maxLength={80}
          autoComplete="off"
        />
        <TextField
          label={c.slugLabel}
          hint={c.slugHint}
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value.toLowerCase().replace(/[\s_]+/g, '-'));
          }}
          error={errors.slug}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          inputClassName={styles.mono}
        />
        <TextField
          label={c.descriptionLabel}
          optional
          hint={c.descriptionHint}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={errors.description}
          maxLength={200}
        />
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{c.cancel}</Button>
          <Button type="submit" variant="primary" loading={pending}>
            {pending ? c.creating : c.create}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Slug kembar (preset yang sama sudah dipakai): coba `tagihan-bulanan-2`, `-3`, … */
const MAX_SLUG_TRIES = 5;

function slugTaken(caught: unknown): boolean {
  return (
    isApiError(caught) &&
    caught.status === 409 &&
    (caught.details.length === 0 || caught.details.some((detail) => detail.field === 'slug'))
  );
}

/**
 * Galeri 6 preset ISP: "Pakai" membuat DRAF (tetap harus diterbitkan). Preset yang slug-nya sudah
 * dipakai mendapat akhiran angka supaya bisa dibuat versi kedua.
 */
export function EmailTemplatePresetDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (template: EmailTemplate) => void;
}) {
  const queryClient = useQueryClient();
  const presets = useQuery(emailTemplatePresetsQuery);
  const [busy, setBusy] = useState<EmailTemplatePresetKey | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const use = async (key: EmailTemplatePresetKey, name: string) => {
    if (busy) return;
    setBusy(key);
    setFailure(null);
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const body = attempt === 1 ? {} : { slug: `${key}-${String(attempt)}` };
          const { template } = await endpoints.emailTemplates.fromPreset(key, body);
          storeEmailTemplate(queryClient, template);
          setEmailTemplateFlash(c.presetCreated(template.name || name));
          onCreated(template);
          return;
        } catch (caught) {
          if (!slugTaken(caught) || attempt >= MAX_SLUG_TRIES) throw caught;
        }
      }
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open title={c.presetsTitle} description={c.presetsBody} onRequestClose={onClose}>
      <div className={styles.presets}>
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        {presets.isPending ? (
          <SkeletonRegion className={styles.presetList}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className={styles.presetSkeleton} />
            ))}
          </SkeletonRegion>
        ) : presets.isError ? (
          <Notice
            tone="danger"
            role="alert"
            actions={
              <Button variant="ghost" onClick={() => void presets.refetch()}>
                {t.common.retry}
              </Button>
            }
          >
            {c.presetsFailed}
          </Notice>
        ) : (
          <ul className={styles.presetList} aria-label={c.presetsLabel}>
            {presets.data.presets.map((preset) => {
              const facts = [
                c.presetVariables(preset.variables.length),
                hasQrisSlot(preset.key) ? c.presetQris : null,
              ].filter(Boolean);
              return (
                <li key={preset.key} className={styles.preset}>
                  <div className={styles.presetText}>
                    <p className={styles.presetTitle}>{preset.name}</p>
                    <p className={styles.presetMeta}>{preset.description}</p>
                    <p className={styles.presetSubject}>{preset.subject}</p>
                    <p className={styles.presetMeta}>{facts.join(' · ')}</p>
                  </div>
                  <Button
                    aria-label={c.presetUse(preset.name)}
                    loading={busy === preset.key}
                    disabled={busy !== null}
                    onClick={() => void use(preset.key, preset.name)}
                  >
                    {busy === preset.key ? c.presetUsing : c.presetUseShort}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <DialogActions sticky>
        <Button onClick={onClose}>{c.cancel}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Preset dengan slot `{{qris}}` (isi HTML preset ada di paket bersama). */
function hasQrisSlot(key: EmailTemplatePresetKey): boolean {
  const preset = EMAIL_TEMPLATE_PRESETS.find((item) => item.key === key);
  return preset ? /\{\{\s*qris\s*\}\}/.test(preset.html) : false;
}
