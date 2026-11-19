import {
  CHANNEL_TYPE_AVAILABILITY,
  type ConnectionChannelType,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { ChannelIllustration } from '../../../components/illustrations/illustrations';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Icon } from '../../../components/ui/Icon';
import { Notice } from '../../../components/ui/Notice';
import { Page } from '../../../components/ui/Page';
import { t } from '../../../i18n/id';
import { isApiError } from '../../../lib/api/client';
import { endpoints } from '../../../lib/api/endpoints';
import { apiFieldErrors } from '../../../lib/form';
import { isConfirmationError } from '../../identity/confirmation-error';
import { IdentityDialog } from '../../identity/IdentityDialog';
import { CHANNEL_TYPE_ICONS, channelTypeLabel } from '../channel-type';
import { ConnectionFields } from './connection-form';
import { useConnectionForm } from './use-connection-form';
import { isConnectionType, setConnectionFlash, storeConnection } from './connection-queries';
import styles from './Connections.module.css';

const c = t.connections;
const routeApi = getRouteApi('/_app/pengaturan/channel/baru/$type');

/**
 * Hubungkan Telegram / Email / Messenger / Instagram. Semua jenis WAJIB konfirmasi identitas.
 * Rahasia (token, password, App Secret) hanya di isian tak terkendali dan dikosongkan setelah
 * dikirim. Messenger/Instagram dibuat nonaktif (butuh App Review Meta).
 */
export function ConnectionWizardPage() {
  const { type } = routeApi.useParams();
  return (
    <Page>
      {isConnectionType(type) ? (
        <ConnectionWizard key={type} type={type} />
      ) : (
        <EmptyState
          illustration={<ChannelIllustration />}
          title={c.unknownType}
          actions={
            <Button variant="primary" asChild>
              <Link to="/pengaturan/channel">{c.backToChannels}</Link>
            </Button>
          }
        />
      )}
    </Page>
  );
}

function ConnectionWizard({ type }: { type: ConnectionChannelType }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useConnectionForm(type, null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const label = channelTypeLabel(type);
  const TypeIcon = CHANNEL_TYPE_ICONS[type];
  const reviewNote = CHANNEL_TYPE_AVAILABILITY[type].reason;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (form.build().ok) setConfirming(true);
  };

  const create = async (confirmation: IdentityConfirmation) => {
    // Dibaca ulang saat konfirmasi: rahasia tetap hanya di isian, tidak disimpan di state/ref.
    const built = form.build();
    if (!built.ok) {
      setConfirming(false);
      return;
    }
    try {
      const { channel } = await endpoints.connections.create({ ...built.create, confirmation });
      form.clearSecrets();
      setConfirming(false);
      storeConnection(queryClient, channel);
      setConnectionFlash(channel.enabled ? c.created : c.createdDisabled);
      void navigate({
        to: '/pengaturan/channel/lain/$channelId',
        params: { channelId: channel.id },
      });
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(false);
      if (isApiError(caught) && caught.details.length > 0) {
        const fieldErrors = apiFieldErrors(caught.details);
        if (Object.keys(fieldErrors).length > 0) form.setErrors(fieldErrors);
      }
      setError(caught);
    }
  };

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={submit} noValidate>
        <div className={styles.wizardHead}>
          <span className={styles.typeIcon}>
            <Icon icon={TypeIcon} size={20} />
          </span>
          <h2 className={styles.cardTitle}>{c.newTitle(label)}</h2>
        </div>
        {reviewNote ? (
          <Notice tone="warning" title={c.metaReviewTitle}>
            {c.metaReviewBody[type] ?? reviewNote}
          </Notice>
        ) : null}
        {type === 'telegram' ? (
          <ol className={styles.steps}>
            {c.telegramSteps.map((step) => (
              <li key={step}>
                {/* Perintah bot (/newbot, /mybots) dalam huruf mono. */}
                {step.split(/(\/[a-z]+)/).map((part, index) =>
                  index % 2 === 1 ? (
                    <code key={index} className={styles.code}>
                      {part}
                    </code>
                  ) : (
                    part
                  ),
                )}
              </li>
            ))}
          </ol>
        ) : null}
        {type === 'email' ? <p className={styles.hint}>{c.emailIntro}</p> : null}
        <ConnectionFields form={form} />
        {error ? (
          <Notice tone="danger" role="alert">
            {isApiError(error) ? error.message : t.api.network}
          </Notice>
        ) : null}
        <div className={styles.actions}>
          <Button asChild>
            <Link to="/pengaturan/channel">{c.cancel}</Link>
          </Button>
          <Button ref={submitRef} type="submit" variant="primary">
            {c.create}
          </Button>
        </div>
      </form>
      <IdentityDialog
        open={confirming}
        title={c.confirmTitle(label)}
        body={c.confirmBody}
        confirmLabel={c.create}
        pendingLabel={c.creating}
        requireCode
        onConfirm={create}
        onCancel={() => setConfirming(false)}
        returnFocusRef={submitRef}
      />
    </div>
  );
}
