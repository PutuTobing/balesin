import type { Message, MobichatAttachment, MobichatMessage } from '@balesin/shared';

/**
 * Pesan Balesin (bentuk respons inbox) → bentuk pesan MobiChat untuk `GET /api/public/messages`.
 *
 * Jenis pengirim (dibaca workflow n8n untuk membedakan pelanggan vs tim):
 *  - pesan masuk pelanggan → `user`; pesan masuk `system` (mis. ganti nomor) → `system`;
 *  - keluar oleh agen → `agent`; oleh bot/API key → `api-bot`; broadcast → `broadcast`.
 * Teks: isi/caption apa adanya; lokasi, balasan tombol, dan kontak dibuat teks ringkas supaya bot
 * tidak menerima "pesan tanpa teks".
 */

const FALLBACK_MIME: Readonly<Record<string, string>> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/ogg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

export function senderTypeOf(message: Pick<Message, 'direction' | 'senderKind' | 'type'>) {
  if (message.direction === 'inbound') return message.type === 'system' ? 'system' : 'user';
  switch (message.senderKind) {
    case 'agent':
      return 'agent';
    case 'bot':
      return 'api-bot';
    case 'broadcast':
      return 'broadcast';
    default:
      return 'system';
  }
}

function textOf(message: Message): string | null {
  if (message.location) {
    const { latitude, longitude, name, address } = message.location;
    const label = [name, address].filter((part) => part && part.trim() !== '').join(', ');
    return `[lokasi] ${label ? `${label} ` : ''}https://maps.google.com/?q=${String(latitude)},${String(longitude)}`;
  }
  if (message.text !== null && message.text !== '') return message.text;
  if (message.interactive?.title) return message.interactive.title;
  if (message.sharedContactsCount > 0) return '[mengirim kontak]';
  return null;
}

function attachmentsOf(message: Message, url: string | null): MobichatAttachment[] {
  const media = message.media;
  if (!media || !message.mediaAvailable) return [];
  const mime = media.mimeType ?? FALLBACK_MIME[media.kind] ?? 'application/octet-stream';
  const name =
    media.kind === 'sticker'
      ? `sticker_${String(message.number)}.webp`
      : (media.filename ?? `${media.kind}_${String(message.number)}`);
  return [
    {
      id: message.number,
      type: mime,
      file_type: mime,
      mime_type: mime,
      media_type: media.kind,
      name,
      url,
      signed_url: url,
      public_url: url,
    },
  ];
}

export function toMobichatMessage(
  message: Message,
  context: {
    conversationNumber: number;
    index: number;
    /** Nama pengirim untuk pesan masuk (nama kontak) dan pesan bot (nama API key). */
    contactName: string | null;
    botName: string | null;
    mediaUrl: string | null;
  },
): MobichatMessage {
  const type = senderTypeOf(message);
  const text = textOf(message);
  const attachments = attachmentsOf(message, context.mediaUrl);
  return {
    id: message.number,
    index: context.index,
    conversation_id: context.conversationNumber,
    type,
    sender: type,
    sender_name:
      type === 'user'
        ? context.contactName
        : type === 'agent'
          ? (message.senderName ?? null)
          : type === 'api-bot'
            ? context.botName
            : null,
    message_type: message.type,
    text,
    message_text: text,
    status: message.status,
    created_at: message.createdAt,
    attachments,
    file_attachments: attachments,
  };
}
