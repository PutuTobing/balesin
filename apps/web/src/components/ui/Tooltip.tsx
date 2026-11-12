import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactNode } from 'react';
import styles from './Tooltip.module.css';

interface TooltipProps {
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Matikan saat labelnya sudah tampil sebagai teks (mis. navigasi bawah HP). */
  disabled?: boolean;
  /** Satu elemen interaktif (tombol/link) yang diberi keterangan. */
  children: ReactNode;
}

/** Keterangan singkat saat hover atau fokus keyboard. Butuh `TooltipProvider` di atasnya. */
export function Tooltip({ label, side = 'bottom', disabled = false, children }: TooltipProps) {
  if (disabled) return children;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={8}
          collisionPadding={8}
          className={styles.tooltip}
        >
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}
