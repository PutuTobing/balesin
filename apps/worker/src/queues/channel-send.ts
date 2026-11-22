import {
  fallbackEmailSettings,
  isMetaApiError,
  isTelegramApiError,
  newOutboundMessageId,
  openChannelConnectionSecret,
  openMetaSocialCredentials,
  openStoredEmailSettings,
  replySubject,
  sendMetaSocialMessage,
  sendSmtpMail,
  type Secret,
  type HostLookup,
  type MailAttachment,
  type MailTransportSettings,
  type MediaStore,
  type MetaGraphClient,
  type PlaintextLoginPolicy,
  type SecretBox,
  type SmtpConnectionConfig,
  type SmtpFailureCode,
  type SmtpFallbackConfig,
  type SmtpPolicy,
  type SmtpTimeouts,
  type TelegramBotClient,
  type TelegramInlineButton,
  type TelegramMediaMethod,
} from '@balesin/core';
import {
  emailSettings,
  mediaFiles,
  messages,
  type Channel,
  type DbExecutor,
  type MessageExtras,
  type MessageRow,
} from '@balesin/db';
import {
  interactiveMessageSchema,
  type InteractiveMessage,
  type OutboundFailureReason,
} from '@balesin/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

/**
 * Pengiriman pesan keluar channel selain WhatsApp (Fase 6). Dipanggil worker `messages` SETELAH
 * pemeriksaan bersama (rem darurat, channel aktif, pengirim masih berhak, jendela 24 jam bila
 * berlaku). Di sini: susun isi per platform (DI DALAM transaksi baca), lalu `send()` dipanggil di
 * LUAR transaksi.
 *
 * Hasil:
 *  - `ok` → ID eksternal (`messages.wamid`): Telegram `<chat_id>:<message_id>`, Email `Message-ID`,
 *    Messenger/Instagram `mid`. Status langsung `sent` (Telegram/Email tidak punya tanda terima;
 *    Messenger/IG memperbaruinya lewat webhook `delivery`/`read`).
 *  - `retry` = layanan jelas BELUM memproses (batas laju, gangguan sementara) → diulang BullMQ.
 *  - selain itu `failed` + alasan; koneksi putus di tengah = `delivery_unknown` (tidak diulang).
 *
 * Tanpa isi pesan / alamat / token di log.
 */

export interface ChannelSendDeps {
  secretBox: SecretBox | null;
  meta: MetaGraphClient;
  telegram: TelegramBotClient;
  store: MediaStore | null;
  smtp: {
    allowedPorts: readonly number[];
    plaintextLogin: PlaintextLoginPolicy;
    fallback: SmtpFallbackConfig | null;
    lookup?: HostLookup;
    timeouts?: Partial<SmtpTimeouts>;
  };
}

export type ChannelSendOutcome =
  | { ok: true; externalId: string; extras?: MessageExtras }
  | {
      ok: false;
      retry: boolean;
      reason: OutboundFailureReason;
      errorCode: number | null;
      /** Kode singkat untuk log. */
      kind: string;
      /** Isian `extras` baru untuk disimpan bersama status gagal (Email: `deliveredCopies`, R8). */
      extras?: MessageExtras;
    };

export type PreparedChannelSend =
  { send: () => Promise<ChannelSendOutcome> } | { failure: OutboundFailureReason };

interface MediaInput {
  kind: 'image' | 'audio' | 'video' | 'document';
  file: Blob;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
}

async function mediaOf(
  tx: DbExecutor,
  message: MessageRow,
  deps: ChannelSendDeps,
  now: Date,
): Promise<MediaInput | null> {
  if (!message.mediaFileId || !deps.store) return null;
  const [file] = await tx
    .select()
    .from(mediaFiles)
    .where(
      and(
        eq(mediaFiles.organizationId, message.organizationId),
        eq(mediaFiles.id, message.mediaFileId),
      ),
    )
    .limit(1);
  if (
    !file?.storageKey ||
    file.deletedAt !== null ||
    file.channelId !== message.channelId ||
    file.expiresAt.getTime() <= now.getTime() ||
    file.kind === 'sticker'
  ) {
    return null;
  }
  return {
    kind: file.kind,
    file: await deps.store.blob(file.storageKey, file.mimeType),
    filename: file.filename ?? `berkas-${file.id.slice(0, 8)}`,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    storageKey: file.storageKey,
  };
}

