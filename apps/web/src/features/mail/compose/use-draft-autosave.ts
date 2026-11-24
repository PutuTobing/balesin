import type { MailDraft, UpdateMailDraftRequest } from '@balesin/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../../../lib/api/client';
import { endpoints } from '../../../lib/api/endpoints';
import { useLatest } from './use-latest';

/**
 * Simpan otomatis draf (KONTRAK-API-EMAIL-TULIS §6.3): debounce 2 dtk setelah berhenti mengetik,
 * paling lambat tiap 5 dtk selama mengetik, dan segera saat jendela ditutup/diperkecil/dikirim.
 * Satu simpan berjalan pada satu waktu; perubahan selama simpan berjalan disimpan sesudahnya.
 * `baseVersion` = versi terakhir yang diketahui; versi basi → 409 `draft_version_conflict`.
 */

export const AUTOSAVE_IDLE_MS = 2_000;
export const AUTOSAVE_MAX_MS = 5_000;
export const AUTOSAVE_RETRY_MS = 5_000;

/** Jeda sampai simpan berikutnya: 2 dtk setelah ketikan terakhir, tapi tak lebih dari 5 dtk sejak kotor. */
export function nextSaveDelay(now: number, firstDirtyAt: number, lastEditAt: number): number {
  return Math.max(0, Math.min(lastEditAt + AUTOSAVE_IDLE_MS, firstDirtyAt + AUTOSAVE_MAX_MS) - now);
}

export type SaveStatus =
  'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict' | 'locked' | 'gone';

export type DraftChanges = Omit<UpdateMailDraftRequest, 'baseVersion' | 'force'>;

export interface SavedDraft {
  version: number;
  updatedAt: string;
  serverCopy: MailDraft['serverCopy'];
  /** Server membuang sebagian HTML (profil editor): isi editor diganti hasil ini. */
  sanitizedHtml: string | null;
}

interface AutosaveOptions {
  draftId: string;
  initialVersion: number;
  initialSavedAt: string | null;
  /** Isi draf saat ini (dibaca tepat sebelum dikirim). */
  collect: () => DraftChanges;
  onSaved?: (saved: SavedDraft) => void;
  onConflict?: (detail: { currentVersion: number | null; updatedAt: string | null }) => void;
}

export interface DraftAutosave {
  status: SaveStatus;
  savedAt: string | null;
  /** Ada perubahan yang belum terkirim ke server. */
  markDirty: () => void;
  /** Simpan sekarang (menunggu simpan yang sedang jalan). `true` = tersimpan / tidak ada perubahan. */
  flush: (options?: { force?: boolean }) => Promise<boolean>;
  /** Status saat ini (tanpa menunggu render), mis. alasan `flush` gagal. */
  currentStatus: () => SaveStatus;
  /** Versi terakhir yang diketahui (dipakai `send`). */
  version: () => number;
  /**
   * Versi baru dari aksi sendiri (unggah/hapus lampiran). Dicatat supaya simpan yang balapan dengan
   * aksi itu tidak dianggap konflik dengan tab lain.
   */
  noteOwnVersion: (version: number) => void;
}

