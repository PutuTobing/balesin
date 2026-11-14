import type { ActiveSession, ActiveSessionListResponse } from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { queryKeys, sessionsQuery } from '../../lib/api/queries';
import { IdentityDialog } from '../identity/IdentityDialog';
import { SessionList, SessionListSkeleton } from '../sessions/SessionList';
import { revokeSessionButtonId } from '../sessions/session-device';
import styles from './Security.module.css';

const copy = t.security.sessions;
const HEADING_ID = 'keamanan-sesi';

/**
 * Kartu "Sesi aktif" di Keamanan akun: perangkat yang sedang masuk ke akun ini. Sesi lain bisa
 * dikeluarkan satu per satu (tanpa konfirmasi identitas, sesuai kontrak) atau sekaligus (password +
 * kode bila 2FA aktif). Sesi yang sedang dipakai tidak punya tombol: keluar lewat tombol Keluar.
 */
export function SessionsCard({ requireCode }: { requireCode: boolean }) {
  const queryClient = useQueryClient();
  const sessions = useQuery(sessionsQuery);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Sesi yang ternyata sudah berakhir (404): barisnya hilang, pesannya di kartu. */
  const [gone, setGone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Sesi yang lebih baru dari sesi ini: dikeluarkan lewat konfirmasi identitas (review butir 6 R4).
  const [newer, setNewer] = useState<ActiveSession | null>(null);
  const newerTrigger = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const revokeAllRef = useRef<HTMLButtonElement>(null);
  const [focusHeading, setFocusHeading] = useState(0);

  useEffect(() => {
    if (focusHeading > 0) headingRef.current?.focus();
  }, [focusHeading]);

  const removeFromCache = (keep: (session: ActiveSession) => boolean) =>
    queryClient.setQueryData<ActiveSessionListResponse>(queryKeys.sessions, (old) =>
      old ? { sessions: old.sessions.filter(keep) } : old,
    );

  /** Sesi sudah berakhir di tempat lain: muat ulang daftar, pesan di kartu, fokus ke judul. */
  const alreadyGone = (message: string) => {
    setGone(message);
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    setFocusHeading((tick) => tick + 1);
  };

  const revoked = (session: ActiveSession) => {
    removeFromCache((item) => item.id !== session.id);
    setNotice(t.sessions.revoked(session.device));
    // Barisnya hilang: fokus ke judul kartu (bukan <body>).
    setFocusHeading((tick) => tick + 1);
  };

  const revoke = async (session: ActiveSession) => {
    if (session.confirmationRequired) {
      setRowError(null);
      setNotice(null);
      setGone(null);
      newerTrigger.current = document.getElementById(
        revokeSessionButtonId(session.id),
      ) as HTMLButtonElement | null;
      setNewer(session);
      return;
    }
    setBusyId(session.id);
    setRowError(null);
    setNotice(null);
    setGone(null);
    try {
      await endpoints.sessions.revoke(session.id);
      revoked(session);
    } catch (caught) {
      if (isApiError(caught) && caught.status === 404) {
        alreadyGone(caught.message);
        return;
      }
      setRowError({
        id: session.id,
        message: isApiError(caught) ? caught.message : t.api.network,
      });
    } finally {
      setBusyId(null);
    }
  };

  const list = sessions.data?.sessions;
  const others = list?.filter((session) => !session.current) ?? [];

  return (
    <section className={styles.card} aria-labelledby={HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={HEADING_ID} ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          {copy.title}
        </h2>
        <p className={styles.text}>{copy.hint}</p>
      </div>
      {notice ? (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      ) : null}
      {gone ? (
        <Notice tone="warning" role="alert">
          {gone}
        </Notice>
      ) : null}
      {list ? (
        <SessionList
          sessions={list}
          onRevoke={(session) => void revoke(session)}
          busyId={busyId}
          error={rowError}
        />
      ) : sessions.isPending ? (
        <SessionListSkeleton rows={1} />
      ) : (
        <Notice
          tone="danger"
          role="alert"
          title={copy.loadFailedTitle}
          actions={<Button onClick={() => void sessions.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(sessions.error) ? sessions.error.message : t.api.network}
        </Notice>
      )}
      {list ? (
        others.length > 0 ? (
          <div className={styles.actions}>
            <Button
              ref={revokeAllRef}
              className={styles.dangerText}
              onClick={() => {
                setNotice(null);
                setGone(null);
                setConfirming(true);
              }}
              disabled={busyId !== null}
            >
              {copy.revokeOthers}
            </Button>
          </div>
        ) : (
          <p className={styles.meta}>{copy.onlyThis}</p>
        )
      ) : null}
      <IdentityDialog
        open={newer !== null}
        title={newer ? copy.revokeNewerTitle(newer.device) : ''}
        body={copy.revokeNewerBody}
        confirmLabel={copy.revokeNewerConfirm}
        pendingLabel={t.sessions.revoking}
        variant="danger"
        requireCode={requireCode}
        returnFocusRef={newerTrigger}
        onCancel={() => setNewer(null)}
        onConfirm={async (identity) => {
          if (!newer) return;
          try {
            await endpoints.sessions.revoke(newer.id, identity);
          } catch (caught) {
            // Sudah berakhir di tempat lain: tutup dialog, muat ulang daftarnya.
            if (isApiError(caught) && caught.status === 404) {
              setNewer(null);
              alreadyGone(caught.message);
              return;
            }
            throw caught;
          }
          setNewer(null);
          revoked(newer);
        }}
      />
      <IdentityDialog
        open={confirming}
        title={copy.revokeOthersTitle}
        body={copy.revokeOthersBody}
        confirmLabel={copy.revokeOthersConfirm}
        pendingLabel={copy.revokeOthersPending}
        variant="danger"
        requireCode={requireCode}
        returnFocusRef={revokeAllRef}
        onCancel={() => setConfirming(false)}
        onConfirm={async (identity) => {
          const result = await endpoints.sessions.revokeOthers(identity);
          setConfirming(false);
          removeFromCache((session) => session.current);
          void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
          setNotice(copy.revokedOthers(result.revokedSessions));
          setFocusHeading((tick) => tick + 1);
        }}
      />
    </section>
  );
}
