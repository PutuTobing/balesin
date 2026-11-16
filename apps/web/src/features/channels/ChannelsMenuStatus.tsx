import type { WhatsAppChannel } from '@balesin/shared';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import styles from '../settings/Settings.module.css';
import { channelStatusView } from './channel-status';

/** Urutan "paling perlu perhatian" untuk ringkasan di menu Pengaturan. */
const SEVERITY = { failed: 3, untested: 2, connected: 1 } as const;

/**
 * Status ringkas Channel di menu Pengaturan: "○ Belum diatur · Hubungkan", atau
 * "4 nomor · ● 1 koneksi gagal" dengan status channel aktif yang paling perlu perhatian (semua
 * nonaktif → "Nonaktif").
 */
export function ChannelsMenuStatus({ channels }: { channels: readonly WhatsAppChannel[] }) {
  if (channels.length === 0) {
    return (
      <>
        <StatusBadge tone="neutral" label={t.channels.menuNone} />
        <span className={styles.statusSeparator} aria-hidden="true">
          ·
        </span>
        <span className={styles.setUpNow}>{t.channels.connectNow}</span>
      </>
    );
  }
  const active = channels.filter((channel) => channel.enabled);
  const worst = active.reduce<WhatsAppChannel | null>(
    (current, channel) =>
      current === null || SEVERITY[channel.status] > SEVERITY[current.status] ? channel : current,
    null,
  );
  const view = channelStatusView(worst ?? { enabled: false, status: 'untested' });
  // Hanya sebagian channel aktif berstatus terburuk → sebut jumlahnya ("1 koneksi gagal"), supaya
  // tidak terbaca "semua channel gagal". Semua sama (atau satu nomor) → label saja.
  const sameCount = worst ? active.filter((channel) => channel.status === worst.status).length : 0;
  const label =
    worst && active.length > 1 && sameCount < active.length
      ? t.channels.menuWorst(sameCount, view.label)
      : view.label;
  return (
    <>
      <span className={styles.menuCount}>{t.channels.menuCount(channels.length)}</span>
      <span className={styles.statusSeparator} aria-hidden="true">
        ·
      </span>
      <StatusBadge tone={view.tone} label={label} />
    </>
  );
}
