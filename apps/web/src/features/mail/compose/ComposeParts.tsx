import type {
  MailComposeIdentityListResponse,
  MailDraft,
  MailDraftAttachment,
  mailSnippetResponseSchema,
} from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { DropdownMenu, Popover } from 'radix-ui';
import {
  AlertTriangle,
  Bold,
  Check,
  ChevronDown,
  File,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  LoaderCircle,
  MessageSquareQuote,
  PenLine,
  Quote,
  RotateCcw,
  Search,
  ShieldCheck,
  Underline,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react';
import type { z } from 'zod';
import { Button } from '../../../components/ui/Button';
import { Dialog, DialogActions } from '../../../components/ui/Dialog';
import { TextField } from '../../../components/ui/Field';
import { Icon } from '../../../components/ui/Icon';
import { IconButton } from '../../../components/ui/IconButton';
import { Notice } from '../../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../../components/ui/Skeleton';
import { Tooltip } from '../../../components/ui/Tooltip';
import { t } from '../../../i18n/id';
import { isApiError } from '../../../lib/api/client';
import { endpoints } from '../../../lib/api/endpoints';
import { cx } from '../../../lib/cx';
import { AccountMark } from '../AccountMark';
import { formatBytes } from '../mail-format';
import { attachmentKind, isViewUrl, type AttachmentKind } from '../mail-list';
import {
  mailMessageQuery,
  mailSignaturesQuery,
  mailSnippetsQuery,
  mailViewQuery,
} from '../mail-queries';
import type { UploadItem } from './compose-attachments';
import { normalizeLinkInput } from './compose-html';
import type { EditorCommand, EditorHandle } from './ComposeEditor';
import styles from './Compose.module.css';

const c = t.mail.compose;

export type MailSnippetResponse = z.infer<typeof mailSnippetResponseSchema>;

export type ComposeIdentity = MailComposeIdentityListResponse['identities'][number];

// ── Dari ───────────────────────────────────────────────────────────────────

/**
 * Pilihan "Dari" (KONTRAK-API-EMAIL-TULIS §3.4): identitas semua akun yang boleh dipakai. Yang
 * belum terverifikasi tampil nonaktif dengan alasannya (+ tautan verifikasi untuk pengelola).
 */
export function FromPicker({
  identities,
  currentId,
  isAllowed,
  disabled,
  onChange,
}: {
  identities: readonly ComposeIdentity[];
  currentId: string;
  /** Identitas akun lain (draf balasan/berlampiran) tidak bisa dipilih. */
  isAllowed: (identity: ComposeIdentity) => boolean;
  disabled?: boolean;
  onChange: (identity: ComposeIdentity) => void;
}) {
  const current = identities.find((identity) => identity.id === currentId);
  const label = current ? `${current.displayName} <${current.address}>` : '';
  const unverified = identities.filter((identity) => !identity.canSend);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button type="button" className={styles.fromButton} aria-label={c.fromMenuLabel(label)}>
          {current ? <AccountMark account={current.account} /> : null}
          <span className={styles.fromName} dir="auto">
            {current?.displayName ?? ''}
          </span>
          <span className={styles.fromAddress}>&lt;{current?.address ?? ''}&gt;</span>
          <Icon icon={ChevronDown} size={16} className={styles.fromChevron} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className={cx(styles.menu, styles.fromMenu)}
        >
          {identities.map((identity) => {
            const allowed = identity.canSend && isAllowed(identity);
            const note = !identity.canSend
              ? identity.verification.state === 'pending'
                ? c.fromPending
                : identity.cannotSendReason === 'identity_not_approved'
                  ? c.fromNotApproved
                  : identity.cannotSendReason === 'identity_unverified'
                    ? c.fromUnverified
                    : c.fromCannotSend
              : !isAllowed(identity)
                ? c.otherAccountNote
                : `${identity.address} · ${identity.account.kind === 'shared' ? c.fromShared : c.fromPersonal}`;
            return (
              <DropdownMenu.Item
                key={identity.id}
                className={styles.fromItem}
                disabled={!allowed}
                onSelect={() => {
                  if (identity.id !== currentId) onChange(identity);
                }}
              >
                <AccountMark account={identity.account} />
                <span className={styles.fromItemText}>
                  <span className={styles.fromItemName} dir="auto">
                    {identity.displayName}
                    {!identity.canSend ? <span className="sr-only">, {note}</span> : null}
                  </span>
                  <span
                    className={styles.fromItemMeta}
                    aria-hidden={!identity.canSend || undefined}
                  >
                    {identity.canSend ? note : `${identity.address} · ${note}`}
                  </span>
                </span>
                {identity.id === currentId ? (
                  <Icon icon={Check} size={16} className={styles.fromCheck} />
                ) : !identity.canSend ? (
                  <Icon icon={AlertTriangle} size={16} className={styles.fromWarn} />
                ) : (
                  <span aria-hidden="true" />
                )}
              </DropdownMenu.Item>
            );
          })}
          {unverified.length > 0 ? (
            <>
              <DropdownMenu.Separator className={styles.menuSeparator} />
              <DropdownMenu.Item asChild className={styles.menuLinkItem}>
                <Link
                  to="/pengaturan/akun-email/$accountId"
                  params={{ accountId: unverified[0]?.accountId ?? '' }}
                  hash="alamat-pengirim"
                >
                  <Icon icon={ShieldCheck} size={16} />
                  {c.verifyLink}
                </Link>
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ── Bilah format ───────────────────────────────────────────────────────────

const COMMANDS: Array<{ command: EditorCommand; label: string; icon: LucideIcon }> = [
  { command: 'bold', label: c.bold, icon: Bold },
  { command: 'italic', label: c.italic, icon: Italic },
  { command: 'underline', label: c.underline, icon: Underline },
];
const LIST_COMMANDS: Array<{ command: EditorCommand; label: string; icon: LucideIcon }> = [
  { command: 'insertUnorderedList', label: c.bulleted, icon: List },
  { command: 'insertOrderedList', label: c.numbered, icon: ListOrdered },
];

/**
 * Bilah format editor (mockup: tebal, miring, garis bawah · daftar, tautan, kutipan, gambar ·
 * "Teks biasa"). Tombol tidak mengambil fokus dari editor (`mousedown` dicegah) supaya pilihan teks
 * tetap.
 */
export function FormatToolbar({
  editorRef,
  format,
  onToggleFormat,
  onPickImage,
  disabled,
  compact = false,
}: {
  editorRef: RefObject<EditorHandle | null>;
  format: 'html' | 'text';
  onToggleFormat: () => void;
  onPickImage: () => void;
  disabled?: boolean;
  /** HP: tanpa garis bawah & kutipan, tanpa tombol format teks (mockup HP). */
  compact?: boolean;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const html = format === 'html';
  const tool = (command: EditorCommand, label: string, icon: LucideIcon) => (
    <ToolButton
      key={command}
      editorRef={editorRef}
      command={command}
      label={label}
      icon={icon}
      disabled={disabled || !html}
    />
  );
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={c.toolbarLabel}>
      {(compact ? COMMANDS.slice(0, 2) : COMMANDS).map((item) =>
        tool(item.command, item.label, item.icon),
      )}
      <span className={styles.toolSeparator} aria-hidden="true" />
      {(compact ? LIST_COMMANDS.slice(0, 1) : LIST_COMMANDS).map((item) =>
        tool(item.command, item.label, item.icon),
      )}
      <LinkPopover
        editorRef={editorRef}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        disabled={disabled || !html}
      />
      {compact ? null : tool('blockquote', c.blockquote, Quote)}
      <IconButton
        label={c.image}
        icon={ImageIcon}
        className={styles.tool}
        disabled={disabled || !html}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          editorRef.current?.rememberSelection();
          onPickImage();
        }}
      />
      {compact ? null : (
        <button
          type="button"
          className={styles.formatToggle}
          aria-pressed={!html}
          disabled={disabled}
          onClick={onToggleFormat}
        >
          {html ? c.plainText : c.richText}
        </button>
      )}
    </div>
  );
}

function ToolButton({
  editorRef,
  command,
  label,
  icon,
  disabled,
}: {
  editorRef: RefObject<EditorHandle | null>;
  command: EditorCommand;
  label: string;
  icon: LucideIcon;
  disabled: boolean;
}) {
  return (
    <IconButton
      label={label}
      icon={icon}
      className={styles.tool}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => editorRef.current?.exec(command)}
    />
  );
}

function LinkPopover({
  editorRef,
  open,
  onOpenChange,
  disabled,
}: {
  editorRef: RefObject<EditorHandle | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const apply = () => {
    const url = normalizeLinkInput(value);
    if (!url) {
      setError(c.linkForm.invalid);
      return;
    }
    onOpenChange(false);
    editorRef.current?.link(url);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          editorRef.current?.rememberSelection();
          const selected = editorRef.current?.selectedText().trim() ?? '';
          setValue(normalizeLinkInput(selected) ? selected : '');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <Tooltip label={c.link} side="bottom">
        <Popover.Trigger asChild disabled={disabled}>
          <button
            type="button"
            className={cx(styles.tool, styles.toolTrigger)}
            aria-label={c.link}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Icon icon={Link2} size={20} />
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.querySelector('input')?.focus();
          }}
        >
          <form
            className={styles.linkForm}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              apply();
            }}
          >
            <TextField
              label={c.linkForm.label}
              value={value}
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://"
              error={error}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
            <div className={styles.popoverActions}>
              <Button onClick={() => onOpenChange(false)}>{c.linkForm.cancel}</Button>
              <Button type="submit" variant="primary">
                {c.linkForm.apply}
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── Template (balasan cepat & template email) ─────────────────────────────

