import {
  API_DOCS_ROUTES,
  API_KEY_SCOPE_LABELS,
  apiKeyHasEmailScope,
  type ApiKey,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, ExternalLink, KeyRound, Mails, Plus } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTime, formatDateTimeInline } from '../../lib/format';
import { ApiKeyCreateDialog } from './ApiKeyCreateDialog';
import { ApiKeyEmailDialog } from './ApiKeyEmailDialog';
import { integrationKeys } from './integration-queries';
import styles from './Integrations.module.css';
import { SecretDialog } from './SecretDialog';

const copy = t.apiKeys;

const STATUS_TONE: Record<ApiKey['status'], StatusTone> = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
};

/**
 * Pengaturan → API key (`api_keys.manage`): daftar, buat (konfirmasi identitas → kunci utuh tampil
 * SEKALI), cabut, dan saklar halaman dokumentasi `/api/docs`.
 */
export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: integrationKeys.apiKeys,
    queryFn: ({ signal }) => endpoints.apiKeys.list(signal),
  });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);

  return (
    <Page>
      <div className={styles.content}>
        <p className={styles.intro}>{copy.intro}</p>
        <Notice tone="warning" title={copy.scopeWarningTitle}>
          {copy.scopeWarning}
        </Notice>

        <section className={styles.card} aria-labelledby="api-key-daftar">
          <div className={styles.cardHeadRow}>
            <h2 id="api-key-daftar" className={styles.cardTitle}>
              {copy.listTitle}
            </h2>
            {list.data && list.data.apiKeys.length > 0 ? (
              <Button ref={createRef} variant="primary" onClick={() => setCreating(true)}>
                <Icon icon={Plus} size={16} />
                {copy.create}
              </Button>
            ) : null}
          </div>
          {notice ? (
            <Notice tone="success" role="status">
              {notice}
            </Notice>
          ) : null}
          {list.data ? (
            list.data.apiKeys.length === 0 ? (
              <EmptyState
                compact
                title={copy.emptyTitle}
                body={copy.emptyBody}
                actions={
                  <Button ref={createRef} variant="primary" onClick={() => setCreating(true)}>
                    <Icon icon={Plus} size={16} />
                    {copy.create}
                  </Button>
                }
              />
            ) : (
              <KeyGroups
                apiKeys={list.data.apiKeys}
                onRevoked={(revoked) => {
                  setNotice(copy.revoked(revoked.name));
                  void queryClient.invalidateQueries({ queryKey: integrationKeys.apiKeys });
                }}
                onUpdated={(updated) => {
                  setNotice(copy.emailSaved(updated.name));
                  queryClient.setQueryData(
                    integrationKeys.apiKeys,
                    (current: { apiKeys: ApiKey[] } | undefined) =>
                      current
                        ? {
                            apiKeys: current.apiKeys.map((item) =>
                              item.id === updated.id ? updated : item,
                            ),
                          }
                        : current,
                  );
                }}
              />
            )
          ) : list.isPending ? (
            <ListSkeleton />
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

        {list.data?.apiKeys.some((apiKey) => apiKeyHasEmailScope(apiKey.scopes)) ? (
          <EmailOutboundCard />
        ) : null}
        <DocsCard />
      </div>

      {creating ? (
        <ApiKeyCreateDialog
          returnFocusRef={createRef}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setNotice(null);
            setSecret(created.secret);
            void queryClient.invalidateQueries({ queryKey: integrationKeys.apiKeys });
          }}
        />
      ) : null}
      <SecretDialog
        secret={secret}
        title={copy.secretTitle}
        body={copy.secretBody}
        label={copy.secretLabel}
        copy={{
          copy: copy.copy,
          copied: copy.copied,
          announcement: copy.copiedAnnouncement,
          done: copy.done,
        }}
        onClose={() => {
          setSecret(null);
          requestAnimationFrame(() => createRef.current?.focus());
        }}
      />
    </Page>
  );
}

