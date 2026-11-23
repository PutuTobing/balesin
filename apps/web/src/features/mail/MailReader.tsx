import {
  MAIL_ATTACHMENT_WARN_MESSAGE,
  MAIL_FOLDER_ROLE_NAMES,
  type MailAction,
  type MailAddressView,
  type MailAttachment,
  type MailMessageDetail,
  type MailMessageSummary,
  type MailSidebarResponse,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  Forward,
  Download,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FolderInput,
  ImageOff,
  Image as ImageIcon,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  PenLine,
  Reply,
  ReplyAll,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LoadFailedIllustration,
  NotFoundIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { Tooltip } from '../../components/ui/Tooltip';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { saveBlob } from '../../lib/download';
import { formatDateTime } from '../../lib/format';
import { useSession } from '../auth/session';
import { ContactAvatar } from '../inbox/InboxBits';
import { openCompose } from './compose/compose-store';
import { AccountMark } from './AccountMark';
import { folderIcon, formatBytes, visibleFolders } from './mail-format';
import {
  accountFolders,
  actionFlash,
  addressLabel,
  addressName,
  attachmentKind,
  attachmentTypeLabel,
  blockedAttachmentReason,
  folderLabel,
  isViewUrl,
  LEAVING_ACTIONS,
  readerActions,
  type AttachmentKind,
} from './mail-list';
import {
  findListedMessage,
  isNotFound,
  mailKeys,
  mailMessageQuery,
  mailViewQuery,
} from './mail-queries';
import { onMailSignal } from './mail-signals';
import { useMailActions } from './use-mail-actions';
import styles from './MailReader.module.css';

const r = t.mail.reading;
const l = t.mail.list;
const rb = t.mail.replyBar;

/** Iframe dokumen tampilan: tanpa `allow-scripts` & `allow-same-origin` (kontrak §8). */
const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
const RECIPIENTS_SHOWN = 3;

export interface ReaderFlash {
  tone: 'success' | 'danger';
  text: string;
}

interface MailReaderProps {
  messageId: string;
  sidebar: MailSidebarResponse;
  /** HP: tombol kembali ke daftar. */
  onBack?: () => void;
  /** Email dipindah/dihapus dari folder ini: panel ditutup. */
  onLeave: () => void;
  /** Hasil aksi untuk pemberitahuan di kolom daftar. */
  onFlash: (flash: ReaderFlash) => void;
  /** HP & keyboard: fokus ke subjek saat dibuka. */
  focusTitle?: boolean;
  /** 9B: pengguna punya hak kirim di akun mana pun (Teruskan). */
  canCompose?: boolean;
  /** 9B: posisi di daftar ("1 dari N") + email sebelumnya/berikutnya (desktop). */
  position?: { index: number; total: number; previous: string | null; next: string | null } | null;
  onStep?: (messageId: string) => void;
}

/**
 * Panel baca (kontrak §8, mockup docs/design/email): bilah aksi, subjek, asal (folder · akun),
 * pengirim + lencana verifikasi, penerima, peringatan, bilah gambar diblokir, lampiran, lalu isi.
 * Isi HTML HANYA lewat `<iframe sandbox src>` dokumen ber-token dari API; teks polos sebagai teks
 * React biasa. Membuka email yang belum dibaca menandainya dibaca (web yang memanggil aksi).
 */
export function MailReader({
  messageId,
  sidebar,
  onBack,
  onLeave,
  onFlash,
  focusTitle,
  canCompose = false,
  position = null,
  onStep,
}: MailReaderProps) {
  const queryClient = useQueryClient();
  const detail = useQuery(mailMessageQuery(messageId));
  const [listed] = useState(() => findListedMessage(queryClient, messageId));
  const act = useMailActions();
  const [images, setImages] = useState<'auto' | 'show'>('auto');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const message = detail.data?.message;

  // Tandai dibaca sekali saat dibuka (data dari daftar bila ada, supaya tidak menunggu detail).
  const marked = useRef(false);
  const current = message ?? listed;
  useEffect(() => {
    if (!current || marked.current) return;
    marked.current = true;
    if (!current.isRead) void act('mark_read', [messageId]);
  }, [current, messageId, act]);

  const folders = message ? visibleFolders(accountFolders(sidebar, message.accountId)) : [];
  const run = async (action: MailAction, targetFolderId?: string) => {
    const target = folders.find((folder) => folder.id === targetFolderId);
    if (LEAVING_ACTIONS.has(action)) onLeave();
    const outcome = await act(action, [messageId], targetFolderId);
    if (!outcome.ok) {
      onFlash({ tone: 'danger', text: outcome.message });
      return;
    }
    const text = actionFlash(action, target ? folderLabel(target) : undefined);
    if (text) onFlash({ tone: 'success', text });
  };

  // Satu pohon untuk semua keadaan (memuat → siap): bilah & judul tidak dipasang ulang, jadi
  // fokus (tombol kembali, subjek) tidak hilang saat detail tiba.
  const head = current ? (
    <ReaderHead summary={current} detail={message} sidebar={sidebar} focusTitle={focusTitle} />
  ) : (
    <SkeletonRegion className={styles.headSkeleton}>
      <Skeleton className={styles.skeletonSubject} />
      <Skeleton className={styles.skeletonChip} />
      <Skeleton className={styles.skeletonSender} />
    </SkeletonRegion>
  );

  let content;
  if (detail.isError && !message) {
    const notFound = isNotFound(detail.error);
    content = (
      <div className={styles.state}>
        <EmptyState
          illustration={notFound ? <NotFoundIllustration /> : <LoadFailedIllustration />}
          title={notFound ? r.notFoundTitle : r.loadFailedTitle}
          body={
            notFound
              ? r.notFoundBody
              : isApiError(detail.error)
                ? detail.error.message
                : t.api.network
          }
          actions={
            notFound ? undefined : (
              <Button loading={detail.isFetching} onClick={() => void detail.refetch()}>
                {t.common.retry}
              </Button>
            )
          }
        />
      </div>
    );
  } else {
    content = (
      <div className={styles.scroll} aria-busy={message ? undefined : true}>
        <article className={styles.inner} aria-labelledby={`subjek-${messageId}`}>
          {head}
          {message ? (
            <>
              <ReaderNotices message={message} />
              {message.body.state === 'ready' && message.body.hasHtml ? (
                <RemoteImagesBar
                  message={message}
                  images={images}
                  onShow={() => setImages('show')}
                />
              ) : null}
              <Attachments attachments={message.attachments} />
              <MailBody message={message} images={images} />
            </>
          ) : (
            <BodySkeleton />
          )}
        </article>
      </div>
    );
  }

  return (
    <div className={styles.reader}>
      <ReaderBar
        onBack={onBack}
        position={position}
        onStep={onStep}
        message={message}
        moveTargets={message ? folders.filter((folder) => folder.id !== message.folderId) : []}
        onAction={(action, folderId) => {
          if (action === 'delete_permanently') setConfirmDelete(true);
          else void run(action, folderId);
        }}
      />
      {content}
      {message ? <ReplyBar message={message} canCompose={canCompose} /> : null}
      <ConfirmDialog
        open={confirmDelete}
        title={r.deleteConfirm.title}
        body={r.deleteConfirm.body}
        cancelLabel={r.cancel}
        confirmLabel={r.deleteConfirm.confirm}
        confirmVariant="danger"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void run('delete_permanently');
        }}
      />
    </div>
  );
}

