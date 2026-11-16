import type { IdentityConfirmation, OutgoingWebhook } from '@balesin/shared';
import { OUTGOING_WEBHOOK_EVENT_LABELS } from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, History, Pencil, Plus, Send, Webhook } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { TextAreaField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTime, formatDateTimeInline } from '../../lib/format';
import { apiFieldErrors, type FieldErrors } from '../../lib/form';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { integrationKeys } from './integration-queries';
import styles from './Integrations.module.css';
import { SecretDialog } from './SecretDialog';
import { WebhookDeliveriesDialog } from './WebhookDeliveriesDialog';
import { WebhookFormDialog } from './WebhookFormDialog';

const copy = t.webhooks;

const secretCopy = {
  copy: copy.copy,
  copied: copy.copied,
  announcement: copy.copiedAnnouncement,
  done: copy.done,
};

/**
 * Pengaturan → Webhook (`integrations.manage`): daftar + status, tambah (konfirmasi → rahasia SEKALI),
 * ubah, aktif/nonaktif, rahasia baru (tumpang tindih 24 jam), event tes, riwayat + kirim ulang,
 * dan allowlist jaringan privat.
 */
export function WebhooksPage() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: integrationKeys.webhooks,
    queryFn: ({ signal }) => endpoints.webhooks.list(signal),
  });
  const [editing, setEditing] = useState<OutgoingWebhook | 'new' | null>(null);
  const [history, setHistory] = useState<OutgoingWebhook | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: integrationKeys.webhooks });

  const addButton = (
    <Button ref={addRef} variant="primary" onClick={() => setEditing('new')}>
      <Icon icon={Plus} size={16} />
      {copy.create}
    </Button>
  );

  return (
    <Page>
      <div className={styles.content}>
        <p className={styles.intro}>{copy.intro}</p>
        <section className={styles.card} aria-labelledby="webhook-daftar">
          <div className={styles.cardHeadRow}>
            <h2 id="webhook-daftar" className={styles.cardTitle}>
              {copy.listTitle}
            </h2>
            {list.data && list.data.webhooks.length > 0 ? addButton : null}
          </div>
          {notice ? (
            <Notice tone="success" role="status">
              {notice}
            </Notice>
          ) : null}
          {list.data ? (
            list.data.webhooks.length === 0 ? (
              <EmptyState
                compact
                title={copy.emptyTitle}
                body={copy.emptyBody}
                actions={addButton}
              />
            ) : (
              <ul className={styles.list}>
                {list.data.webhooks.map((webhook) => (
                  <WebhookRow
                    key={webhook.id}
                    webhook={webhook}
                    onEdit={() => setEditing(webhook)}
                    onHistory={() => setHistory(webhook)}
                    onSecret={setSecret}
                    onChanged={(text) => {
                      setNotice(text);
                      refresh();
                    }}
                  />
                ))}
              </ul>
            )
          ) : list.isPending ? (
            <SkeletonRegion className={styles.list}>
              {[0, 1].map((index) => (
                <div key={index} className={styles.item}>
                  <Skeleton className={styles.skeletonTitle} />
                  <Skeleton className={styles.skeletonLine} />
                </div>
              ))}
            </SkeletonRegion>
          ) : (
            <Notice
              tone="danger"
              role="alert"
              title={copy.loadFailedTitle}
              actions={
                <Button onClick={() => void list.refetch()} loading={list.isFetching}>
                  {t.common.retry}
                </Button>
              }
            >
              {isApiError(list.error) ? list.error.message : t.api.network}
            </Notice>
          )}
        </section>
        <PrivateNetworkCard />
      </div>

      {editing ? (
        <WebhookFormDialog
          webhook={editing === 'new' ? null : editing}
          returnFocusRef={addRef}
          onClose={() => setEditing(null)}
          onCreated={(created) => {
            setEditing(null);
            setNotice(copy.created);
            setSecret(created);
            refresh();
          }}
          onSaved={() => {
            setEditing(null);
            setNotice(copy.saved);
            refresh();
          }}
        />
      ) : null}
      {history ? (
        <WebhookDeliveriesDialog webhook={history} onClose={() => setHistory(null)} />
      ) : null}
      <SecretDialog
        secret={secret}
        title={copy.secretTitle}
        body={copy.secretBody}
        label={copy.secretLabel}
        copy={secretCopy}
        onClose={() => setSecret(null)}
      />
    </Page>
  );
}

