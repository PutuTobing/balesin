import { queryOptions } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';
import { retryTransient } from '../inbox/inbox-queries';

export const csatKey = ['settings', 'csat'] as const;

/** Pengaturan CSAT (`settings.workspace.manage`). */
export const csatSettingsQuery = queryOptions({
  queryKey: csatKey,
  queryFn: ({ signal }) => endpoints.reports.csat(signal),
  retry: retryTransient,
});
