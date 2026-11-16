import { useQuery } from '@tanstack/react-query';
import { useCan } from '../auth/session';
import { sendingLimitsQuery, sendingPausedQuery } from './inbox-queries';

/** Rem darurat ditarik: dari jawaban 423, atau dari pengaturan batas kirim (pengelolanya). */
export function useSendingPaused() {
  const canManage = useCan('sending.limits.manage');
  const fromLimits = useQuery({ ...sendingLimitsQuery, enabled: canManage }).data?.limits.paused;
  const from423 = useQuery(sendingPausedQuery).data;
  return { paused: Boolean(fromLimits) || from423 === true, reason: fromLimits?.reason ?? null };
}
