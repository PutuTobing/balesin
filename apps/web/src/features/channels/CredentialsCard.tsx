import type {
  ChannelCredentialField,
  IdentityConfirmation,
  UpdateChannelRequest,
  WhatsAppChannel,
} from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { SecretField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { queryKeys, storeChannel } from '../../lib/api/queries';
import { formatDateTime } from '../../lib/format';
import type { FieldErrors } from '../../lib/form';
import { useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import styles from './Channels.module.css';
import {
  CREDENTIAL_FIELDS,
  credentialChanges,
  validateCredentialChanges,
} from './credentials-form';
import { Fact } from './NumberFacts';

const copy = t.channels.credentials;

export interface CredentialsCardProps {
  channel: WhatsAppChannel;
  /**
   * Form ganti terbuka, dengan isian yang difokus saat dibuka (`null` = tertutup). Dikendalikan
   * halaman nomor supaya "Ganti kredensial" di kotak "Tes terakhir gagal" bisa membukanya langsung.
   */
  editing: ChannelCredentialField | null;
  onEdit: (field: ChannelCredentialField | null) => void;
}

/**
 * Kredensial Meta: ID tampil apa adanya (bukan rahasia), token dan App Secret hanya petunjuk
 * tersamar `••••abcd`. Ganti kredensial = form di dalam kartu (isian rahasia selalu kosong dan tak
 * terkendali) + konfirmasi identitas. Setelah diganti, status kembali "Belum dites".
 */
export function CredentialsCard({ channel, editing, onEdit }: CredentialsCardProps) {
  const queryClient = useQueryClient();
  const session = useSession();
  const [done, setDone] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done) resultRef.current?.focus();
  }, [done]);

  return (
    <section id="kredensial" className={styles.card} aria-labelledby="channel-kredensial">
      <div className={styles.cardHead}>
        <h2 id="channel-kredensial" className={styles.cardTitle}>
          {copy.title}
        </h2>
        <p className={styles.hint}>{copy.hint}</p>
      </div>
      {done ? (
        <div ref={resultRef} tabIndex={-1} className={styles.result}>
          <Notice tone="success" role="status">
            {copy.saved}
          </Notice>
        </div>
      ) : null}
      {editing ? (
        // Selama form terbuka, fakta di atasnya disembunyikan: nilainya sudah ada di isian.
        <CredentialsForm
          key={editing}
          channel={channel}
          focus={editing}
          ownersNotified={session !== null && session.user.role !== 'owner'}
          onCancel={() => {
            onEdit(null);
            requestAnimationFrame(() => openRef.current?.focus());
          }}
          onSaved={(next) => {
            storeChannel(queryClient, next);
            // Profil bisnis dibaca dengan kredensial lama; dibaca ulang setelah tes berikutnya.
            queryClient.removeQueries({ queryKey: queryKeys.businessProfile(channel.id) });
            onEdit(null);
            setDone(true);
          }}
        />
      ) : (
        <>
          <dl className={styles.facts}>
            <Fact label={copy.phoneNumberId}>
              <span className={styles.mono}>{channel.phoneNumberId}</span>
            </Fact>
            <Fact label={copy.wabaId}>
              <span className={styles.mono}>{channel.wabaId}</span>
            </Fact>
            <Fact label={copy.token}>
              <span className={styles.mono}>{channel.accessTokenHint ?? copy.stored}</span>
            </Fact>
            <Fact label={copy.appSecret}>
              <span className={styles.mono}>{channel.appSecretHint ?? copy.stored}</span>
            </Fact>
            <Fact label={copy.updatedAt}>{formatDateTime(channel.credentialsUpdatedAt)}</Fact>
          </dl>
          {/* Aksi kartu: kiri bawah isi kartu (pola halaman nomor). */}
          <div className={styles.actions}>
            <Button
              ref={openRef}
              onClick={() => {
                setDone(false);
                onEdit('phoneNumberId');
              }}
            >
              {copy.change}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function CredentialsForm({
  channel,
  focus,
  ownersNotified,
  onCancel,
  onSaved,
}: {
  channel: WhatsAppChannel;
  focus: ChannelCredentialField;
  ownersNotified: boolean;
  onCancel: () => void;
  onSaved: (channel: WhatsAppChannel) => void;
}) {
  // ID (bukan rahasia) di state; token dan App Secret hanya di elemen input (lewat ref).
  const [ids, setIds] = useState({ phoneNumberId: channel.phoneNumberId, wabaId: channel.wabaId });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<UpdateChannelRequest | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const [invalidTick, setInvalidTick] = useState(0);

  // Dibuka → gulir ke form dan fokus ke isian yang relevan (mis. Token setelah tes gagal).
  useEffect(() => {
    const input = formRef.current?.querySelector<HTMLInputElement>(`[data-isian="${focus}"]`);
    formRef.current?.scrollIntoView({ block: 'nearest' });
    input?.focus();
  }, [focus]);
  useEffect(() => {
    if (invalidTick === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalidTick]);

  // Rahasia tidak tertinggal di elemen setelah form ditutup (berhasil atau batal).
  useEffect(() => {
    const token = tokenRef.current;
    const secret = secretRef.current;
    return () => {
      if (token) token.value = '';
      if (secret) secret.value = '';
    };
  }, []);

  const clearError = (field: string) => {
    setFailure(null);
    if (errors[field]) setErrors(({ [field]: _removed, ...rest }) => rest);
  };

  const persist = async (changes: UpdateChannelRequest, identity: IdentityConfirmation) => {
    try {
      const response = await endpoints.channels.update(channel.id, {
        ...changes,
        confirmation: identity,
      });
      setConfirming(null);
      onSaved(response.channel);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(null);
      const fieldErrors: FieldErrors = {};
      if (isApiError(caught)) {
        for (const detail of caught.details) {
          if ((CREDENTIAL_FIELDS as readonly string[]).includes(detail.field))
            fieldErrors[detail.field] ??= detail.message;
        }
      }
      if (Object.keys(fieldErrors).length > 0) {
        setErrors(fieldErrors);
        setInvalidTick((tick) => tick + 1);
        return;
      }
      setFailure(isApiError(caught) ? caught.message : t.api.network);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes = credentialChanges(
      {
        ...ids,
        accessToken: tokenRef.current?.value ?? '',
        appSecret: secretRef.current?.value ?? '',
      },
      channel,
    );
    if (Object.keys(changes).length === 0) {
      setFailure(copy.unchanged);
      return;
    }
    const invalid = validateCredentialChanges(changes);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      setInvalidTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setFailure(null);
    setConfirming(changes);
  };

  return (
    <>
      <form ref={formRef} className={styles.inlineForm} onSubmit={submit} noValidate>
        <p className={styles.hint}>{copy.formHint}</p>
        <div className={styles.row}>
          <TextField
            data-isian="phoneNumberId"
            label={copy.phoneNumberId}
            inputMode="numeric"
            value={ids.phoneNumberId}
            onChange={(event) => {
              setIds((current) => ({ ...current, phoneNumberId: event.target.value }));
              clearError('phoneNumberId');
            }}
            error={errors.phoneNumberId}
            autoComplete="off"
            spellCheck={false}
            inputClassName={styles.mono}
          />
          <TextField
            data-isian="wabaId"
            label={t.channels.wizard.steps.ids.wabaId}
            inputMode="numeric"
            value={ids.wabaId}
            onChange={(event) => {
              setIds((current) => ({ ...current, wabaId: event.target.value }));
              clearError('wabaId');
            }}
            error={errors.wabaId}
            autoComplete="off"
            spellCheck={false}
            inputClassName={styles.mono}
          />
        </div>
        <SecretField
          ref={tokenRef}
          data-isian="accessToken"
          label={copy.token}
          optional
          hint={channel.accessTokenHint ? copy.keepToken(channel.accessTokenHint) : copy.keepNoHint}
          name="token-system-user"
          onChange={() => clearError('accessToken')}
          error={errors.accessToken}
          inputClassName={styles.mono}
        />
        <SecretField
          ref={secretRef}
          data-isian="appSecret"
          label={copy.appSecret}
          optional
          hint={channel.appSecretHint ? copy.keepSecret(channel.appSecretHint) : copy.keepNoHint}
          name="app-secret"
          onChange={() => clearError('appSecret')}
          error={errors.appSecret}
          inputClassName={styles.mono}
        />
        {ownersNotified ? <p className={styles.note}>{t.channels.ownersNotified}</p> : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {failure}
          </Notice>
        ) : null}
        <div className={styles.formFooter}>
          <Button variant="ghost" onClick={onCancel}>
            {copy.cancel}
          </Button>
          <Button ref={submitRef} type="submit" variant="primary">
            {copy.save}
          </Button>
        </div>
      </form>
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
