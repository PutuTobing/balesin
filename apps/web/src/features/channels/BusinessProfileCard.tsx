import {
  BUSINESS_PROFILE_LIMITS,
  type BusinessProfileResponse,
  type IdentityConfirmation,
  type UpdateBusinessProfileRequest,
  type WhatsAppChannel,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { FormActions } from '../../components/ui/FormActions';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { businessProfileQuery, queryKeys } from '../../lib/api/queries';
import { formatDateTimeInline } from '../../lib/format';
import type { FieldErrors } from '../../lib/form';
import { useLock } from '../../lib/use-lock';
import { useSession } from '../auth/session';
import { isConfirmationError, needsConfirmation } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import styles from './Channels.module.css';
import { LinkLabel } from './GuideSteps';
import {
  hasProfileChanges,
  profileChanges,
  profileFieldErrors,
  profileFormFrom,
  profileNeedsConfirmation,
  validateProfileChanges,
  verticalOptions,
  type ProfileFormValues,
} from './profile-form';

const copy = t.channels.profile;
const WHATSAPP_MANAGER_URL = 'https://business.facebook.com/wa/manage/phone-numbers/';

/**
 * Profil bisnis nomor (Info, alamat, deskripsi, email, website, kategori), dibaca dan diubah
 * langsung di Meta. Baru dimuat bila tes koneksi terakhir berhasil: tanpa itu Meta hampir pasti
 * menolak, dan setiap pembacaan memakai jatah batas laju.
 */
export function BusinessProfileCard({ channel }: { channel: WhatsAppChannel }) {
  return (
    <section id="profil-bisnis" className={styles.card} aria-labelledby="channel-profil">
      <div className={styles.cardHead}>
        <h2 id="channel-profil" className={styles.cardTitle}>
          {copy.title}
        </h2>
        <p className={styles.hint}>{copy.hint}</p>
      </div>
      {channel.status === 'connected' ? (
        <ProfileLoader channelId={channel.id} />
      ) : (
        <Notice tone="info">{copy.needsConnection}</Notice>
      )}
    </section>
  );
}

function ProfileLoader({ channelId }: { channelId: string }) {
  const profile = useQuery(businessProfileQuery(channelId));
  // Di luar form: form dibuat ulang setiap data profil baru (`key`), pesan tersimpan tetap ada.
  const [saved, setSaved] = useState<SavedState>(null);
  const lock = useLock();
  const { lockFor } = lock;
  const errorAt = profile.errorUpdatedAt;
  const error = profile.error;

  // 429 / 502 dengan Retry-After: "Coba lagi" terkunci dengan hitung mundur.
  useEffect(() => {
    if (isApiError(error) && error.retryAfterSeconds) lockFor(error.retryAfterSeconds);
  }, [error, errorAt, lockFor]);

  if (profile.data) {
    return (
      <ProfileForm
        key={profile.dataUpdatedAt}
        channelId={channelId}
        data={profile.data}
        saved={saved}
        onSaved={setSaved}
        onReload={() => {
          setSaved(null);
          void profile.refetch();
        }}
      />
    );
  }
  if (profile.isPending) return <ProfileSkeleton />;
  return (
    <FormErrorNotice
      error={error}
      lock={lock}
      lockedTitle={copy.lockedTitle}
      failedTitle={copy.loadFailedTitle}
      actions={
        <SubmitButton
          type="button"
          size="md"
          variant="secondary"
          pending={profile.isFetching}
          pendingLabel={t.common.loading}
          lock={lock}
          onClick={() => void profile.refetch()}
        >
          {t.common.retry}
        </SubmitButton>
      }
    />
  );
}

function ProfileSkeleton() {
  return (
    <SkeletonRegion className={styles.form}>
      {[copy.about, copy.address, copy.description, copy.email].map((label) => (
        <div key={label} className={styles.fact}>
          <span className={styles.factLabel}>{label}</span>
          <Skeleton className={styles.skeletonInput} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

type SavedState = 'saved' | 'noReload' | null;

function ProfileForm({
  channelId,
  data,
  saved,
  onSaved: setSaved,
  onReload,
}: {
  channelId: string;
  data: BusinessProfileResponse;
  saved: SavedState;
  onSaved: (saved: SavedState) => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const [values, setValues] = useState<ProfileFormValues>(() => profileFormFrom(data.profile));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<UpdateBusinessProfileRequest | null>(null);
  const lock = useLock();
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const [invalidTick, setInvalidTick] = useState(0);

  useEffect(() => {
    if (invalidTick === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalidTick]);

  const changes = profileChanges(values, data.profile);
  const dirty = hasProfileChanges(changes);

  const set = (field: keyof ProfileFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setSaved(null);
    if (errors[field]) setErrors(({ [field]: _removed, ...rest }) => rest);
  };

  const showFieldErrors = (next: FieldErrors) => {
    setErrors(next);
    setInvalidTick((tick) => tick + 1);
  };

  /**
   * Kirim ke Meta lewat server. Dipanggil langsung (bukan `useMutation`) supaya konfirmasi
   * identitas tidak tertinggal di cache mutasi.
   */
  const persist = async (body: UpdateBusinessProfileRequest, identity?: IdentityConfirmation) => {
    setSaving(true);
    setFailure(null);
    try {
      const response = await endpoints.channels.updateBusinessProfile(
        channelId,
        identity ? { ...body, confirmation: identity } : body,
      );
      setConfirming(null);
      if (response.profile && response.fetchedAt) {
        const next = { profile: response.profile, fetchedAt: response.fetchedAt };
        queryClient.setQueryData(queryKeys.businessProfile(channelId), next);
        setValues(profileFormFrom(next.profile));
        setSaved('saved');
      } else {
        setSaved('noReload');
      }
    } catch (caught) {
      if (identity && isConfirmationError(caught)) throw caught;
      if (!identity && needsConfirmation(caught)) {
        setConfirming(body);
        return;
      }
      setConfirming(null);
      const fieldErrors =
        isApiError(caught) && caught.code === 'VALIDATION_ERROR'
          ? profileFieldErrors(caught.details)
          : {};
      if (Object.keys(fieldErrors).length > 0) {
        showFieldErrors(fieldErrors);
        return;
      }
      if (isApiError(caught) && caught.retryAfterSeconds) lock.lockFor(caught.retryAfterSeconds);
      setFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving || lock.locked || !dirty) return;
    const invalid = validateProfileChanges(changes);
    if (Object.keys(invalid).length > 0) {
      showFieldErrors(invalid);
      return;
    }
    setErrors({});
    setFailure(null);
    if (profileNeedsConfirmation(changes)) {
      setConfirming(changes);
      return;
    }
    void persist(changes);
  };

  const counter = (value: string, max: number) => copy.counter(value.trim().length, max);
  const errorCount = Object.keys(errors).length;

  return (
    <>
      <form ref={formRef} className={styles.form} onSubmit={submit} noValidate>
        <p className={styles.copyMeta}>{copy.fetchedAt(formatDateTimeInline(data.fetchedAt))}</p>
        {/* Dua baris: kalimat ±60 karakter terbaca utuh di HP (isian satu baris memotongnya). */}
        <TextAreaField
          className={styles.aboutField}
          rows={2}
          label={copy.about}
          hint={`${copy.aboutHint} ${counter(values.about, BUSINESS_PROFILE_LIMITS.about)}`}
          value={values.about}
          onChange={(event) => set('about', event.target.value.replace(/\r?\n/g, ' '))}
          error={errors.about}
          disabled={saving}
        />
        <TextField
          label={copy.address}
          optional
          value={values.address}
          onChange={(event) => set('address', event.target.value)}
          error={errors.address}
          autoComplete="off"
          disabled={saving}
        />
        <TextAreaField
          label={copy.description}
          optional
          hint={counter(values.description, BUSINESS_PROFILE_LIMITS.description)}
          value={values.description}
          onChange={(event) => set('description', event.target.value)}
          error={errors.description}
          disabled={saving}
        />
        <div className={styles.row}>
          <TextField
            type="email"
            inputMode="email"
            label={copy.email}
            optional
            placeholder={copy.emailPlaceholder}
            value={values.email}
            onChange={(event) => set('email', event.target.value)}
            error={errors.email}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={saving}
          />
          <SelectField
            label={copy.vertical}
            value={values.vertical}
            onChange={(event) => set('vertical', event.target.value)}
            error={errors.vertical}
            options={verticalOptions(data.profile.vertical ?? '', {
              none: copy.verticalNone,
              unknown: copy.verticalUnknown,
            })}
            disabled={saving}
          />
        </div>
        <fieldset className={styles.fieldset}>
          <legend className="sr-only">{copy.websites}</legend>
          <div className={styles.row}>
            {(['website1', 'website2'] as const).map((field, index) => (
              <TextField
                key={field}
                type="url"
                inputMode="url"
                label={copy.website(index + 1)}
                optional
                hint={index === 0 ? copy.websitesHint : undefined}
                placeholder={copy.websitePlaceholder}
                value={values[field]}
                onChange={(event) => set(field, event.target.value)}
                error={errors[field]}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={saving}
              />
            ))}
          </div>
        </fieldset>
        <p className={styles.photoNote}>
          <span>{copy.photo}</span>
          <a href={WHATSAPP_MANAGER_URL} target="_blank" rel="noopener noreferrer">
            <LinkLabel label={copy.photoLink} />
            <span className="sr-only"> {t.channels.newTab}</span>
          </a>
        </p>
        {session && session.user.role !== 'owner' ? (
          <p className={styles.note}>{t.channels.ownersNotified}</p>
        ) : null}
        {failure ? (
          <FormErrorNotice error={failure} lock={lock} lockedTitle={copy.lockedTitle} />
        ) : null}
        {saved === 'noReload' ? (
          <Notice
            tone="success"
            role="status"
            actions={
              <Button variant="secondary" onClick={onReload}>
                {copy.reload}
              </Button>
            }
          >
            {copy.savedNoReload}
          </Notice>
        ) : null}
        {errorCount > 0 ? (
          <p className="sr-only" role="alert">
            {t.form.fixErrors(errorCount)}
          </p>
        ) : null}
        <FormActions
          meta={
            saved === 'saved' ? (
              <span className={styles.savedNote} role="status">
                <Icon icon={CircleCheck} size={16} />
                {copy.saved}
              </span>
            ) : undefined
          }
        >
          <SubmitButton
            ref={submitRef}
            size="md"
            pending={saving}
            pendingLabel={copy.saving}
            lock={lock}
            disabled={!dirty}
          >
            {copy.save}
          </SubmitButton>
        </FormActions>
      </form>
      {/* Di luar form: dialog punya form sendiri (form tidak boleh bersarang). */}
      <IdentityDialog
        open={confirming !== null}
        title={copy.confirmTitle}
        body={copy.confirmBody}
        confirmLabel={copy.save}
        pendingLabel={copy.saving}
        requireCode
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(null)}
        onConfirm={(identity) => (confirming ? persist(confirming, identity) : Promise.resolve())}
      />
    </>
  );
}
