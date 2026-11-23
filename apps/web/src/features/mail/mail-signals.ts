/**
 * Sinyal sekali-jalan dari soket ke komponen yang sedang menunggu (unduhan lampiran yang sedang
 * disiapkan server, aksi yang dikembalikan server). Bukan data cache: hanya pemberitahuan.
 */
export type MailSignal =
  | { type: 'attachment.ready'; attachmentId: string }
  | { type: 'attachment.failed'; attachmentId: string; code: string }
  | { type: 'action.failed'; messageIds: readonly string[] };

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
