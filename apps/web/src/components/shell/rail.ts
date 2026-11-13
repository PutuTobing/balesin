import { size } from '@balesin/shared/design-tokens';

/**
 * Jarak tooltip dan menu dari item rail. Item (44px) berada di tengah rail (64px), jadi
 * tepinya 10px dari garis tepi rail; ditambah 8px supaya popover muncul di luar garis itu,
 * bukan menimpanya.
 */
export const RAIL_POPOVER_OFFSET = (size.rail - size.touch) / 2 + 8;
