import { getRouteApi, Link } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './MailLinkWarning.module.css';
import { safeLinkTarget, type MailLinkWarningSearch } from './mail-link-warning';

const w = t.mail.linkWarning;
const routeApi = getRouteApi('/_app/email/tautan');

/** Komponen rute (pencarian dari URL). */
export function MailLinkWarningRoute() {
  return <MailLinkWarningPage search={routeApi.useSearch()} />;
}

/**
 * Halaman peringatan tautan menipu (`/email/tautan`). Tanpa pengalihan otomatis: URL lengkap + domain
 * asli ditampilkan sebagai TEKS, pengguna sendiri yang menekan "Tetap buka" (tab baru, tanpa
 * `opener`/`Referer`).
 */
export function MailLinkWarningPage({ search }: { search: MailLinkWarningSearch }) {
  usePageTitle(w.title);
  const target = safeLinkTarget(search.ke);
  const back = (
    <Button asChild variant="primary">
      <Link to="/email">{w.back}</Link>
    </Button>
  );
  if (!target) {
    return (
      <div className={styles.screen}>
        <EmptyState headingLevel={1} title={w.invalidTitle} body={w.invalidBody} actions={back} />
      </div>
    );
  }
  return (
    <div className={styles.screen}>
      <section className={styles.card} aria-labelledby="peringatan-tautan-judul">
        <span className={styles.icon} aria-hidden="true">
          <Icon icon={ShieldAlert} size={20} />
        </span>
        <h1 id="peringatan-tautan-judul" className={styles.title}>
          {w.title}
        </h1>
        <p className={styles.body}>{w.body}</p>
        <dl className={styles.facts}>
          {search.tampil ? (
            <div>
              <dt>{w.shownLabel}</dt>
              <dd dir="auto">{search.tampil}</dd>
            </div>
          ) : null}
          <div>
            <dt>{w.domainLabel}</dt>
            <dd className={styles.domain}>{target.hostname}</dd>
          </div>
          <div>
            <dt>{w.targetLabel}</dt>
            <dd>
              <code className={styles.url}>{target.href}</code>
            </dd>
          </div>
        </dl>
        <div className={styles.actions}>
          {back}
          <Button asChild variant="secondary">
            <a href={target.href} target="_blank" rel="noopener noreferrer">
              {w.open}
            </a>
          </Button>
        </div>
      </section>
    </div>
  );
}
