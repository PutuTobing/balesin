import type { Message } from '@balesin/shared';

/** Reaksi terakhir pada satu pesan: dari pelanggan (`in`) dan dari tim (`out`). */
export interface MessageReactions {
  in?: string;
  out?: string;
}

export interface TimelineModel {
  /** Pesan yang tampil sebagai baris (reaksi yang sasarannya dimuat tidak termasuk). */
  rows: Message[];
  /** Reaksi terakhir per pesan sasaran, per arah (pelanggan / tim). */
  reactions: Map<string, MessageReactions>;
  byId: Map<string, Message>;
}

/**
 * Reaksi ditempel ke pesan sasarannya; per arah hanya reaksi terakhir yang berlaku (WhatsApp:
 * satu reaksi per orang per pesan; emoji kosong = reaksi dihapus).
 */
export function buildTimeline(messages: Message[]): TimelineModel {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const reactions = new Map<string, MessageReactions>();
  const rows: Message[] = [];
  for (const message of messages) {
    const target = message.type === 'reaction' ? message.reaction?.messageId : null;
    if (target && byId.has(target)) {
      const side = message.direction === 'outbound' ? 'out' : 'in';
      const current = { ...reactions.get(target) };
      const emoji = message.reaction?.emoji;
      if (emoji) current[side] = emoji;
      else delete current[side];
      if (current.in || current.out) reactions.set(target, current);
      else reactions.delete(target);
      continue;
    }
    // Menghapus reaksi atas pesan yang tidak dimuat: tidak ada yang perlu ditampilkan.
    if (message.type === 'reaction' && !message.reaction?.emoji) continue;
    rows.push(message);
  }
  return { rows, reactions, byId };
}

/** Pesan yang boleh dibalas/diberi reaksi: sudah sampai di WhatsApp (punya wamid). */
export function isActionable(message: Message): boolean {
  if (message.type === 'reaction' || message.type === 'system') return false;
  if (message.direction === 'inbound') return true;
  return (
    message.status === 'sent' ||
    message.status === 'delivered' ||
    message.status === 'read' ||
    message.status === 'played'
  );
}
