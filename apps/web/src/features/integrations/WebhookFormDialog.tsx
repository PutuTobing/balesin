import {
  OUTGOING_WEBHOOK_EVENTS,
  OUTGOING_WEBHOOK_EVENT_LABELS,
  createOutgoingWebhookRequestSchema,
  updateOutgoingWebhookRequestSchema,
  type IdentityConfirmation,
  type OutgoingWebhook,
  type OutgoingWebhookEvent,
} from '@balesin/shared';
import { useState, type FormEvent, type RefObject } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import styles from './Integrations.module.css';

const copy = t.webhooks;

type Pending =
  | { kind: 'create'; body: { url: string; events: OutgoingWebhookEvent[]; description?: string } }
  | {
      kind: 'update';
      body: { url?: string; events: OutgoingWebhookEvent[]; description: string | null };
    };

/**
 * Tambah / ubah webhook. Membuat & mengganti URL = jalur data pelanggan ke luar → konfirmasi
 * identitas; mengubah keterangan/kejadian saja tanpa konfirmasi.
 */
export function WebhookFormDialog({
  webhook,
  returnFocusRef,
  onClose,
  onCreated,
  onSaved,
}: {
  /** `null` = tambah baru. */
  webhook: OutgoingWebhook | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCreated: (secret: string) => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(webhook?.url ?? 'https://');
  const [description, setDescription] = useState(webhook?.description ?? '');
  const [events, setEvents] = useState<Set<OutgoingWebhookEvent>>(
    new Set(webhook?.events ?? ['message.received']),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const allSelected = events.size === OUTGOING_WEBHOOK_EVENTS.length;

  const send = async (pending: Pending, confirmation?: IdentityConfirmation) => {
    if (pending.kind === 'create') {
      const created = await endpoints.webhooks.create({ ...pending.body, confirmation });
      onCreated(created.secret);
    } else if (webhook) {
      await endpoints.webhooks.update(webhook.id, { ...pending.body, confirmation });
      onSaved();
    }
  };

  const handleError = (caught: unknown) => {
    if (isApiError(caught) && caught.code === 'VALIDATION_ERROR' && caught.details.length > 0) {
      setErrors(apiFieldErrors(caught.details));
    } else {
      setFailure(caught);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const chosen = OUTGOING_WEBHOOK_EVENTS.filter((item) => events.has(item));
    const trimmed = description.trim();
    if (!webhook) {
      const parsed = createOutgoingWebhookRequestSchema.safeParse({
        url,
        events: chosen,
        description: trimmed || undefined,
      });
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        return;
      }
      setErrors({});
      setConfirming({
        kind: 'create',
        body: { url: parsed.data.url, events: chosen, description: parsed.data.description },
      });
      return;
    }
    const urlChanged = url.trim() !== webhook.url;
    const parsed = updateOutgoingWebhookRequestSchema.safeParse({
      ...(urlChanged ? { url } : {}),
      events: chosen,
      description: trimmed || null,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const pending: Pending = {
      kind: 'update',
      body: {
        ...(urlChanged ? { url: parsed.data.url } : {}),
        events: chosen,
        description: trimmed || null,
      },
    };
    if (urlChanged) {
      setConfirming(pending);
      return;
    }
    setSaving(true);
    try {
      await send(pending);
    } catch (caught) {
      handleError(caught);
    } finally {
      setSaving(false);
    }
  };

  const confirm = async (confirmation: IdentityConfirmation) => {
    if (!confirming) return;
    try {
      await send(confirming, confirmation);
      setConfirming(null);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(null);
      handleError(caught);
    }
  };

  return (
    <>
      <Dialog
        open={confirming === null}
        title={webhook ? copy.formTitleEdit : copy.formTitleCreate}
        onRequestClose={onClose}
      >
        <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            label={copy.urlLabel}
            hint={copy.urlHint}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            error={errors.url}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={2048}
            inputClassName={styles.monoInput}
          />
          <TextField
            label={copy.descriptionLabel}
            hint={copy.descriptionHint}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            error={errors.description}
            maxLength={120}
          />
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{copy.eventsLabel}</legend>
            <div className={styles.options}>
              <Checkbox
                checked={allSelected}
                onChange={(event) =>
                  setEvents(event.target.checked ? new Set(OUTGOING_WEBHOOK_EVENTS) : new Set())
                }
              >
                <strong>{copy.allEvents}</strong>
              </Checkbox>
              {OUTGOING_WEBHOOK_EVENTS.map((item) => (
                <Checkbox
                  key={item}
                  checked={events.has(item)}
                  onChange={(event) =>
                    setEvents((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item);
                      else next.delete(item);
                      return next;
                    })
                  }
                >
                  <span className={styles.optionText}>
                    <span>{OUTGOING_WEBHOOK_EVENT_LABELS[item]}</span>
                    <code className={styles.monoSmall}>{item}</code>
                  </span>
                </Checkbox>
              ))}
            </div>
            {errors.events ? <p className={styles.fieldError}>{errors.events}</p> : null}
          </fieldset>
          {failure ? (
            <Notice tone="danger" role="alert">
              {isApiError(failure) ? failure.message : t.api.network}
            </Notice>
          ) : null}
          <DialogActions>
            <Button onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" variant="primary" loading={saving}>
              {saving ? copy.saving : copy.save}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <IdentityDialog
        open={confirming !== null}
        title={confirming?.kind === 'create' ? copy.confirmCreateTitle : copy.confirmUrlTitle}
        body={confirming?.kind === 'create' ? copy.confirmCreateBody : copy.confirmUrlBody}
        confirmLabel={copy.save}
        pendingLabel={copy.saving}
        variant="primary"
        requireCode
        returnFocusRef={returnFocusRef}
        onCancel={() => setConfirming(null)}
        onConfirm={confirm}
      />
    </>
  );
}
