import type {
  ChannelCredentialField,
  ChannelTestResult,
  IdentityConfirmation,
  WhatsAppChannel,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Smartphone } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  LoadFailedIllustration,
  NotFoundIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { channelQuery, channelWebhookQuery, queryKeys, storeChannel } from '../../lib/api/queries';
import { formatDateTime, formatDateTimeInline } from '../../lib/format';
import { apiFieldErrors } from '../../lib/form';
import { useSession } from '../auth/session';
import { IdentityDialog } from '../identity/IdentityDialog';
import { BusinessProfileCard } from './BusinessProfileCard';
import { dropChannelFromList, forgetChannel } from './channel-cache';
import { credentialFixFor, isChannelId } from './channel-status';
import { ChannelStatusBadge } from './ChannelBadges';
import styles from './Channels.module.css';
import { ChannelDetailCardsSkeleton } from './ChannelsSkeleton';
import { CredentialsCard } from './CredentialsCard';
import { NumberFacts } from './NumberFacts';
import { SectionNav } from './SectionNav';
import './route-state';
import { TestPanel } from './TestPanel';
import { WebhookHealthCard } from './WebhookHealthCard';
import { WebhookPanel } from './WebhookPanel';

const routeApi = getRouteApi('/_app/pengaturan/channel/$channelId');
const copy = t.channels.detail;

/**
 * Halaman nomor (izin `channels.manage`): ringkasan + tes koneksi, webhook, profil bisnis, nama,
 * kredensial, dan akses (nonaktifkan / hapus). Data yang gagal dimuat tidak menggagalkan rute:
 * halamannya sendiri menampilkan "tidak ditemukan" / gagal + coba lagi.
 */
export function ChannelPage() {
  const { channelId } = routeApi.useParams();
  const queryClient = useQueryClient();
  const valid = isChannelId(channelId);
  const channel = useQuery({ ...channelQuery(channelId, queryClient), enabled: valid });

  const notFound = !valid || (isApiError(channel.error) && channel.error.status === 404);
  return (
    <Page>
      {notFound ? (
        <EmptyState
          illustration={<NotFoundIllustration />}
          title={copy.notFoundTitle}
          body={copy.notFoundBody}
          actions={
            <Button asChild variant="primary">
              <Link to="/pengaturan/channel">{copy.backToList}</Link>
            </Button>
          }
        />
      ) : channel.data ? (
        <ChannelScreen key={channel.data.id} channel={channel.data} />
      ) : channel.isPending ? (
        <SkeletonRegion>
          <ChannelDetailCardsSkeleton />
        </SkeletonRegion>
      ) : (
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={copy.loadFailedTitle}
          body={isApiError(channel.error) ? channel.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void channel.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      )}
    </Page>
  );
}

function ChannelScreen({ channel }: { channel: WhatsAppChannel }) {
  // Form ganti kredensial dibuka dari kartunya sendiri ATAU dari kotak "Tes terakhir gagal".
  const [editing, setEditing] = useState<ChannelCredentialField | null>(null);
  return (
    <div className={styles.detailLayout}>
      <div className={styles.content}>
        <SummaryCard channel={channel} onFixCredentials={setEditing} />
        <WebhookHealthCard channelId={channel.id} onFixAppSecret={() => setEditing('appSecret')} />
        <WebhookCard channelId={channel.id} />
        <BusinessProfileCard channel={channel} />
        <RenameCard channel={channel} />
        <CredentialsCard channel={channel} editing={editing} onEdit={setEditing} />
        <AccessCard channel={channel} />
      </div>
      <SectionNav />
    </div>
  );
}

// ── Ringkasan + tes koneksi ─────────────────────────────────────────────────

function SummaryCard({
  channel,
  onFixCredentials,
}: {
  channel: WhatsAppChannel;
  onFixCredentials: (field: ChannelCredentialField) => void;
}) {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const number = channel.number;
  const lastTest = channel.lastTest;
  const failed = lastTest && !lastTest.ok ? lastTest : null;
  // Gagal karena kredensial → aksi utama memperbaikinya, bukan mengulang tes yang sama.
  const fixField = failed ? credentialFixFor(failed.code) : null;

  const enable = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      const response = await endpoints.channels.setEnabled(channel.id, true);
      storeChannel(queryClient, response.channel);
    } catch (caught) {
      setEnableError(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setEnabling(false);
    }
  };

  return (
    <section id="ringkasan" className={styles.card} aria-labelledby="channel-nama">
      <div className={styles.summaryHead}>
        <span className={styles.summaryIcon}>
          <Icon icon={Smartphone} size={20} />
        </span>
        <div className={styles.summaryText}>
          <h2 id="channel-nama" className={styles.summaryName}>
            {channel.name}
          </h2>
          <p className={styles.summaryNumber}>
            {number?.displayPhoneNumber ?? t.channels.list.noNumber}
          </p>
          <p className={styles.summaryBadges}>
            <ChannelStatusBadge channel={channel} className={styles.smallBadge} />
          </p>
        </div>
      </div>

      {!channel.enabled ? (
        <Notice
          tone="info"
          title={
            channel.disabledAt
              ? copy.disabledSince(formatDateTimeInline(channel.disabledAt))
              : t.channels.disabled
          }
          actions={
            <Button variant="secondary" loading={enabling} onClick={() => void enable()}>
              {enabling ? copy.enabling : copy.enable}
            </Button>
          }
        >
          {copy.disabledBody}
        </Notice>
      ) : null}
      {enableError ? (
        <Notice tone="danger" role="alert">
          {enableError}
        </Notice>
      ) : null}

      {number ? (
        <NumberFacts number={number} lastTest={lastTest} divided />
      ) : lastTest === null ? (
        <Notice tone="info">{copy.untested}</Notice>
      ) : null}

      {/* Tes terakhir gagal (juga tes yang baru dijalankan di halaman ini: cache ikut diperbarui). */}
      {failed ? (
        <Notice
          tone="danger"
          title={copy.lastFailedTitle}
          role={testResult ? 'alert' : undefined}
          actions={
            fixField ? (
              <Button variant="primary" onClick={() => onFixCredentials(fixField)}>
                {t.channels.credentials.change}
              </Button>
            ) : undefined
          }
        >
          <div className={styles.paragraphs}>
            <p>{failed.message}</p>
            {/* Waktunya sudah ada di fakta "Tes terakhir" bila data nomor tampil. */}
            {number ? null : <p>{formatDateTime(failed.testedAt)}</p>}
          </div>
        </Notice>
      ) : null}

      {channel.warnings.length > 0 ? (
        <ul className={styles.warnings} aria-label={t.channels.test.warningsTitle}>
          {channel.warnings.map((warning) => (
            <li key={warning.code}>
              <Notice tone="warning">{warning.message}</Notice>
            </li>
          ))}
        </ul>
      ) : null}

      <TestPanel
        channelId={channel.id}
        result={testResult}
        onResult={setTestResult}
        // Kegagalan tampil di kotak "Tes terakhir gagal" di atas (dengan aksi perbaikannya).
        showFailure={false}
        variant={channel.status === 'connected' || fixField ? 'secondary' : 'primary'}
      />
    </section>
  );
}

