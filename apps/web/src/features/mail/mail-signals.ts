import type { MailOutboxStatus } from '@balesin/shared';

/**
 * Sinyal sekali-jalan dari soket ke komponen yang sedang menunggu (unduhan lampiran yang sedang
 * disiapkan server, aksi yang dikembalikan server, status kirim, penanda "sedang membalas"). Bukan
 * data cache: hanya pemberitahuan.
 */
export type MailSignal =
  | { type: 'attachment.ready'; attachmentId: string }
  | { type: 'attachment.failed'; attachmentId: string; code: string }
  | { type: 'action.failed'; messageIds: readonly string[] }
  // ── 9B (KONTRAK-API-EMAIL-TULIS §14) ──
  | {
      type: 'outbox.updated';
      outboxId: string;
      draftId: string | null;
      accountId: string;
      status: MailOutboxStatus;
      holdReason: string | null;
      sendAfter: string | null;
      failureReason: string | null;
    }
  | { type: 'draft.updated'; draftId: string; version: number }
  | { type: 'draft.deleted'; draftId: string }
  | {
      type: 'compose.presence';
      accountId: string;
      threadKey: string;
      users: readonly { id: string; name: string }[];
    }
  | { type: 'message.created'; accountId: string; messageId: string; threadKey: string | null };

type Listener = (signal: MailSignal) => void;

const listeners = new Set<Listener>();

export function onMailSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitMailSignal(signal: MailSignal): void {
  for (const listener of [...listeners]) listener(signal);
}