async function targetExternalId(
  tx: DbExecutor,
  message: MessageRow,
  targetId: string | null,
): Promise<string | null> {
  if (!targetId) return null;
  const [row] = await tx
    .select({ wamid: messages.wamid })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, message.organizationId),
        eq(messages.channelId, message.channelId),
        eq(messages.contactId, message.contactId),
        eq(messages.id, targetId),
      ),
    )
    .limit(1);
  return row?.wamid ?? null;
}

/** Pesan interaktif → teks + tombol inline Telegram (satu tombol per baris). */
export function telegramKeyboardOf(interactive: InteractiveMessage): {
  text: string;
  buttons: TelegramInlineButton[][];
} {
  const text = [interactive.header, interactive.body, interactive.footer]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
  const buttons =
    interactive.kind === 'button'
      ? interactive.buttons.map((button) => [{ text: button.title, callbackData: button.id }])
      : interactive.sections.flatMap((section) =>
          section.rows.map((row) => [{ text: row.title, callbackData: row.id }]),
        );
  return { text, buttons };
}

const TELEGRAM_MEDIA_METHOD: Readonly<Record<MediaInput['kind'], TelegramMediaMethod>> = {
  image: 'sendPhoto',
  audio: 'sendAudio',
  video: 'sendVideo',
  document: 'sendDocument',
};

function telegramFailure(error: unknown): ChannelSendOutcome {
  if (!isTelegramApiError(error)) throw error;
  const fail = (reason: OutboundFailureReason, retry = false): ChannelSendOutcome => ({
    ok: false,
    retry,
    reason,
    errorCode: error.httpStatus,
    kind: error.kind,
  });
  switch (error.kind) {
    case 'rate_limited':
    case 'server_error':
      return fail('channel_rejected', true);
    case 'forbidden':
    case 'chat_not_found':
      return fail('recipient_blocked');
    case 'network':
    case 'unexpected_response':
      return fail('delivery_unknown');
    default:
      return fail('channel_rejected');
  }
}

/** Kegagalan SMTP yang terjadi SEBELUM email diterima server (aman diulang). */
const SMTP_RETRYABLE = new Set<SmtpFailureCode>([
  'host_not_found',
  'connection_refused',
  'connection_timeout',
  'tls_failed',
]);

async function systemTransport(
  tx: DbExecutor,
  organizationId: string,
  deps: ChannelSendDeps,
): Promise<{ transport: MailTransportSettings; policy: SmtpPolicy } | null> {
  const basePolicy = {
    plaintextLogin: deps.smtp.plaintextLogin,
    lookup: deps.smtp.lookup,
    timeouts: deps.smtp.timeouts,
  };
  const [stored] = await tx
    .select()
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);
  if (stored) {
    const opened = openStoredEmailSettings(stored, deps.secretBox);
    return opened.ok
      ? {
          transport: opened.settings,
          policy: { ...basePolicy, allowedPorts: deps.smtp.allowedPorts },
        }
      : null;
  }
  if (deps.smtp.fallback) {
    return {
      transport: fallbackEmailSettings(deps.smtp.fallback),
      policy: { ...basePolicy, allowedPorts: [...deps.smtp.allowedPorts, deps.smtp.fallback.port] },
    };
  }
  return null;
}

