import type { MailComposeAddress, MailDraftMode, MailOutboxItem } from '@balesin/shared';
import { useSyncExternalStore } from 'react';

/**
 * Pengelola jendela tulis & toast kirim menu Email (PRD §4.4: beberapa draf sekaligus). Disimpan di
 * modul (bukan state komponen) supaya tombol Balas di panel baca, kolom folder, daftar Draf, dan
 * toast "Batalkan" bisa membuka jendela yang sama. Jendela yang ditutup selalu menyimpan drafnya
 * dulu (ComposeWindow), jadi menutup paksa jendela lama aman.
 */

/** Maksimal jendela tulis sekaligus (desktop); lebih dari itu, jendela paling lama ditutup. */
export const MAX_COMPOSE_WINDOWS = 3;

export type ComposeIntent =
  | {
      kind: 'new';
      /** Akun yang sedang dibuka (pilihan "Dari" bawaan). */
      accountId?: string | null;
      to?: MailComposeAddress[];
      subject?: string;
    }
  | {
      kind: Exclude<MailDraftMode, 'new'>;
      sourceMessageId: string;
      accountId: string;
      subject: string | null;
    }
  | { kind: 'draft'; draftId: string; subject?: string | null };

export type ComposeWindowMode = 'open' | 'minimized' | 'maximized';

export interface ComposeWindowState {
  key: string;
  intent: ComposeIntent;
  /** Terisi setelah draf dibuat/dibuka. */
  draftId: string | null;
  mode: ComposeWindowMode;
  /** Judul bilah (subjek terbaru). */
  title: string | null;
  draftMode: MailDraftMode;
}

export type SendToastStatus = MailOutboxItem['status'] | 'canceling';

export interface SendToastState {
  key: string;
  outbox: MailOutboxItem;
  /** Waktu lokal saat toast dibuat, untuk hitung mundur yang tidak bergantung jam server. */
  createdAt: number;
  /** Status terkini (WS / tanya ulang); `canceling` = permintaan batal sedang jalan. */
  status: SendToastStatus;
  message: string | null;
}

interface ComposeSnapshot {
  windows: readonly ComposeWindowState[];
  toasts: readonly SendToastState[];
  /** Pemberitahuan singkat (mis. jendela lama ditutup karena batas). */
  notice: string | null;
}

let snapshot: ComposeSnapshot = { windows: [], toasts: [], notice: null };
const listeners = new Set<() => void>();
let counter = 0;

function emit(next: Partial<ComposeSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useComposeStore(): ComposeSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function getComposeSnapshot(): ComposeSnapshot {
  return snapshot;
}

function modeOf(intent: ComposeIntent): MailDraftMode {
  return intent.kind === 'draft' ? 'new' : intent.kind;
}

function sameIntent(window: ComposeWindowState, intent: ComposeIntent): boolean {
  if (intent.kind === 'draft') {
    return (
      window.draftId === intent.draftId ||
      (window.intent.kind === 'draft' && window.intent.draftId === intent.draftId)
    );
  }
  if (intent.kind === 'new') return false;
  return (
    window.intent.kind === intent.kind &&
    'sourceMessageId' in window.intent &&
    window.intent.sourceMessageId === intent.sourceMessageId
  );
}

/**
 * Buka jendela tulis. Draf/balasan yang sama sudah terbuka → jendela itu yang difokus. Jendela lain
 * diperkecil (satu jendela terbuka penuh pada satu waktu); lewat batas → yang paling lama ditutup.
 */
export function openCompose(intent: ComposeIntent): string {
  const existing = snapshot.windows.find((window) => sameIntent(window, intent));
  if (existing) {
    focusCompose(existing.key);
    return existing.key;
  }
  counter += 1;
  const key = `tulis-${String(counter)}`;
  const opened: ComposeWindowState = {
    key,
    intent,
    draftId: intent.kind === 'draft' ? intent.draftId : null,
    mode: 'open',
    title: intent.kind === 'new' ? (intent.subject ?? null) : (intent.subject ?? null),
    draftMode: modeOf(intent),
  };
  let windows = snapshot.windows.map((window) =>
    window.mode === 'minimized' ? window : { ...window, mode: 'minimized' as const },
  );
  let notice: string | null = null;
  if (windows.length >= MAX_COMPOSE_WINDOWS) {
    windows = windows.slice(windows.length - MAX_COMPOSE_WINDOWS + 1);
    notice = 'too-many';
  }
  emit({ windows: [...windows, opened], notice });
  return key;
}

export function focusCompose(key: string): void {
  emit({
    windows: snapshot.windows.map((window) =>
      window.key === key
        ? { ...window, mode: window.mode === 'maximized' ? 'maximized' : 'open' }
        : window.mode === 'minimized'
          ? window
          : { ...window, mode: 'minimized' },
    ),
  });
}

/** Ubah ukuran satu jendela. Membuka/memperbesar satu jendela memperkecil jendela lain. */
export function setComposeMode(key: string, mode: ComposeWindowMode): void {
  emit({
    windows: snapshot.windows.map((window) =>
      window.key === key
        ? { ...window, mode }
        : mode !== 'minimized' && window.mode !== 'minimized'
          ? { ...window, mode: 'minimized' }
          : window,
    ),
  });
}

export function patchCompose(
  key: string,
  patch: Partial<Pick<ComposeWindowState, 'draftId' | 'title' | 'draftMode'>>,
): void {
  if (!snapshot.windows.some((window) => window.key === key)) return;
  emit({
    windows: snapshot.windows.map((window) =>
      window.key === key ? { ...window, ...patch } : window,
    ),
  });
}

export function closeCompose(key: string): void {
  emit({ windows: snapshot.windows.filter((window) => window.key !== key) });
}

/** Tutup jendela draf tertentu (draf dibuang/terkirim di tab lain). */
export function closeComposeForDraft(draftId: string): void {
  emit({ windows: snapshot.windows.filter((window) => window.draftId !== draftId) });
}

export function clearComposeNotice(): void {
  if (snapshot.notice !== null) emit({ notice: null });
}

// ── Toast kirim ────────────────────────────────────────────────────────────

export function showSendToast(outbox: MailOutboxItem): void {
  const others = snapshot.toasts.filter((toast) => toast.outbox.id !== outbox.id);
  emit({
    toasts: [
      // Paling banyak tiga toast; yang lama hilang lebih dulu.
      ...others.slice(-2),
      {
        key: `kirim-${outbox.id}`,
        outbox,
        createdAt: Date.now(),
        status: outbox.status,
        message: null,
      },
    ],
  });
}

export function patchSendToast(
  outboxId: string,
  patch: Partial<Pick<SendToastState, 'status' | 'message' | 'outbox'>>,
): void {
  if (!snapshot.toasts.some((toast) => toast.outbox.id === outboxId)) return;
  emit({
    toasts: snapshot.toasts.map((toast) =>
      toast.outbox.id === outboxId ? { ...toast, ...patch } : toast,
    ),
  });
}

export function dismissSendToast(outboxId: string): void {
  emit({ toasts: snapshot.toasts.filter((toast) => toast.outbox.id !== outboxId) });
}

/** Untuk tes: kembali ke keadaan awal. */
export function resetComposeStore(): void {
  // Penghitung kunci jendela sengaja tidak direset: kunci tidak pernah dipakai ulang.
  snapshot = { windows: [], toasts: [], notice: null };
  for (const listener of [...listeners]) listener();
}
