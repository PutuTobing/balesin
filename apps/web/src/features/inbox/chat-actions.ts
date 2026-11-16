import type { Message } from '@balesin/shared';
import { createContext, useContext } from 'react';

/**
 * Aksi per pesan di ruang chat (balas, reaksi, kirim ulang) + nama agen. Lewat konteks supaya
 * riwayat pesan (memo) tidak dirender ulang setiap kali composer berubah.
 */
export interface ChatActions {
  /** Pengguna boleh membalas di percakapan ini sekarang (izin + jendela 24 jam + tidak selesai). */
  canReply: boolean;
  /** Boleh menekan "Kirim ulang" (izin; jendela diperiksa server). */
  canRetry: boolean;
  onReply: (message: Message) => void;
  onReact: (message: Message, emoji: string) => void;
  onRetry: (message: Message) => void;
  /** Tandai / lepas tanda pesan (bintang bersama). */
  onStar: (message: Message, starred: boolean) => void;
  /** ID pesan yang sedang dikirim ulang. */
  retrying: ReadonlySet<string>;
  /** Nama agen pengirim pesan keluar. */
  agentName: (userId: string | null) => string | null;
  /** ID pengguna yang sedang masuk (label "Kamu"). */
  selfId: string | null;
}

const noop = () => undefined;

export const ChatActionsContext = createContext<ChatActions>({
  canReply: false,
  canRetry: false,
  onReply: noop,
  onReact: noop,
  onRetry: noop,
  onStar: noop,
  retrying: new Set(),
  agentName: () => null,
  selfId: null,
});

export function useChatActions(): ChatActions {
  return useContext(ChatActionsContext);
}

/** Pilihan reaksi cepat (emoji = isi pesan, bukan ikon UI). */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