export async function prepareChannelSend(
  tx: DbExecutor,
  message: MessageRow,
  channel: Channel,
  recipient: string,
  deps: ChannelSendDeps,
  now: Date,
): Promise<PreparedChannelSend> {
  if (!deps.secretBox) return { failure: 'credentials_unavailable' };
  const isMedia = ['image', 'audio', 'video', 'document'].includes(message.type);
  const media = isMedia ? await mediaOf(tx, message, deps, now) : null;
  if (isMedia && !media) return { failure: 'media_unavailable' };

  switch (channel.type) {
    case 'telegram': {
      if (!channel.tgBotTokenEncrypted) return { failure: 'credentials_unavailable' };
      let token: Secret<string>;
      try {
        token = openChannelConnectionSecret(
          deps.secretBox,
          channel,
          'telegramBotToken',
          channel.tgBotTokenEncrypted,
        );
      } catch {
        return { failure: 'credentials_unavailable' };
      }
      const quoted = await targetExternalId(tx, message, message.replyToMessageId);
      const replyTo = quoted ? Number(quoted.split(':')[1]) : null;
      const replyToMessageId = replyTo !== null && Number.isSafeInteger(replyTo) ? replyTo : null;
      const ok = (sent: { chatId: string; messageId: number }): ChannelSendOutcome => ({
        ok: true,
        externalId: `${sent.chatId}:${String(sent.messageId)}`,
      });
      let call: () => Promise<{ chatId: string; messageId: number }>;
      switch (message.type) {
        case 'text':
          if (!message.text) return { failure: 'channel_rejected' };
          call = () =>
            deps.telegram.sendText(token, {
              chatId: recipient,
              text: message.text ?? '',
              replyToMessageId,
              buttons: null,
            });
          break;
        case 'interactive': {
          const parsed = interactiveMessageSchema.safeParse(message.extras.interactiveMessage);
          if (!parsed.success) return { failure: 'channel_rejected' };
          const keyboard = telegramKeyboardOf(parsed.data);
          call = () =>
            deps.telegram.sendText(token, {
              chatId: recipient,
              text: keyboard.text,
              replyToMessageId,
              buttons: keyboard.buttons,
            });
          break;
        }
        case 'location': {
          const location = message.location;
          if (!location) return { failure: 'channel_rejected' };
          call = () =>
            deps.telegram.sendLocation(token, {
              chatId: recipient,
              latitude: location.latitude,
              longitude: location.longitude,
              replyToMessageId,
            });
          break;
        }
        default: {
          if (!media) return { failure: 'channel_rejected' };
          call = () =>
            deps.telegram.sendMedia(token, {
              method: TELEGRAM_MEDIA_METHOD[media.kind],
              chatId: recipient,
              file: media.file,
              filename: media.filename,
              caption: message.text,
              replyToMessageId,
            });
        }
      }
      return {
        send: async () => {
          try {
            return ok(await call());
          } catch (error) {
            return telegramFailure(error);
          }
        },
      };
    }

    case 'email': {
      if (message.type !== 'text' && !media) return { failure: 'channel_rejected' };
      const fromAddress = channel.emailAddress ?? '';
      let resolved: { transport: MailTransportSettings; policy: SmtpPolicy } | null;
      if (channel.emailSmtpMode === 'custom') {
        if (!channel.emailSmtpPasswordEncrypted) return { failure: 'credentials_unavailable' };
        let password: Secret<string>;
        try {
          password = openChannelConnectionSecret(
            deps.secretBox,
            channel,
            'emailSmtpPassword',
            channel.emailSmtpPasswordEncrypted,
          );
        } catch {
          return { failure: 'credentials_unavailable' };
        }
        const connection: SmtpConnectionConfig = {
          host: channel.emailSmtpHost ?? '',
          port: channel.emailSmtpPort ?? 465,
          security: (channel.emailSmtpSecurity ?? 'ssl') as SmtpConnectionConfig['security'],
          username: channel.emailSmtpUsername,
          password,
        };
        resolved = {
          transport: {
            connection,
            sender: { fromName: channel.emailFromName ?? channel.name, fromAddress, replyTo: null },
          },
          policy: {
            plaintextLogin: deps.smtp.plaintextLogin,
            lookup: deps.smtp.lookup,
            timeouts: deps.smtp.timeouts,
            allowedPorts: deps.smtp.allowedPorts,
          },
        };
      } else {
        resolved = await systemTransport(tx, message.organizationId, deps);
        if (!resolved) return { failure: 'credentials_unavailable' };
        // Akun SMTP sistem mengirim atas nama alamatnya sendiri; balasan pelanggan ke alamat channel.
        resolved = {
          ...resolved,
          transport: {
            ...resolved.transport,
            sender: {
              ...resolved.transport.sender,
              fromName: channel.emailFromName ?? resolved.transport.sender.fromName,
              replyTo: resolved.transport.sender.fromAddress === fromAddress ? null : fromAddress,
            },
          },
        };
      }

      // Utas: email masuk terakhir di percakapan ini.
      const [previous] = await tx
        .select({ wamid: messages.wamid, extras: messages.extras })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, message.organizationId),
            eq(messages.conversationId, message.conversationId),
            eq(messages.direction, 'inbound'),
            isNotNull(messages.wamid),
            sql`${messages.extras} ? 'email'`,
          ),
        )
        .orderBy(desc(messages.occurredAt))
        .limit(1);
      const inReplyTo =
        previous?.wamid && !previous.wamid.startsWith('sha256:') ? previous.wamid : null;
      const references = [
        ...(previous?.extras.email?.references ?? []),
        ...(inReplyTo ? [inReplyTo] : []),
      ].slice(-20);
      const subject = replySubject(previous?.extras.email?.subject ?? null);
      const messageId = newOutboundMessageId(fromAddress);
      // Tahap 9.0: Cc/Bcc yang SUDAH diperiksa api (format, izin alamat baru, maks. 10).
      const cc = message.extras.email?.cc ?? [];
      const bcc = message.extras.email?.bcc ?? [];
      // Review 9.0 R8: tembusan yang sudah menerima email ini (percobaan sebelumnya) tidak dikirimi lagi.
      const alreadyDelivered = message.extras.email?.deliveredCopies ?? [];
      const store = deps.store;
      const transport = resolved.transport;
      const policy = resolved.policy;
      return {
        send: async () => {
          let attachments: MailAttachment[] | undefined;
          if (media && store) {
            const chunks: Buffer[] = [];
            for await (const chunk of store.chunks(media.storageKey)) chunks.push(chunk);
            attachments = [
              {
                filename: media.filename,
                contentType: media.mimeType,
                content: Buffer.concat(chunks),
              },
            ];
          }
          const result = await sendSmtpMail(
            transport.connection,
            transport.sender,
            {
              to: recipient,
              cc,
              bcc,
              ...(alreadyDelivered.length > 0 ? { skipCopies: alreadyDelivered } : {}),
              subject,
              text: message.text ?? (attachments ? 'Terlampir.' : ''),
              thread: { messageId, inReplyTo, references },
              autoSubmitted: message.senderKind !== 'agent',
              ...(attachments ? { attachments } : {}),
            },
            policy,
          );
          if (result.ok) {
            return {
              ok: true,
              externalId: messageId,
              extras: {
                ...message.extras,
                email: {
                  subject,
                  inReplyTo,
                  references,
                  authWarning: false,
                  skippedAttachments: 0,
                  hasHtml: false,
                  to: [recipient.toLowerCase()],
                  cc,
                  bcc,
                  ...(result.rejectedCopies ? { rejectedCopies: result.rejectedCopies } : {}),
                },
              },
            };
          }
          return {
            ok: false,
            retry: SMTP_RETRYABLE.has(result.code),
            reason: result.code === 'unknown' ? 'delivery_unknown' : 'channel_rejected',
            errorCode: result.diagnostic.responseCode ?? null,
            kind: result.code,
            ...(result.deliveredCopies && message.extras.email
              ? {
                  extras: {
                    ...message.extras,
                    email: {
                      ...message.extras.email,
                      deliveredCopies: [
                        ...new Set([...alreadyDelivered, ...result.deliveredCopies]),
                      ],
                    },
                  },
                }
              : {}),
          };
        },
      };
    }

    case 'messenger':
    case 'instagram': {
      let credentials;
      try {
        credentials = openMetaSocialCredentials(deps.secretBox, channel);
      } catch {
        return { failure: 'credentials_unavailable' };
      }
      const pageId = channel.metaPageId ?? '';
      if (message.type === 'text' && !message.text) return { failure: 'channel_rejected' };
      if (message.type !== 'text' && !media) return { failure: 'channel_rejected' };
      return {
        send: async () => {
          try {
            const sent = await sendMetaSocialMessage(
              deps.meta,
              credentials,
              pageId,
              recipient,
              media
                ? { type: 'media', kind: media.kind, file: media.file, filename: media.filename }
                : { type: 'text', text: message.text ?? '' },
            );
            return { ok: true, externalId: sent.messageId };
          } catch (error) {
            if (!isMetaApiError(error)) throw error;
            const retry = error.kind === 'rate_limited' || error.kind === 'temporarily_unavailable';
            return {
              ok: false,
              retry,
              reason: error.kind === 'network_error' ? 'delivery_unknown' : 'meta_rejected',
              errorCode: error.metaCode,
              kind: error.kind,
            };
          }
        },
      };
    }

    default:
      return { failure: 'channel_unavailable' };
  }
}
