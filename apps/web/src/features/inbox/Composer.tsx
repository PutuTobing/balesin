import {
  CHANNEL_CAPABILITIES,
  type Conversation,
  type Message,
  type QuickReply,
} from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  LayoutTemplate,
  ListChecks,
  Music,
  Paperclip,
  Plus,
  Reply,
  SendHorizontal,
  Video,
  X,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import styles from './Composer.module.css';
import { ACCEPT, checkAttachment, guessMediaKind } from './attachments';
import { messageBody } from './message-content';
import { createOutboxItem, sendOutboxItem } from './outbox';
import { slashQuery, useQuickReplies } from './quick-replies';
import { InteractiveDialog } from './InteractiveDialog';
import { TemplateSendDialog } from './TemplateSendDialog';
import { QuickReplyPicker } from './QuickReplyPicker';
import { endpoints } from '../../lib/api/endpoints';

const k = t.inbox.compose;
const MAX_TEXT = 4096;
const COUNTER_FROM = 3800;

interface ComposerProps {
  conversation: Conversation;
  replyTo: Message | null;
  onCancelReply: () => void;
  /** Error selain kirim pesan (mis. template `/`), ditampilkan di atas composer. */
  onError: (error: unknown) => void;
  /** Gagal kirim pesan: keterangannya sudah ada di item outbox; hanya 429 yang ke atas composer. */
  onSendError: (error: unknown) => void;
  /** Kunci 429: tombol kirim nonaktif selama hitung mundur. */
  locked: boolean;
  lockLabel: string | null;
  disabled?: boolean;
  /** Rem darurat ditarik: kirim & lampirkan nonaktif (draf tetap bisa ditulis). */
  pausedNoticeId?: string;
}

/**
 * Composer ruang chat: teks (Enter kirim / Shift+Enter baris baru di desktop; di HP tombol kirim),
 * lampiran (pilih → pratinjau → kirim dengan keterangan), dan balas-kutip. Pesan dikirim optimistis
 * lewat `outbox` dengan `clientMessageId` sendiri, jadi composer langsung siap untuk pesan berikutnya.
 */
