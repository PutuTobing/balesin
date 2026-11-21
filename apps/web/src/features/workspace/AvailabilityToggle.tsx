import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { availabilityQuery, workspaceKeys } from './workspace-queries';
import styles from './Workspace.module.css';

const w = t.workspace;

/**
 * Saklar "Tersedia" milik agen sendiri di kepala daftar chat (`inbox.reply`). Hanya tampil saat
 * pembagian otomatis (round-robin) aktif; Teknisi (409) dan agen yang tidak bisa dimuat statusnya
 * tidak melihatnya. Keadaan terbaca sebagai TEKS ("Tersedia" / "Tidak tersedia"), bukan ikon saja;
 * agen yang dikecualikan (bawaan Owner/Admin) melihat tombol nonaktif "Tidak ikut pembagian".
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
  const excluded = availability.excluded;
  const on = availability.available && !excluded;
  const text = excluded ? w.availabilityExcludedShort : on ? w.availabilityOn : w.availabilityOff;
  const reason = excluded
    ? w.availabilityExcluded
    : toggle.isError
      ? w.availabilityFailed
      : on
        ? w.availabilityHintOn
        : w.availabilityHintOff;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      // Nama = "Tersedia untuk chat baru: <keadaan>" — teks yang terlihat ada di dalam nama.
      aria-label={`${w.availabilityLabel}: ${text}${toggle.isError ? `. ${w.availabilityFailed}` : ''}`}
      title={reason}
      disabled={excluded || toggle.isPending}
      className={cx(styles.availability, on && styles.availabilityOn)}
      onClick={() => toggle.mutate(!availability.available)}
    >
      <span className={styles.availabilityDot} aria-hidden="true" />
      {text}
    </button>
  );
}