function WebhookRow({
  webhook,
  onEdit,
  onHistory,
  onSecret,
  onChanged,
}: {
  webhook: OutgoingWebhook;
  onEdit: () => void;
  onHistory: () => void;
  onSecret: (secret: string) => void;
  onChanged: (notice: string) => void;
}) {
  const [busy, setBusy] = useState<'test' | 'toggle' | 'remove' | null>(null);
  const [asking, setAsking] = useState<'rotate' | 'remove' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const menuRef = useRef<HTMLButtonElement>(null);

  const run = async (kind: 'test' | 'toggle' | 'remove', action: () => Promise<string | null>) => {
    setBusy(kind);
    setMessage(null);
    try {
      const text = await action();
      if (text) setMessage({ tone: 'success', text });
    } catch (caught) {
      setMessage({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    } finally {
      setBusy(null);
    }
  };

  const status = webhook.enabled
    ? { tone: 'success' as const, label: copy.statusActive }
    : webhook.disabledReason === 'auto_failures'
      ? { tone: 'danger' as const, label: copy.statusAuto }
      : { tone: 'neutral' as const, label: copy.statusPaused };

  const facts = [
    copy.events(webhook.events.length),
    webhook.lastDeliveryAt
      ? copy.lastDelivery(formatDateTimeInline(webhook.lastDeliveryAt))
      : copy.neverDelivered,
    copy.secretRotated(formatDateTimeInline(webhook.secretRotatedAt)),
  ];

  const rotate = async (confirmation: IdentityConfirmation) => {
    try {
      const response = await endpoints.webhooks.rotateSecret(webhook.id, confirmation);
      setAsking(null);
      onSecret(response.secret);
      onChanged(copy.saved);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setAsking(null);
      setMessage({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    }
  };

  return (
    <li className={styles.item} data-enabled={webhook.enabled ? '' : undefined}>
      <div className={styles.itemHead}>
        <Icon icon={Webhook} size={20} className={styles.itemIcon} />
        <div className={styles.itemTitleBox}>
          <code className={styles.url} dir="ltr">
            {webhook.url}
          </code>
          {webhook.description ? (
            <p className={styles.itemSub} dir="auto">
              {webhook.description}
            </p>
          ) : null}
        </div>
        <StatusBadge tone={status.tone} label={status.label} />
      </div>
      {webhook.disabledReason === 'auto_failures' && !webhook.enabled ? (
        <Notice tone="danger">{copy.autoDisabled(webhook.consecutiveFailures)}</Notice>
      ) : webhook.consecutiveFailures > 0 ? (
        <p className={styles.warningText}>{copy.failing(webhook.consecutiveFailures)}</p>
      ) : null}
      <ul className={styles.chips} aria-label={copy.eventsLabel}>
        {webhook.events.map((event) => (
          <li key={event} className={styles.chip} title={event}>
            {OUTGOING_WEBHOOK_EVENT_LABELS[event]}
          </li>
        ))}
      </ul>
      <p className={styles.meta}>{facts.join(' · ')}</p>
      {webhook.previousSecretExpiresAt ? (
        <p className={styles.meta}>
          {copy.previousSecret(formatDateTime(webhook.previousSecretExpiresAt))}
        </p>
      ) : null}
      {message ? (
        <Notice tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>
          {message.text}
        </Notice>
      ) : null}
      <div className={styles.itemActions}>
        <Button
          loading={busy === 'test'}
          disabled={!webhook.enabled}
          onClick={() =>
            void run('test', async () => {
              await endpoints.webhooks.test(webhook.id);
              return copy.testSent;
            })
          }
        >
          {busy === 'test' ? null : <Icon icon={Send} size={16} />}
          {copy.test}
        </Button>
        <Button onClick={onHistory}>
          <Icon icon={History} size={16} />
          {copy.history}
        </Button>
        <Button onClick={onEdit}>
          <Icon icon={Pencil} size={16} />
          {copy.edit}
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button ref={menuRef} aria-label={copy.actions} className={styles.menuTrigger}>
              <Icon icon={Ellipsis} size={16} />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className={styles.menu}
              align="end"
              sideOffset={4}
              collisionPadding={8}
            >
              <DropdownMenu.Item
                className={styles.menuItem}
                onSelect={() =>
                  void run('toggle', async () => {
                    await endpoints.webhooks.update(webhook.id, { enabled: !webhook.enabled });
                    onChanged(webhook.enabled ? copy.disabled : copy.enabled);
                    return null;
                  })
                }
              >
                {webhook.enabled ? copy.disable : copy.enable}
              </DropdownMenu.Item>
              <DropdownMenu.Item className={styles.menuItem} onSelect={() => setAsking('rotate')}>
                {copy.rotate}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.menuItemDanger}
                onSelect={() => setAsking('remove')}
              >
                {copy.remove}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <ConfirmDialog
        open={asking === 'remove'}
        title={copy.removeTitle}
        body={copy.removeBody}
        cancelLabel={copy.cancel}
        confirmLabel={copy.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          setAsking(null);
          void run('remove', async () => {
            await endpoints.webhooks.remove(webhook.id);
            onChanged(copy.removed);
            return null;
          });
        }}
      />
      <IdentityDialog
        open={asking === 'rotate'}
        title={copy.confirmRotateTitle}
        body={copy.confirmRotateBody}
        confirmLabel={copy.rotate}
        pendingLabel={copy.saving}
        variant="primary"
        requireCode
        returnFocusRef={menuRef}
        onCancel={() => setAsking(null)}
        onConfirm={rotate}
      />
    </li>
  );
}

function PrivateNetworkCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: integrationKeys.privateNetwork,
    queryFn: ({ signal }) => endpoints.webhooks.privateNetwork(signal),
  });
  return (
    <section className={styles.card} aria-labelledby="webhook-jaringan-privat">
      <div className={styles.cardHead}>
        <h2 id="webhook-jaringan-privat" className={styles.cardTitle}>
          {copy.privateTitle}
        </h2>
        <p className={styles.hint}>{copy.privateHint}</p>
      </div>
      {settings.data ? (
        <PrivateNetworkForm
          cidrs={settings.data.settings.cidrs}
          onSaved={(next) => queryClient.setQueryData(integrationKeys.privateNetwork, next)}
        />
      ) : settings.isPending ? (
        <Skeleton className={styles.skeletonLine} />
      ) : (
        <Notice tone="danger" role="alert">
          {isApiError(settings.error) ? settings.error.message : t.api.network}
        </Notice>
      )}
    </section>
  );
}