// ── Webhook ─────────────────────────────────────────────────────────────────

function WebhookCard({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const webhook = useQuery(channelWebhookQuery(channelId));
  const [asking, setAsking] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const rotateRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rotated) resultRef.current?.focus();
  }, [rotated]);

  const rotate = async () => {
    setAsking(false);
    setRotating(true);
    setRotateError(null);
    try {
      const next = await endpoints.channels.rotateVerifyToken(channelId);
      queryClient.setQueryData(queryKeys.channelWebhook(channelId), next);
      setRotated(true);
    } catch (caught) {
      setRotateError(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setRotating(false);
      requestAnimationFrame(() => rotateRef.current?.focus());
    }
  };

  const rotateButton = (
    <div className={styles.actions}>
      <Button
        ref={rotateRef}
        loading={rotating}
        onClick={() => {
          setRotated(false);
          setAsking(true);
        }}
      >
        {rotating ? t.channels.webhook.rotating : t.channels.webhook.rotate}
      </Button>
    </div>
  );

  return (
    <section id="webhook" className={styles.card} aria-labelledby="channel-webhook">
      <div className={styles.cardHead}>
        <h2 id="channel-webhook" className={styles.cardTitle}>
          {t.channels.webhook.title}
        </h2>
        <p className={styles.hint}>{t.channels.webhook.hint}</p>
      </div>
      {rotated ? (
        <div ref={resultRef} tabIndex={-1} className={styles.result}>
          <Notice tone="success" role="status">
            {t.channels.webhook.rotated}
          </Notice>
        </div>
      ) : null}
      {rotateError ? (
        <Notice tone="danger" role="alert">
          {rotateError}
        </Notice>
      ) : null}
      {webhook.data ? (
        <WebhookPanel webhook={webhook.data} actions={rotateButton} context="detail" />
      ) : webhook.isPending ? (
        <SkeletonRegion className={styles.copyRows}>
          {[t.channels.webhook.callbackUrl, t.channels.webhook.verifyToken].map((label) => (
            <div key={label} className={styles.copyRow}>
              <span className={styles.copyLabel}>{label}</span>
              <Skeleton className={styles.skeletonInput} />
            </div>
          ))}
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          title={t.channels.webhook.loadFailedTitle}
          actions={
            // 503 = verify token tersimpan tidak bisa dibuka (master key berubah): buat yang baru.
            isApiError(webhook.error) && webhook.error.status === 503 ? (
              rotateButton
            ) : (
              <Button onClick={() => void webhook.refetch()}>{t.common.retry}</Button>
            )
          }
        >
          {isApiError(webhook.error) ? webhook.error.message : t.api.network}
        </Notice>
      )}
      <ConfirmDialog
        open={asking}
        title={t.channels.webhook.rotateTitle}
        body={t.channels.webhook.rotateBody}
        cancelLabel={t.channels.webhook.rotateCancel}
        confirmLabel={t.channels.webhook.rotateConfirm}
        confirmVariant="danger"
        onCancel={() => {
          setAsking(false);
          requestAnimationFrame(() => rotateRef.current?.focus());
        }}
        onConfirm={() => void rotate()}
      />
    </section>
  );
}

