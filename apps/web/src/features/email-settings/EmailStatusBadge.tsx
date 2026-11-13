import { EMAIL_SETTINGS_STATUS_LABELS, type EmailSettingsStatus } from '@balesin/shared';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';

const tones: Record<EmailSettingsStatus, StatusTone> = {
  connected: 'success',
  failed: 'danger',
  untested: 'warning',
  not_configured: 'neutral',
};

/** Terhubung / Gagal / Belum dites / Belum diatur. */
export function EmailStatusBadge({
  status,
  className,
}: {
  status: EmailSettingsStatus;
  className?: string;
}) {
  return (
    <StatusBadge
      tone={tones[status]}
      label={EMAIL_SETTINGS_STATUS_LABELS[status]}
      className={className}
    />
  );
}
