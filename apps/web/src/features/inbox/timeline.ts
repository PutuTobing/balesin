import type { Message } from '@balesin/shared';

export interface TimelineModel {
  /** Pesan yang tampil sebagai baris (reaksi yang sasarannya dimuat tidak termasuk). */
  rows: Message[];
  /** Reaksi terakhir per pesan sasaran (`null` = dihapus). */
  reactions: Map<string, string>;
  byId: Map<string, Message>;
}

/** Reaksi ditempel ke pesan sasarannya; hanya reaksi terakhir per pesan yang berlaku. */
export function buildTimeline(messages: Message[]): TimelineModel {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const reactions = new Map<string, string>();
  const rows: Message[] = [];
  for (const message of messages) {
    const target = message.type === 'reaction' ? message.reaction?.messageId : null;
    if (target && byId.has(target)) {
      const emoji = message.reaction?.emoji;
      if (emoji) reactions.set(target, emoji);
      else reactions.delete(target);
      continue;
    }
    // Menghapus reaksi atas pesan yang tidak dimuat: tidak ada yang perlu ditampilkan.
    if (message.type === 'reaction' && !message.reaction?.emoji) continue;
    rows.push(message);
  }
  return { rows, reactions, byId };
}
