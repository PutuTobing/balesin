import { RadioGroup } from 'radix-ui';
import { useBrand } from '../../brand/brand';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { parsePreference, type ResolvedTheme, type ThemePreference } from '../../theme/theme';
import { useTheme } from '../../theme/theme-context';
import { themeOptions } from '../../theme/theme-options';
import styles from './Settings.module.css';

const APPEARANCE_HEADING_ID = 'pengaturan-tampilan';

/**
 * Pengaturan. Bagian lain (channel, peran, jam kerja, dan seterusnya) ditambahkan
 * bersama fiturnya masing-masing; saat ini yang sudah berfungsi adalah Tampilan.
 */
export function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const { productName } = useBrand();

  return (
    <Page title={t.nav.settings} parent={{ to: '/lainnya', label: t.nav.more }}>
      <div className={styles.content}>
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
