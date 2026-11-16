import { RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';
import { IconButton } from '../components/ui/IconButton';
import { t } from '../i18n/id';
import styles from './UpdateBanner.module.css';
import { applyUpdate, dismissUpdate, useUpdateReady } from './service-worker';

/** "Versi baru tersedia · Muat ulang" di atas konten (pola sama dengan banner keamanan). */
export function UpdateBanner() {
  const ready = useUpdateReady();
  const [reloading, setReloading] = useState(false);
  if (!ready) return null;
  return (
    <section className={styles.banner} aria-labelledby="versi-baru" role="status">
      <Icon icon={RefreshCw} size={20} className={styles.icon} />
      <div className={styles.text}>
        <p id="versi-baru" className={styles.title}>
          {t.pwa.updateTitle}
        </p>
        <p className={styles.body}>{t.pwa.updateBody}</p>
      </div>
      <div className={styles.actions}>
        <Button
          variant="primary"
          loading={reloading}
          onClick={() => {
            setReloading(true);
            applyUpdate();
          }}
        >
          {reloading ? t.pwa.reloading : t.pwa.reload}
        </Button>
        <IconButton label={t.pwa.dismiss} icon={X} onClick={dismissUpdate} />
      </div>
    </section>
  );
}
