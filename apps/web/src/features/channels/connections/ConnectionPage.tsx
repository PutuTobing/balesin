import {
  CONNECTION_TEST_MESSAGES,
  type ConnectionChannel,
  type ConnectionTestResult,
  type EmailChannel,
  type IdentityConfirmation,
  type MetaSocialChannel,
  type TelegramChannel,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { CheckCircle2, CircleAlert, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import {
  ChannelIllustration,
  LoadFailedIllustration,
} from '../../../components/illustrations/illustrations';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { CopyButton } from '../../../components/ui/CopyButton';
import { Dialog, DialogActions } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { FormErrorNotice } from '../../../components/ui/FormErrorNotice';
import { Icon } from '../../../components/ui/Icon';
import { Notice } from '../../../components/ui/Notice';
import { Page } from '../../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../../components/ui/Skeleton';
import { t } from '../../../i18n/id';
import { isApiError } from '../../../lib/api/client';
import { endpoints } from '../../../lib/api/endpoints';
import { formatDateTime } from '../../../lib/format';
import { apiFieldErrors } from '../../../lib/form';
import { useLock } from '../../../lib/use-lock';
import { isConfirmationError, needsConfirmation } from '../../identity/confirmation-error';
import { IdentityDialog } from '../../identity/IdentityDialog';
import { isNotFound } from '../../inbox/inbox-queries';
import { ChannelStatusBadge } from '../ChannelBadges';
import { CHANNEL_TYPE_ICONS, channelTypeLabel } from '../channel-type';
import { Fact } from '../NumberFacts';
import channelStyles from '../Channels.module.css';
import '../route-state';
import { ConnectionFields } from './connection-form';
import { useConnectionForm } from './use-connection-form';
import {
  connectionKeys,
  connectionQuery,
  storeConnection,
  takeConnectionFlash,
} from './connection-queries';
import styles from './Connections.module.css';

const c = t.connections;
const routeApi = getRouteApi('/_app/pengaturan/channel/lain/$channelId');

/** Halaman channel Telegram/Email/Messenger/Instagram (`channels.manage`). */
export function ConnectionPage() {
  const { channelId } = routeApi.useParams();
  const queryClient = useQueryClient();
  const result = useQuery(connectionQuery(channelId, queryClient));
  const channel = result.data?.channel;
  return (
    <Page>
      {channel ? (
        <ConnectionDetail key={channel.id} channel={channel} />
      ) : result.isPending ? (
        <SkeletonRegion className={styles.page}>
          <div className={styles.card}>
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonLine} />
          </div>
        </SkeletonRegion>
      ) : isNotFound(result.error) ? (
        <EmptyState
          illustration={<ChannelIllustration />}
          title={c.notFoundTitle}
          body={c.notFoundBody}
          actions={
            <Button variant="primary" asChild>
              <Link to="/pengaturan/channel">{c.backToChannels}</Link>
            </Button>
          }
        />
      ) : (
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={c.notFoundTitle}
          body={isApiError(result.error) ? result.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void result.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      )}
    </Page>
  );
}

function ConnectionDetail({ channel }: { channel: ConnectionChannel }) {
  const [flash, setFlash] = useState(() => takeConnectionFlash());
  const TypeIcon = CHANNEL_TYPE_ICONS[channel.type];
  const meta = channel.type === 'messenger' || channel.type === 'instagram' ? channel : null;
  return (
    <div className={styles.page}>
      {flash ? (
        <Notice tone="success" role="status">
          {flash}
        </Notice>
      ) : null}
      <section className={styles.card} aria-labelledby="channel-nama">
        <div className={styles.summary}>
          <span className={styles.typeIcon}>
            <Icon icon={TypeIcon} size={20} />
          </span>
          <div className={styles.summaryText}>
            <h2 id="channel-nama" className={styles.summaryName}>
              {channel.name}
            </h2>
            <p className={styles.hint}>{channelTypeLabel(channel.type)}</p>
          </div>
          <ChannelStatusBadge channel={channel} />
        </div>
        {meta && !meta.enabled ? (
          <Notice tone="warning" title={c.metaReviewTitle}>
            {meta.reviewNote}
          </Notice>
        ) : null}
      </section>

      {channel.type === 'telegram' ? <TelegramFacts channel={channel} onDone={setFlash} /> : null}
      {channel.type === 'email' ? <EmailFacts channel={channel} /> : null}
      {meta ? <MetaFacts channel={meta} onDone={setFlash} /> : null}

      <TestCard channel={channel} />
      <SettingsCard channel={channel} onDone={setFlash} />
      <StatusCard channel={channel} onDone={setFlash} />
    </div>
  );
}

function TelegramFacts({
  channel,
  onDone,
}: {
  channel: TelegramChannel;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const renew = useMutation({
    mutationFn: () => endpoints.connections.renewWebhook(channel.id),
    onSuccess: ({ channel: next }) => {
      storeConnection(queryClient, next);
      onDone(c.webhookRegisteredDone);
    },
  });
  return (
    <section className={styles.card} aria-labelledby="channel-koneksi">
      <h2 id="channel-koneksi" className={styles.cardTitle}>
        {c.connectionTitle}
      </h2>
      <dl className={channelStyles.facts}>
        <Fact label={c.bot}>{channel.botUsername ? `@${channel.botUsername}` : '—'}</Fact>
        <Fact label={c.botId}>
          <span className={channelStyles.mono}>{channel.botId}</span>
        </Fact>
        <Fact label={c.botToken}>
          <span className={channelStyles.mono}>{channel.botTokenHint ?? c.stored}</span>
        </Fact>
        <Fact label={c.credentialsUpdated}>{formatDateTime(channel.credentialsUpdatedAt)}</Fact>
      </dl>
      <h3 className={styles.subTitle}>{c.webhookTitle}</h3>
      <dl className={channelStyles.facts}>
        <Fact label={c.webhookUrl}>
          <span className={styles.urlRow}>
            <span className={styles.url}>{channel.webhook.url}</span>
          </span>
        </Fact>
        <Fact label={c.statusTitle}>
          {channel.webhook.registeredAt ? (
            <span className={styles.ok}>
              <Icon icon={CheckCircle2} size={16} />
              {c.webhookRegistered} · {formatDateTime(channel.webhook.registeredAt)}
            </span>
          ) : (
            <span className={styles.bad}>
              <Icon icon={CircleAlert} size={16} />
              {c.webhookNotRegistered}
            </span>
          )}
        </Fact>
      </dl>
      {channel.webhook.warning ? <Notice tone="warning">{channel.webhook.warning}</Notice> : null}
      {renew.isError ? (
        <Notice tone="danger" role="alert">
          {isApiError(renew.error) ? renew.error.message : t.api.network}
        </Notice>
      ) : null}
      <div className={styles.actionsStart}>
        <Button loading={renew.isPending} onClick={() => renew.mutate()}>
          {renew.isPending ? c.registeringWebhook : c.registerWebhook}
        </Button>
      </div>
    </section>
  );
}

function EmailFacts({ channel }: { channel: EmailChannel }) {
  const mailbox = channel.mailbox;
  return (
    <section className={styles.card} aria-labelledby="channel-koneksi">
      <h2 id="channel-koneksi" className={styles.cardTitle}>
        {c.connectionTitle}
      </h2>
      <dl className={channelStyles.facts}>
        <Fact label={c.emailAddress}>{channel.emailAddress}</Fact>
        <Fact label={c.fromName}>{channel.fromName}</Fact>
        <Fact label={c.imapTitle}>
          <span className={channelStyles.mono}>
            {channel.imap.host}:{channel.imap.port}
          </span>{' '}
          · {c.securityLabels[channel.imap.security]} · {channel.imap.username} ·{' '}
          {channel.imap.folder}
        </Fact>
        <Fact label={c.password}>
          <span className={channelStyles.mono}>{channel.imap.passwordHint ?? c.stored}</span>
        </Fact>
        <Fact label={c.smtpTitle}>
          {channel.smtp.mode === 'system' ? (
            c.smtpSystem
          ) : (
            <>
              <span className={channelStyles.mono}>
                {channel.smtp.host}:{channel.smtp.port}
              </span>{' '}
              · {c.securityLabels[channel.smtp.security]} · {channel.smtp.username}
            </>
          )}
        </Fact>
        <Fact label={c.pollInterval}>{channel.pollIntervalMinutes}</Fact>
        <Fact label={c.senderVerificationTitle}>
          {channel.senderVerification.trustedAuthServIds.join(', ') || '—'}
          <span className={styles.factNote}>
            {channel.senderVerification.isDefault
              ? c.senderVerificationDefault
              : c.senderVerificationCustom}
          </span>
        </Fact>
      </dl>
      <h3 className={styles.subTitle}>{c.mailboxTitle}</h3>
      <dl className={channelStyles.facts}>
        <Fact label={c.lastPolled}>
          {mailbox.lastPolledAt ? (
            <span className={mailbox.lastPollOk === false ? styles.bad : styles.ok}>
              <Icon icon={mailbox.lastPollOk === false ? CircleAlert : CheckCircle2} size={16} />
              {mailbox.lastPollOk === false ? c.pollFailed : c.pollOk} ·{' '}
              {formatDateTime(mailbox.lastPolledAt)}
            </span>
          ) : (
            c.neverPolled
          )}
        </Fact>
        <Fact label={c.skipped}>
          {mailbox.skippedMessages.toLocaleString('id-ID')}
          <span className={styles.factNote}>{c.skippedHint}</span>
        </Fact>
      </dl>
      {mailbox.lastPollOk === false && mailbox.lastPollMessage ? (
        <Notice tone="danger">{mailbox.lastPollMessage}</Notice>
      ) : null}
    </section>
  );
}

function MetaFacts({
  channel,
  onDone,
}: {
  channel: MetaSocialChannel;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const webhook = useQuery({
    queryKey: connectionKeys.webhook(channel.id),
    queryFn: ({ signal }) => endpoints.connections.webhook(channel.id, signal),
  });
  const rotate = useMutation({
    mutationFn: () => endpoints.connections.renewWebhook(channel.id),
    onSuccess: ({ channel: next, webhook: info }) => {
      storeConnection(queryClient, next);
      if (info) queryClient.setQueryData(connectionKeys.webhook(channel.id), info);
      else void queryClient.invalidateQueries({ queryKey: connectionKeys.webhook(channel.id) });
      onDone(c.verifyTokenRotated);
    },
  });
  return (
    <section className={styles.card} aria-labelledby="channel-koneksi">
      <h2 id="channel-koneksi" className={styles.cardTitle}>
        {c.connectionTitle}
      </h2>
      <dl className={channelStyles.facts}>
        <Fact label={c.pageId}>
          <span className={channelStyles.mono}>{channel.pageId}</span>
        </Fact>
        {channel.instagramAccountId ? (
          <Fact label={c.instagramAccountId}>
            <span className={channelStyles.mono}>{channel.instagramAccountId}</span>
          </Fact>
        ) : null}
        <Fact label={c.pageAccessToken}>
          <span className={channelStyles.mono}>{channel.pageAccessTokenHint ?? c.stored}</span>
        </Fact>
        <Fact label={c.appSecret}>
          <span className={channelStyles.mono}>{channel.appSecretHint ?? c.stored}</span>
        </Fact>
      </dl>
      <h3 className={styles.subTitle}>{c.webhookTitle}</h3>
      <dl className={channelStyles.facts}>
        <Fact label={c.webhookUrl}>
          <span className={styles.urlRow}>
            <span className={styles.url}>{channel.webhookUrl}</span>
            <CopyButton
              text={channel.webhookUrl}
              label={c.copy}
              ariaLabel={c.copyLabel(c.webhookUrl)}
              copiedLabel={c.copied}
              announcement={c.copiedAnnouncement(c.webhookUrl)}
              variant="ghost"
            />
          </span>
        </Fact>
        <Fact label={c.verifyToken}>
          {webhook.data ? (
            <span className={styles.urlRow}>
              <span className={styles.url}>{webhook.data.verifyToken}</span>
              <CopyButton
                text={webhook.data.verifyToken}
                label={c.copy}
                ariaLabel={c.copyLabel(c.verifyToken)}
                copiedLabel={c.copied}
                announcement={c.copiedAnnouncement(c.verifyToken)}
                variant="ghost"
              />
            </span>
          ) : webhook.isPending ? (
            <Skeleton className={styles.skeletonLine} />
          ) : (
            '—'
          )}
        </Fact>
        {webhook.data ? (
          <Fact label={c.subscribeFields}>
            <span className={channelStyles.mono}>{webhook.data.subscribeFields.join(', ')}</span>
          </Fact>
        ) : null}
      </dl>
      {webhook.data?.warning ? <Notice tone="warning">{webhook.data.warning}</Notice> : null}
      <div className={styles.actionsStart}>
        <Button loading={rotate.isPending} onClick={() => rotate.mutate()}>
          {rotate.isPending ? c.rotatingVerifyToken : c.rotateVerifyToken}
        </Button>
      </div>
    </section>
  );
}

function TestCard({ channel }: { channel: ConnectionChannel }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useLock();

  const run = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await endpoints.connections.test(channel.id);
      setResult(next);
      void queryClient.invalidateQueries({ queryKey: connectionKeys.detail(channel.id) });
      void queryClient.invalidateQueries({ queryKey: connectionKeys.list });
    } catch (caught) {
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  const last = result ?? channel.lastTest;
  return (
    <section className={styles.card} aria-labelledby="channel-tes">
      <div>
        <h2 id="channel-tes" className={styles.cardTitle}>
          {c.testTitle}
        </h2>
        <p className={styles.hint}>{c.testHint}</p>
      </div>
      <dl className={channelStyles.facts}>
        <Fact label={c.lastTest}>
          {last ? (
            <span className={last.ok ? styles.ok : styles.bad}>
              <Icon icon={last.ok ? CheckCircle2 : CircleAlert} size={16} />
              {formatDateTime(last.testedAt)}
            </span>
          ) : (
            c.neverTested
          )}
        </Fact>
      </dl>
      {last && !last.ok ? (
        <Notice tone="danger" role={result ? 'alert' : undefined}>
          {last.message || CONNECTION_TEST_MESSAGES[last.code]}
        </Notice>
      ) : result?.ok ? (
        <Notice tone="success" role="status">
          {result.message}
        </Notice>
      ) : null}
      {result && result.checks.length > 0 ? (
        <ul className={styles.checks}>
          {result.checks.map((check) => (
            <li key={check.name} className={styles.check}>
              <span className={check.ok ? styles.ok : styles.bad}>
                <Icon icon={check.ok ? CheckCircle2 : CircleAlert} size={16} />
                {c.checkLabels[check.name] ?? check.name}
              </span>
              {!check.ok ? <span className={styles.checkMessage}>{check.message}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <FormErrorNotice error={error} lock={lock} lockedTitle={c.testLockedTitle} /> : null}
      <div className={styles.actionsStart}>
        <Button
          variant="primary"
          loading={pending}
          disabled={lock.locked}
          onClick={() => void run()}
        >
          {pending ? c.testing : c.test}
        </Button>
      </div>
    </section>
  );
}

function SettingsCard({
  channel,
  onDone,
}: {
  channel: ConnectionChannel;
  onDone: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  return (
    <section className={styles.card} aria-labelledby="channel-pengaturan">
      <div>
        <h2 id="channel-pengaturan" className={styles.cardTitle}>
          {c.settingsTitle}
        </h2>
        <p className={styles.hint}>
          {c.credentialsUpdated}: {formatDateTime(channel.credentialsUpdatedAt)}
        </p>
      </div>
      <div className={styles.actionsStart}>
        <Button ref={openRef} onClick={() => setEditing(true)}>
          {c.edit}
        </Button>
      </div>
      {editing ? (
        <EditDialog
          channel={channel}
          onClose={() => {
            setEditing(false);
            requestAnimationFrame(() => openRef.current?.focus());
          }}
          onSaved={() => {
            setEditing(false);
            onDone(c.saved);
          }}
        />
      ) : null}
    </section>
  );
}

function EditDialog({
  channel,
  onClose,
  onSaved,
}: {
  channel: ConnectionChannel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const form = useConnectionForm(channel.type, channel);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const send = async (confirmation?: IdentityConfirmation) => {
    const built = form.build();
    if (!built.ok) return 'invalid' as const;
    if (built.empty) {
      onClose();
      return 'done' as const;
    }
    const { channel: next } = await endpoints.connections.update(channel.id, {
      ...built.update,
      ...(confirmation ? { confirmation } : {}),
    });
    form.clearSecrets();
    storeConnection(queryClient, next);
    onSaved();
    return 'done' as const;
  };

  const handle = (caught: unknown) => {
    if (isApiError(caught) && caught.details.length > 0) {
      const fieldErrors = apiFieldErrors(caught.details);
      if (Object.keys(fieldErrors).length > 0) form.setErrors(fieldErrors);
    }
    setError(caught);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const built = form.build();
    if (!built.ok) return;
    if (built.sensitive) {
      setConfirming(true);
      return;
    }
    setPending(true);
    try {
      await send();
    } catch (caught) {
      if (needsConfirmation(caught)) setConfirming(true);
      else handle(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Dialog open={!confirming} title={c.editTitle} onRequestClose={onClose}>
        <form className={styles.dialogForm} onSubmit={(event) => void submit(event)} noValidate>
          <ConnectionFields form={form} disabled={pending} />
          {error ? (
            <Notice tone="danger" role="alert">
              {isApiError(error) ? error.message : t.api.network}
            </Notice>
          ) : null}
          <DialogActions sticky>
            <Button onClick={onClose} disabled={pending}>
              {c.cancel}
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {pending ? c.saving : c.save}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <IdentityDialog
        open={confirming}
        title={c.editConfirmTitle}
        body={c.editConfirmBody}
        confirmLabel={c.save}
        pendingLabel={c.saving}
        requireCode
        onCancel={() => setConfirming(false)}
        onConfirm={async (confirmation) => {
          try {
            await send(confirmation);
            setConfirming(false);
          } catch (caught) {
            if (isConfirmationError(caught)) throw caught;
            setConfirming(false);
            handle(caught);
          }
        }}
      />
    </>
  );
}

function StatusCard({
  channel,
  onDone,
}: {
  channel: ConnectionChannel;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [disabling, setDisabling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const toggle = useMutation({
    mutationFn: (enable: boolean) =>
      enable ? endpoints.connections.enable(channel.id) : endpoints.connections.disable(channel.id),
    onSuccess: ({ channel: next }, enable) => {
      storeConnection(queryClient, next);
      onDone(enable ? c.enabledDone : c.disabledDone);
    },
  });
  const isMeta = channel.type === 'messenger' || channel.type === 'instagram';
  const enableBlocked = isMeta && !channel.enabled && channel.lastTest?.ok !== true;

  const remove = async (confirmation: IdentityConfirmation) => {
    await endpoints.connections.remove(channel.id, confirmation);
    setDeleting(false);
    queryClient.removeQueries({ queryKey: connectionKeys.detail(channel.id) });
    void queryClient.invalidateQueries({ queryKey: connectionKeys.list });
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'channels'] });
    void navigate({
      to: '/pengaturan/channel',
      state: (previous) => ({ ...previous, deletedChannel: channel.name }),
    });
  };

  return (
    <section className={styles.card} aria-labelledby="channel-status">
      <h2 id="channel-status" className={styles.cardTitle}>
        {c.statusTitle}
      </h2>
      {toggle.isError ? (
        <Notice tone="danger" role="alert">
          {isApiError(toggle.error) ? toggle.error.message : t.api.network}
        </Notice>
      ) : null}
      {enableBlocked ? <p className={styles.hint}>{c.enableBlocked}</p> : null}
      <div className={styles.actionsSplit}>
        {channel.enabled ? (
          <Button onClick={() => setDisabling(true)} loading={toggle.isPending}>
            {c.disable}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={enableBlocked}
            loading={toggle.isPending}
            onClick={() => toggle.mutate(true)}
          >
            {c.enable}
          </Button>
        )}
        <Button ref={deleteRef} className={styles.dangerText} onClick={() => setDeleting(true)}>
          <Icon icon={Trash2} size={16} />
          {c.delete}
        </Button>
      </div>
      <ConfirmDialog
        open={disabling}
        title={c.disableTitle}
        body={c.disableBody}
        cancelLabel={c.cancel}
        confirmLabel={c.disable}
        confirmVariant="danger"
        onCancel={() => setDisabling(false)}
        onConfirm={() => {
          setDisabling(false);
          toggle.mutate(false);
        }}
      />
      <IdentityDialog
        open={deleting}
        title={c.deleteTitle}
        body={c.deleteBody}
        confirmLabel={c.deleteConfirm}
        pendingLabel={c.deleting}
        variant="danger"
        requireCode
        onConfirm={remove}
        onCancel={() => setDeleting(false)}
        returnFocusRef={deleteRef}
      />
    </section>
  );
}