export function Composer({
  conversation,
  replyTo,
  onCancelReply,
  onError,
  onSendError,
  locked,
  lockLabel,
  disabled = false,
  pausedNoticeId,
}: ComposerProps) {
  const paused = pausedNoticeId !== undefined;
  const queryClient = useQueryClient();
  const isHp = useMediaQuery(media.hp);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const pickerId = useId();

  // Template `/`: seluruh isi kolom berupa `/kata` → daftar template (Escape menutup sampai isi berubah).
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [usingTemplate, setUsingTemplate] = useState(false);
  const search = slashQuery(text);
  const pickerOpen = search !== null && dismissedFor !== text && !file;
  const templates = useQuickReplies(pickerOpen ? search : null);
  const activeIndex = Math.min(active, Math.max(0, templates.items.length - 1));

  const pickTemplate = (template: QuickReply) => {
    setUsingTemplate(true);
    onError(null);
    endpoints.quickReplies
      .use(template.id, conversation.id)
      .then(({ text: filled }) => {
        setText(filled);
        setActive(0);
        inputRef.current?.focus();
      })
      .catch(onError)
      .finally(() => setUsingTemplate(false));
  };

  // Balas-kutip dipilih → fokus ke kolom tulis.
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  // Kolom tulis ikut tinggi isinya (sampai batas CSS), tanpa lompatan saat mengetik.
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  // Lampiran yang belum dikirim: pratinjaunya dicabut saat composer dilepas (pindah chat).
  const previewRef = useRef<string | null>(null);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const clearFile = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFile(null);
    setFileError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    const problem = checkAttachment(picked);
    if (preview) URL.revokeObjectURL(preview);
    setFileError(problem);
    setFile(problem ? null : picked);
    setPreview(!problem && guessMediaKind(picked) === 'image' ? URL.createObjectURL(picked) : null);
    inputRef.current?.focus();
  };

  const trimmed = text.trim();
  const tooLong = text.length > MAX_TEXT;
  const canSend =
    !disabled && !paused && !locked && !tooLong && (file !== null || trimmed.length > 0);

  const send = () => {
    if (!canSend) return;
    const item = createOutboxItem({
      conversationId: conversation.id,
      kind: file ? 'media' : 'text',
      text: file ? trimmed : text,
      file: file ?? undefined,
      previewUrl: preview ?? undefined,
      replyToMessageId: replyTo?.id,
    });
    // Pratinjau kini milik item outbox (dicabut saat item dibuang).
    setPreview(null);
    setFile(null);
    setText('');
    if (fileRef.current) fileRef.current.value = '';
    onCancelReply();
    onError(null);
    sendOutboxItem(queryClient, item).catch(onSendError);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && !event.nativeEvent.isComposing) {
      const count = templates.items.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (count > 0) {
          setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
        }
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && count > 0) {
        event.preventDefault();
        const chosen = templates.items[activeIndex];
        if (chosen) pickTemplate(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedFor(text);
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    // HP: Enter = baris baru (papan ketik sentuh); kirim lewat tombol.
    if (isHp) return;
    event.preventDefault();
    send();
  };

  // Aksi tambahan sesuai kemampuan channel (email: tanpa tombol interaktif & template).
  const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
  const allowed = {
    attach: capabilities.messageTypes.includes('media'),
    interactive: capabilities.messageTypes.includes('interactive'),
    template: capabilities.templates,
  };
  const extras = [
    {
      key: 'attach' as const,
      label: k.attach,
      icon: Paperclip,
      disabled: disabled || paused,
    },
    {
      key: 'interactive' as const,
      label: k.interactive,
      icon: ListChecks,
      disabled: disabled || paused || locked || file !== null,
    },
    {
      key: 'template' as const,
      label: k.template,
      icon: LayoutTemplate,
      disabled: disabled || paused || locked,
    },
  ].filter((extra) => allowed[extra.key]);

  /** Aksi tambahan (event handler, bukan saat render). */
  const runExtra = (key: (typeof extras)[number]['key']) => {
    if (key === 'attach') fileRef.current?.click();
    else if (key === 'interactive') setInteractiveOpen(true);
    else setTemplateOpen(true);
  };

  const kind = file ? guessMediaKind(file) : null;
  const replyBody = replyTo ? messageBody(replyTo) : null;

  return (
    <div className={styles.composer}>
      {pickerOpen ? (
        <QuickReplyPicker
          id={pickerId}
          search={search}
          items={templates.items}
          loading={templates.loading}
          failed={templates.failed}
          activeIndex={activeIndex}
          onActiveChange={setActive}
          onPick={pickTemplate}
        />
      ) : null}
      {replyTo ? (
        <div className={styles.reply}>
          <Icon icon={Reply} size={16} className={styles.replyIcon} />
          <div className={styles.replyText}>
            <p className={styles.replyWho}>
              {k.replyingTo(
                replyTo.direction === 'inbound'
                  ? t.inbox.actions.customer
                  : t.inbox.chat.senders[replyTo.senderKind].toLowerCase(),
              )}
            </p>
            <p className={styles.replySnippet} dir="auto">
              {replyBody?.text ?? replyBody?.label ?? ''}
            </p>
          </div>
          <IconButton label={k.cancelReply} icon={X} onClick={onCancelReply} />
        </div>
      ) : null}

      {file ? (
        <div className={styles.attachment}>
          {preview ? (
            <img src={preview} alt="" className={styles.thumb} />
          ) : (
            <span className={styles.fileIcon}>
              <Icon
                icon={kind === 'video' ? Video : kind === 'audio' ? Music : FileText}
                size={20}
              />
            </span>
          )}
          <div className={styles.fileText}>
            <p className={styles.fileName} dir="auto">
              {file.name}
            </p>
            <p className={styles.fileSize}>{formatSize(file.size)}</p>
          </div>
          <IconButton label={k.removeAttachment} icon={X} onClick={clearFile} />
        </div>
      ) : null}
      {fileError ? (
        <p className={styles.fileError} role="alert">
          {fileError}
        </p>
      ) : null}

      <div className={styles.row}>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => pickFile(event.target.files?.[0])}
          data-testid="composer-file"
        />
        {isHp && extras.length === 0 ? null : isHp ? (
          // HP: satu tombol "+" → menu berlabel, supaya kotak tulis tetap lebar (review template TM1).
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={styles.moreTrigger}
                aria-label={k.more}
                aria-describedby={pausedNoticeId}
                disabled={disabled}
              >
                <Icon icon={Plus} size={20} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={8}
                collisionPadding={16}
                className={styles.moreMenu}
              >
                {extras.map((extra) => (
                  <DropdownMenu.Item
                    key={extra.key}
                    className={styles.moreItem}
                    disabled={extra.disabled}
                    onSelect={() => runExtra(extra.key)}
                  >
                    <Icon icon={extra.icon} size={20} />
                    <span className={styles.moreText}>
                      <span className={styles.moreLabel}>{k.moreItems[extra.key].label}</span>
                      <span className={styles.moreHint}>{k.moreItems[extra.key].hint}</span>
                    </span>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : (
          <>
            {allowed.attach ? (
              <IconButton
                label={k.attach}
                icon={Paperclip}
                tooltipSide="top"
                disabled={disabled || paused}
                aria-describedby={pausedNoticeId}
                onClick={() => fileRef.current?.click()}
              />
            ) : null}
            {allowed.interactive ? (
              <IconButton
                label={k.interactive}
                icon={ListChecks}
                tooltipSide="top"
                disabled={disabled || paused || locked || file !== null}
                aria-describedby={pausedNoticeId}
                onClick={() => setInteractiveOpen(true)}
              />
            ) : null}
            {allowed.template ? (
              <IconButton
                label={k.template}
                icon={LayoutTemplate}
                tooltipSide="top"
                disabled={disabled || paused || locked}
                aria-describedby={pausedNoticeId}
                onClick={() => setTemplateOpen(true)}
              />
            ) : null}
          </>
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label={k.label}
          aria-autocomplete="list"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen && templates.items.length > 0 ? pickerId : undefined}
          aria-activedescendant={
            pickerOpen && templates.items[activeIndex]
              ? `${pickerId}-${templates.items[activeIndex].id}`
              : undefined
          }
          aria-busy={usingTemplate || undefined}
          aria-describedby={isHp ? undefined : hintId}
          placeholder={
            paused
              ? k.pausedPlaceholder
              : file
                ? k.captionPlaceholder
                : conversation.channel.type === 'email'
                  ? k.emailPlaceholder
                  : k.placeholder
          }
          className={styles.input}
          disabled={disabled}
          enterKeyHint={isHp ? 'enter' : 'send'}
        />
        <button
          type="button"
          className={styles.send}
          onClick={send}
          disabled={!canSend}
          aria-describedby={pausedNoticeId}
          aria-label={lockLabel ?? k.send}
        >
          {lockLabel ? (
            <span className={styles.sendLock}>{lockLabel}</span>
          ) : (
            <Icon icon={SendHorizontal} size={20} />
          )}
        </button>
      </div>
      {!isHp ? (
        <p id={hintId} className="sr-only">
          {k.enterHint}
        </p>
      ) : null}
      {text.length >= COUNTER_FROM ? (
        <p className={styles.counter} data-over={tooLong ? '' : undefined}>
          {k.tooLong(text.length)}
        </p>
      ) : null}
      {interactiveOpen ? (
        <InteractiveDialog conversation={conversation} onClose={() => setInteractiveOpen(false)} />
      ) : null}
      {templateOpen ? (
        <TemplateSendDialog conversation={conversation} onClose={() => setTemplateOpen(false)} />
      ) : null}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
}
