import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Mail } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useBrand } from '../../brand/brand';
import { Icon } from '../../components/ui/Icon';
import { Page } from '../../components/ui/Page';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { parsePreference, type ResolvedTheme, type ThemePreference } from '../../theme/theme';
import { useTheme } from '../../theme/theme-context';
import { themeOptions } from '../../theme/theme-options';
import { useSession } from '../auth/session';
import { EmailStatusBadge } from '../email-settings/EmailStatusBadge';
import { emailSettingsQuery } from '../../lib/api/queries';
import styles from './Settings.module.css';

const APPEARANCE_HEADING_ID = 'pengaturan-tampilan';
const ORGANIZATION_HEADING_ID = 'pengaturan-organisasi';

/**
 * Pengaturan. Bagian lain (channel, peran, jam kerja, dan seterusnya) ditambahkan
 * bersama fiturnya masing-masing. Pengaturan organisasi (Email pengirim) hanya untuk Owner;
 * peran lain tidak melihat menunya.
 */
export function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const { productName } = useBrand();
  const session = useSession();
  const isOwner = session?.user.role === 'owner';

  return (
    <Page>
      <div className={styles.content}>
        {isOwner ? <OrganizationSettings /> : null}
        <section className={styles.card} aria-labelledby={APPEARANCE_HEADING_ID}>
          <div className={styles.cardHead}>
            <h2 id={APPEARANCE_HEADING_ID} className={styles.cardTitle}>
              {t.settings.appearance.title}
            </h2>
            <p className={styles.cardHint}>{t.settings.appearance.hint}</p>
          </div>
          <RadioGroup.Root
            className={styles.options}
            value={preference}
            onValueChange={(value) => setPreference(parsePreference(value))}
            aria-label={t.settings.appearance.themeLabel}
          >
            {themeOptions.map((option) => (
              <RadioGroup.Item key={option.value} value={option.value} className={styles.option}>
                <ThemePreview preference={option.value} />
                <span className={styles.optionLabel}>
                  <span className={styles.radio}>
                    <RadioGroup.Indicator className={styles.radioDot} />
                  </span>
                  {option.label}
                </span>
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </section>
        <p className={styles.about}>{t.common.version(productName, __APP_VERSION__)}</p>
      </div>
    </Page>
  );
}

/** Miniatur kerangka aplikasi dalam tema yang dipilih; "Ikuti sistem" = separuh-separuh. */
function ThemePreview({ preference }: { preference: ThemePreference }) {
  return (
    <span className={styles.preview} aria-hidden="true">
      {preference === 'system' ? (
        <>
          <Scene theme="light" />
          <Scene theme="dark" split />
        </>
      ) : (
        <Scene theme={preference} />
      )}
    </span>
  );
}

function Scene({ theme, split = false }: { theme: ResolvedTheme; split?: boolean }) {
  return (
    // `data-theme` memaksa warna token tema itu di dalam miniatur, apa pun tema aplikasi.
    <span data-theme={theme} className={cx(styles.scene, split && styles.sceneSplit)}>
      <span className={styles.sceneRail}>
        <span className={styles.sceneMark} />
      </span>
      <span className={styles.sceneList}>
        <span className={styles.sceneLine} />
        <span className={styles.sceneLine} />
        <span className={styles.sceneLine} />
      </span>
      <span className={styles.sceneChat}>
        <span className={styles.sceneIn} />
        <span className={styles.sceneOut} />
        <span className={styles.sceneIn} />
      </span>
    </span>
  );
}

/** Menu pengaturan organisasi (khusus Owner), lengkap dengan status tiap koneksi. */
function OrganizationSettings() {
  const email = useQuery(emailSettingsQuery);
  return (
    <section className={styles.card} aria-labelledby={ORGANIZATION_HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={ORGANIZATION_HEADING_ID} className={styles.cardTitle}>
          {t.settingsMenu.sectionTitle}
        </h2>
      </div>
      <ul className={styles.menu}>
        <li>
          <Link to="/pengaturan/email" className={styles.menuLink}>
            <span className={styles.menuIcon}>
              <Icon icon={Mail} size={20} />
            </span>
            <span className={styles.menuText}>
              <span className={styles.menuLabel}>{t.emailSettings.title}</span>
              <span className={styles.menuHint}>{t.emailSettings.menuHint}</span>
            </span>
            <span className={styles.menuStatus}>
              {email.data ? (
                <>
                  <EmailStatusBadge status={email.data.status} />
                  {email.data.status === 'not_configured' ? (
                    <span className={styles.setUpNow}>· {t.emailSettings.setUpNow}</span>
                  ) : null}
                </>
              ) : email.isPending ? (
                <Skeleton className={styles.statusSkeleton} />
              ) : null}
            </span>
            <Icon icon={ChevronRight} size={16} className={styles.chevron} />
          </Link>
        </li>
      </ul>
    </section>
  );
}
