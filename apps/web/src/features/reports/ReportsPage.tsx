import { permissionScope } from '@balesin/shared';
import { useState } from 'react';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { useSession } from '../auth/session';
import { CostsReport } from './CostsReport';
import { PerformanceReport } from './PerformanceReport';
import styles from './Reports.module.css';

const r = t.reports;

/**
 * Laporan (`reports.view`). Cakupan `all` (Owner/Admin/Supervisor): kinerja organisasi + biaya pesan
 * Meta. Cakupan `own` (CS/Teknisi): "Kinerja saya" saja (server mengosongkan bagian organisasi).
 */
export function ReportsPage() {
  const session = useSession();
  const own = session ? permissionScope(session.user.role, 'reports.view') === 'own' : true;
  const [tab, setTab] = useState<'kinerja' | 'biaya'>('kinerja');
  return (
    <Page>
      <div className={styles.page}>
        {own ? null : (
          <div className={styles.tabs} role="group" aria-label={r.tabsLabel}>
            {(
              [
                ['kinerja', r.tabPerformance],
                ['biaya', r.tabCosts],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={styles.tab}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {own || tab === 'kinerja' ? <PerformanceReport own={own} /> : <CostsReport />}
      </div>
    </Page>
  );
}
