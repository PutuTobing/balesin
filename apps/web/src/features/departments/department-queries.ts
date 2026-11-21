import { queryOptions } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';
import { retryTransient } from '../inbox/inbox-queries';

/** Kunci cache departemen. Event `resync` menyegarkan semuanya. */
export const departmentKeys = {
  all: ['departments'] as const,
  names: ['departments', 'names'] as const,
  settings: ['departments', 'settings'] as const,
  access: (userId: string) => ['departments', 'access', userId] as const,
};

/** Nama departemen (`inbox.view`): saringan inbox, dialog pindah, board tiket. */
export const departmentsQuery = queryOptions({
  queryKey: departmentKeys.names,
  queryFn: ({ signal }) => endpoints.departments.list(signal),
  staleTime: 60_000,
  retry: retryTransient,
});

/** Lengkap dengan anggota, channel bawaan, jam kerja (`settings.workspace.manage`). */
export const departmentSettingsQuery = queryOptions({
  queryKey: departmentKeys.settings,
  queryFn: ({ signal }) => endpoints.departments.settings(signal),
  retry: retryTransient,
});

export const departmentAccessQuery = (userId: string) =>
  queryOptions({
    queryKey: departmentKeys.access(userId),
    queryFn: ({ signal }) => endpoints.departments.access(userId, signal),
    retry: retryTransient,
  });
