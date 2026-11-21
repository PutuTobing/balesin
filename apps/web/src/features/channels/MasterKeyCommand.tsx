import { CopyButton } from '../../components/ui/CopyButton';
import { t } from '../../i18n/id';
import styles from './Channels.module.css';

const copy = t.channels.list;

/** Perintah pembuat `BALESIN_MASTER_KEY` yang siap disalin (keadaan "Token Meta belum bisa disimpan"). */
export function MasterKeyCommand() {
  return (
    <div className={styles.commandRow}>
      <code className={styles.command}>{copy.masterKeyCommand}</code>
      <CopyButton
        text={copy.masterKeyCommand}
        label={t.channels.webhook.copy}
        copiedLabel={t.channels.webhook.copied}
        announcement={copy.copiedCommand}
        ariaLabel={copy.copyCommand}
      />
    </div>
  );
}
