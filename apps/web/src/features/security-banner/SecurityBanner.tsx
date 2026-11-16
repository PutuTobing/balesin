import { SECURITY_EVENT_LABELS, USER_ROLE_LABELS } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { ShieldAlert, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { securitySummaryQuery } from '../../lib/api/queries';
import { writeDeviceValue } from '../../lib/device-storage';
import { formatDateTimeInline } from '../../lib/format';
import { useCan, useSession } from '../auth/session';
import { auditSearchFor, bannerSeenKey, readSeenAt, unseenWarnings } from './banner-state';
import styles from './SecurityBanner.module.css';

const copy = t.securityBanner;
/** `id` elemen `<main>` di kerangka aplikasi (AppShell). */
const MAIN_CONTENT_ID = 'konten';

/**
 * Banner peringatan keamanan untuk pemegang `audit.view` (Owner, Admin): kejadian `warning` dalam
 * 7 hari terakhir yang belum ditutup di perangkat ini (mis. email pengirim diubah oleh selain
 * Owner, 2FA anggota diatur ulang, akun dikunci). Bukan wilayah `alert`: tampil sejak halaman
 * dibuka, jadi tidak diumumkan berulang. "Terakhir ditutup" disimpan di localStorage per
 * pengguna — kenyamanan saja; bila penyimpanan diblokir, banner tetap bisa ditutup untuk kunjungan
 * ini.
 */
const SENDING_KINDS: ReadonlySet<string> = new Set([
  'sending_paused',
  'sending_limit_reached',
  'sending_limits_changed',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SecurityBanner() {
  const session = useSession();
  const canView = useCan('audit.view');
  const canChannels = useCan('channels.manage');
  const canSendingLimits = useCan('sending.limits.manage');
  const summary = useQuery({ ...securitySummaryQuery, enabled: canView });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const userId = session?.user.id ?? '';
  // Nilai "terakhir ditutup" di memori: tetap berlaku walau localStorage menolak menulis.
  const [dismissed, setDismissed] = useState<{ userId: string; at: number } | null>(null);
  const titleId = useId();
  /*
   * Banner hanya muncul bersamaan dengan halaman. Biasanya ringkasan sudah dimuat guard sebelum
   * kerangka aplikasi tampil; bila tiba belakangan (jaringan lambat), banner menunggu perpindahan
   * halaman berikutnya, supaya isi halaman yang sedang dibaca tidak terdorong ke bawah (CLS).
   */
  const hasData = summary.data !== undefined;
  const [allowed, setAllowed] = useState(hasData);
  const [shownPath, setShownPath] = useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    if (hasData && !allowed) setAllowed(true);
  }

  if (!canView || !summary.data || !userId || !allowed) return null;
  const seenAt = Math.max(readSeenAt(userId), dismissed?.userId === userId ? dismissed.at : 0);
  const events = unseenWarnings(summary.data, seenAt, userId);
  const latest = events[0];
  if (!latest) return null;

  const dismiss = () => {
    const at = summary.data.latestWarningAt ?? latest.occurredAt;
    writeDeviceValue(bannerSeenKey(userId), at);
    setDismissed({ userId, at: Date.parse(at) });
  };

  return (
    <section className={styles.banner} aria-labelledby={titleId}>
      <Icon icon={ShieldAlert} size={20} className={styles.icon} />
      <div className={styles.text}>
        {/* Bukan judul (h2): banner ada sebelum h1 halaman, urutan judul tetap rapi. */}
        <p id={titleId} className={styles.title}>
          {copy.title(events.length)}
        </p>
        <p className={styles.body}>
          {latest.kind === 'member_joined' && latest.actor
            ? copy.latestJoined(
                latest.actor.name,
                USER_ROLE_LABELS[latest.actor.role],
                formatDateTimeInline(latest.occurredAt),
              )
            : copy.latest(
                latest.kind === 'webhook_signature_failed' &&
                  typeof latest.details.name === 'string'
                  ? copy.onChannel(SECURITY_EVENT_LABELS[latest.kind], latest.details.name)
                  : SECURITY_EVENT_LABELS[latest.kind],
                formatDateTimeInline(latest.occurredAt),
                latest.actor
                  ? { name: latest.actor.name, role: USER_ROLE_LABELS[latest.actor.role] }
                  : undefined,
              )}
        </p>
      </div>
      <div className={styles.actions}>
        {latest.kind === 'webhook_signature_failed' &&
        typeof latest.details.channelId === 'string' &&
        UUID.test(latest.details.channelId) &&
        canChannels ? (
          // Webhook ditolak di satu channel: langsung ke halaman nomornya (S3 kritikus Channel).
          <Link
            to="/pengaturan/channel/$channelId"
            params={{ channelId: latest.details.channelId }}
            className={styles.review}
            onClick={dismiss}
          >
            {copy.reviewChannel}
          </Link>
        ) : null}
        {SENDING_KINDS.has(latest.kind) && canSendingLimits ? (
          // Rem ditarik / batas tercapai / batas diubah: langsung ke Pengaturan → Batas kirim.
          <Link to="/pengaturan/batas-kirim" className={styles.review} onClick={dismiss}>
            {copy.reviewSending}
          </Link>
        ) : null}
        <Link
          to="/pengaturan/audit"
          search={auditSearchFor(events, summary.data.since)}
          className={styles.review}
          onClick={dismiss}
        >
          {copy.review}
        </Link>
        <button
          type="button"
          className={styles.dismiss}
          aria-label={copy.dismiss}
          title={copy.dismiss}
          onClick={() => {
            dismiss();
            // Banner hilang bersama tombolnya: fokus ke konten utama, bukan <body>.
            document.getElementById(MAIN_CONTENT_ID)?.focus({ preventScroll: true });
          }}
        >
          <Icon icon={X} size={20} />
        </button>
      </div>
    </section>
  );
}