/** Key aktif di atas; yang dicabut/kedaluwarsa dilipat supaya key aktif menonjol. */
function KeyGroups({
  apiKeys,
  onRevoked,
  onUpdated,
}: {
  apiKeys: ApiKey[];
  onRevoked: (apiKey: ApiKey) => void;
  onUpdated: (apiKey: ApiKey) => void;
}) {
  const active = apiKeys.filter((apiKey) => apiKey.status === 'active');
  const inactive = apiKeys.filter((apiKey) => apiKey.status !== 'active');
  // Dikendalikan state (bukan atribut `open` langsung): render ulang setelah daftar dimuat ulang
  // tidak boleh menutup lipatan yang baru dibuka pengguna.
  const [open, setOpen] = useState(active.length === 0);
  return (
    <>
      {active.length > 0 ? (
        <ul className={styles.list}>
          {active.map((apiKey) => (
            <ApiKeyRow
              key={apiKey.id}
              apiKey={apiKey}
              onRevoked={onRevoked}
              onUpdated={onUpdated}
            />
          ))}
        </ul>
      ) : null}
      {inactive.length > 0 ? (
        <details
          className={styles.inactive}
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className={styles.inactiveSummary}>
            <Icon icon={ChevronRight} size={16} className={styles.inactiveChevron} />
            {copy.inactiveTitle(inactive.length)}
          </summary>
          <ul className={styles.list}>
            {inactive.map((apiKey) => (
              <ApiKeyRow
                key={apiKey.id}
                apiKey={apiKey}
                onRevoked={onRevoked}
                onUpdated={onUpdated}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function ApiKeyRow({
  apiKey,
  onRevoked,
  onUpdated,
}: {
  apiKey: ApiKey;
  onRevoked: (apiKey: ApiKey) => void;
  onUpdated: (apiKey: ApiKey) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const emailRef = useRef<HTMLButtonElement>(null);
  const hasEmail = apiKeyHasEmailScope(apiKey.scopes);
  const [failure, setFailure] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const revokeRef = useRef<HTMLButtonElement>(null);

  const revoke = async () => {
    setPending(true);
    setFailure(null);
    try {
      const { apiKey: updated } = await endpoints.apiKeys.revoke(apiKey.id);
      setConfirming(false);
      onRevoked(updated);
    } catch (caught) {
      setConfirming(false);
      setFailure(caught);
    } finally {
      setPending(false);
    }
  };

  const facts = [
    apiKey.createdBy
      ? copy.createdBy(apiKey.createdBy.name, formatDateTimeInline(apiKey.createdAt))
      : copy.createdAt(formatDateTimeInline(apiKey.createdAt)),
    apiKey.lastUsedAt ? copy.lastUsed(formatDateTimeInline(apiKey.lastUsedAt)) : copy.neverUsed,
    apiKey.revokedAt
      ? copy.revokedAt(formatDateTimeInline(apiKey.revokedAt))
      : apiKey.expiresAt
        ? copy.expires(formatDateTime(apiKey.expiresAt))
        : copy.noExpiry,
    copy.dailyLimit(apiKey.dailySendLimit),
    apiKey.allowedIps && apiKey.allowedIps.length > 0
      ? copy.allowedIps(apiKey.allowedIps.join(', '))
      : copy.anyIp,
  ];

  return (
    <li className={styles.item} data-status={apiKey.status}>
      <div className={styles.itemHead}>
        <Icon icon={KeyRound} size={20} className={styles.itemIcon} />
        <div className={styles.itemTitleBox}>
          <p className={styles.itemTitle} dir="auto">
            {apiKey.name}
          </p>
          <code className={styles.prefix}>{apiKey.displayPrefix}…</code>
        </div>
        <StatusBadge
          tone={STATUS_TONE[apiKey.status]}
          label={copy.status[apiKey.status]}
          className={styles.itemStatus}
        />
      </div>
      <ul className={styles.chips} aria-label={copy.scopesLabel}>
        {apiKey.scopes.map((scope) => (
          <li key={scope} className={styles.chip} title={API_KEY_SCOPE_LABELS[scope]}>
            {copy.scopeShort[scope] ?? API_KEY_SCOPE_LABELS[scope]}
          </li>
        ))}
      </ul>
      <p className={styles.meta}>
        {facts.map((fact, index) => (
          <Fragment key={fact}>
            {index > 0 ? ' · ' : null}
            <span className={styles.fact}>{fact}</span>
          </Fragment>
        ))}
      </p>
      {hasEmail ? <EmailAccess apiKey={apiKey} /> : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : null}
      {apiKey.status === 'active' || hasEmail ? (
        <div className={styles.itemActions}>
          {hasEmail && apiKey.status === 'active' ? (
            <Button
              ref={emailRef}
              aria-label={copy.emailEditLabel(apiKey.name)}
              onClick={() => setEditingEmail(true)}
            >
              {copy.emailEdit}
            </Button>
          ) : null}
          {hasEmail ? (
            <Button asChild>
              <Link
                to="/pengaturan/api-key/email-terkirim"
                search={{ apiKeyId: apiKey.id }}
                aria-label={copy.emailHistoryLabel(apiKey.name)}
              >
                <Icon icon={Mails} size={16} />
                {copy.emailHistory}
              </Link>
            </Button>
          ) : null}
          {apiKey.status === 'active' ? (
            <Button
              ref={revokeRef}
              className={styles.dangerText}
              aria-label={copy.revoke(apiKey.name)}
              onClick={() => setConfirming(true)}
            >
              {copy.revokeShort}
            </Button>
          ) : null}
        </div>
      ) : null}
      {editingEmail ? (
        <ApiKeyEmailDialog
          apiKey={apiKey}
          returnFocusRef={emailRef}
          onClose={() => {
            setEditingEmail(false);
            requestAnimationFrame(() => emailRef.current?.focus());
          }}
          onSaved={(updated) => {
            setEditingEmail(false);
            onUpdated(updated);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={copy.revokeTitle(apiKey.name)}
        body={copy.revokeBody}
        cancelLabel={copy.cancel}
        confirmLabel={copy.revokeConfirm}
        confirmVariant="danger"
        onCancel={() => {
          setConfirming(false);
          requestAnimationFrame(() => revokeRef.current?.focus());
        }}
        onConfirm={() => {
          if (!pending) void revoke();
        }}
      />
    </li>
  );
}

/** Pengirim email yang boleh dipakai key + allowlist host URL lampiran (tahap 9.1). */
function EmailAccess({ apiKey }: { apiKey: ApiKey }) {
  const senders = apiKey.emailSenders.map((sender) => `${sender.name} (${sender.address})`);
  const canSend = apiKey.scopes.includes('email:send');
  return (
    <ul className={styles.emailAccess}>
      <li className={senders.length === 0 ? styles.warningText : undefined}>
        {senders.length > 0 ? copy.emailSenders(senders.join(', ')) : copy.emailSendersNone}
      </li>
      {canSend ? (
        <li>
          {apiKey.emailAttachmentHosts.length > 0
            ? copy.emailHosts(apiKey.emailAttachmentHosts.join(', '))
            : copy.emailHostsNone}
        </li>
      ) : null}
    </ul>
  );
}

function EmailOutboundCard() {
  return (
    <section className={styles.card} aria-labelledby="api-email-terkirim">
      <div className={styles.cardHeadRow}>
        <div className={styles.cardHead}>
          <h2 id="api-email-terkirim" className={styles.cardTitle}>
            {copy.outboundTitle}
          </h2>
          <p className={styles.hint}>{copy.outboundHint}</p>
        </div>
        <Button asChild>
          <Link to="/pengaturan/api-key/email-terkirim" search={{}}>
            <Icon icon={Mails} size={16} />
            {copy.outboundOpen}
          </Link>
        </Button>
      </div>
    </section>
  );
}

function DocsCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: integrationKeys.apiSettings,
    queryFn: ({ signal }) => endpoints.apiKeys.settings(signal),
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const enabled = settings.data?.settings.docsEnabled ?? false;

  const toggle = async (next: boolean) => {
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await endpoints.apiKeys.updateSettings({ docsEnabled: next });
      queryClient.setQueryData(integrationKeys.apiSettings, response);
      setSaved(true);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="api-dokumentasi">
      <div className={styles.cardHead}>
        <h2 id="api-dokumentasi" className={styles.cardTitle}>
          {copy.docsTitle}
        </h2>
        <p className={styles.hint}>{copy.docsHint}</p>
      </div>
      {settings.data ? (
        <>
          <Checkbox
            checked={enabled}
            disabled={saving}
            onChange={(event) => void toggle(event.target.checked)}
          >
            {copy.docsEnabled}
          </Checkbox>
          {enabled ? (
            <a
              className={styles.externalLink}
              href={API_DOCS_ROUTES.page}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy.docsOpen}
              <Icon icon={ExternalLink} size={16} />
            </a>
          ) : null}
        </>
      ) : settings.isPending ? (
        <Skeleton className={styles.skeletonLine} />
      ) : (
        <Notice tone="danger" role="alert">
          {isApiError(settings.error) ? settings.error.message : t.api.network}
        </Notice>
      )}
      {saved ? (
        <Notice tone="success" role="status">
          {copy.docsSaved}
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : null}
    </section>
  );
}

function ListSkeleton() {
  return (
    <SkeletonRegion className={styles.list}>
      {[0, 1].map((index) => (
        <div key={index} className={styles.item}>
          <Skeleton className={styles.skeletonTitle} />
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLine} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
