import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';

/** Status 2FA: "Aktif" (hijau) atau "Belum aktif" (netral). Di Keamanan akun dan menu Pengaturan. */
export function TwoFactorBadge({ enabled }: { enabled: boolean }) {
  return (
    <StatusBadge
      tone={enabled ? 'success' : 'neutral'}
      label={enabled ? t.security.twoFactor.on : t.security.twoFactor.off}
    />
  );
}
