import { icon as iconToken } from '@balesin/shared/design-tokens';
import type { LucideIcon } from 'lucide-react';

export type IconSize = (typeof iconToken.sizes)[number];

interface IconProps {
  icon: LucideIcon;
  /** Hanya 16 atau 20 (DESIGN.md §1). */
  size?: IconSize;
  className?: string;
}

/**
 * Satu-satunya cara menggambar ikon: Lucide, stroke 1.75, ukuran 16 atau 20.
 * Selalu dekoratif; tombol yang hanya berisi ikon wajib punya label sendiri.
 */
export function Icon({ icon: Glyph, size = 20, className }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={iconToken.strokeWidth}
      className={className}
      aria-hidden="true"
      focusable="false"
    />
  );
}
