import type { Conversation, MessageTemplate } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Icon } from '../../components/ui/Icon';
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
  parameterErrors,
  type FillValues,
} from '../templates/template-fill';
import styles from './Composer.module.css';
import { inboxKeys } from './inbox-queries';

const s = t.inbox.templateSend;

/**
 * Kirim template Meta DISETUJUI ke percakapan ini — satu-satunya pesan yang boleh di luar sesi 24
 * jam. Langkah 1 pilih template nomor ini; langkah 2 isi variabel (+ berkas judul) dengan
 * pratinjau langsung, lalu kirim (`type: template`).
 */
export function TemplateSendDialog({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [values, setValues] = useState<FillValues>(emptyFill);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  // Satu kunci idempotensi per template yang dipilih: kirim ulang setelah galat jaringan tidak
  // menggandakan pesan.
  const [clientMessageId, setClientMessageId] = useState(() => crypto.randomUUID());

  const pick = (next: MessageTemplate | null) => {
    setTemplate(next);
    setValues(emptyFill());
    setFile(null);
    setErrors({});
    setFailure(null);
    setClientMessageId(crypto.randomUUID());
  };

  const send = async () => {
    if (!template) return;
    const spec = fillSpec(template);
    const problems = fillErrors(spec, values, file !== null);
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setSending(true);
    try {
      const mediaId = file
        ? (await endpoints.inbox.upload(conversation.id, file)).media.id
        : undefined;
      await endpoints.inbox.send(conversation.id, {
        type: 'template',
        clientMessageId,
        templateId: template.id,
        parameters: fillParameters(spec, values, mediaId),
      });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversation.id) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversation.id) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
      onClose();
    } catch (caught) {
      const fieldErrors = parameterErrors(caught);
      if (fieldErrors) setErrors(fieldErrors);
      else setFailure(caught);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open
      title={s.title}
      description={template ? undefined : s.pickHint}
      onRequestClose={onClose}
    >
      {template ? (
        <div className={styles.tplStep}>
          <div className={styles.tplBack}>
            <Button variant="ghost" onClick={() => pick(null)}>
              <Icon icon={ArrowLeft} size={16} />
              {s.back}
            </Button>
            <span className={styles.tplName}>{template.name}</span>
          </div>
          <TemplateFillFields
            template={template}
            values={values}
            onChange={(next) => {
              setValues(next);
              setErrors({});
            }}
            errors={errors}
            file={file}
            onFile={(picked) => {
              setFile(picked);
              setErrors({});
            }}
          />
          {failure ? (
            <Notice tone="danger" role="alert">
              {isApiError(failure) ? failure.message : t.api.network}
            </Notice>
          ) : null}
        </div>
      ) : (
        <ApprovedTemplateList
          channelId={conversation.channel.id}
          allowMedia
          onPick={(picked) => pick(picked)}
        />
      )}
      <DialogActions sticky>
        <Button onClick={onClose}>{s.cancel}</Button>
        {template ? (
          <Button variant="primary" loading={sending} onClick={() => void send()}>
            {sending ? s.sending : s.send}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
