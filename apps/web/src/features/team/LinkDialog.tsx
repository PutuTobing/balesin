import { USER_ROLE_LABELS, type InvitableRole } from '@balesin/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import styles from './Team.module.css';

const copy = t.team.linkDialog;

export interface IssuedLink {
  link: string;
  email: string;
  role: InvitableRole;
}

/**
 * Tautan undangan sekali tampil (email pengirim belum diatur). Tautan hanya ada di props/state
 * layar Tim selama dialog terbuka: tidak di cache Query/mutasi, URL, atau storage, dan tidak bisa
 * ditampilkan lagi setelah ditutup (server tidak menyimpan tokennya). Menutup tanpa menyalin
 * meminta konfirmasi dulu.
 */
export function LinkDialog({
  issued,
  onClose,
}: {
  issued: IssuedLink | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();

  // Peringatan "belum disalin" muncul → fokus ke "Kembali" (aksi aman), bukan ke <body>.
  useEffect(() => {
    if (confirming) backRef.current?.focus();
  }, [confirming]);

  const close = () => {
    setCopied(false);
    setConfirming(false);
    onClose();
  };
  const requestClose = () => {
    if (copied || confirming) close();
    else setConfirming(true);
  };

  return (
    <Dialog
      open={issued !== null}
      title={copy.title}
      description={issued ? copy.body(issued.email) : undefined}
      onRequestClose={requestClose}
      initialFocusRef={copyRef}
    >
      {issued ? (
        <>
          <Notice tone="warning" title={copy.keyTitle}>
            {copy.keyBody(USER_ROLE_LABELS[issued.role])}
          </Notice>
          <div className={styles.linkBlock} role="group" aria-labelledby={labelId}>
            <p className={styles.linkLabel} id={labelId}>
              {copy.linkLabel}
            </p>
            <code className={styles.link}>{issued.link}</code>
          </div>
          {confirming ? (
            <>
              <Notice tone="danger" role="alert">
                {copy.notCopied}
              </Notice>
              <DialogActions>
                <Button variant="danger" onClick={close}>
                  {copy.closeAnyway}
                </Button>
                <Button
                  ref={backRef}
                  variant="primary"
                  onClick={() => {
                    setConfirming(false);
                    copyRef.current?.focus();
                  }}
                >
                  {copy.back}
                </Button>
              </DialogActions>
            </>
          ) : (
            <DialogActions>
              <Button variant={copied ? 'primary' : 'secondary'} onClick={requestClose}>
                {copy.done}
              </Button>
              <CopyButton
                ref={copyRef}
                text={issued.link}
                label={copy.copy}
                copiedLabel={copy.copied}
                announcement={copy.copiedAnnouncement}
                variant={copied ? 'secondary' : 'primary'}
                onCopied={() => setCopied(true)}
              />
            </DialogActions>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
