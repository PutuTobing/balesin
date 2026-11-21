import type { Conversation } from '@balesin/shared';
import { useCan } from '../auth/session';
import { reopenIsStale } from './inbox-time';
import { useMinuteClock } from './use-minute-clock';

/** Keterangan chat selesai di dasar ruang chat; tombol "Buka lagi" yang nonaktif merujuk ke sini. */
export const RESOLVED_NOTE_ID = 'chat-selesai-keterangan';

/**
 * "Buka lagi" tidak bisa dipakai: chat selesai yang pelanggannya tidak menghubungi dalam 24 jam
 * terakhir, dan pengguna tanpa `inbox.initiate` (audit akhir A1 — server menjawab 403).
 */
export function useReopenBlocked(conversation: Conversation): boolean {
  const canInitiate = useCan('inbox.initiate');
  const now = useMinuteClock();
  return conversation.status === 'resolved' && !canInitiate && reopenIsStale(conversation, now);
}
