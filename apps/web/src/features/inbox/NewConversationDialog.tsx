import type { MessageTemplate } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SelectField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { ApprovedTemplateList, TemplateFillFields } from '../templates/TemplatePicker';
import {
  emptyFill,
  fillErrors,
  fillParameters,
  fillSpec,
  looksLikePhone,
  parameterErrors,
  type FillValues,
} from '../templates/template-fill';
import styles from './Composer.module.css';
import { inboxChannelsQuery } from './inbox-queries';

const n = t.inbox.newConversation;

/**
 * Mulai percakapan ke nomor (bisa belum pernah chat) dengan template DISETUJUI (`inbox.initiate`:
 * Owner/Admin/Supervisor). Pilih nomor pengirim → nomor tujuan → template + isian → kirim, lalu
 * chat-nya dibuka (dipegang pengirim). Batas 200 percakapan baru per hari per pengguna (429).
 */
export function NewConversationDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (conversationId: string) => void;
}) {
  const channels = useQuery(inboxChannelsQuery);
  const senders = (channels.data?.channels ?? []).filter(
    (channel) => channel.type === 'whatsapp' && channel.enabled,
  );
  const [channelId, setChannelId] = useState('');
  const sender = channelId || senders[0]?.id || '';
  const [phone, setPhone] = useState('+62');
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [values, setValues] = useState<FillValues>(emptyFill);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const [clientMessageId, setClientMessageId] = useState(() => crypto.randomUUID());

  const pick = (next: MessageTemplate | null) => {
    setTemplate(next);
    setValues(emptyFill());
    setErrors({});
    setClientMessageId(crypto.randomUUID());
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const problems: Record<string, string> = {};
    if (!looksLikePhone(phone)) problems.phone = n.phoneInvalid;
    if (!template) problems.template = n.noTemplate;
    const spec = template ? fillSpec(template) : null;
    if (spec) Object.assign(problems, fillErrors(spec, values, false));
    setErrors(problems);
    if (Object.keys(problems).length > 0 || !template || !spec) return;
    setSending(true);
    try {
      const { conversationId } = await endpoints.inbox.start({
        channelId: sender,
        phone: phone.trim(),
        clientMessageId,
        templateId: template.id,
        parameters: fillParameters(spec, values),
      });
      onStarted(conversationId);
    } catch (caught) {
      const fieldErrors = parameterErrors(caught);
      const phoneError =
        isApiError(caught) && caught.details.find((detail) => detail.field === 'phone');
      if (fieldErrors) setErrors(fieldErrors);
      else if (phoneError && isApiError(caught)) setErrors({ phone: caught.message });
      else setFailure(caught);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open title={n.title} description={n.body} onRequestClose={onClose}>
      <form className={styles.tplStep} onSubmit={(event) => void submit(event)} noValidate>
        {channels.isSuccess && senders.length === 0 ? (
          <Notice tone="warning" role="status">
            {n.noChannel}
          </Notice>
        ) : (
          <>
            {senders.length > 1 ? (
              <SelectField
                label={n.channelLabel}
                value={sender}
                onChange={(event) => {
                  setChannelId(event.target.value);
                  pick(null);
                }}
                options={senders.map((channel) => ({
                  value: channel.id,
                  label: channel.displayPhoneNumber
                    ? `${channel.name} · ${channel.displayPhoneNumber}`
                    : channel.name,
                }))}
              />
            ) : null}
            <TextField
              label={n.phoneLabel}
              hint={n.phoneHint}
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setErrors(({ phone: _, ...rest }) => rest);
              }}
              error={errors.phone}
              inputMode="tel"
              autoComplete="off"
              maxLength={24}
            />
            <div className={styles.tplPick}>
              <span className={styles.tplLabel}>{n.templateLabel}</span>
              {template ? (
                <>
                  <div className={styles.tplChosen}>
                    <span className={styles.tplName}>{template.name}</span>
                    <Button onClick={() => pick(null)}>{n.changeTemplate}</Button>
                  </div>
                  <TemplateFillFields
                    template={template}
                    values={values}
                    onChange={(next) => {
                      setValues(next);
                      setErrors((current): Record<string, string> =>
                        current.phone ? { phone: current.phone } : {},
                      );
                    }}
                    errors={errors}
                    file={null}
                    onFile={() => undefined}
                  />
                </>
              ) : sender ? (
                <ApprovedTemplateList channelId={sender} allowMedia={false} onPick={pick} />
              ) : null}
              {errors.template ? (
                <p className={styles.tplError} role="alert">
                  {errors.template}
                </p>
              ) : null}
            </div>
            <p className={styles.tplNote}>{n.limitHint}</p>
          </>
        )}
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <DialogActions sticky>
          <Button onClick={onClose}>{n.cancel}</Button>
          <Button
            type="submit"
            variant="primary"
            loading={sending}
            disabled={senders.length === 0 && channels.isSuccess}
          >
            {sending ? n.starting : n.start}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