// ── Bilah aksi ─────────────────────────────────────────────────────────────

function ReaderBar({
  onBack,
  message,
  moveTargets = [],
  onAction,
  position,
  onStep,
}: {
  position?: MailReaderProps['position'];
  onStep?: (messageId: string) => void;
  onBack?: () => void;
  message?: MailMessageDetail;
  moveTargets?: ReturnType<typeof visibleFolders>;
  onAction?: (action: MailAction, folderId?: string) => void;
}) {
  const acts = message
    ? readerActions({ level: message.myLevel, folderRole: message.folderRole })
    : null;
  const button = (action: MailAction, label: string, icon: LucideIcon) => (
    <IconButton label={label} icon={icon} onClick={() => onAction?.(action)} />
  );
  return (
    <div className={styles.bar}>
      {onBack ? (
        <IconButton label={r.back} icon={ArrowLeft} onClick={onBack} className={styles.back} />
      ) : null}
      {message && acts && onAction ? (
        <div className={styles.barActions} role="group" aria-label={r.toolbar}>
          {acts.archive ? button('archive', r.archive, Archive) : null}
          {acts.trash ? button('trash', r.trash, Trash2) : null}
          {acts.deletePermanently
            ? button('delete_permanently', r.deletePermanently, Trash2)
            : null}
          {acts.spam ? button('spam', r.spam, ShieldAlert) : null}
          {acts.notSpam ? button('not_spam', r.notSpam, Inbox) : null}
          {acts.move && moveTargets.length > 0 ? (
            <DropdownMenu.Root modal={false}>
              <Tooltip label={r.move} side="bottom">
                <DropdownMenu.Trigger asChild>
                  <button type="button" className={styles.menuTrigger} aria-label={r.move}>
                    <Icon icon={FolderInput} size={20} />
                  </button>
                </DropdownMenu.Trigger>
              </Tooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  collisionPadding={8}
                  className={styles.menu}
                >
                  <DropdownMenu.Label className={styles.menuLabel}>{r.moveMenu}</DropdownMenu.Label>
                  {moveTargets.map((folder) => (
                    <DropdownMenu.Item
                      key={folder.id}
                      className={styles.menuItem}
                      onSelect={() => onAction('move', folder.id)}
                    >
                      <Icon icon={folderIcon(folder.role)} size={16} />
                      <span className={styles.menuText}>{folderLabel(folder)}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
          <span className={styles.separator} aria-hidden="true" />
          {message.isRead
            ? button('mark_unread', r.markUnread, Mail)
            : button('mark_read', r.markRead, MailOpen)}
          <IconButton
            label={message.isStarred ? r.unstar : r.star}
            icon={Star}
            className={cx(message.isStarred && styles.starred)}
            onClick={() => onAction(message.isStarred ? 'unstar' : 'star')}
          />
        </div>
      ) : null}
      {position && onStep ? (
        <div className={styles.position}>
          <span className={styles.positionText}>{rb.position(position.index, position.total)}</span>
          <IconButton
            label={rb.previous}
            icon={ChevronUp}
            disabled={!position.previous}
            onClick={() => position.previous && onStep(position.previous)}
          />
          <IconButton
            label={rb.next}
            icon={ChevronDown}
            disabled={!position.next}
            onClick={() => position.next && onStep(position.next)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Balas / teruskan (9B) ─────────────────────────────────────────────────

/**
 * Kaki panel baca: Balas · Balas semua · Teruskan (mockup). Balas hanya dari akun yang sama
 * (level ≥ kirim); Teruskan boleh dari akun lain yang ber-hak kirim (KONTRAK-API-EMAIL-TULIS §6.1).
 */
function ReplyBar({ message, canCompose }: { message: MailMessageDetail; canCompose: boolean }) {
  const canReply = canCompose && message.myLevel !== 'read';
  if (!canCompose) return null;
  const open = (kind: 'reply' | 'reply_all' | 'forward') =>
    openCompose({
      kind,
      sourceMessageId: message.id,
      accountId: message.accountId,
      subject: message.subject,
    });
  return (
    <div className={styles.replyBar} role="group" aria-label={rb.actionsLabel}>
      <Button disabled={!canReply} onClick={() => open('reply')}>
        <Icon icon={Reply} size={16} />
        {rb.reply}
      </Button>
      <Button disabled={!canReply} onClick={() => open('reply_all')} aria-label={rb.replyAll}>
        <Icon icon={ReplyAll} size={16} />
        <span className={styles.replyAllLong}>{rb.replyAll}</span>
        <span className={styles.replyAllShort} aria-hidden="true">
          {rb.replyAllShort}
        </span>
      </Button>
      <Button onClick={() => open('forward')}>
        <Icon icon={Forward} size={16} />
        {rb.forward}
      </Button>
      {!canReply ? <p className={styles.replyNote}>{rb.noSendRight}</p> : null}
    </div>
  );
}

/** "Dimas sedang membalas…" (presence 9B; diri sendiri tidak ditampilkan). */
function ComposingChip({ detail }: { detail: MailMessageDetail }) {
  const selfId = useSession()?.user.id;
  const others = (detail.composing ?? []).filter((item) => item.user.id !== selfId);
  const first = others[0];
  if (!first) return null;
  return (
    <span className={styles.composingChip} role="status">
      <Icon icon={PenLine} size={16} />
      {others.length === 1
        ? rb.composing(first.user.name)
        : others.length === 2
          ? rb.composingTwo(first.user.name, others[1]?.user.name ?? '')
          : rb.composingMany(first.user.name, others.length - 1)}
    </span>
  );
}

// ── Kepala: subjek, asal, pengirim, penerima ──────────────────────────────

function ReaderHead({
  summary,
  detail,
  sidebar,
  focusTitle,
}: {
  summary: MailMessageSummary;
  detail?: MailMessageDetail;
  sidebar: MailSidebarResponse;
  focusTitle?: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle]);
  const folder = accountFolders(sidebar, summary.accountId).find(
    (item) => item.id === summary.folderId,
  );
  const folderName = folder
    ? folderLabel(folder)
    : summary.folderRole
      ? MAIL_FOLDER_ROLE_NAMES[summary.folderRole]
      : null;
  const sender = addressName(summary.from);
  const verification = summary.senderVerification;
  return (
    <header className={styles.head}>
      <div className={styles.titleGroup}>
        <h2
          ref={titleRef}
          id={`subjek-${summary.id}`}
          className={styles.subject}
          tabIndex={-1}
          dir="auto"
        >
          {summary.subject?.trim() || l.noSubject}
        </h2>
        <div className={styles.chips}>
          <span className={styles.chip}>
            <AccountMark account={{ ...summary.account, avatarUrl: null }} />
            {folderName
              ? r.folderChip(folderName, summary.account.displayName)
              : summary.account.displayName}
          </span>
          {detail ? <ComposingChip detail={detail} /> : null}
          {summary.pending ? (
            <span className={styles.chip}>
              <Icon icon={Clock} size={16} />
              {l.pending.charAt(0).toLocaleUpperCase('id-ID') + l.pending.slice(1)}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.sender}>
        <ContactAvatar name={sender} className={styles.senderAvatar} />
        <div className={styles.senderText}>
          <p className={styles.who}>
            <span className={styles.senderName} dir="auto">
              {sender}
            </span>
            {summary.from && summary.from.name?.trim() ? (
              <span className={styles.senderAddress}>&lt;{summary.from.address}&gt;</span>
            ) : null}
            <VerificationBadge result={verification} />
            <time className={styles.date} dateTime={summary.receivedAt}>
              {formatDateTime(summary.receivedAt)}
            </time>
          </p>
          {detail ? <Recipients detail={detail} /> : <Skeleton className={styles.skeletonLine} />}
          {detail ? (
            <p className={styles.meta}>
              {r.receivedIn} <strong>{detail.receivedVia.displayName}</strong>
              {detail.deliveredToAlias && detail.deliveredTo ? (
                <>
                  {' · '}
                  {r.sentTo} <strong className={styles.breakable}>{detail.deliveredTo}</strong>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function VerificationBadge({ result }: { result: MailMessageSummary['senderVerification'] }) {
  if (result === 'pass') {
    return (
      <Tooltip label={r.verifiedHint}>
        <span className={styles.badge} data-tone="success" tabIndex={0}>
          <Icon icon={ShieldCheck} size={16} />
          {r.verified}
        </span>
      </Tooltip>
    );
  }
  if (result === 'fail') {
    return (
      <span className={styles.badge} data-tone="danger">
        <Icon icon={ShieldAlert} size={16} />
        {r.failedBadge}
      </span>
    );
  }
  return (
    <span className={styles.badge} data-tone="neutral">
      <Icon icon={Shield} size={16} />
      {r.unverified}
    </span>
  );
}

function Recipients({ detail }: { detail: MailMessageDetail }) {
  const [all, setAll] = useState(false);
  const groups: Array<{ label: string; list: MailAddressView[] }> = [
    { label: r.to, list: detail.to },
    { label: r.cc, list: detail.cc },
    { label: r.bcc, list: detail.bcc ?? [] },
  ].filter((group) => group.list.length > 0);
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.list.length, 0);
  let budget = all ? Number.POSITIVE_INFINITY : RECIPIENTS_SHOWN;
  const hidden = Math.max(0, total - RECIPIENTS_SHOWN);
  return (
    <p className={styles.meta}>
      {groups.map((group, index) => {
        const shown = group.list.slice(0, Math.max(0, budget));
        budget -= shown.length;
        if (shown.length === 0) return null;
        return (
          <span key={group.label}>
            {index > 0 ? ' · ' : ''}
            {group.label}{' '}
            <span className={styles.breakable} dir="auto">
              {shown.map(addressLabel).join(', ')}
            </span>
          </span>
        );
      })}
      {!all && hidden > 0 ? (
        <>
          {' '}
          <button
            type="button"
            className={styles.inlineButton}
            aria-label={r.showAllRecipients(hidden)}
            onClick={() => setAll(true)}
          >
            {r.moreRecipients(hidden)}
          </button>
        </>
      ) : null}
    </p>
  );
}

// ── Peringatan ─────────────────────────────────────────────────────────────

function ReaderNotices({ message }: { message: MailMessageDetail }) {
  const failed = message.verification.result === 'fail';
  const warnings = message.warningDetails;
  if (!failed && warnings.length === 0) return null;
  return (
    <div className={styles.notices}>
      {failed ? (
        <Notice tone="danger" title={r.failedTitle}>
          {message.verification.label}
        </Notice>
      ) : null}
      {warnings.length > 0 ? (
        <Notice tone="warning" title={r.warningsTitle}>
          {warnings.length === 1 ? (
            warnings[0]?.message
          ) : (
            <ul className={styles.warningList}>
              {warnings.map((warning) => (
                <li key={warning.type}>{warning.message}</li>
              ))}
            </ul>
          )}
        </Notice>
      ) : null}
    </div>
  );
}

// ── Gambar luar ────────────────────────────────────────────────────────────

function RemoteImagesBar({
  message,
  images,
  onShow,
}: {
  message: MailMessageDetail;
  images: 'auto' | 'show';
  onShow: () => void;
}) {
  const queryClient = useQueryClient();
  const view = useQuery(mailViewQuery(message.id, images));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = view.data?.remoteImages;
  const autoBlocked = message.body.remoteImages.autoBlocked;
  const address = message.from?.address ?? null;

  if (saved && address) {
    return (
      <p className={styles.imagesSaved} role="status">
        <Icon icon={ImageIcon} size={16} />
        {r.images.alwaysSaved(address)}
      </p>
    );
  }
  // Sebelum token tampilan tiba, perkirakan dari detail supaya bilah tidak muncul belakangan (CLS).
  const { count, senderAllowed } = message.body.remoteImages;
  const hidden = remote
    ? remote.count > 0 && !remote.shown
    : images === 'auto' && count > 0 && (!senderAllowed || autoBlocked);
  if (!hidden) return null;

  const always = async () => {
    if (!address) return;
    setSaving(true);
    setError(null);
    try {
      await endpoints.mail.allowRemoteImages(address);
      queryClient.setQueryData<{ message: MailMessageDetail }>(
        mailKeys.message(message.id),
        (data) =>
          data && {
            message: {
              ...data.message,
              body: {
                ...data.message.body,
                remoteImages: { ...data.message.body.remoteImages, senderAllowed: true },
              },
            },
          },
      );
      setSaved(true);
      onShow();
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.imagesBar}>
      <p className={styles.imagesText}>
        <Icon icon={ImageOff} size={16} className={styles.imagesIcon} />
        {autoBlocked ? r.images.autoBlocked : r.images.blocked}
      </p>
      {/* Tautan teks seperti mockup (bukan dua tombol berbingkai): muat satu baris di HP 390. */}
      <div className={styles.imagesActions}>
        <button type="button" className={styles.linkButton} onClick={onShow}>
          {r.images.show}
        </button>
        {!autoBlocked && address ? (
          <button
            type="button"
            className={styles.linkButton}
            disabled={saving}
            aria-busy={saving || undefined}
            onClick={() => void always()}
          >
            {r.images.always}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={styles.imagesError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ── Isi ────────────────────────────────────────────────────────────────────

function BodySkeleton() {
  return (
    <div className={styles.bodyLoading} role="status">
      <SkeletonRegion className={styles.bodySkeleton}>
        <Skeleton className={styles.skeletonLine} />
        <Skeleton className={styles.skeletonLineLong} />
        <Skeleton className={styles.skeletonLine} />
      </SkeletonRegion>
      <span className="sr-only">{r.bodyLoading}</span>
    </div>
  );
}

function MailBody({ message, images }: { message: MailMessageDetail; images: 'auto' | 'show' }) {
  const { body } = message;
  const queryClient = useQueryClient();
  if (body.state === 'loading' || body.state === 'none') {
    return (
      <div className={styles.bodyLoading} role="status">
        <SkeletonRegion className={styles.bodySkeleton}>
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLineLong} />
          <Skeleton className={styles.skeletonLine} />
        </SkeletonRegion>
        <p className={styles.bodyLoadingText}>{r.bodyLoading}</p>
      </div>
    );
  }
  if (body.state === 'error') {
    return (
      <Notice
        tone="danger"
        role="alert"
        title={r.bodyFailedTitle}
        actions={
          <Button
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: mailKeys.message(message.id) })
            }
          >
            {t.common.retry}
          </Button>
        }
      >
        {r.bodyFailedBody}
      </Notice>
    );
  }
  return (
    <>
      {body.state === 'too_large' ? (
        <Notice tone="warning" title={r.tooLargeTitle}>
          {r.tooLargeBody}
        </Notice>
      ) : null}
      {body.hasHtml ? (
        <HtmlFrame message={message} images={images} />
      ) : (
        <div className={styles.plain} dir="auto">
          {body.text?.trim() ? body.text : <span className={styles.muted}>{r.textEmpty}</span>}
        </div>
      )}
    </>
  );
}

function HtmlFrame({ message, images }: { message: MailMessageDetail; images: 'auto' | 'show' }) {
  const view = useQuery(mailViewQuery(message.id, images));
  const badUrl = view.data !== undefined && !isViewUrl(view.data.url);
  if (view.isError || badUrl) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title={r.viewFailed}
        actions={
          <Button loading={view.isFetching} onClick={() => void view.refetch()}>
            {r.reload}
          </Button>
        }
      >
        {isApiError(view.error) ? view.error.message : badUrl ? r.viewFailed : t.api.network}
      </Notice>
    );
  }
  return (
    <div className={styles.frame}>
      {view.data ? (
        <iframe
          key={view.data.url}
          title={r.frameTitle(message.subject?.trim() || l.noSubject)}
          className={styles.iframe}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          src={view.data.url}
        />
      ) : (
        <SkeletonRegion className={styles.frameSkeleton}>
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLineLong} />
          <Skeleton className={styles.skeletonLine} />
        </SkeletonRegion>
      )}
    </div>
  );
}

// ── Lampiran ───────────────────────────────────────────────────────────────

const KIND_ICONS: Record<AttachmentKind, LucideIcon> = {
  pdf: FileText,
  image: ImageIcon,
  sheet: FileSpreadsheet,
  doc: FileText,
  archive: FileArchive,
  other: File,
};

type DownloadState = { state: 'preparing' } | { state: 'error'; message: string };

function Attachments({ attachments }: { attachments: readonly MailAttachment[] }) {
  const files = attachments.filter((item) => !item.isInline);
  const [states, setStates] = useState<Record<string, DownloadState>>({});
  const [confirmFor, setConfirmFor] = useState<MailAttachment | null>(null);
  /** Lampiran yang sedang diambil server (202): diunduh ulang saat event `ready`. */
  const waiting = useRef(new Map<string, { item: MailAttachment; confirm: boolean }>());
  const setState = useCallback(
    (id: string, value: DownloadState | null) =>
      setStates((current) => {
        const next = { ...current };
        if (value) next[id] = value;
        else delete next[id];
        return next;
      }),
    [],
  );

  const download = useCallback(
    async (item: MailAttachment, confirm: boolean) => {
      setState(item.id, { state: 'preparing' });
      try {
        const result = await endpoints.mail.downloadAttachment(item.id, confirm);
        if (result.state === 'loading') {
          waiting.current.set(item.id, { item, confirm });
          return;
        }
        waiting.current.delete(item.id);
        saveBlob(result.blob, item.filename);
        setState(item.id, null);
      } catch (error) {
        waiting.current.delete(item.id);
        setState(item.id, {
          state: 'error',
          message: isApiError(error) ? error.message : r.attachments.failed,
        });
      }
    },
    [setState],
  );

  useEffect(
    () =>
      onMailSignal((signal) => {
        if (signal.type !== 'attachment.ready' && signal.type !== 'attachment.failed') return;
        const pending = waiting.current.get(signal.attachmentId);
        if (!pending) return;
        waiting.current.delete(signal.attachmentId);
        if (signal.type === 'attachment.ready') void download(pending.item, pending.confirm);
        else
          setState(signal.attachmentId, {
            state: 'error',
            message: signal.code === 'cache_full' ? r.attachments.cacheFull : r.attachments.failed,
          });
      }),
    [download, setState],
  );

  if (files.length === 0) return null;
  const total = files.reduce((sum, item) => sum + item.sizeBytes, 0);

  return (
    <section
      className={styles.attachments}
      aria-label={r.attachments.heading(files.length, formatBytes(total))}
    >
      <h3 className={styles.attachmentsHead}>
        {r.attachments.heading(files.length, formatBytes(total))}
      </h3>
      <ul className={styles.attachmentList}>
        {files.map((item) => {
          const kind = attachmentKind(item.contentType, item.filename);
          const state = states[item.id];
          const blocked = item.risk === 'blocked';
          return (
            <li key={item.id} className={styles.attachment} data-risk={item.risk}>
              <span className={styles.attachmentIcon} data-kind={blocked ? 'blocked' : kind}>
                <Icon icon={blocked ? ShieldAlert : KIND_ICONS[kind]} size={20} />
              </span>
              <span className={styles.attachmentText}>
                <span className={styles.attachmentName} dir="auto" title={item.filename}>
                  {item.filename}
                </span>
                <span className={styles.attachmentMeta}>
                  {blocked ? (
                    <>
                      <span className={styles.attachmentBlocked}>{r.attachments.blocked}</span>
                      {' · '}
                      {
                        r.attachments.blockedReasons[
                          blockedAttachmentReason(item.contentType, item.filename)
                        ]
                      }
                    </>
                  ) : (
                    <>
                      {item.risk === 'warn' ? (
                        <>
                          <span className={styles.attachmentRisky}>{r.attachments.risky}</span>
                          {' · '}
                        </>
                      ) : null}
                      {`${attachmentTypeLabel(item.filename, kind)} · ${formatBytes(item.sizeBytes)}`}
                    </>
                  )}
                </span>
                {blocked && item.riskMessage ? (
                  <span className="sr-only">{item.riskMessage}</span>
                ) : null}
                {state?.state === 'error' ? (
                  <span className={styles.attachmentError} role="alert">
                    {state.message}
                  </span>
                ) : null}
              </span>
              {blocked ? null : state?.state === 'preparing' ? (
                <span
                  className={styles.attachmentButton}
                  role="status"
                  aria-label={r.attachments.preparingLabel(item.filename)}
                >
                  <Icon icon={LoaderCircle} size={20} className={styles.spinning} />
                </span>
              ) : (
                <IconButton
                  label={r.attachments.download(item.filename)}
                  icon={Download}
                  className={styles.attachmentButton}
                  onClick={() =>
                    item.risk === 'warn' ? setConfirmFor(item) : void download(item, false)
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={confirmFor !== null}
        title={r.attachments.warnTitle}
        body={MAIL_ATTACHMENT_WARN_MESSAGE}
        cancelLabel={r.cancel}
        confirmLabel={r.attachments.warnConfirm}
        confirmVariant="primary"
        onCancel={() => setConfirmFor(null)}
        onConfirm={() => {
          const item = confirmFor;
          setConfirmFor(null);
          if (item) void download(item, true);
        }}
      />
    </section>
  );
}