function PrivateNetworkForm({
  cidrs,
  onSaved,
}: {
  cidrs: string[];
  onSaved: (response: { settings: { cidrs: string[] } }) => void;
}) {
  const [text, setText] = useState(cidrs.join('\n'));
  const [pending, setPending] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    setFailure(null);
    setErrors({});
    setPending(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  };

  const save = async (confirmation: IdentityConfirmation) => {
    if (!pending) return;
    try {
      const response = await endpoints.webhooks.updatePrivateNetwork(pending, confirmation);
      setPending(null);
      setText(response.settings.cidrs.join('\n'));
      onSaved(response);
      setSaved(true);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setPending(null);
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        const fieldErrors = apiFieldErrors(caught.details);
        const first = Object.entries(fieldErrors).find(([key]) => key.startsWith('cidrs'));
        setErrors({ cidrs: first?.[1] ?? caught.message });
      } else {
        setFailure(caught);
      }
    }
  };

  return (
    <>
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextAreaField
          label={copy.privateLabel}
          hint={copy.privateEmpty}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSaved(false);
          }}
          error={errors.cidrs}
          rows={3}
          spellCheck={false}
          className={styles.monoField}
        />
        {saved ? (
          <Notice tone="success" role="status">
            {copy.privateSaved}
          </Notice>
        ) : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <div className={styles.itemActions}>
          <Button ref={submitRef} type="submit">
            {copy.privateSave}
          </Button>
        </div>
      </form>
      <IdentityDialog
        open={pending !== null}
        title={copy.privateConfirmTitle}
        body={copy.privateConfirmBody}
        confirmLabel={copy.privateSave}
        pendingLabel={copy.saving}
        variant="primary"
        requireCode
        returnFocusRef={submitRef}
        onCancel={() => setPending(null)}
        onConfirm={save}
      />
    </>
  );
}
