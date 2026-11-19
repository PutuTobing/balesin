import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserCheck, UserX } from 'lucide-react';
import { IconButton } from '../../components/ui/IconButton';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { availabilityQuery, workspaceKeys } from './workspace-queries';
import styles from './Workspace.module.css';

const w = t.workspace;

/**
 * Saklar "Tersedia" milik agen sendiri di kepala daftar chat (`inbox.reply`). Hanya tampil saat
 * pembagian otomatis (round-robin) aktif; Teknisi (409) dan agen yang tidak bisa dimuat statusnya
 * tidak melihatnya. Agen yang dikecualikan Owner/Admin melihat tombol nonaktif dengan alasannya.
 */
export function AvailabilityToggle() {
  const queryClient = useQueryClient();
  const status = useQuery(availabilityQuery);
  const toggle = useMutation({
    mutationFn: (available: boolean) => endpoints.availability.set(available),
    onSuccess: (data) => {
      queryClient.setQueryData(workspaceKeys.availability, data);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.agents });
    },
  });
  const availability = status.data?.availability;
  if (!availability || availability.mode !== 'round_robin') return null;
  const on = availability.available && !availability.excluded;
  const label = availability.excluded
    ? w.availabilityExcluded
    : toggle.isError
      ? w.availabilityFailed
      : `${w.availabilityLabel}: ${on ? w.availabilityOn : w.availabilityOff}. ${on ? w.availabilityHintOn : w.availabilityHintOff}`;
  return (
    <IconButton
      label={label}
      icon={on ? UserCheck : UserX}
      aria-pressed={availability.available}
      disabled={availability.excluded || toggle.isPending}
      className={cx(styles.availability, on && styles.availabilityOn)}
      onClick={() => toggle.mutate(!availability.available)}
    />
  );
}
