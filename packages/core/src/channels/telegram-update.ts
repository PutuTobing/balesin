import { z } from 'zod';

import { cleanCustomerText, cleanFileName } from '../meta/contact-identity';
import type { ChannelInboundMessage } from './inbound';

/**
 * Update Bot API Telegram (webhook) → kejadian masuk netral (Fase 6). Input TIDAK tepercaya walau
 * header `secret_token` sudah cocok: skema toleran (isian tak dikenal diabaikan), batas panjang,
 * teks pelanggan dibersihkan.
 *
 * Yang diproses: `message` di chat PRIBADI (teks, foto, dokumen, suara, audio, video, video note,
 * stiker, lokasi, venue, kontak) dan `callback_query` (tombol inline). Lainnya (grup/kanal, pesan
 * diedit, anggota bergabung, …) → `ignored` dengan alasan (dicatat sebagai `skipped`).
 */

const userSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string().max(1024).optional(),
  last_name: z.string().max(1024).optional(),
  username: z.string().max(64).optional(),
});

const fileFields = {
  file_id: z.string().min(1).max(512),
  file_unique_id: z.string().max(256).optional(),
  file_size: z.number().int().nonnegative().optional(),
};

const messageSchema = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int().nonnegative(),
  from: userSchema.optional(),
  chat: z.object({ id: z.number().int(), type: z.string().max(32) }),
  text: z.string().max(8192).optional(),
  caption: z.string().max(4096).optional(),
  photo: z
    .array(z.object({ ...fileFields, width: z.number().optional() }))
    .max(20)
    .optional(),
  document: z
    .object({
      ...fileFields,
      file_name: z.string().max(1024).optional(),
      mime_type: z.string().max(255).optional(),
    })
    .optional(),
  voice: z.object({ ...fileFields, mime_type: z.string().max(255).optional() }).optional(),
  audio: z
    .object({
      ...fileFields,
      file_name: z.string().max(1024).optional(),
      mime_type: z.string().max(255).optional(),
    })
    .optional(),
  video: z
    .object({
      ...fileFields,
      file_name: z.string().max(1024).optional(),
      mime_type: z.string().max(255).optional(),
    })
    .optional(),
  video_note: z.object(fileFields).optional(),
  sticker: z
    .object({
      ...fileFields,
      is_animated: z.boolean().optional(),
      is_video: z.boolean().optional(),
    })
    .optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  venue: z
    .object({
      location: z.object({ latitude: z.number(), longitude: z.number() }),
      title: z.string().max(1024).optional(),
      address: z.string().max(1024).optional(),
    })
    .optional(),
  contact: z
    .object({
      phone_number: z.string().max(64).optional(),
      first_name: z.string().max(1024).optional(),
      last_name: z.string().max(1024).optional(),
    })
    .optional(),
  reply_to_message: z.object({ message_id: z.number().int().positive() }).optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string().min(1).max(256),
      from: userSchema,
      data: z.string().max(256).optional(),
      message: z
        .object({
          message_id: z.number().int(),
          chat: z.object({ id: z.number().int(), type: z.string().max(32) }),
        })
        .optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export type TelegramUpdateResult =
  | {
      ok: true;
      message: ChannelInboundMessage;
      /** Diisi untuk tombol inline: dijawab di badan respons webhook (`answerCallbackQuery`). */
      callbackQueryId: string | null;
    }
  | { ok: false; reason: 'invalid' | 'ignored'; updateId: number | null };

function displayNameOf(user: z.infer<typeof userSchema>): string | null {
  return cleanCustomerText([user.first_name, user.last_name].filter(Boolean).join(' '));
}

function handleOf(user: z.infer<typeof userSchema>): string | null {
  return user.username && /^[A-Za-z0-9_]{1,64}$/.test(user.username) ? `@${user.username}` : null;
}

function senderOf(user: z.infer<typeof userSchema>) {
  return {
    externalUserId: String(user.id),
    handle: handleOf(user),
    displayName: displayNameOf(user),
  };
}

function text(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.replaceAll('\u0000', '');
  return trimmed.trim().length === 0 ? null : trimmed;
}

