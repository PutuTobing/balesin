import { queryOptions, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../../lib/api/endpoints';
import {
  currentSubscription,
  pushPermission,
  pushSupport,
  type PushPermission,
  type PushSupport,
} from './push-device';

export const notificationKeys = {
  preferences: ['notifications', 'preferences'] as const,
  settings: ['notifications', 'settings'] as const,
};

export const notificationPreferencesQuery = queryOptions({
  queryKey: notificationKeys.preferences,
  queryFn: ({ signal }) => endpoints.notifications.preferences(signal),
});

/** Pengaturan organisasi (`organization.manage`). */
export const notificationSettingsQuery = queryOptions({
  queryKey: notificationKeys.settings,
  queryFn: ({ signal }) => endpoints.notifications.settings(signal),
});

export interface PushDeviceState {
  support: PushSupport;
  permission: PushPermission;
  /** `null` = masih diperiksa. */
  subscribed: boolean | null;
}

function snapshot(): Pick<PushDeviceState, 'support' | 'permission'> {
  const support = pushSupport();
  return { support, permission: support === 'supported' ? pushPermission() : 'default' };
}

/**
 * Keadaan notifikasi di perangkat INI: dukungan browser, izin, dan langganan push. Izin bisa diubah
 * pengguna dari pengaturan browser kapan saja — diperiksa ulang saat tab kembali dilihat dan lewat
 * Permissions API bila ada.
 */
export function usePushDevice(): PushDeviceState & { refresh: () => void } {
  const [state, setState] = useState<PushDeviceState>(() => ({ ...snapshot(), subscribed: null }));

  const refresh = useCallback(() => {
    const next = snapshot();
    void currentSubscription().then((subscription) =>
      setState({
        ...next,
        subscribed: next.support === 'supported' && next.permission === 'granted' && !!subscription,
      }),
    );
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    let status: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((result) => {
        status = result;
        result.addEventListener('change', refresh);
      })
      .catch(() => undefined);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      status?.removeEventListener('change', refresh);
    };
  }, [refresh]);

  return { ...state, refresh };
}

export function useNotificationPreferences() {
  return useQuery(notificationPreferencesQuery);
}
