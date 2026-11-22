import {
  updateApiKeyRequestSchema,
  type ApiKey,
  type IdentityConfirmation,
  type UpdateApiKeyRequest,
} from '@balesin/shared';
import { useState, type FormEvent, type RefObject } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, type FieldErrors } from '../../lib/form';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { emailErrors, parseAttachmentHosts, sameSet } from './api-key-email';
import { ApiKeyEmailFields } from './ApiKeyEmailFields';
import styles from './Integrations.module.css';

const copy = t.apiKeys;

/**
 * Ubah pengirim email & host lampiran sebuah key (`PATCH /settings/api-keys/:id`) — SELALU dengan
 * konfirmasi identitas. Scope tidak bisa diubah. Isian konfirmasi hanya di `IdentityDialog`
 * (di luar `<form>` ini), tanpa `useMutation`.
 */
export function ApiKeyEmailDialog({
  apiKey,
  returnFocusRef,
  onClose,
  onSaved,
}: {
  apiKey: ApiKey;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSaved: (apiKey: ApiKey) => void;
}) {
  const initialSenders = apiKey.emailSenders.map((sender) => sender.id);
  const canSend = apiKey.scopes.includes('email:send');
  const [senderIds, setSenderIds] = useState<Set<string>>(new Set(initialSenders));
  const [hosts, setHosts] = useState(apiKey.emailAttachmentHosts.join('\n'));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [unchanged, setUnchanged] = useState(false);
  const [confirming, setConfirming] = useState<UpdateApiKeyRequest | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setUnchanged(false);
    const nextErrors: FieldErrors = {};
    if (senderIds.size === 0) nextErrors.emailSenderIds = copy.emailSendersRequired;
    const hostResult = canSend ? parseAttachmentHosts(hosts) : null;
    if (hostResult?.error) nextErrors.emailAttachmentHosts = hostResult.error;
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    const body: UpdateApiKeyRequest = {};
    const nextSenders = [...senderIds];
    if (!sameSet(nextSenders, initialSenders)) body.emailSenderIds = nextSenders;
    if (hostResult?.hosts && !sameSet(hostResult.hosts, apiKey.emailAttachmentHosts)) {
      body.emailAttachmentHosts = hostResult.hosts;
    }
    const parsed = updateApiKeyRequestSchema.safeParse(body);
    if (!parsed.success) {
      setUnchanged(true);
      return;
    }
    setConfirming(parsed.data);
  };

  const save = async (confirmation: IdentityConfirmation) => {
    if (!confirming) return;
    try {
      const { apiKey: updated } = await endpoints.apiKeys.update(apiKey.id, {
        ...confirming,
        confirmation,
      });
      setConfirming(null);
      onSaved(updated);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(null);
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        setErrors(apiFieldErrors(caught.details));
      } else {
        setFailure(caught);
      }
    }
  };

  return (
    <>
      <Dialog
        open={confirming === null}
        title={copy.emailEditTitle(apiKey.name)}
        description={copy.emailEditBody}
        onRequestClose={onClose}
      >
        <form className={styles.form} onSubmit={submit} noValidate>
          <ApiKeyEmailFields
            senderIds={senderIds}
            onSenderIds={(next) => {
              setSenderIds(next);
              setUnchanged(false);
            }}
            hosts={hosts}
            onHosts={(next) => {
              setHosts(next);
              setUnchanged(false);
            }}
            showHosts={canSend}
            errors={emailErrors(errors)}
          />
          {unchanged ? (
            <Notice tone="info" role="status">
              {copy.emailUnchanged}
            </Notice>
          ) : null}
          {failure ? (
            <Notice tone="danger" role="alert">
              {isApiError(failure) ? failure.message : t.api.network}
            </Notice>
          ) : null}
          <DialogActions sticky>
            <Button onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" variant="primary">
              {copy.emailSave}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <IdentityDialog
        open={confirming !== null}
        title={copy.emailConfirmTitle}
        body={copy.emailConfirmBody}
        confirmLabel={copy.emailSave}
        pendingLabel={copy.emailSaving}
        variant="primary"
        requireCode
        returnFocusRef={returnFocusRef}
        onCancel={() => setConfirming(null)}
        onConfirm={save}
      />
    </>
  );
}
