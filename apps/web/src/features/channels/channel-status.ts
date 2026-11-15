import {
  CHANNEL_STATUS_LABELS,
  type ChannelSettingsListResponse,
  qualityRatingLabel,
  type ChannelStatus,
  type WhatsAppChannel,
} from '@balesin/shared';
import type { StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';

const statusTones: Record<ChannelStatus, StatusTone> = {
  connected: 'success',
  failed: 'danger',
  untested: 'warning',
};

/**
 * Status yang ditampilkan untuk satu channel: "Nonaktif" mengalahkan status koneksi (channel yang
 * dinonaktifkan tidak menerima/mengirim pesan, apa pun hasil tes terakhirnya).
 */
export function channelStatusView(channel: Pick<WhatsAppChannel, 'enabled' | 'status'>): {
  tone: StatusTone;
  label: string;
} {
  if (!channel.enabled) return { tone: 'neutral', label: t.channels.disabled };
  return { tone: statusTones[channel.status], label: CHANNEL_STATUS_LABELS[channel.status] };
}

/** Kualitas nomor: GREEN Tinggi (hijau), YELLOW Sedang (kuning), RED Rendah (merah), lainnya netral. */
export function qualityView(rating: string | null): { tone: StatusTone; label: string } {
  const tone: StatusTone =
    rating === 'GREEN'
      ? 'success'
      : rating === 'YELLOW'
        ? 'warning'
        : rating === 'RED'
          ? 'danger'
          : 'neutral';
  return { tone, label: qualityRatingLabel(rating) };
}

/** UUID seperti yang dibuat server; alamat lain langsung "tidak ditemukan" tanpa memanggil API. */
export function isChannelId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Alasan menambah nomor tidak bisa: server tidak bisa menyimpan rahasia, atau batas tercapai. */
export function addBlockedReason(
  data: ChannelSettingsListResponse,
): 'noMasterKey' | 'limit' | null {
  if (!data.canStoreSecrets) return 'noMasterKey';
  if (data.channels.length >= data.maxChannels) return 'limit';
  return null;
}
