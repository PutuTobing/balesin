import { useCallback, useState } from 'react';
import { deviceKey, readDeviceFlag, writeDeviceFlag } from '../../lib/device-storage';
import { media, useMediaQuery } from '../../lib/media';

const STORAGE_KEY = deviceKey('inbox.detail');

export interface DetailPanelState {
  open: boolean;
  /** Tablet: panel melayang di atas ruang chat, bukan kolom ketiga. */
  overlay: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * Buka/tutup panel detail. Di desktop panel adalah kolom ketiga: bawaannya terbuka dan
 * pilihan pengguna diingat di perangkat. Di tablet panel melayang: bawaannya tertutup
 * dan tidak diingat.
 */
export function useDetailPanel(): DetailPanelState {
  const isDesktop = useMediaQuery(media.desktop);
  const [pinnedOpen, setPinnedOpen] = useState(() => readDeviceFlag(STORAGE_KEY, true));
  const [overlayOpen, setOverlayOpen] = useState(false);

  const setOpen = useCallback(
    (open: boolean) => {
      if (isDesktop) {
        setPinnedOpen(open);
        writeDeviceFlag(STORAGE_KEY, open);
      } else {
        setOverlayOpen(open);
      }
    },
    [isDesktop],
  );

  return { open: isDesktop ? pinnedOpen : overlayOpen, overlay: !isDesktop, setOpen };
}