// ── Nama channel ────────────────────────────────────────────────────────────

function RenameCard({ channel }: { channel: WhatsAppChannel }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(channel.name);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirty = name.trim() !== channel.name;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    setFailure(null);
    try {
      const response = await endpoints.channels.update(channel.id, { name });
      storeChannel(queryClient, response.channel);
      setName(response.channel.name);
      setSaved(true);
    } catch (caught) {
      const fieldError =
        isApiError(caught) && caught.code === 'VALIDATION_ERROR'
          ? apiFieldErrors(caught.details).name
          : undefined;
      if (fieldError) {
        setError(fieldError);
        inputRef.current?.focus();
      } else {
        setFailure(isApiError(caught) ? caught.message : t.api.network);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="nama" className={styles.card} aria-labelledby="channel-ganti-nama">
      <div className={styles.cardHead}>
        <h2 id="channel-ganti-nama" className={styles.cardTitle}>
          {t.channels.rename.title}
        </h2>
        <p className={styles.hint}>{t.channels.rename.hint}</p>
      </div>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.renameRow}>
          <TextField
            ref={inputRef}
            label={t.channels.rename.label}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
              setError(null);
            }}
            error={error}
            autoComplete="off"
            disabled={saving}
          />
          <Button type="submit" variant="secondary" loading={saving} disabled={!dirty}>
            {saving ? t.channels.rename.saving : t.channels.rename.save}
          </Button>
        </div>
        {saved ? (
          <p className={styles.savedNote} role="status">
            {t.channels.rename.saved}
          </p>
        ) : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {failure}
          </Notice>
        ) : null}
      </form>
    </section>
  );
}

// ── Akses: nonaktifkan & hapus ──────────────────────────────────────────────

function AccessCard({ channel }: { channel: WhatsAppChannel }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const [asking, setAsking] = useState<'disable' | 'delete' | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const disableRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const access = t.channels.access;

  const disable = async () => {
    setAsking(null);
    setDisabling(true);
    setFailure(null);
    try {
      const response = await endpoints.channels.setEnabled(channel.id, false);
      storeChannel(queryClient, response.channel);
    } catch (caught) {
      setFailure(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setDisabling(false);
    }
  };

  const remove = async (identity: IdentityConfirmation) => {
    try {
      await endpoints.channels.remove(channel.id, identity);
    } catch (caught) {
      // 404: sudah dihapus di tempat lain — hasil akhirnya sama.
      if (!(isApiError(caught) && caught.status === 404)) throw caught;
    }
    setAsking(null);
    dropChannelFromList(queryClient, channel.id);
    await navigate({
      to: '/pengaturan/channel',
      replace: true,
      state: (previous) => ({ ...previous, deletedChannel: channel.name }),
    });
    forgetChannel(queryClient, channel.id);
  };

  return (
    <section id="akses" className={styles.card} aria-labelledby="channel-akses">
      <div className={styles.cardHead}>
        <h2 id="channel-akses" className={styles.cardTitle}>
          {access.title}
        </h2>
        <p className={styles.hint}>{channel.enabled ? access.disableHint : access.enableHint}</p>
      </div>
      {channel.enabled ? (
        <div className={styles.actions}>
          <Button ref={disableRef} loading={disabling} onClick={() => setAsking('disable')}>
            {disabling ? access.disabling : access.disable}
          </Button>
        </div>
      ) : null}
      {session && session.user.role !== 'owner' ? (
        <p className={styles.note}>{t.channels.ownersNotified}</p>
      ) : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {failure}
        </Notice>
      ) : null}
      {/* Aksi kartu di kiri bawah teksnya; merah penuh hanya di tombol konfirmasi dialog. */}
      <div className={styles.dangerZone}>
        <h3 className={styles.dangerTitle}>{access.deleteTitleCard}</h3>
        <p className={styles.hint}>{access.deleteHint}</p>
        <div className={styles.actions}>
          <Button ref={deleteRef} className={styles.dangerText} onClick={() => setAsking('delete')}>
            {access.delete}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={asking === 'disable'}
        title={access.disableTitle}
        body={access.disableBody}
        cancelLabel={access.disableCancel}
        confirmLabel={access.disableConfirm}
        confirmVariant="danger"
        onCancel={() => {
          setAsking(null);
          requestAnimationFrame(() => disableRef.current?.focus());
        }}
        onConfirm={() => void disable()}
      />
      <IdentityDialog
        open={asking === 'delete'}
        title={access.deleteTitle(channel.name)}
        body={access.deleteBody}
        confirmLabel={access.deleteConfirm}
        pendingLabel={access.deleting}
        variant="danger"
        requireCode
        returnFocusRef={deleteRef}
        onCancel={() => setAsking(null)}
        onConfirm={remove}
      />
    </section>
  );
}
