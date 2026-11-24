import { EMAIL_SENDER_VERIFICATION_LABELS, type Message } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { AtSign, CircleAlert, EyeOff, FileCode2, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Icon } from '../../components/ui/Icon';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import styles from './EmailMessage.module.css';
import { inboxChannelsQuery } from './inbox-queries';

const e = t.inbox.email;
/** Lebih dari ini (Kepada + Cc + Bcc) → ringkas, bisa dibuka. */
const COLLAPSE_FROM = 4;
/** Alamat per baris saat ringkas. */
const COLLAPSED_PER_ROW = 2;

/**
 * Bagian khusus pesan Email di gelembung: subjek, hasil verifikasi pengirim (`fail` = peringatan
 * keras; `unverified` = netral; `pass` = tenang), lampiran yang dilewati, dan tombol versi HTML.
 * Semua isi dari pelanggan dirender sebagai teks.
 */
export function EmailHeader({ message }: { message: Message }) {
  const email = message.email;
  const [htmlOpen, setHtmlOpen] = useState(false);
  if (!email) return null;
  const inbound = message.direction === 'inbound';
  const verification = email.senderVerification ?? (email.authWarning ? 'fail' : 'unverified');
  return (
    <div className={styles.email}>
      {email.subject ? (
        <p className={styles.subject} dir="auto">
          <span className="sr-only">{e.subject}: </span>
          {email.subject}
        </p>
      ) : null}
      <EmailAddresses message={message} />
      {inbound ? (
        verification === 'fail' ? (
          <p className={styles.fail} role="note">
            <Icon icon={CircleAlert} size={16} />
            <span>{EMAIL_SENDER_VERIFICATION_LABELS.fail}</span>
          </p>
        ) : (
          <p className={styles.verification} data-state={verification}>
            <Icon icon={verification === 'pass' ? ShieldCheck : ShieldQuestion} size={16} />
            <span>{EMAIL_SENDER_VERIFICATION_LABELS[verification]}</span>
          </p>
        )
      ) : null}
      {email.skippedAttachments > 0 ? (
        <p className={styles.note}>{e.skippedAttachments(email.skippedAttachments)}</p>
      ) : null}
      {email.hasHtml ? (
        <>
          <Button variant="ghost" className={styles.htmlButton} onClick={() => setHtmlOpen(true)}>
            <Icon icon={FileCode2} size={16} />
            {e.viewHtml}
          </Button>
          {htmlOpen ? (
            <EmailHtmlDialog
              messageId={message.id}
              subject={email.subject}
              onClose={() => setHtmlOpen(false)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Tahap 9.0 — Kepada/Cc (dan Bcc email keluar, hanya tim) + "Dikirim ke <alias>" bila email masuk
 * lewat alias channel. Disembunyikan bila tidak menambah informasi (email masuk hanya ke alamat
 * channel, balasan tanpa Cc/Bcc). Banyak penerima → ringkas dengan tombol buka-tutup.
 */
function EmailAddresses({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const primary = useQuery(inboxChannelsQuery).data?.channels.find((channel) =>
    message.email?.recipient ? channel.emailAddresses?.includes(message.email.recipient) : false,
  )?.emailAddresses?.[0];
  const email = message.email;
  if (!email) return null;
  const to = email.to ?? [];
  const cc = email.cc ?? [];
  const bcc = message.direction === 'outbound' ? (email.bcc ?? []) : [];
  const inbound = message.direction === 'inbound';
  const alias =
    inbound && email.recipient && primary && email.recipient !== primary ? email.recipient : null;
  const showRows = inbound ? to.length > 1 || cc.length > 0 : cc.length > 0 || bcc.length > 0;
  if (!showRows && !alias) return null;

  const total = to.length + cc.length + bcc.length;
  // Ringkas hanya bila memang ada alamat yang disembunyikan.
  const collapsible =
    total >= COLLAPSE_FROM && [to, cc, bcc].some((list) => list.length > COLLAPSED_PER_ROW);
  const short = collapsible && !expanded;
  const rows = [
    { key: 'to', label: e.to, list: to, hidden: false },
    { key: 'cc', label: e.cc, list: cc, hidden: false },
    { key: 'bcc', label: e.bcc, list: bcc, hidden: true },
  ].filter((row) => row.list.length > 0);

  return (
    <div className={styles.addresses}>
      {showRows ? (
        <dl className={styles.addressList} aria-label={e.recipients}>
          {rows.map((row) => {
            const visible = short ? row.list.slice(0, COLLAPSED_PER_ROW) : row.list;
            const rest = row.list.length - visible.length;
            return (
              <div key={row.key} className={styles.addressRow}>
                <dt className={styles.addressLabel}>{row.label}</dt>
                <dd className={styles.addressValues}>
                  {visible.map((address, index) => {
                    const more = index < visible.length - 1 || rest > 0;
                    return (
                      <Fragment key={address}>
                        <span className={styles.address}>
                          {address}
                          {more ? ',' : ''}
                        </span>
                        {/* Spasi di luar kotak alamat = tempat pindah baris. */}
                        {more ? ' ' : null}
                      </Fragment>
                    );
                  })}
                  {rest > 0 ? <span className={styles.more}>{e.more(rest)}</span> : null}
                  {row.hidden ? (
                    // Label terlihat (HP tanpa hover): Bcc tidak pernah dilihat pelanggan (P6).
                    // Di kolom nilai supaya kolom label tetap sempit.
                    <>
                      {' '}
                      <span className={styles.teamOnly} title={e.bccTeamOnly}>
                        <Icon icon={EyeOff} size={16} />
                        <span aria-hidden="true">{e.bccTeamOnlyShort}</span>
                        <span className="sr-only">{e.bccTeamOnly}</span>
                      </span>
                    </>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {collapsible && showRows ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? e.showLess : e.showAll(total)}
        </button>
      ) : null}
      {alias ? (
        <p className={styles.via}>
          <Icon icon={AtSign} size={16} />
          <span>
            {e.sentTo} <strong className={styles.viaAddress}>{alias}</strong>
            <span className="sr-only"> ({e.sentToAlias})</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Versi HTML email (SUDAH disanitasi server) HANYA di `<iframe sandbox srcdoc>` tanpa
 * `allow-scripts` dan `allow-same-origin`: skrip tidak jalan dan dokumen tidak bisa menyentuh
 * aplikasi, cookie, atau penyimpanan. Tautan di dalamnya tidak bisa membuka jendela (tanpa
 * `allow-popups`).
 */
function EmailHtmlDialog({
  messageId,
  subject,
  onClose,
}: {
  messageId: string;
  subject: string | null;
  onClose: () => void;
}) {
  const html = useQuery({
    queryKey: ['inbox', 'email-html', messageId],
    queryFn: ({ signal }) => endpoints.emailHtml(messageId, signal),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  return (
    <Dialog open title={e.htmlTitle} description={subject ?? undefined} onRequestClose={onClose}>
      {/* Label di atas bingkai (sejajar tepi dialog), bukan menempel di dalamnya (K11). Dokumen
          email selalu berlatar terang (dirancang begitu), juga di mode gelap. */}
      <figure className={styles.figure}>
        {html.isSuccess ? (
          <figcaption className={styles.frameLabel}>{e.htmlOriginal}</figcaption>
        ) : null}
        <div className={styles.frameWrap}>
          {html.isPending ? (
            <SkeletonRegion className={styles.frameSkeleton}>
              <Skeleton className={styles.skeletonLine} />
              <Skeleton className={styles.skeletonLine} />
            </SkeletonRegion>
          ) : html.isError ? (
            <p className={styles.note} role="alert">
              {isApiError(html.error) && html.error.status === 404
                ? e.htmlMissing
                : isApiError(html.error)
                  ? html.error.message
                  : t.api.network}
            </p>
          ) : (
            <iframe
              title={e.htmlFrameTitle}
              className={styles.frame}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={html.data.html}
            />
          )}
        </div>
      </figure>
      <p className={styles.note}>{e.htmlNote}</p>
      <DialogActions>
        <Button variant="primary" onClick={onClose}>
          {t.common.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
