import { TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Icon } from '../../components/ui/Icon';
import styles from './Integrations.module.css';

/**
 * Rahasia (API key / rahasia webhook) yang ditampilkan SEKALI. Nilainya hanya di state pemanggil
 * selama dialog terbuka — tidak di cache Query, storage, atau URL — dan dibuang saat ditutup.
 */
export function SecretDialog({
  secret,
  title,
  body,
  label,
  copy,
  onClose,
}: {
  secret: string | null;
  title: string;
  body: string;
  label: string;
  copy: { copy: string; copied: string; announcement: string; done: string };
  onClose: () => void;
}) {
  return (
    <Dialog open={secret !== null} title={title} onRequestClose={onClose}>
      <div className={styles.secretBox}>
        <p className={styles.secretWarning}>
          <Icon icon={TriangleAlert} size={20} className={styles.secretIcon} />
          <span>{body}</span>
        </p>
        <p className={styles.secretLabel} id="rahasia-label">
          {label}
        </p>
        <div className={styles.secretRow}>
          <code className={styles.secret} aria-labelledby="rahasia-label">
            {secret}
          </code>
          {secret ? (
            <CopyButton
              text={secret}
              label={copy.copy}
              ariaLabel={`${copy.copy} ${label}`}
              copiedLabel={copy.copied}
              announcement={copy.announcement}
            />
          ) : null}
        </div>
      </div>
      <DialogActions>
        <Button variant="primary" onClick={onClose}>
          {copy.done}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
