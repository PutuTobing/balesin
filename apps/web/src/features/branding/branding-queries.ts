import { queryOptions } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';

export const brandingSettingsKey = ['settings', 'branding'] as const;

/** Pengaturan → Merek (`organization.manage`). */
export const brandingSettingsQuery = queryOptions({
  queryKey: brandingSettingsKey,
  queryFn: ({ signal }) => endpoints.branding.settings(signal),
  // Hanya berubah lewat halaman ini (yang memperbarui cache-nya sendiri).
  staleTime: Infinity,
});
