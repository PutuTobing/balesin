import {
  API_KEY_DAILY_SEND_DEFAULT,
  API_KEY_SCOPES,
  API_KEY_SCOPE_LABELS,
  apiKeyHasEmailScope,
  createApiKeyRequestSchema,
  type ApiKeyScope,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useState, type FormEvent, type RefObject } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { expiryFrom, impliedScopes, type Expiry } from './api-key-form';
import { emailErrors, parseAttachmentHosts, scopeGroups } from './api-key-email';
import { ApiKeyEmailFields } from './ApiKeyEmailFields';
import styles from './Integrations.module.css';

const copy = t.apiKeys;
const SCOPE_GROUPS = scopeGroups();

/** Buat API key: isian → konfirmasi identitas → kunci utuh (diserahkan ke pemanggil sekali). */
export function ApiKeyCreateDialog({
  returnFocusRef,
  onClose,
  onCreated,
}: {
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCreated: (created: CreateApiKeyResponse) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(['messages:send']));
  const [expiry, setExpiry] = useState<Expiry>('d365');
  const [customDate, setCustomDate] = useState('');
  const [ips, setIps] = useState('');
  const [limit, setLimit] = useState(String(API_KEY_DAILY_SEND_DEFAULT));
  const [emailSenders, setEmailSenders] = useState<Set<string>>(new Set());
  const [emailHosts, setEmailHosts] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirming, setConfirming] = useState<CreateApiKeyRequest | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const implied = impliedScopes(scopes);
  const hasEmail = apiKeyHasEmailScope([...scopes, ...implied]);
  const canSendEmail = scopes.has('email:send');

  const toggle = (scope: ApiKeyScope, checked: boolean) => {
    setScopes((current) => {
      const next = new Set(current);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const expiresAt = expiryFrom(expiry, customDate);
    const nextErrors: FieldErrors = {};
    if (expiresAt === undefined) nextErrors.expiresAt = copy.expiryInvalid;
    const dailySendLimit = /^\d{1,6}$/.test(limit.replace(/[.\s]/g, ''))
      ? Number(limit.replace(/[.\s]/g, ''))
      : Number.NaN;
    const allowedIps = ips
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (hasEmail && emailSenders.size === 0) nextErrors.emailSenderIds = copy.emailSendersRequired;
    const hostResult = canSendEmail ? parseAttachmentHosts(emailHosts) : null;
    if (hostResult?.error) nextErrors.emailAttachmentHosts = hostResult.error;
    const parsed = createApiKeyRequestSchema.safeParse({
      name,
      // Hanya pilihan eksplisit; tingkatan dihitung server dari scope tertinggi.
      scopes: API_KEY_SCOPES.filter((scope) => scopes.has(scope)),
      expiresAt: expiresAt ?? null,
      allowedIps: allowedIps.length > 0 ? allowedIps : null,
      dailySendLimit,
      ...(hasEmail ? { emailSenderIds: [...emailSenders] } : {}),
      ...(hostResult?.hosts && hostResult.hosts.length > 0
        ? { emailAttachmentHosts: hostResult.hosts }
        : {}),
    });
    if (!parsed.success || Object.keys(nextErrors).length > 0) {
      const fieldErrors = parsed.success ? {} : zodFieldErrors(parsed.error);
      if (fieldErrors.dailySendLimit) fieldErrors.dailySendLimit = copy.limitInvalid;
      // Galat per baris IP digabung ke satu isian.
      const ipError = Object.entries(fieldErrors).find(([key]) => key.startsWith('allowedIps'));
      if (ipError) fieldErrors.allowedIps = ipError[1];
      setErrors({ ...fieldErrors, ...nextErrors });
      return;
    }
    setErrors({});
    setConfirming(parsed.data);
  };

  const create = async (confirmation: IdentityConfirmation) => {
    if (!confirming) return;
    try {
      const created = await endpoints.apiKeys.create({ ...confirming, confirmation });
      setConfirming(null);
      onCreated(created);
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
      <Dialog open={confirming === null} title={copy.formTitle} onRequestClose={onClose}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <TextField
            label={copy.nameLabel}
            hint={copy.nameHint}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={errors.name}
            maxLength={80}
            autoComplete="off"
          />
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{copy.scopesLabel}</legend>
            <p className={styles.hint}>{copy.scopesHint}</p>
            {SCOPE_GROUPS.map((group) => (
              <div
                key={group.key}
                className={styles.scopeGroup}
                role="group"
                aria-labelledby={`izin-${group.key}`}
              >
                <p id={`izin-${group.key}`} className={styles.scopeGroupTitle}>
                  {group.label}
                </p>
                <div className={styles.options}>
                  {group.scopes.map((scope) => {
                    const isImplied = implied.has(scope);
                    return (
                      <Checkbox
                        key={scope}
                        checked={scopes.has(scope) || isImplied}
                        disabled={isImplied}
                        onChange={(event) => toggle(scope, event.target.checked)}
                      >
                        <span className={styles.optionText}>
                          <span>{API_KEY_SCOPE_LABELS[scope]}</span>
                          <span className={styles.optionHint}>
                            <code className={styles.monoSmall}>{scope}</code>
                            {isImplied ? ` · ${copy.implied}` : ''}
                          </span>
                        </span>
                      </Checkbox>
                    );
                  })}
                </div>
              </div>
            ))}
            {errors.scopes ? <p className={styles.fieldError}>{errors.scopes}</p> : null}
          </fieldset>
          {hasEmail ? (
            <ApiKeyEmailFields
              senderIds={emailSenders}
              onSenderIds={setEmailSenders}
              hosts={emailHosts}
              onHosts={setEmailHosts}
              showHosts={canSendEmail}
              errors={emailErrors(errors)}
            />
          ) : null}
          <SelectField
            label={copy.expiryLabel}
            value={expiry}
            onChange={(event) => setExpiry(event.target.value as Expiry)}
            error={expiry === 'custom' ? undefined : errors.expiresAt}
            options={(Object.keys(copy.expiryOptions) as Expiry[]).map((key) => ({
              value: key,
              label: copy.expiryOptions[key],
            }))}
          />
          {expiry === 'custom' ? (
            <TextField
              label={copy.expiryDate}
              type="date"
              value={customDate}
              onChange={(event) => setCustomDate(event.target.value)}
              error={errors.expiresAt}
            />
          ) : null}
          <TextAreaField
            label={copy.ipsLabel}
            hint={copy.ipsHint}
            value={ips}
            onChange={(event) => setIps(event.target.value)}
            error={errors.allowedIps}
            rows={3}
            spellCheck={false}
            className={styles.monoField}
          />
          <TextField
            label={copy.limitLabel}
            hint={copy.limitHint}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            error={errors.dailySendLimit}
            inputMode="numeric"
            maxLength={7}
          />
          {failure ? (
            <Notice tone="danger" role="alert">
              {isApiError(failure) ? failure.message : t.api.network}
            </Notice>
          ) : null}
          <DialogActions sticky>
            <Button onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" variant="primary">
              {copy.next}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <IdentityDialog
        open={confirming !== null}
        title={copy.confirmTitle}
        body={copy.confirmBody}
        confirmLabel={copy.next}
        pendingLabel={copy.creating}
        variant="primary"
        requireCode
        returnFocusRef={returnFocusRef}
        onCancel={() => setConfirming(null)}
        onConfirm={create}
      />
    </>
  );
}
