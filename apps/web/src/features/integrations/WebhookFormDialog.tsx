import {
  MOBICHAT_WEBHOOK_EVENTS,
  OUTGOING_WEBHOOK_EVENTS,
  OUTGOING_WEBHOOK_EVENT_LABELS,
  createOutgoingWebhookRequestSchema,
  updateOutgoingWebhookRequestSchema,
  type CreateOutgoingWebhookRequest,
  type IdentityConfirmation,
  type OutgoingWebhook,
  type OutgoingWebhookEvent,
  type OutgoingWebhookFormat,
  type UpdateOutgoingWebhookRequest,
} from '@balesin/shared';
import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SecretField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import styles from './Integrations.module.css';

const copy = t.webhooks;
const MOBICHAT_EVENTS: readonly OutgoingWebhookEvent[] = MOBICHAT_WEBHOOK_EVENTS;

type Pending =
  | { kind: 'create'; body: CreateOutgoingWebhookRequest }
  | { kind: 'update'; body: UpdateOutgoingWebhookRequest; mobichat: boolean };

const isHttp = (value: string) => /^http:\/\//i.test(value.trim());

/**
 * Tambah / ubah webhook. Membuat, mengganti URL, dan mengganti API key/alamat MobiChat = jalur data
 * pelanggan ke luar → konfirmasi identitas; keterangan, kejadian, `botOnly` tanpa konfirmasi.
 *
 * API key MobiChat dibaca dari isian TAK TERKENDALI (`SecretField` + ref) saat disimpan — tidak
 * pernah di cache Query, storage, atau atribut DOM. Bila perlu konfirmasi identitas, isi permintaan
 * (termasuk key) disimpan sebentar di state `confirming` selama dialog konfirmasi terbuka, lalu
 * dibuang saat dialog ditutup atau setelah terkirim; isian key dikosongkan setelah terkirim.
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
  const [format, setFormat] = useState<OutgoingWebhookFormat>(webhook?.format ?? 'native');
  const mobichat = format === 'mobichat';
  const [url, setUrl] = useState(webhook?.url ?? 'https://');
  const [description, setDescription] = useState(webhook?.description ?? '');
  const [events, setEvents] = useState<Set<OutgoingWebhookEvent>>(
    new Set(webhook?.events ?? ['message.received']),
  );
  const [botOnly, setBotOnly] = useState(webhook?.botOnly ?? false);
  const [baseUrl, setBaseUrl] = useState(webhook?.mobichat?.baseUrl ?? '');
  const keyRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const chosenEvents = mobichat ? MOBICHAT_EVENTS : OUTGOING_WEBHOOK_EVENTS;
  const allSelected = events.size === OUTGOING_WEBHOOK_EVENTS.length;

  const readKey = () => keyRef.current?.value.trim() ?? '';
  const clearKey = () => {
    if (keyRef.current) keyRef.current.value = '';
  };

  const send = async (pending: Pending, confirmation?: IdentityConfirmation) => {
    if (pending.kind === 'create') {
      const created = await endpoints.webhooks.create({ ...pending.body, confirmation });
      clearKey();
      onCreated(created.secret);
    } else if (webhook) {
      await endpoints.webhooks.update(webhook.id, { ...pending.body, confirmation });
      clearKey();
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
    const chosen = mobichat
      ? [...MOBICHAT_EVENTS]
      : OUTGOING_WEBHOOK_EVENTS.filter((item) => events.has(item));
    const trimmed = description.trim();
    const key = readKey();
    const base = baseUrl.trim() ? baseUrl.trim() : null;
    if (!webhook) {
      const body: CreateOutgoingWebhookRequest = {
        url,
        events: chosen,
        description: trimmed || undefined,
        botOnly,
        ...(mobichat
          ? { format: 'mobichat' as const, mobichat: { apiKey: key, baseUrl: base } }
          : {}),
      };
      const parsed = createOutgoingWebhookRequestSchema.safeParse(body);
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        return;
      }
      setErrors({});
      setConfirming({ kind: 'create', body: parsed.data });
      return;
    }
    const urlChanged = url.trim() !== webhook.url;
    const baseChanged = mobichat && base !== (webhook.mobichat?.baseUrl ?? null);
    const keyChanged = mobichat && key !== '';
    const mobichatChanged = baseChanged || keyChanged;
    const body: UpdateOutgoingWebhookRequest = {
      ...(urlChanged ? { url } : {}),
      events: chosen,
      description: trimmed || null,
      botOnly,
      ...(mobichatChanged
        ? {
            mobichat: {
              ...(baseChanged ? { baseUrl: base } : {}),
              ...(keyChanged ? { apiKey: key } : {}),
            },
          }
        : {}),
    };
    const parsed = updateOutgoingWebhookRequestSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const pending: Pending = { kind: 'update', body: parsed.data, mobichat: mobichatChanged };
    if (urlChanged || mobichatChanged) {
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

  const httpUsed = isHttp(url) || (mobichat && isHttp(baseUrl));
  const keyError = errors['mobichat.apiKey'] ?? errors.mobichat;
  const identityTitle =
    confirming?.kind === 'create'
      ? copy.confirmCreateTitle
      : confirming?.mobichat
        ? copy.confirmMobichatTitle
        : copy.confirmUrlTitle;
  const identityBody =
    confirming?.kind === 'create'
      ? copy.confirmCreateBody
      : confirming?.mobichat
        ? copy.confirmMobichatBody
        : copy.confirmUrlBody;

  return (
    <>
      <Dialog
        open={confirming === null}
        title={webhook ? copy.formTitleEdit : copy.formTitleCreate}
        onRequestClose={onClose}
      >
        <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
          {webhook ? null : (
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>{copy.formatLabel}</legend>
              <div className={styles.segments} role="radiogroup" aria-label={copy.formatLabel}>
                {(['native', 'mobichat'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={format === item}
                    className={styles.segment}
                    onClick={() => setFormat(item)}
                  >
                    {copy.formats[item]}
                  </button>
                ))}
              </div>
              <p className={styles.hint}>{copy.formatHint[format]}</p>
            </fieldset>
          )}
          <TextField
            label={copy.urlLabel}
            hint={isHttp(url) ? copy.urlHintHttp : copy.urlHint}
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
          {mobichat ? (
            <>
              <SecretField
                ref={keyRef}
                label={webhook ? copy.mobichatKeyReplace : copy.mobichatKeyLabel}
                hint={copy.mobichatKeyHint}
                error={keyError}
                spellCheck={false}
                maxLength={200}
              />
              <TextField
                label={copy.mobichatBaseLabel}
                hint={copy.mobichatBaseHint}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                error={errors['mobichat.baseUrl']}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={2048}
                inputClassName={styles.monoInput}
              />
            </>
          ) : null}
          {httpUsed ? (
            <Notice tone="warning" title={copy.httpWarningTitle}>
              {copy.httpWarning}
            </Notice>
          ) : null}
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
            {mobichat ? (
              <p className={styles.hint}>{copy.mobichatEventsLocked}</p>
            ) : (
              <div className={styles.options}>
                <Checkbox
                  checked={allSelected}
                  onChange={(event) =>
                    setEvents(event.target.checked ? new Set(OUTGOING_WEBHOOK_EVENTS) : new Set())
                  }
                >
                  <strong>{copy.allEvents}</strong>
                </Checkbox>
                {chosenEvents.map((item) => (
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
            )}
            {errors.events ? <p className={styles.fieldError}>{errors.events}</p> : null}
          </fieldset>
          <Checkbox checked={botOnly} onChange={(event) => setBotOnly(event.target.checked)}>
            <span className={styles.optionText}>
              <span>{copy.botOnly}</span>
              <span className={styles.optionHint}>{copy.botOnlyHint}</span>
            </span>
          </Checkbox>
          {failure ? (
            <Notice tone="danger" role="alert">
              {isApiError(failure) ? failure.message : t.api.network}
            </Notice>
          ) : null}
          <DialogActions sticky>
            <Button onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" variant="primary" loading={saving}>
              {saving ? copy.saving : copy.save}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <IdentityDialog
        open={confirming !== null}
        title={identityTitle}
        body={identityBody}
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
