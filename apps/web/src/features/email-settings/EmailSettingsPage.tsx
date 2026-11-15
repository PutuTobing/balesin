import type {
  EmailSettingsInput,
  EmailSettingsResponse,
  IdentityConfirmation,
} from '@balesin/shared';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { CircleCheck, Info } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useBrand } from '../../brand/brand';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { RichText } from '../../components/ui/RichText';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { emailSettingsQuery, queryKeys } from '../../lib/api/queries';
import { formatDateTime } from '../../lib/format';
import { apiFieldErrors, type FieldErrors } from '../../lib/form';
import { media, useMediaQuery } from '../../lib/media';
import { useSession } from '../auth/session';
import { isConfirmationError, needsConfirmation } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import styles from './EmailSettings.module.css';
import { EmailGuide } from './EmailGuide';
import { EmailSettingsFields } from './EmailSettingsFields';
import { EmailStatusBadge } from './EmailStatusBadge';
import { EmailTemplatePreview } from './EmailTemplatePreview';
import { EmailTestPanel, type RunEmailTest } from './EmailTestPanel';
import {
  emailFormFromView,
  emptyEmailForm,
  isEmailFormDirty,
  needsIdentityToSave,
  toEmailInput,
  type EmailFormValues,
} from './email-form';

/** Pengaturan → Email pengirim (izin `settings.email.manage`: Owner, Admin). Data dimuat oleh loader rute. */
export function EmailSettingsPage() {
  const { data } = useSuspenseQuery(emailSettingsQuery);
  return (
    <Page>
      <EmailSettingsScreen data={data} />
    </Page>
  );
}

