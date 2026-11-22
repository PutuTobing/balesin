import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { inboxKeys, storeMessage } from './inbox-queries';

/**
 * Pesan yang sedang dikirim dari browser ini (belum punya baris di server): tampil optimistis di
 * bawah riwayat sampai server menjawab, lalu digantikan pesan sungguhan (`status: pending` → status
 * dari WebSocket). `clientMessageId` = kunci idempotensi: "Kirim ulang" memakai ID yang sama, jadi
 * permintaan yang sebenarnya sudah sampai tidak menggandakan pesan.
 */
export interface OutboxItem {
  clientMessageId: string;
  conversationId: string;
  kind: 'text' | 'media';
  /** Isi teks, atau keterangan media. */
  text: string;
  file?: File;
  /** Pratinjau gambar lokal (object URL), dicabut saat item dibuang. */
  previewUrl?: string;
  /** ID unggahan yang sudah berhasil (kirim ulang tidak mengunggah dua kali). */
  mediaId?: string;
  replyToMessageId?: string;
  /** Channel Email (tahap 9.0): alamat tambahan. Kirim ulang memakai daftar yang sama. */
  cc?: string[];
  bcc?: string[];
  state: 'sending' | 'failed';
  error?: unknown;
  createdAt: string;
}

const items = new Map<string, OutboxItem[]>();
const listeners = new Set<() => void>();
const EMPTY: OutboxItem[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function update(conversationId: string, change: (list: OutboxItem[]) => OutboxItem[]): void {
  const next = change(items.get(conversationId) ?? []);
  if (next.length === 0) items.delete(conversationId);
  else items.set(conversationId, next);
  emit();
}

function patch(item: OutboxItem, changes: Partial<OutboxItem>): OutboxItem {
  const next = { ...item, ...changes };
  update(item.conversationId, (list) =>
    list.map((entry) => (entry.clientMessageId === item.clientMessageId ? next : entry)),
  );
  return next;
}

export function removeOutboxItem(item: OutboxItem): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  update(item.conversationId, (list) =>
    list.filter((entry) => entry.clientMessageId !== item.clientMessageId),
  );
}

export function useOutbox(conversationId: string): OutboxItem[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => items.get(conversationId) ?? EMPTY,
  );
}

/** Kosongkan semua (keluar / pindah pengguna). Hanya untuk tes & pembersihan. */
export function resetOutbox(): void {
  for (const list of items.values()) {
    for (const item of list) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  items.clear();
  emit();
}

export function newClientMessageId(): string {
  return crypto.randomUUID();
}

export function createOutboxItem(
  init: Omit<OutboxItem, 'clientMessageId' | 'state' | 'createdAt'>,
): OutboxItem {
  const item: OutboxItem = {
    ...init,
    clientMessageId: newClientMessageId(),
    state: 'sending',
    createdAt: new Date().toISOString(),
  };
  update(item.conversationId, (list) => [...list, item]);
  return item;
}

/**
 * Kirim (atau kirim ulang) satu item. Berhasil → pesan server masuk ke cache, item dibuang.
 * Gagal → item ditandai gagal dan error dilempar lagi supaya composer bisa menjelaskannya
 * (429 dengan hitung mundur, 423 rem darurat, 409 jendela habis).
 */
export async function sendOutboxItem(queryClient: QueryClient, item: OutboxItem): Promise<void> {
  let current = patch(item, { state: 'sending', error: undefined });
  try {
    let mediaId = current.mediaId;
    if (current.kind === 'media' && !mediaId && current.file) {
      mediaId = (await endpoints.inbox.upload(current.conversationId, current.file)).media.id;
      current = patch(current, { mediaId });
    }
    const caption = current.text.trim();
    const copies = {
      ...(current.cc && current.cc.length > 0 ? { cc: current.cc } : {}),
      ...(current.bcc && current.bcc.length > 0 ? { bcc: current.bcc } : {}),
    };
    const { message } = await endpoints.inbox.send(
      current.conversationId,
      current.kind === 'media' && mediaId
        ? {
            type: 'media',
            clientMessageId: current.clientMessageId,
            mediaId,
            ...(caption ? { caption } : {}),
            ...(current.replyToMessageId ? { replyToMessageId: current.replyToMessageId } : {}),
            ...copies,
          }
        : {
            type: 'text',
            clientMessageId: current.clientMessageId,
            text: current.text,
            ...(current.replyToMessageId ? { replyToMessageId: current.replyToMessageId } : {}),
            ...copies,
          },
    );
    storeMessage(queryClient, current.conversationId, message);
    queryClient.setQueryData(inboxKeys.sendingPaused, false);
    removeOutboxItem(current);
  } catch (error) {
    patch(current, { state: 'failed', error });
    noteSendError(queryClient, current.conversationId, error);
    throw error;
  }
}

/** Akibat error kirim pada keadaan inbox: rem darurat, jendela habis, sudah tidak berhak. */
export function noteSendError(queryClient: QueryClient, conversationId: string, error: unknown) {
  if (!isApiError(error)) return;
  if (error.status === 423) queryClient.setQueryData(inboxKeys.sendingPaused, true);
  if (error.code === 'WINDOW_CLOSED' || error.status === 403 || error.status === 404) {
    // Keadaan jendela/cakupan di layar sudah basi (403: mis. chat baru saja diselesaikan orang lain
    // dan mengirim ke chat selesai butuh `inbox.initiate`): ambil ulang percakapannya.
    void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
  }
}
