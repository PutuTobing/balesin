import type { Conversation, Message } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Music, Paperclip, Reply, SendHorizontal, Video, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import styles from './Composer.module.css';
import { ACCEPT, checkAttachment, guessMediaKind } from './attachments';
import { messageBody } from './message-content';
import { createOutboxItem, sendOutboxItem } from './outbox';

const k = t.inbox.compose;
const MAX_TEXT = 4096;
const COUNTER_FROM = 3800;

interface ComposerProps {
  conversation: Conversation;
  replyTo: Message | null;
  onCancelReply: () => void;
  /** Error kirim terbaru (ditampilkan ruang chat dengan pola `FormErrorNotice`). */
  onError: (error: unknown) => void;
  /** Kunci 429: tombol kirim nonaktif selama hitung mundur. */
  locked: boolean;
  lockLabel: string | null;
  disabled?: boolean;
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
  locked,
  lockLabel,
  disabled = false,
}: ComposerProps) {
  const queryClient = useQueryClient();
  const isHp = useMediaQuery(media.hp);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

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
  const canSend = !disabled && !locked && !tooLong && (file !== null || trimmed.length > 0);

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
    sendOutboxItem(queryClient, item).catch(onError);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    // HP: Enter = baris baru (papan ketik sentuh); kirim lewat tombol.
    if (isHp) return;
    event.preventDefault();
    send();
  };

  const kind = file ? guessMediaKind(file) : null;
  const replyBody = replyTo ? messageBody(replyTo) : null;

  return (
    <div className={styles.composer}>
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
        <IconButton
          label={k.attach}
          icon={Paperclip}
          tooltipSide="top"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        />
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label={k.label}
          aria-describedby={isHp ? undefined : hintId}
          placeholder={file ? k.captionPlaceholder : k.placeholder}
          className={styles.input}
          disabled={disabled}
          enterKeyHint={isHp ? 'enter' : 'send'}
        />
        <button
          type="button"
          className={styles.send}
          onClick={send}
          disabled={!canSend}
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
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
}
