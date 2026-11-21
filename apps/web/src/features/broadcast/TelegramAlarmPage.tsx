import {
  telegramChatIdSchema,
  type IdentityConfirmation,
  type TelegramAlarmSettings,
  type TelegramTestCode,
  type UpdateTelegramAlarmRequest,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { FormActions } from '../../components/ui/FormActions';
import { Checkbox } from '../../components/ui/Checkbox';
import { SecretField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { broadcastKeys, telegramAlarmQuery } from './broadcast-queries';
import styles from './Broadcast.module.css';

const a = t.alarms;
const TOKEN_FORMAT = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;

/**
 * Pengaturan → Alarm Telegram (`integrations.manage`). Token bot = rahasia: isian TAK TERKENDALI
 * (`SecretField` + ref), tidak pernah dikirim balik (hanya ekornya). Tanpa token = alarm tidak dikirim
 * ke mana pun (dijelaskan). Simpan & hapus dengan konfirmasi identitas; kirim pesan tes.
 */
export function TelegramAlarmPage() {
  const query = useQuery(telegramAlarmQuery);
  return (
    <Page>
      <div className={styles.content}>
        <p className={styles.intro}>{a.intro}</p>
        {query.data ? (
          <TelegramCard settings={query.data.telegram} />
        ) : query.isPending ? (
          <Skeleton className={styles.skeletonCard} />
        ) : (
          <Notice
            tone="danger"
            role="alert"
            title={a.loadFailedTitle}
            actions={
              <Button onClick={() => void query.refetch()} loading={query.isFetching}>
                {t.common.retry}
              </Button>
            }
          >
            {isApiError(query.error) ? query.error.message : t.api.network}
          </Notice>
        )}
      </div>
    </Page>
  );
}

function TelegramCard({ settings }: { settings: TelegramAlarmSettings }) {
  const queryClient = useQueryClient();
  const tokenRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [chatId, setChatId] = useState(settings.chatId ?? '');
  const [enabled, setEnabled] = useState(settings.configured ? settings.enabled : true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<'save' | 'remove' | null>(null);
  const [pending, setPending] = useState<UpdateTelegramAlarmRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; code: TelegramTestCode; message: string } | null>(
    null,
  );

  const store = (telegram: TelegramAlarmSettings) =>
    queryClient.setQueryData(broadcastKeys.telegram, { telegram });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setFailure(null);
    setTest(null);
    const token = tokenRef.current?.value.trim() ?? '';
    const problems: Record<string, string> = {};
    if (!settings.configured && token === '') problems.botToken = 'Token bot wajib diisi.';
    else if (token !== '' && !TOKEN_FORMAT.test(token)) {
      problems.botToken = 'Format token bot Telegram: 123456:ABC…';
    }
    const chat = telegramChatIdSchema.safeParse(chatId);
    if (!chat.success) problems.chatId = chat.error.issues[0]?.message ?? '';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    // Token hanya di state selama dialog konfirmasi terbuka, lalu dibuang.
    setPending({ ...(token ? { botToken: token } : {}), chatId: chatId.trim(), enabled });
    setConfirming('save');
  };

  const save = async (confirmation: IdentityConfirmation) => {
    if (!pending) return;
    try {
      const { telegram } = await endpoints.alarms.updateTelegram({ ...pending, confirmation });
      if (tokenRef.current) tokenRef.current.value = '';
      setPending(null);
      setConfirming(null);
      store(telegram);
      setNotice(a.saved);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setPending(null);
      setConfirming(null);
      if (isApiError(caught) && caught.details.length > 0) {
        setErrors(
          Object.fromEntries(caught.details.map((detail) => [detail.field, detail.message])),
        );
      } else {
        setFailure(caught);
      }
    }
  };

  const remove = async (confirmation: IdentityConfirmation) => {
    try {
      const { telegram } = await endpoints.alarms.removeTelegram(confirmation);
      setConfirming(null);
      store(telegram);
      setChatId('');
      setNotice(a.removed);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(null);
      setFailure(caught);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await endpoints.alarms.testTelegram();
      setTest(result);
      void queryClient.invalidateQueries({ queryKey: broadcastKeys.telegram });
    } catch (caught) {
      setFailure(caught);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="alarm-telegram">
      <div className={styles.cardHeadRow}>
        <h2 id="alarm-telegram" className={styles.cardTitle}>
          {a.cardTitle}
        </h2>
        {settings.configured ? (
          <StatusBadge
            tone={settings.enabled ? 'success' : 'neutral'}
            label={settings.enabled ? a.statusOn : a.statusOff}
          />
        ) : null}
      </div>
      {!settings.configured ? (
        <Notice tone="info" role="status" title={a.notConfiguredTitle}>
          {a.notConfiguredBody}
        </Notice>
      ) : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        <SecretField
          ref={tokenRef}
          label={settings.tokenTail ? a.tokenReplace(settings.tokenTail) : a.tokenLabel}
          hint={a.tokenHint}
          error={errors.botToken}
          maxLength={90}
        />
        <TextField
          label={a.chatIdLabel}
          hint={a.chatIdHint}
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
          error={errors.chatId}
          maxLength={40}
          spellCheck={false}
          className={styles.short}
        />
        <Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)}>
          {a.enabled}
        </Checkbox>
        {notice ? (
          <Notice tone="success" role="status">
            {notice}
          </Notice>
        ) : null}
        {test ? (
          <Notice tone={test.ok ? 'success' : 'danger'} role="status">
            {test.message}
          </Notice>
        ) : settings.lastTest ? (
          <p className={settings.lastTest.ok ? styles.hint : styles.itemDanger}>
            {a.lastTest(formatDateTimeInline(settings.lastTest.at))}: {settings.lastTest.message}
          </p>
        ) : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <FormActions
          danger={
            settings.configured ? (
              <Button
                variant="ghost"
                className={styles.dangerButton}
                onClick={() => setConfirming('remove')}
              >
                <Icon icon={Trash2} size={16} />
                {a.remove}
              </Button>
            ) : undefined
          }
        >
          {settings.configured ? (
            <Button loading={testing} onClick={() => void sendTest()}>
              {testing ? null : <Icon icon={Send} size={16} />}
              {testing ? a.testing : a.test}
            </Button>
          ) : null}
          <Button ref={saveRef} type="submit" variant="primary">
            {a.save}
          </Button>
        </FormActions>
      </form>
      <IdentityDialog
        open={confirming === 'save'}
        title={a.confirmTitle}
        body={a.confirmBody}
        confirmLabel={a.save}
        pendingLabel={a.saving}
        requireCode
        returnFocusRef={saveRef}
        onCancel={() => {
          setPending(null);
          setConfirming(null);
        }}
        onConfirm={save}
      />
      <IdentityDialog
        open={confirming === 'remove'}
        title={a.removeTitle}
        body={a.removeBody}
        confirmLabel={a.remove}
        pendingLabel={a.removing}
        variant="danger"
        requireCode
        onCancel={() => setConfirming(null)}
        onConfirm={remove}
      />
    </section>
  );
}
