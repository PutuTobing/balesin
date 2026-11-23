import {
  API_ROUTES,
  MAIL_COMPOSE_MESSAGES,
  apiPath,
  type MailComposeAddress,
  type MailDraft,
  type MailDraftCheckResponse,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Maximize2, Minimize2, Minus, Paperclip, Send, Trash2, X, FileText } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../../components/ui/Dialog';
import { Icon } from '../../../components/ui/Icon';
import { IconButton } from '../../../components/ui/IconButton';
import { Notice } from '../../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../../components/ui/Skeleton';
import { Tooltip } from '../../../components/ui/Tooltip';
import { t } from '../../../i18n/id';
import { isApiError } from '../../../lib/api/client';
import { endpoints } from '../../../lib/api/endpoints';
import { cx } from '../../../lib/cx';
import { useVisualViewportFit } from '../../../lib/use-visual-viewport';
import { useSession } from '../../auth/session';
import { composeIdentitiesQuery, mailKeys } from '../mail-queries';
import { onMailSignal } from '../mail-signals';
import { DEFAULT_ATTACHMENT_MAX_BYTES, useDraftAttachments } from './compose-attachments';
import {
  fillSignature,
  htmlToPlainText,
  isBlankHtml,
  mentionsAttachment,
  signatureIdOfLogoCid,
  textToHtml,
} from './compose-html';
import {
  addRecipients,
  recipientCount,
  removeRecipient,
  type RecipientField as Field,
  type Recipients,
} from './compose-recipients';
import {
  closeCompose,
  patchCompose,
  setComposeMode,
  showSendToast,
  type ComposeIntent,
  type ComposeWindowState,
} from './compose-store';
import { ComposeEditor, type EditorHandle } from './ComposeEditor';
import {
  AttachmentList,
  FormatToolbar,
  FromPicker,
  QuotePanel,
  SignatureMenu,
  SnippetMenu,
  type ComposeIdentity,
  type MailSnippetResponse,
} from './ComposeParts';
import { RecipientField } from './RecipientField';
import { useDraftAutosave } from './use-draft-autosave';
import { useLatest } from './use-latest';
import { checkWarnings, composeTitle, defaultIdentity } from './compose-view';
import styles from './Compose.module.css';

const c = t.mail.compose;
const clockFormat = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });

/** Detak penanda "sedang membalas" (KONTRAK-API-EMAIL-TULIS §11: 20 dtk, TTL 45 dtk). */
const PRESENCE_HEARTBEAT_MS = 20_000;

interface ComposeWindowProps {
  window: ComposeWindowState;
  /** HP: layar penuh. */
  fullscreen: boolean;
  /** "Lihat" email baru di utas: buka email itu di panel baca. */
  onOpenMessage: (messageId: string) => void;
}

/** Buat draf sekali per jendela (StrictMode memanggil efek dua kali). */
const creations = new Map<string, Promise<{ draft: MailDraft; skipped: Skipped }>>();
type Skipped = Array<{ filename: string; reason: string }>;

function createFor(
  key: string,
  intent: Exclude<ComposeIntent, { kind: 'draft' }>,
  identityId: string | null,
) {
  const existing = creations.get(key);
  if (existing) return existing;
  const request = endpoints.mail
    .createDraft(
      intent.kind === 'new'
        ? {
            mode: 'new',
            identityId,
            ...(intent.to ? { to: intent.to } : {}),
            ...(intent.subject ? { subject: intent.subject } : {}),
          }
        : { mode: intent.kind, sourceMessageId: intent.sourceMessageId },
    )
    .then((response) => ({ draft: response.draft, skipped: response.skippedAttachments }));
  creations.set(key, request);
  request.catch(() => creations.delete(key));
  return request;
}

/**
 * Satu jendela tulis (mockup docs/design/email, keadaan Tulis): desktop mengambang 600×600 di
 * kanan bawah (perkecil/perbesar), HP layar penuh. Membuat atau membuka draf, lalu menyerahkan isi
 * ke `ComposeForm`.
 */