/** Update yang SUDAH lolos JSON.parse → kejadian netral (atau alasan dilewati). */
export function normalizeTelegramUpdate(body: unknown): TelegramUpdateResult {
  const parsed = telegramUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const id = (body as { update_id?: unknown } | null)?.update_id;
    return { ok: false, reason: 'invalid', updateId: typeof id === 'number' ? id : null };
  }
  const update = parsed.data;

  if (update.callback_query) {
    const query = update.callback_query;
    // Review Fase 6 Info 4: tombol tanpa pesan (inline mode — tidak dipakai Balesin) atau dari chat
    // selain pribadi diabaikan.
    if (query.from.is_bot || !query.message || query.message.chat.type !== 'private') {
      return { ok: false, reason: 'ignored', updateId: update.update_id };
    }
    const data = cleanCustomerText(query.data ?? null, 256);
    return {
      ok: true,
      callbackQueryId: query.id,
      message: {
        kind: 'message',
        externalId: `cb:${query.id}`.slice(0, 256),
        sentAt: new Date().toISOString(),
        sender: senderOf(query.from),
        type: 'interactive',
        rawType: 'callback_query',
        text: data,
        media: null,
        location: null,
        replyToExternalId: query.message
          ? `${String(query.message.chat.id)}:${String(query.message.message_id)}`
          : null,
        reply: { kind: 'button_reply', id: data, title: data },
        email: null,
      },
    };
  }

  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type !== 'private') {
    return { ok: false, reason: 'ignored', updateId: update.update_id };
  }
  const chatId = String(message.chat.id);
  const base: ChannelInboundMessage = {
    kind: 'message',
    externalId: `${chatId}:${String(message.message_id)}`,
    sentAt: new Date(message.date * 1000).toISOString(),
    sender: senderOf(message.from),
    type: 'text',
    rawType: 'text',
    text: text(message.text ?? message.caption),
    media: null,
    location: null,
    replyToExternalId: message.reply_to_message
      ? `${chatId}:${String(message.reply_to_message.message_id)}`
      : null,
    reply: null,
    email: null,
  };
  const media = (
    kind: 'image' | 'audio' | 'video' | 'document' | 'sticker',
    rawType: string,
    file: { file_id: string; file_size?: number },
    extra: { mimeType?: string; filename?: string; voice?: boolean; animated?: boolean } = {},
  ): ChannelInboundMessage => ({
    ...base,
    type: kind,
    rawType,
    media: {
      kind,
      ref: file.file_id,
      mimeType:
        extra.mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(extra.mimeType) ? extra.mimeType : null,
      filename: cleanFileName(extra.filename ?? null),
      sizeBytes: file.file_size ?? null,
      voice: extra.voice ?? false,
      animated: extra.animated ?? false,
      mediaFileId: null,
    },
  });

  let result: ChannelInboundMessage;
  if (message.photo && message.photo.length > 0) {
    // Ukuran terbesar ada di akhir daftar.
    result = media(
      'image',
      'photo',
      message.photo[message.photo.length - 1] as { file_id: string },
    );
  } else if (message.document) {
    result = media('document', 'document', message.document, {
      mimeType: message.document.mime_type,
      filename: message.document.file_name,
    });
  } else if (message.voice) {
    result = media('audio', 'voice', message.voice, {
      mimeType: message.voice.mime_type,
      voice: true,
    });
  } else if (message.audio) {
    result = media('audio', 'audio', message.audio, {
      mimeType: message.audio.mime_type,
      filename: message.audio.file_name,
    });
  } else if (message.video) {
    result = media('video', 'video', message.video, {
      mimeType: message.video.mime_type,
      filename: message.video.file_name,
    });
  } else if (message.video_note) {
    result = media('video', 'video_note', message.video_note);
  } else if (message.sticker) {
    result = media('sticker', 'sticker', message.sticker, {
      animated: message.sticker.is_animated === true || message.sticker.is_video === true,
    });
  } else if (message.venue || message.location) {
    const location = message.venue?.location ?? message.location;
    if (!location || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180) {
      return { ok: false, reason: 'invalid', updateId: update.update_id };
    }
    result = {
      ...base,
      type: 'location',
      rawType: message.venue ? 'venue' : 'location',
      text: null,
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        name: cleanCustomerText(message.venue?.title ?? null),
        address: cleanCustomerText(message.venue?.address ?? null, 512),
      },
    };
  } else if (message.contact) {
    const name = cleanCustomerText(
      [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' '),
    );
    const phone = cleanCustomerText(message.contact.phone_number ?? null, 64);
    result = {
      ...base,
      type: 'contacts',
      rawType: 'contact',
      text: [name, phone].filter(Boolean).join(' — ') || null,
    };
  } else if (base.text !== null) {
    result = base;
  } else {
    // Jenis lain (polling, dadu, game, …): disimpan sebagai "belum didukung".
    result = { ...base, type: 'unsupported', rawType: 'other' };
  }
  return { ok: true, message: result, callbackQueryId: null };
}
