import type { WhatsAppChannel } from '@balesin/shared';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { channelStatusView, qualityView } from './channel-status';

/** Terhubung / Gagal / Belum dites, atau Nonaktif bila channel dinonaktifkan. */
export function ChannelStatusBadge({
  channel,
  className,
}: {
  channel: Pick<WhatsAppChannel, 'enabled' | 'status'>;
  className?: string;
}) {
  const view = channelStatusView(channel);
  return <StatusBadge tone={view.tone} label={view.label} className={className} />;
}

/** Kualitas nomor dengan warna yang sesuai (Tinggi hijau, Sedang kuning, Rendah merah). */
export function QualityBadge({
  rating,
  withLabel = false,
  className,
}: {
  rating: string | null;
  /** `true`: "Kualitas Tinggi" (berdiri sendiri, mis. di daftar); `false`: "Tinggi". */
  withLabel?: boolean;
  className?: string;
}) {
  const view = qualityView(rating);
  return (
    <StatusBadge
      tone={view.tone}
      label={withLabel ? t.channels.list.quality(view.label) : view.label}
      className={className}
    />
  );
}
