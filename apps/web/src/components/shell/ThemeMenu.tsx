import { Check, Moon, Sun } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { t } from '../../i18n/id';
import { parsePreference } from '../../theme/theme';
import { useTheme } from '../../theme/theme-context';
import { themeOptions } from '../../theme/theme-options';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';
import styles from './ThemeMenu.module.css';

/** Tombol di rail desktop untuk memilih Terang / Gelap / Ikuti sistem. */
export function ThemeMenu({ className }: { className?: string }) {
  const { preference, resolved, setPreference } = useTheme();

  return (
    // Non-modal: menu kecil ini tidak perlu mengunci scroll halaman. Mode modal Radix
    // menyuntikkan elemen <style> inline, yang ditolak CSP `style-src 'self'`.
    <DropdownMenu.Root modal={false}>
      <Tooltip label={t.theme.change} side="right">
        <DropdownMenu.Trigger asChild>
          <button type="button" className={className} aria-label={t.theme.change}>
            <Icon icon={resolved === 'dark' ? Moon : Sun} size={20} />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className={styles.menu}
        >
          <DropdownMenu.Label className={styles.heading}>{t.theme.title}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={preference}
            onValueChange={(value) => setPreference(parsePreference(value))}
          >
            {themeOptions.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className={styles.option}
              >
                <Icon icon={option.icon} size={16} className={styles.optionIcon} />
                <span className={styles.optionLabel}>{option.label}</span>
                <DropdownMenu.ItemIndicator className={styles.check}>
                  <Icon icon={Check} size={16} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