export function useDraftAutosave({
  draftId,
  initialVersion,
  initialSavedAt,
  collect,
  onSaved,
  onConflict,
}: AutosaveOptions): DraftAutosave {
  const [status, setStatusState] = useState<SaveStatus>('idle');
  const statusRef = useRef<SaveStatus>('idle');
  const setStatus = useCallback((next: SaveStatus | ((current: SaveStatus) => SaveStatus)) => {
    statusRef.current = typeof next === 'function' ? next(statusRef.current) : next;
    setStatusState(statusRef.current);
  }, []);
  const [savedAt, setSavedAt] = useState<string | null>(initialSavedAt);
  const version = useRef(initialVersion);
  const ownVersions = useRef(new Set<number>([initialVersion]));
  const dirty = useRef(false);
  const firstDirtyAt = useRef(0);
  const lastEditAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const stopped = useRef(false);
  const callbacks = useLatest({ collect, onSaved, onConflict });

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const save = useCallback(
    async (force: boolean): Promise<boolean> => {
      if (stopped.current) return false;
      if (!dirty.current && !force) return true;
      clearTimer();
      dirty.current = false;
      setStatus('saving');
      let attempt = 0;
      for (;;) {
        const body: UpdateMailDraftRequest = {
          baseVersion: version.current,
          ...callbacks.current.collect(),
          ...(force ? { force: true } : {}),
        };
        try {
          const response = await endpoints.mail.updateDraft(draftId, body);
          // Versi hanya naik di server; jawaban unggah yang tiba lebih dulu tidak boleh tertimpa.
          version.current = Math.max(version.current, response.draft.version);
          ownVersions.current.add(response.draft.version);
          setSavedAt(response.draft.updatedAt);
          callbacks.current.onSaved?.({
            version: response.draft.version,
            updatedAt: response.draft.updatedAt,
            serverCopy: response.draft.serverCopy,
            sanitizedHtml: response.sanitized && response.bodyHtml ? response.bodyHtml : null,
          });
          setStatus(dirty.current ? 'dirty' : 'saved');
          return true;
        } catch (error) {
          const reason = isApiError(error)
            ? error.details.find((detail) => detail.reason)?.reason
            : undefined;
          if (isApiError(error) && reason === 'draft_version_conflict') {
            const detail = error.details.find((item) => item.reason === reason);
            const current = detail?.currentVersion ?? null;
            // Versi itu hasil aksi kita sendiri (unggah lampiran berbarengan): ulangi sekali.
            if (current !== null && ownVersions.current.has(current) && attempt === 0) {
              version.current = current;
              attempt += 1;
              continue;
            }
            dirty.current = true;
            setStatus('conflict');
            callbacks.current.onConflict?.({
              currentVersion: current,
              updatedAt: detail?.updatedAt ?? null,
            });
            return false;
          }
          if (isApiError(error) && reason === 'draft_locked') {
            setStatus('locked');
            return false;
          }
          if (isApiError(error) && error.status === 404) {
            stopped.current = true;
            setStatus('gone');
            return false;
          }
          // Jaringan/server: coba lagi otomatis, perubahan tetap ditandai kotor.
          dirty.current = true;
          setStatus('error');
          if (!stopped.current) {
            clearTimer();
            timer.current = setTimeout(() => void enqueue(false), AUTOSAVE_RETRY_MS);
          }
          return false;
        }
      }
    },
    // `enqueue` dideklarasikan di bawah; referensinya stabil lewat `useCallback`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftId],
  );

  const enqueue = useCallback(
    (force: boolean): Promise<boolean> => {
      const next = queue.current.then(() => save(force));
      queue.current = next.catch(() => false);
      return next;
    },
    [save],
  );

  const schedule = useCallback(() => {
    clearTimer();
    const delay = nextSaveDelay(Date.now(), firstDirtyAt.current, lastEditAt.current);
    timer.current = setTimeout(() => void enqueue(false), delay);
  }, [enqueue]);

  const markDirty = useCallback(() => {
    if (stopped.current) return;
    const now = Date.now();
    if (!dirty.current) firstDirtyAt.current = now;
    dirty.current = true;
    lastEditAt.current = now;
    setStatus((current) =>
      current === 'saving' || current === 'conflict' || current === 'locked' ? current : 'dirty',
    );
    schedule();
  }, [schedule, setStatus]);

  const flush = useCallback(
    (options: { force?: boolean } = {}) => enqueue(options.force ?? false),
    [enqueue],
  );

  useEffect(
    () => () => {
      clearTimer();
    },
    [],
  );

  return {
    status,
    savedAt,
    markDirty,
    flush,
    currentStatus: () => statusRef.current,
    version: () => version.current,
    noteOwnVersion: (next: number) => {
      ownVersions.current.add(next);
      if (next > version.current) version.current = next;
    },
  };
}