function EmailSettingsScreen({ data }: { data: EmailSettingsResponse }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const { productName } = useBrand();
  const isDesktop = useMediaQuery(media.desktop);
  const saved = data.source === 'database' ? data.settings : null;

  const [values, setValues] = useState<EmailFormValues>(() =>
    data.settings ? emailFormFromView(data.settings) : { ...emptyEmailForm, fromName: productName },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<unknown>(null);
  /** Isian yang menunggu konfirmasi identitas (dialog terbuka). */
  const [confirming, setConfirming] = useState<EmailSettingsInput | null>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  /**
   * Simpan. Dipanggil langsung (bukan `useMutation`): isian konfirmasi identitas dan password SMTP
   * tidak boleh tertinggal di cache mutasi. `identity` = konfirmasi dari dialog (wajib bila jalur
   * kirim berubah atau simpan pertama kali — semua peran, Owner juga).
   */
  const persist = async (input: EmailSettingsInput, identity?: IdentityConfirmation) => {
    setSaving(true);
    setSaveFailure(null);
    try {
      const response = await endpoints.emailSettings.save(
        identity ? { ...input, confirmation: identity } : input,
      );
      setConfirming(null);
      queryClient.setQueryData(queryKeys.emailSettings, response);
      // Password tidak pernah dikirim balik: kolomnya dikosongkan, petunjuk tersamar tampil.
      if (response.settings) setValues(emailFormFromView(response.settings));
      setJustSaved(true);
    } catch (caught) {
      // Password/kode salah atau dibatasi: tetap di dialog, pesannya di sana.
      if (identity && isConfirmationError(caught)) throw caught;
      // Server ternyata meminta konfirmasi (mis. pengaturan tersimpan berubah di tempat lain).
      if (!identity && needsConfirmation(caught)) {
        setConfirming(input);
        return;
      }
      setConfirming(null);
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        setErrors(apiFieldErrors(caught.details));
      } else {
        setSaveFailure(caught);
      }
    } finally {
      setSaving(false);
    }
  };

  const change = (next: EmailFormValues) => {
    setValues(next);
    setJustSaved(false);
    if (Object.keys(errors).length > 0) setErrors({});
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = toEmailInput(values, saved);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaveFailure(null);
    if (needsIdentityToSave(values, saved)) {
      setConfirming(result.input);
      return;
    }
    void persist(result.input);
  };

  const runTest: RunEmailTest = async (kind, to) => {
    // Isian sama dengan yang tersimpan → uji pengaturan tersimpan (status ikut tercatat).
    const useStored = data.source === 'database' && !isEmailFormDirty(values, saved);
    let settings;
    if (!useStored) {
      const result = toEmailInput(values, saved);
      if (!result.ok) {
        setErrors(result.errors);
        return null;
      }
      settings = result.input;
    }
    setErrors({});
    try {
      return kind === 'connection'
        ? await endpoints.emailSettings.testConnection(settings)
        : await endpoints.emailSettings.sendTest(to ?? '', settings);
    } finally {
      if (useStored) void queryClient.invalidateQueries({ queryKey: queryKeys.emailSettings });
    }
  };

  const saveError = saveFailure
    ? isApiError(saveFailure)
      ? saveFailure.message
      : t.api.network
    : null;
  const errorCount = Object.keys(errors).length;

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <StatusSummary data={data} />
        {!data.canStoreSecrets ? (
          <Notice tone="warning" title={t.emailSettings.noMasterKeyTitle}>
            <RichText text={t.emailSettings.noMasterKeyBody} />
          </Notice>
        ) : null}
        {data.source === 'env' ? (
          <Notice tone="info">
            <RichText
              text={
                // Tanpa kunci enkripsi tombol Simpan nonaktif: jangan ajak menyimpan form.
                data.canStoreSecrets ? t.emailSettings.envNotice : t.emailSettings.envNoticeReadOnly
              }
            />
          </Notice>
        ) : null}

        <form className={styles.card} onSubmit={submit} noValidate>
          <EmailSettingsFields
            idPrefix="email"
            values={values}
            onChange={change}
            errors={errors}
            saved={saved}
            detectHost={endpoints.emailSettings.detectHost}
            disabled={saving}
            // HP/tablet: panduan tepat di bawah pilihan penyedia (seperti wizard), supaya langkah
            // khusus penyedia terlihat saat memilihnya. Desktop: kolom kanan.
            guide={isDesktop ? undefined : <EmailGuide context="settings" preset={values.preset} />}
          />
          <EmailTestPanel
            defaultRecipient={session?.user.email ?? ''}
            run={runTest}
            onFieldErrors={setErrors}
            disabled={saving}
            note={
              data.source === 'database' && isEmailFormDirty(values, saved)
                ? t.emailSettings.unsavedTest
                : undefined
            }
          />
          {/* Admin: perubahan server/alamat pengirim diberitahukan ke Owner (oleh server). */}
          {session && session.user.role !== 'owner' ? (
            <p className={styles.ownersNote}>
              <Icon icon={Info} size={16} className={styles.ownersNoteIcon} />
              {t.emailSettings.ownersNotified}
            </p>
          ) : null}
          {/* Pesan server apa adanya (mis. 503 pemberitahuan ke Owner belum bisa dikirim);
              isian form tetap seperti yang diketik. */}
          {saveError ? (
            <Notice tone="danger" role="alert">
              {saveError}
            </Notice>
          ) : null}
          {errorCount > 0 ? (
            <p className="sr-only" role="alert">
              {t.form.fixErrors(errorCount)}
            </p>
          ) : null}
          <div className={styles.formFooter}>
            {justSaved ? (
              <span className={styles.savedNote} role="status">
                <Icon icon={CircleCheck} size={16} />
                {t.emailSettings.saved}
              </span>
            ) : null}
            <Button
              ref={submitRef}
              type="submit"
              variant="primary"
              loading={saving}
              disabled={!data.canStoreSecrets}
            >
              {saving ? t.emailSettings.saving : t.emailSettings.save}
            </Button>
          </div>
        </form>
        <IdentityDialog
          open={confirming !== null}
          title={t.emailSettings.confirmTitle}
          body={t.emailSettings.confirmBody}
          confirmLabel={t.emailSettings.save}
          pendingLabel={t.emailSettings.saving}
          variant="primary"
          // Pemegang `settings.email.manage` (Owner/Admin) selalu peran wajib 2FA.
          requireCode
          returnFocusRef={submitRef}
          onCancel={() => setConfirming(null)}
          onConfirm={(identity) => (confirming ? persist(confirming, identity) : Promise.resolve())}
        />
        <EmailTemplatePreview />
      </div>

      {isDesktop ? (
        <EmailGuide
          context="settings"
          preset={values.preset}
          defaultOpen
          className={styles.aside}
        />
      ) : null}
    </div>
  );
}

function StatusSummary({ data }: { data: EmailSettingsResponse }) {
  return (
    <dl className={styles.statusCard}>
      <div className={styles.statusItem}>
        <dt className={styles.statusLabel}>{t.emailSettings.status}</dt>
        <dd className={styles.statusValue}>
          <EmailStatusBadge status={data.status} />
        </dd>
      </div>
      <div className={styles.statusItem}>
        <dt className={styles.statusLabel}>{t.emailSettings.lastTest}</dt>
        <dd className={styles.statusValue}>
          <LastTestValue data={data} />
        </dd>
      </div>
      {/* Belum diatur sama sekali: "Sumber" hanya mengulang status, jadi tidak ditampilkan. */}
      {data.source === 'none' ? null : (
        <div className={styles.statusItem}>
          <dt className={styles.statusLabel}>{t.emailSettings.source}</dt>
          <dd className={styles.statusValue}>
            <RichText text={t.emailSettings.sources[data.source]} />
          </dd>
        </div>
      )}
    </dl>
  );
}

function LastTestValue({ data }: { data: EmailSettingsResponse }) {
  if (data.lastTest) return formatDateTime(data.lastTest.testedAt);
  // Status sudah "Belum dites": cukup tanda kosong, tidak mengulang kalimat yang sama (N6).
  if (data.status === 'untested') {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t.emailSettings.neverTested}</span>
      </>
    );
  }
  return t.emailSettings.neverTested;
}