export function ComposeWindow({ window: win, fullscreen, onOpenMessage }: ComposeWindowProps) {
  const queryClient = useQueryClient();
  const identities = useQuery(composeIdentitiesQuery);
  // HP: keyboard iOS tidak mengecilkan 100dvh — jendela layar penuh mengikuti area terlihat.
  const sectionRef = useRef<HTMLElement>(null);
  const noFitRef = useRef<HTMLElement>(null);
  useVisualViewportFit(fullscreen ? sectionRef : noFitRef);
  const [created, setCreated] = useState<{ draft: MailDraft; skipped: Skipped } | null>(null);
  const [createError, setCreateError] = useState<unknown>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const intent = win.intent;

  // Belum ada draf: buat (baru butuh identitas bawaan; balas/teruskan ditentukan server).
  const needsIdentity = intent.kind === 'new';
  const identityId =
    needsIdentity && identities.data
      ? (defaultIdentity(identities.data.identities, intent.accountId)?.id ?? null)
      : null;
  const ready = !needsIdentity || identities.data !== undefined;
  useEffect(() => {
    if (win.draftId || intent.kind === 'draft' || !ready) return;
    if (needsIdentity && identityId === null) return;
    let live = true;
    createFor(win.key, intent, identityId)
      .then((result) => {
        if (!live) return;
        queryClient.setQueryData(mailKeys.draft(result.draft.id), { draft: result.draft });
        setCreated(result);
        patchCompose(win.key, {
          draftId: result.draft.id,
          title: result.draft.subject,
          draftMode: result.draft.mode,
        });
      })
      .catch((error: unknown) => {
        if (live) setCreateError(error);
      });
    return () => {
      live = false;
    };
  }, [identityId, intent, needsIdentity, queryClient, ready, win.draftId, win.key]);

  const draftId = win.draftId;
  const draft = useQuery({
    queryKey: mailKeys.draft(draftId ?? ''),
    queryFn: ({ signal }) => endpoints.mail.draft(draftId ?? '', signal),
    enabled: draftId !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2,
  });

  useEffect(() => {
    if (draft.data) {
      patchCompose(win.key, {
        title: draft.data.draft.subject,
        draftMode: draft.data.draft.mode,
      });
    }
    // Hanya saat draf (versi) dimuat ulang.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.data?.draft.id, draft.data?.draft.version]);

  // Jendela ditutup: cache draf dibuang supaya membuka lagi (batal kirim, folder Draf) memuat versi
  // terbaru dari server, bukan salinan saat jendela pertama dibuka.
  useEffect(
    () => () => {
      if (draftId) queryClient.removeQueries({ queryKey: mailKeys.draft(draftId) });
    },
    [draftId, queryClient],
  );

  const title = composeTitle(win.draftMode, win.title);
  const minimized = win.mode === 'minimized' && !fullscreen;
  const noIdentity = needsIdentity && identities.data && identityId === null;
  const error = createError ?? draft.error ?? identities.error;

  let body;
  if (draft.data) {
    body = (
      <ComposeForm
        key={`${draft.data.draft.id}:${String(reloadTick)}`}
        win={win}
        draft={draft.data.draft}
        skipped={created?.draft.id === draft.data.draft.id ? created.skipped : []}
        identities={identities.data?.identities ?? []}
        fullscreen={fullscreen}
        hidden={minimized}
        onOpenMessage={onOpenMessage}
        onReload={async () => {
          await draft.refetch();
          setReloadTick((tick) => tick + 1);
        }}
      />
    );
  } else if (noIdentity) {
    body = (
      <div className={styles.windowState}>
        <Notice tone="warning" title={c.noIdentitiesTitle}>
          {c.noIdentitiesBody}
        </Notice>
      </div>
    );
  } else if (error) {
    body = (
      <div className={styles.windowState}>
        <Notice
          tone="danger"
          role="alert"
          title={c.loadFailedTitle}
          actions={
            isApiError(error) && error.status === 404 ? undefined : (
              <Button
                onClick={() => {
                  setCreateError(null);
                  creations.delete(win.key);
                  void identities.refetch();
                  if (draftId) void draft.refetch();
                }}
              >
                {t.common.retry}
              </Button>
            )
          }
        >
          {isApiError(error) && error.status === 404
            ? c.notFound
            : isApiError(error)
              ? error.message
              : t.api.network}
        </Notice>
      </div>
    );
  } else {
    body = (
      <SkeletonRegion className={styles.windowSkeleton}>
        <Skeleton className={styles.skeletonRow} />
        <Skeleton className={styles.skeletonRow} />
        <Skeleton className={styles.skeletonRow} />
        <Skeleton className={styles.skeletonBody} />
        <span className="sr-only">{c.loading}</span>
      </SkeletonRegion>
    );
  }

  return (
    <section
      ref={sectionRef}
      className={styles.window}
      data-mode={fullscreen ? 'fullscreen' : win.mode}
      aria-label={c.windowLabel(title)}
      role="dialog"
      aria-modal={fullscreen || win.mode === 'maximized' ? true : undefined}
    >
      {fullscreen ? null : (
        <header className={styles.windowBar}>
          <button
            type="button"
            className={styles.windowTitle}
            onClick={() => setComposeMode(win.key, minimized ? 'open' : 'minimized')}
            aria-label={minimized ? c.restore : c.minimize}
            aria-expanded={!minimized}
          >
            <span className={styles.windowTitleText} dir="auto">
              {title}
            </span>
          </button>
          {minimized ? null : (
            <IconButton
              label={c.minimize}
              icon={Minus}
              className={styles.barButton}
              onClick={() => setComposeMode(win.key, 'minimized')}
            />
          )}
          <IconButton
            label={win.mode === 'maximized' ? c.unmaximize : c.maximize}
            icon={win.mode === 'maximized' ? Minimize2 : Maximize2}
            className={styles.barButton}
            onClick={() => setComposeMode(win.key, win.mode === 'maximized' ? 'open' : 'maximized')}
          />
          <IconButton
            label={c.close}
            icon={X}
            className={styles.barButton}
            onClick={() => closeCompose(win.key)}
          />
        </header>
      )}
      {draft.data ? (
        body
      ) : (
        <div className={styles.windowBody} hidden={minimized}>
          {fullscreen ? (
            <div className={styles.hpBar}>
              <IconButton label={c.closeHp} icon={X} onClick={() => closeCompose(win.key)} />
              <div className={styles.hpTitle}>
                <h2 className={styles.hpHeading}>{title}</h2>
              </div>
            </div>
          ) : null}
          {body}
        </div>
      )}
    </section>
  );
}

// ── Isi jendela ────────────────────────────────────────────────────────────

interface ComposeFormProps {
  win: ComposeWindowState;
  draft: MailDraft;
  skipped: Skipped;
  identities: readonly ComposeIdentity[];
  fullscreen: boolean;
  hidden: boolean;
  onOpenMessage: (messageId: string) => void;
  onReload: () => Promise<void>;
}

type Banner = { tone: 'danger' | 'warning'; text: string; verifyAccountId?: string };
type PreSendReason = 'subject' | 'attachment';

function ComposeForm({
  win,
  draft,
  skipped,
  identities,
  fullscreen,
  hidden,
  onOpenMessage,
  onReload,
}: ComposeFormProps) {
  const session = useSession();
  const formId = useId();
  const editorRef = useRef<EditorHandle>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [identityId, setIdentityId] = useState(draft.identityId);
  const [recipients, setRecipients] = useState<Recipients>({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
  });
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [showBcc, setShowBcc] = useState(draft.bcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [format, setFormat] = useState(draft.format);
  const [bodyText, setBodyText] = useState(draft.bodyText ?? '');
  const [includeQuote, setIncludeQuote] = useState(draft.includeQuote);
  const [banner, setBanner] = useState<Banner | null>(
    draft.lastSendError
      ? { tone: 'danger', text: draft.lastSendError.message }
      : draft.state === 'sending'
        ? { tone: 'warning', text: MAIL_COMPOSE_MESSAGES.draftLocked }
        : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [checks, setChecks] = useState<MailDraftCheckResponse['checks'] | null>(null);
  const [serverCopy, setServerCopy] = useState(draft.serverCopy.state);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: 'conflict' }
    | { kind: 'thread'; count: number; latest: string | null; messageIds: string[] }
    | { kind: 'presend'; reasons: PreSendReason[] }
    | { kind: 'discard' }
    | { kind: 'plain' }
    | null
  >(null);
  const sendingRef = useRef(false);
  const closing = useRef<'send' | 'discard' | 'close' | null>(null);
  const needsCheck = useRef(draft.mode !== 'new');

  const identity = identities.find((item) => item.id === identityId) ?? null;
  const purpose = draft.mode === 'reply' || draft.mode === 'reply_all' ? 'reply' : 'new';

  // Isi terkini dibaca autosave tepat sebelum dikirim.
  const latest = useLatest({ identityId, recipients, subject, format, bodyText, includeQuote });

  const autosave = useDraftAutosave({
    draftId: draft.id,
    initialVersion: draft.version,
    initialSavedAt: draft.updatedAt,
    collect: () => {
      const now = latest.current;
      const html =
        now.format === 'html' ? (editorRef.current?.getHtml() ?? draft.bodyHtml ?? '') : null;
      return {
        identityId: now.identityId,
        to: now.recipients.to,
        cc: now.recipients.cc,
        bcc: now.recipients.bcc,
        subject: now.subject,
        format: now.format,
        bodyHtml: html,
        bodyText: now.format === 'text' ? now.bodyText : null,
        includeQuote: now.includeQuote,
      };
    },
    onSaved: (saved) => {
      setServerCopy(saved.serverCopy.state);
      if (saved.sanitizedHtml !== null && latest.current.format === 'html') {
        editorRef.current?.setHtml(saved.sanitizedHtml);
      }
      if (needsCheck.current) {
        needsCheck.current = false;
        void runCheck();
      }
    },
    onConflict: () => setDialog({ kind: 'conflict' }),
  });
  const { markDirty, flush } = autosave;

  const attachments = useDraftAttachments({
    draftId: draft.id,
    initial: draft.attachments,
    maxBytes: checks?.attachments.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
    onVersion: autosave.noteOwnVersion,
    onInlineReady: (attachment) => {
      if (attachment.contentId)
        editorRef.current?.insertImage(attachment.contentId, attachment.filename);
    },
  });
  // `cid:` gambar inline draf → URL pratinjau (hanya untuk tampilan editor).
  const inlineById = useLatest(
    new Map(
      attachments.attachments
        .filter((item) => item.inline && item.contentId)
        .map((item) => [
          item.contentId ?? '',
          `${apiPath(API_ROUTES.mail.draftAttachment, { draftId: draft.id, attachmentId: item.id })}?preview=1`,
        ]),
    ),
  );
  const resolveCid = useCallback(
    (cid: string) => {
      const signatureId = signatureIdOfLogoCid(cid);
      if (signatureId) return apiPath(API_ROUTES.mail.signatureLogo, { signatureId });
      return inlineById.current.get(cid) ?? null;
    },
    [inlineById],
  );

  const runCheck = useCallback(async () => {
    try {
      const response = await endpoints.mail.checkDraft(draft.id);
      setChecks(response.checks);
    } catch {
      // Cek hanya peringatan; server tetap memeriksa saat kirim.
    }
  }, [draft.id]);

  // Balasan: cek awal (balas-ke berbeda, penerima luar domain).
  useEffect(() => {
    if (draft.mode !== 'new') {
      needsCheck.current = false;
      void runCheck();
    }
  }, [draft.mode, runCheck]);

  // Judul bilah ikut subjek.
  useEffect(() => {
    patchCompose(win.key, { title: subject });
  }, [subject, win.key]);

  // Diperkecil: simpan sekarang.
  useEffect(() => {
    if (hidden) void flush();
  }, [hidden, flush]);

  // Penanda "sedang membalas" (balas/teruskan dengan utas): detak 20 dtk, keluar saat ditutup.
  useEffect(() => {
    if (!draft.threadKey || draft.mode === 'new') return;
    const beat = () => {
      if (document.visibilityState === 'hidden') return;
      void endpoints.mail.presence(draft.id, true).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      void endpoints.mail.presence(draft.id, false).catch(() => undefined);
    };
  }, [draft.id, draft.mode, draft.threadKey]);

  // Email baru di utas yang sama → bilah "Ada email baru di utas ini". Draf dibuang di tab lain → tutup.
  useEffect(
    () =>
      onMailSignal((signal) => {
        if (
          signal.type === 'message.created' &&
          draft.threadKey &&
          signal.accountId === draft.accountId &&
          signal.threadKey === draft.threadKey
        ) {
          setThreadMessageId(signal.messageId);
        }
        if (signal.type === 'draft.deleted' && signal.draftId === draft.id) {
          closing.current = 'discard';
          closeCompose(win.key);
        }
      }),
    [draft.accountId, draft.id, draft.threadKey, win.key],
  );

  const attachmentsRef = useLatest(attachments.attachments.length + attachments.uploads.length);
  // Ditutup (oleh pengguna atau batas jendela): simpan dulu; draf baru yang kosong dibuang.
  useEffect(
    () => () => {
      if (closing.current === 'send' || closing.current === 'discard') return;
      const now = latest.current;
      const html = editorRef.current?.getHtml() ?? '';
      const empty =
        draft.mode === 'new' &&
        recipientCount(now.recipients) === 0 &&
        now.subject.trim() === '' &&
        (now.format === 'html' ? isBlankHtml(stripSignature(html)) : now.bodyText.trim() === '') &&
        attachmentsRef.current === 0;
      if (empty) void endpoints.mail.deleteDraft(draft.id).catch(() => undefined);
      else void flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const changeRecipients = (next: Recipients) => {
    setRecipients(next);
    needsCheck.current = true;
    markDirty();
  };
  const addTo = (field: Field, items: MailComposeAddress[]) => {
    const result = addRecipients(recipients, field, items);
    changeRecipients(result.next);
    return result.duplicates;
  };
  const removeFrom = (field: Field, address: string) =>
    changeRecipients(removeRecipient(recipients, field, address));

  const changeIdentity = async (next: ComposeIdentity) => {
    setIdentityId(next.id);
    needsCheck.current = true;
    markDirty();
    if (latest.current.format !== 'html') return;
    try {
      const signature = await endpoints.mail.identitySignature(next.id, purpose);
      editorRef.current?.replaceSignature(signature.html, signature.signatureId);
    } catch {
      setNotice(c.signature.failed);
    }
  };

  const pickSignature = (picked: { id: string; html: string; hasLogo: boolean } | null) => {
    if (!picked) {
      editorRef.current?.replaceSignature('', null);
      return;
    }
    const html = fillSignature(picked.html, {
      signatureId: picked.id,
      agentName: session?.user.name ?? '',
      senderAddress: identity?.address ?? '',
      organizationName: session?.organization.name ?? '',
      hasLogo: picked.hasLogo,
    });
    editorRef.current?.replaceSignature(html, picked.id);
  };

  const insertSnippet = (snippet: MailSnippetResponse) => {
    if (latest.current.format === 'html') {
      const dropped = editorRef.current?.insertHtml(snippet.html) ?? 0;
      if (dropped > 0) setNotice(c.pastedImagesDropped);
    } else {
      const area = textRef.current;
      const start = area?.selectionStart ?? bodyText.length;
      const end = area?.selectionEnd ?? bodyText.length;
      setBodyText((current) => `${current.slice(0, start)}${snippet.text}${current.slice(end)}`);
    }
    if (!latest.current.subject.trim() && snippet.subject) setSubject(snippet.subject);
    markDirty();
  };

  const toggleFormat = () => {
    if (format === 'html') {
      setDialog({ kind: 'plain' });
      return;
    }
    const html = textToHtml(bodyText);
    setFormat('html');
    // Editor dipasang ulang dengan isi dari teks.
    setEditorSeed(html);
    markDirty();
  };
  /** Isi awal editor saat beralih dari teks biasa ke berformat. */
  const [editorSeed, setEditorSeed] = useState<string | null>(null);

  const recipientTotal = recipientCount(recipients);
  const canSend = identity?.canSend ?? draft.canSend;

  const send = async (acknowledge: string | null = null) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setBanner(null);
    try {
      const saved = await flush();
      if (!saved) {
        const failure = autosave.currentStatus();
        if (failure === 'conflict') setDialog({ kind: 'conflict' });
        else if (failure === 'locked') {
          setBanner({ tone: 'warning', text: MAIL_COMPOSE_MESSAGES.draftLocked });
        } else if (failure === 'gone') setBanner({ tone: 'danger', text: c.notFound });
        else setBanner({ tone: 'danger', text: c.footer.saveFailed });
        return;
      }
      const response = await endpoints.mail.sendDraft(draft.id, {
        baseVersion: autosave.version(),
        acknowledgeNewMessagesUntil: acknowledge,
      });
      closing.current = 'send';
      closeCompose(win.key);
      showSendToast(response.outbox);
    } catch (error) {
      const reason = isApiError(error)
        ? error.details.find((detail) => detail.reason)?.reason
        : undefined;
      const detail = isApiError(error)
        ? error.details.find((item) => item.reason === reason)
        : undefined;
      if (reason === 'thread_has_new_messages') {
        setDialog({
          kind: 'thread',
          count: detail?.count ?? 1,
          latest: detail?.latestReceivedAt ?? null,
          messageIds: detail?.messageIds ?? [],
        });
      } else if (reason === 'draft_version_conflict') {
        setDialog({ kind: 'conflict' });
      } else if (reason === 'identity_unverified' || reason === 'identity_not_approved') {
        setBanner({
          tone: 'danger',
          text: isApiError(error) ? error.message : c.fromUnverifiedBody,
          verifyAccountId: draft.accountId,
        });
      } else {
        setBanner({ tone: 'danger', text: isApiError(error) ? error.message : t.api.network });
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const requestSend = () => {
    if (sendingRef.current) return;
    if (recipientTotal === 0) {
      setBanner({ tone: 'danger', text: MAIL_COMPOSE_MESSAGES.noRecipients });
      toRef.current?.focus();
      return;
    }
    if (attachments.busy) {
      setBanner({ tone: 'warning', text: MAIL_COMPOSE_MESSAGES.attachmentsNotReady });
      return;
    }
    const reasons: PreSendReason[] = [];
    if (!subject.trim()) reasons.push('subject');
    const content = format === 'html' ? (editorRef.current?.getHtml() ?? '') : bodyText;
    if (
      attachments.attachments.filter((item) => !item.inline).length === 0 &&
      mentionsAttachment(content, format)
    ) {
      reasons.push('attachment');
    }
    if (reasons.length > 0) {
      setDialog({ kind: 'presend', reasons });
      return;
    }
    void send();
  };

  const close = () => {
    closing.current = 'close';
    closeCompose(win.key);
  };

  const discard = async () => {
    closing.current = 'discard';
    closeCompose(win.key);
    try {
      await endpoints.mail.deleteDraft(draft.id);
    } catch {
      // Draf tetap ada di folder Draf; tidak ada yang hilang.
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      requestSend();
    }
    if (event.key === 'Escape' && !fullscreen && !event.defaultPrevented) {
      const target = event.target as HTMLElement;
      if (target.closest('[role="listbox"], [role="menu"], dialog')) return;
      setComposeMode(win.key, 'minimized');
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    attachments.add(Array.from(event.dataTransfer.files));
  };

  const title = composeTitle(draft.mode, subject);
  const status = autosave.status;
  const statusText =
    status === 'saving'
      ? c.footer.saving
      : status === 'error'
        ? c.footer.saveFailed
        : status === 'dirty'
          ? c.footer.unsaved
          : autosave.savedAt
            ? c.footer.saved(clockFormat.format(new Date(autosave.savedAt)))
            : '';
  const locked = status === 'locked' || draft.state === 'sending';
  const disabled = locked || sending;
  const allowOtherAccounts = draft.mode === 'new' && attachments.attachments.length === 0;
  const flagged = useMemo(
    () =>
      new Set(
        checks?.recipients
          .filter((item) => item.external || !item.valid)
          .map((item) => item.address.toLowerCase()) ?? [],
      ),
    [checks],
  );
  const warnings = checkWarnings(checks, draft);
  const html = format === 'html';

  const fields = (
    <>
      <div className={styles.row}>
        <span className={styles.rowLabel} id={`${formId}-dari`}>
          {c.from}
        </span>
        <div className={styles.rowValue}>
          <FromPicker
            identities={identities}
            currentId={identityId}
            disabled={disabled || identities.length === 0}
            isAllowed={(item) => item.accountId === draft.accountId || allowOtherAccounts}
            onChange={(next) => void changeIdentity(next)}
          />
        </div>
      </div>
      <RecipientField
        label={c.to}
        inputLabel={c.toLabel}
        values={recipients.to}
        onAdd={(items) => addTo('to', items)}
        onRemove={(address) => removeFrom('to', address)}
        accountId={draft.accountId}
        disabled={disabled}
        inputRef={toRef}
        flagged={flagged}
        trailing={
          showCc || showBcc ? null : (
            <button
              type="button"
              className={styles.copyToggle}
              aria-label={c.showCopiesLabel}
              onClick={() => {
                setShowCc(true);
                setShowBcc(true);
              }}
            >
              {c.showCopies}
            </button>
          )
        }
      />
      {showCc ? (
        <RecipientField
          label={c.cc}
          inputLabel={c.ccLabel}
          values={recipients.cc}
          onAdd={(items) => addTo('cc', items)}
          onRemove={(address) => removeFrom('cc', address)}
          accountId={draft.accountId}
          disabled={disabled}
          flagged={flagged}
        />
      ) : null}
      {showBcc ? (
        <RecipientField
          label={c.bcc}
          inputLabel={c.bccLabel}
          values={recipients.bcc}
          onAdd={(items) => addTo('bcc', items)}
          onRemove={(address) => removeFrom('bcc', address)}
          accountId={draft.accountId}
          disabled={disabled}
          flagged={flagged}
          trailing={
            <Tooltip label={c.bccHiddenHint}>
              <span className={styles.bccNote} tabIndex={0}>
                {c.bccHidden}
              </span>
            </Tooltip>
          }
        />
      ) : null}
      <div className={styles.row}>
        <label className={styles.rowLabel} htmlFor={`${formId}-subjek`}>
          {c.subject}
        </label>
        <input
          id={`${formId}-subjek`}
          className={styles.subjectInput}
          value={subject}
          maxLength={200}
          disabled={disabled}
          dir="auto"
          onChange={(event) => {
            setSubject(event.target.value.replace(/[\r\n]+/g, ' '));
            markDirty();
          }}
        />
      </div>
    </>
  );

  const editor = html ? (
    <ComposeEditor
      ref={editorRef}
      initialHtml={editorSeed ?? draft.bodyHtml ?? ''}
      resolveCid={resolveCid}
      label={c.bodyLabel}
      placeholder={c.bodyPlaceholder}
      disabled={disabled}
      onChange={markDirty}
      onSlash={() => setSnippetOpen(true)}
      onImagesDropped={() => setNotice(c.pastedImagesDropped)}
      onFiles={(files) => {
        const images = files.filter((file) => file.type.startsWith('image/'));
        if (images.length === files.length) attachments.add(images, { inline: true });
        else attachments.add(files);
      }}
    />
  ) : (
    <textarea
      ref={textRef}
      className={styles.plainEditor}
      aria-label={c.bodyLabel}
      value={bodyText}
      disabled={disabled}
      dir="auto"
      onChange={(event) => {
        setBodyText(event.target.value);
        markDirty();
      }}
    />
  );

  const attachButton = (
    <IconButton
      label={c.attachments.attach}
      icon={Paperclip}
      className={styles.tool}
      disabled={disabled}
      onClick={() => fileRef.current?.click()}
    />
  );
  const templateButton = (
    <SnippetMenu
      draftId={draft.id}
      open={snippetOpen}
      onOpenChange={(open) => {
        if (open) editorRef.current?.rememberSelection();
        setSnippetOpen(open);
      }}
      onInsert={insertSnippet}
      trigger={
        <button
          type="button"
          className={cx(styles.tool, styles.toolTrigger)}
          aria-label={c.template.button}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Icon icon={FileText} size={20} />
        </button>
      }
    />
  );
  const signatureButton = (
    <SignatureMenu
      accountId={draft.accountId}
      getCurrentId={() => editorRef.current?.signatureId() ?? null}
      disabled={disabled || !html}
      onPick={pickSignature}
    />
  );

  return (
    <div
      ref={rootRef}
      className={styles.windowBody}
      hidden={hidden}
      onKeyDown={onKeyDown}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      data-dragging={dragging ? '' : undefined}
    >
      {fullscreen ? (
        <div className={styles.hpBar}>
          <IconButton label={c.closeHp} icon={X} onClick={close} />
          <div className={styles.hpTitle}>
            <h2 className={styles.hpHeading} dir="auto">
              {title}
            </h2>
            <p className={styles.hpStatus} role="status">
              {statusText}
            </p>
          </div>
          {attachButton}
          <Tooltip label={c.footer.send}>
            <button
              type="button"
              className={styles.hpSend}
              aria-label={sending ? c.footer.sending : c.footer.send}
              aria-busy={sending || undefined}
              disabled={disabled || !canSend}
              onClick={requestSend}
            >
              <Icon icon={Send} size={20} />
            </button>
          </Tooltip>
        </div>
      ) : null}

      <div className={styles.scrollArea}>
        {fields}
        {banner ? (
          <div className={styles.banner}>
            <Notice
              tone={banner.tone}
              role="alert"
              title={
                banner.tone === 'danger' &&
                draft.lastSendError &&
                banner.text === draft.lastSendError.message
                  ? c.failedTitle
                  : undefined
              }
              actions={
                banner.verifyAccountId ? (
                  <Button asChild>
                    <Link
                      to="/pengaturan/akun-email/$accountId"
                      params={{ accountId: banner.verifyAccountId }}
                      hash="alamat-pengirim"
                    >
                      {c.verifyLink}
                    </Link>
                  </Button>
                ) : undefined
              }
            >
              {banner.text}
            </Notice>
          </div>
        ) : null}
        {!canSend && identity && !banner ? (
          <div className={styles.banner}>
            <Notice
              tone="warning"
              title={c.fromUnverifiedTitle}
              actions={
                <Button asChild>
                  <Link
                    to="/pengaturan/akun-email/$accountId"
                    params={{ accountId: identity.accountId }}
                    hash="alamat-pengirim"
                  >
                    {c.verifyLink}
                  </Link>
                </Button>
              }
            >
              {c.fromUnverifiedBody}
            </Notice>
          </div>
        ) : null}
        {threadMessageId ? (
          <div className={styles.threadBar} role="status">
            <span>{c.threadNew.bar}</span>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setComposeMode(win.key, 'minimized');
                onOpenMessage(threadMessageId);
              }}
            >
              {c.threadNew.view}
            </button>
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <ul className={styles.warnings}>
            {warnings.map((text) => (
              <li key={text} className={styles.warning}>
                {text}
              </li>
            ))}
          </ul>
        ) : null}
        {skipped.length > 0 ? (
          <div className={styles.banner}>
            <Notice tone="warning" title={c.attachments.skippedTitle}>
              <ul className={styles.skippedList}>
                {skipped.map((item) => (
                  <li key={item.filename}>
                    <span dir="auto">{item.filename}</span>:{' '}
                    {c.attachments.skippedReasons[item.reason] ?? item.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}

        {fullscreen ? null : (
          <FormatToolbar
            editorRef={editorRef}
            format={format}
            disabled={disabled}
            onToggleFormat={toggleFormat}
            onPickImage={() => imageRef.current?.click()}
          />
        )}
        <div className={styles.bodyArea}>
          {editor}
          {notice ? (
            <p className={styles.inlineNote} role="status">
              {notice}
              <button
                type="button"
                className={styles.inlineDismiss}
                aria-label={c.toast.dismiss}
                onClick={() => setNotice(null)}
              >
                <Icon icon={X} size={16} />
              </button>
            </p>
          ) : null}
          <QuotePanel
            draft={draft}
            includeQuote={includeQuote}
            disabled={disabled}
            onIncludeChange={(next) => {
              setIncludeQuote(next);
              markDirty();
            }}
          />
          <AttachmentList
            attachments={attachments.attachments}
            uploads={attachments.uploads}
            disabled={disabled}
            onRemove={(item) => void attachments.remove(item)}
            onCancel={attachments.cancel}
            onDismiss={attachments.dismiss}
          />
          {attachments.removeError ? (
            <p className={styles.inlineError} role="alert">
              {attachments.removeError}
            </p>
          ) : null}
          {serverCopy === 'disabled' || serverCopy === 'error' ? (
            <p className={styles.inlineNote}>
              {serverCopy === 'disabled' ? c.serverCopy.disabled : c.serverCopy.error}
            </p>
          ) : null}
        </div>
        {dragging ? (
          <div className={styles.dropZone} aria-hidden="true">
            <Icon icon={Paperclip} size={20} />
            {c.attachments.dropHere}
          </div>
        ) : null}
      </div>

      {fullscreen ? (
        <div className={styles.hpTools}>
          <FormatToolbar
            editorRef={editorRef}
            format={format}
            disabled={disabled}
            compact
            onToggleFormat={toggleFormat}
            onPickImage={() => imageRef.current?.click()}
          />
          {templateButton}
          {signatureButton}
          <span className={styles.toolSeparator} aria-hidden="true" />
          <IconButton
            label={c.footer.discard}
            icon={Trash2}
            className={styles.tool}
            disabled={sending}
            onClick={() => setDialog({ kind: 'discard' })}
          />
        </div>
      ) : (
        <footer className={styles.footer}>
          <Button
            variant="primary"
            className={styles.sendButton}
            loading={sending}
            disabled={disabled || !canSend}
            onClick={requestSend}
          >
            {sending ? c.footer.sending : c.footer.send}
          </Button>
          {attachButton}
          {templateButton}
          {signatureButton}
          <span className={styles.saveStatus} role="status">
            {statusText}
          </span>
          <IconButton
            label={c.footer.discard}
            icon={Trash2}
            className={styles.tool}
            disabled={sending}
            onClick={() => setDialog({ kind: 'discard' })}
          />
        </footer>
      )}

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          attachments.add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <input
        ref={imageRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        tabIndex={-1}
        onChange={(event) => {
          attachments.add(Array.from(event.target.files ?? []), { inline: true });
          event.target.value = '';
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === 'discard'}
        title={c.discardConfirm.title}
        body={c.discardConfirm.body}
        cancelLabel={c.linkForm.cancel}
        confirmLabel={c.discardConfirm.confirm}
        confirmVariant="danger"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          void discard();
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'plain'}
        title={c.toPlainTitle}
        body={c.toPlainBody}
        cancelLabel={c.linkForm.cancel}
        confirmLabel={c.toPlainConfirm}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          const current = editorRef.current?.getHtml() ?? draft.bodyHtml ?? '';
          setBodyText(htmlToPlainText(current));
          setFormat('text');
          setEditorSeed(null);
          markDirty();
        }}
      />
      <Dialog
        open={dialog?.kind === 'conflict'}
        title={c.conflict.title}
        description={c.conflict.body}
        onRequestClose={() => setDialog(null)}
      >
        <DialogActions>
          <Button
            onClick={() => {
              setDialog(null);
              closing.current = 'discard';
              void onReload();
            }}
          >
            {c.conflict.reload}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setDialog(null);
              void flush({ force: true });
            }}
          >
            {c.conflict.overwrite}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={dialog?.kind === 'thread'}
        title={c.threadNew.dialogTitle}
        description={
          dialog?.kind === 'thread' ? MAIL_COMPOSE_MESSAGES.threadHasNewMessages(dialog.count) : ''
        }
        onRequestClose={() => setDialog(null)}
      >
        <DialogActions>
          <Button
            onClick={() => {
              const target = dialog?.kind === 'thread' ? dialog.messageIds[0] : undefined;
              setDialog(null);
              if (target) {
                setComposeMode(win.key, 'minimized');
                onOpenMessage(target);
              }
            }}
          >
            {c.threadNew.viewFirst}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const until = dialog?.kind === 'thread' ? dialog.latest : null;
              setDialog(null);
              void send(until ?? new Date().toISOString());
            }}
          >
            {c.threadNew.sendAnyway}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={dialog?.kind === 'presend'}
        title={
          dialog?.kind === 'presend' && dialog.reasons[0] === 'subject'
            ? c.preSend.noSubjectTitle
            : c.preSend.attachmentTitle
        }
        description={
          dialog?.kind === 'presend' ? (
            <>
              {dialog.reasons.map((reason) => (
                <p key={reason}>
                  {reason === 'subject' ? c.preSend.noSubjectBody : c.preSend.attachmentBody}
                </p>
              ))}
            </>
          ) : null
        }
        onRequestClose={() => setDialog(null)}
      >
        <DialogActions>
          <Button onClick={() => setDialog(null)}>{c.preSend.back}</Button>
          <Button
            variant="primary"
            onClick={() => {
              setDialog(null);
              void send();
            }}
          >
            {c.preSend.sendAnyway}
          </Button>
        </DialogActions>
      </Dialog>
      <span className="sr-only">{locked ? c.lockedNote : ''}</span>
    </div>
  );
}

/** Blok tanda tangan tidak dihitung saat menilai draf kosong. */
function stripSignature(html: string): string {
  return html.replace(/<div data-signature="[^"]*">[\s\S]*<\/div>\s*$/i, '');
}