type SnippetChoice =
  | { kind: 'quick_reply'; id: string; title: string }
  | {
      kind: 'email_template';
      id: string;
      title: string;
      variables: Array<{ name: string; label: string; required: boolean }>;
    };

/**
 * Menu template (`/` di editor atau tombol): cari balasan cepat + template email terbit, isi dari
 * server (variabel terisi, profil editor), lalu disisipkan di posisi kursor. Variabel wajib yang
 * belum terisi → formulir kecil, lalu diminta ulang.
 */
export function SnippetMenu({
  draftId,
  open,
  onOpenChange,
  onInsert,
  trigger,
}: {
  draftId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (snippet: MailSnippetResponse) => void;
  trigger: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variables, setVariables] = useState<{
    choice: SnippetChoice;
    missing: MailSnippetResponse['missingVariables'];
  } | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const snippets = useQuery({ ...mailSnippetsQuery(query), enabled: open });
  const listId = useId();

  const run = async (choice: SnippetChoice, values?: Record<string, string>) => {
    setBusy(choice.id);
    setError(null);
    try {
      const result = await endpoints.mail.snippet(draftId, {
        kind: choice.kind,
        id: choice.id,
        ...(values ? { variables: values } : {}),
      });
      const missing = result.missingVariables.filter((item) => item.required);
      if (missing.length > 0 && !values) {
        onOpenChange(false);
        setVariables({ choice, missing: result.missingVariables });
        return;
      }
      setVariables(null);
      onOpenChange(false);
      onInsert(result);
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : c.template.insertFailed);
    } finally {
      setBusy(null);
    }
  };

  const data = snippets.data;
  const empty = data && data.quickReplies.length === 0 && data.emailTemplates.length === 0;

  return (
    <>
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={cx(styles.popover, styles.snippetPopover)}
            align="start"
            side="top"
            sideOffset={4}
            collisionPadding={8}
          >
            <label className={styles.searchBox}>
              <Icon icon={Search} size={16} />
              <input
                className={styles.searchInput}
                value={search}
                placeholder={c.template.searchPlaceholder}
                aria-label={c.template.searchLabel}
                aria-controls={listId}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={60}
              />
            </label>
            <div id={listId} className={styles.snippetList}>
              {snippets.isPending ? (
                <SkeletonRegion className={styles.snippetSkeleton}>
                  <Skeleton className={styles.skeletonRow} />
                  <Skeleton className={styles.skeletonRow} />
                  <span className="sr-only">{c.template.loading}</span>
                </SkeletonRegion>
              ) : snippets.isError ? (
                <p className={styles.menuEmpty} role="alert">
                  {c.template.failed}
                </p>
              ) : empty ? (
                <p className={styles.menuEmpty}>{c.template.empty}</p>
              ) : data ? (
                <>
                  {data.quickReplies.length > 0 ? (
                    <section aria-label={c.template.quickReplies}>
                      <h3 className={styles.menuHeading}>{c.template.quickReplies}</h3>
                      <ul className={styles.snippetItems}>
                        {data.quickReplies.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              className={styles.snippetItem}
                              disabled={busy !== null}
                              aria-busy={busy === item.id || undefined}
                              onClick={() =>
                                void run({ kind: 'quick_reply', id: item.id, title: item.title })
                              }
                            >
                              <Icon icon={MessageSquareQuote} size={16} />
                              <span className={styles.snippetTitle}>{item.title}</span>
                              <kbd className={styles.snippetShortcut}>/{item.shortcut}</kbd>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {data.emailTemplates.length > 0 ? (
                    <section aria-label={c.template.emailTemplates}>
                      <h3 className={styles.menuHeading}>{c.template.emailTemplates}</h3>
                      <ul className={styles.snippetItems}>
                        {data.emailTemplates.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              className={styles.snippetItem}
                              disabled={busy !== null}
                              aria-busy={busy === item.id || undefined}
                              onClick={() =>
                                void run({
                                  kind: 'email_template',
                                  id: item.id,
                                  title: item.name,
                                  variables: item.variables,
                                })
                              }
                            >
                              <Icon icon={FileText} size={16} />
                              <span className={styles.snippetTitle}>{item.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              ) : null}
              {error ? (
                <p className={styles.menuError} role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {variables ? (
        <VariablesDialog
          title={c.template.variablesTitle(variables.choice.title)}
          missing={variables.missing}
          busy={busy !== null}
          error={error}
          onCancel={() => {
            setVariables(null);
            setError(null);
          }}
          onSubmit={(values) => void run(variables.choice, values)}
        />
      ) : null}
    </>
  );
}

function VariablesDialog({
  title,
  missing,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  title: string;
  missing: MailSnippetResponse['missingVariables'];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Dialog open title={title} description={c.template.variablesBody} onRequestClose={onCancel}>
      <form
        className={styles.dialogForm}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const next: Record<string, string> = {};
          for (const item of missing) {
            if (item.required && !(values[item.name] ?? '').trim())
              next[item.name] = c.template.required;
          }
          setErrors(next);
          if (Object.keys(next).length > 0) return;
          onSubmit(values);
        }}
      >
        {missing.map((item) => (
          <TextField
            key={item.name}
            label={item.label}
            optional={!item.required}
            value={values[item.name] ?? ''}
            error={errors[item.name] ?? null}
            maxLength={2000}
            onChange={(event) =>
              setValues((current) => ({ ...current, [item.name]: event.target.value }))
            }
          />
        ))}
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onCancel}>{c.linkForm.cancel}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {c.template.insert}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ── Tanda tangan ───────────────────────────────────────────────────────────

/** Pilih tanda tangan untuk email ini saja (bersama/pribadi akun draf, atau tanpa). */
export function SignatureMenu({
  accountId,
  getCurrentId,
  disabled,
  onPick,
}: {
  accountId: string;
  /** Tanda tangan yang sedang ada di editor (dibaca saat menu dibuka). */
  getCurrentId: () => string | null;
  disabled?: boolean;
  onPick: (signature: { id: string; html: string; hasLogo: boolean } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const signatures = useQuery({ ...mailSignaturesQuery(accountId), enabled: open });
  const groups = signatures.data
    ? [
        { label: c.signature.shared, items: signatures.data.shared },
        { label: c.signature.mine, items: signatures.data.mine },
      ].filter((group) => group.items.length > 0)
    : [];
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (next) setCurrentId(getCurrentId());
        setOpen(next);
      }}
    >
      <Tooltip label={c.signature.button} side="top">
        <DropdownMenu.Trigger asChild disabled={disabled}>
          <button
            type="button"
            className={cx(styles.tool, styles.toolTrigger)}
            aria-label={c.signature.button}
          >
            <Icon icon={PenLine} size={20} />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={4}
          collisionPadding={8}
          className={styles.menu}
        >
          <DropdownMenu.Label className={styles.menuHeading}>
            {c.signature.button}
          </DropdownMenu.Label>
          {signatures.isPending ? (
            <p className={styles.menuEmpty} role="status">
              {c.signature.loading}
            </p>
          ) : null}
          {groups.map((group) => (
            <DropdownMenu.Group key={group.label}>
              <DropdownMenu.Label className={styles.menuSub}>{group.label}</DropdownMenu.Label>
              {group.items.map((item) => (
                <DropdownMenu.Item
                  key={item.id}
                  className={styles.menuItem}
                  onSelect={() =>
                    onPick({ id: item.id, html: item.html, hasLogo: item.logoUrl !== null })
                  }
                >
                  <span className={styles.menuItemText}>{item.name}</span>
                  {item.id === currentId ? (
                    <Icon icon={Check} size={16} className={styles.fromCheck} />
                  ) : null}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          ))}
          <DropdownMenu.Separator className={styles.menuSeparator} />
          <DropdownMenu.Item className={styles.menuItem} onSelect={() => onPick(null)}>
            <span className={styles.menuItemText}>{c.signature.none}</span>
            {currentId === null ? (
              <Icon icon={Check} size={16} className={styles.fromCheck} />
            ) : null}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ── Kutipan email asli ─────────────────────────────────────────────────────

/** Iframe dokumen tampilan ber-token 9A: tanpa skrip & tanpa origin aplikasi (kontrak §6.2). */
const QUOTE_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * Cip "Tampilkan kutipan email …" (mockup). HTML email asli TIDAK pernah masuk editor: dibuka di
 * iframe sandbox lewat dokumen tampilan ber-token, atau sebagai teks biasa.
 */
export function QuotePanel({
  draft,
  includeQuote,
  onIncludeChange,
  disabled,
}: {
  draft: MailDraft;
  includeQuote: boolean;
  onIncludeChange: (include: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const quote = draft.quote;
  if (draft.mode === 'new' || !quote.messageId) return null;
  const name = quote.from?.name?.trim() || quote.from?.address || c.quote.someone;
  const forward = draft.mode === 'forward';
  if (!includeQuote) {
    return (
      <div className={styles.quoteRow}>
        <p className={styles.quoteNote}>{c.quote.removed}</p>
        <button
          type="button"
          className={styles.linkButton}
          disabled={disabled}
          onClick={() => onIncludeChange(true)}
        >
          <Icon icon={RotateCcw} size={16} />
          {c.quote.include}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.quote}>
      <div className={styles.quoteRow}>
        <button
          type="button"
          className={styles.quoteChip}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon icon={MessageSquareQuote} size={16} />
          {open ? c.quote.hide : c.quote.show(name)}
        </button>
        {forward ? (
          <span className={styles.quoteNote}>{c.quote.forwardNote}</span>
        ) : (
          <button
            type="button"
            className={styles.linkButton}
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              onIncludeChange(false);
            }}
          >
            {c.quote.remove}
          </button>
        )}
      </div>
      {!quote.available ? <p className={styles.quoteNote}>{c.quote.unavailable}</p> : null}
      {open && quote.available ? (
        quote.hasHtml ? (
          <QuoteFrame messageId={quote.messageId} />
        ) : (
          <QuoteText messageId={quote.messageId} />
        )
      ) : null}
    </div>
  );
}

function QuoteFrame({ messageId }: { messageId: string }) {
  const view = useQuery(mailViewQuery(messageId, 'auto'));
  if (view.isError || (view.data && !isViewUrl(view.data.url))) {
    return (
      <p className={styles.quoteNote} role="alert">
        {c.quote.loadFailed}
      </p>
    );
  }
  return view.data ? (
    <iframe
      title={c.quote.frameTitle}
      className={styles.quoteFrame}
      sandbox={QUOTE_SANDBOX}
      referrerPolicy="no-referrer"
      src={view.data.url}
    />
  ) : (
    <SkeletonRegion className={styles.quoteSkeleton}>
      <Skeleton className={styles.skeletonRow} />
      <Skeleton className={styles.skeletonRow} />
    </SkeletonRegion>
  );
}

function QuoteText({ messageId }: { messageId: string }) {
  const detail = useQuery(mailMessageQuery(messageId));
  const text = detail.data?.message.body.text;
  if (detail.isError) {
    return (
      <p className={styles.quoteNote} role="alert">
        {c.quote.loadFailed}
      </p>
    );
  }
  return text ? (
    <blockquote className={styles.quoteText} dir="auto">
      {text}
    </blockquote>
  ) : (
    <SkeletonRegion className={styles.quoteSkeleton}>
      <Skeleton className={styles.skeletonRow} />
    </SkeletonRegion>
  );
}

// ── Lampiran ───────────────────────────────────────────────────────────────

const KIND_ICONS: Record<AttachmentKind, LucideIcon> = {
  pdf: FileText,
  image: ImageIcon,
  sheet: FileSpreadsheet,
  doc: FileText,
  archive: File,
  other: File,
};

/** Daftar lampiran draf (mockup: kotak berisi ikon jenis, nama, ukuran, tombol hapus). */
export function AttachmentList({
  attachments,
  uploads,
  onRemove,
  onCancel,
  onDismiss,
  disabled,
}: {
  attachments: readonly MailDraftAttachment[];
  uploads: readonly UploadItem[];
  onRemove: (attachment: MailDraftAttachment) => void;
  onCancel: (localId: string) => void;
  onDismiss: (localId: string) => void;
  disabled?: boolean;
}) {
  const files = attachments.filter((item) => !item.inline);
  if (files.length === 0 && uploads.length === 0) return null;
  return (
    <ul className={styles.attachments} aria-label={c.attachments.listLabel}>
      {files.map((item) => {
        const kind = attachmentKind(item.contentType, item.filename);
        const loading = item.state === 'loading';
        return (
          <li key={item.id} className={styles.attachment} data-state={item.state}>
            <span className={styles.attachmentIcon} data-kind={kind}>
              <Icon
                icon={loading ? LoaderCircle : KIND_ICONS[kind]}
                size={16}
                className={loading ? styles.spinning : undefined}
              />
            </span>
            <span className={styles.attachmentName} dir="auto" title={item.filename}>
              {item.filename}
            </span>
            <span className={styles.attachmentSize}>
              {loading ? c.attachments.preparing : formatBytes(item.sizeBytes)}
            </span>
            <button
              type="button"
              className={styles.attachmentRemove}
              aria-label={c.attachments.remove(item.filename)}
              disabled={disabled}
              onClick={() => onRemove(item)}
            >
              <Icon icon={X} size={16} />
            </button>
          </li>
        );
      })}
      {uploads
        .filter((item) => !item.inline || item.state === 'failed')
        .map((item) => {
          const percent = Math.round(item.progress * 100);
          const failed = item.state === 'failed';
          return (
            <li
              key={item.localId}
              className={styles.attachment}
              data-state={failed ? 'failed' : 'uploading'}
            >
              <span className={styles.attachmentIcon} data-kind={failed ? 'failed' : 'other'}>
                <Icon
                  icon={failed ? AlertTriangle : LoaderCircle}
                  size={16}
                  className={failed ? undefined : styles.spinning}
                />
              </span>
              {failed ? (
                <span className={styles.attachmentStack}>
                  <span className={styles.attachmentName} dir="auto" title={item.filename}>
                    {item.filename}
                  </span>
                  <span className={styles.attachmentError} role="alert">
                    {item.error ?? c.attachments.failed}
                  </span>
                </span>
              ) : (
                <span className={styles.attachmentName} dir="auto" title={item.filename}>
                  {item.filename}
                </span>
              )}
              {failed ? null : (
                <span className={styles.attachmentSize}>
                  <span
                    className={styles.progress}
                    role="progressbar"
                    aria-label={c.attachments.uploadingLabel(item.filename, percent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <span
                      className={styles.progressBar}
                      style={{ inlineSize: `${String(percent)}%` }}
                    />
                  </span>
                  {c.attachments.uploading(percent)}
                </span>
              )}
              <button
                type="button"
                className={styles.attachmentRemove}
                aria-label={
                  failed
                    ? c.attachments.dismiss(item.filename)
                    : c.attachments.cancel(item.filename)
                }
                onClick={() => (failed ? onDismiss(item.localId) : onCancel(item.localId))}
              >
                <Icon icon={X} size={16} />
              </button>
            </li>
          );
        })}
    </ul>
  );
}
