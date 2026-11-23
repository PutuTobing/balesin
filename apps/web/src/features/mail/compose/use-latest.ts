import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Nilai terbaru untuk dibaca di event handler, timer, atau efek tanpa memasang ulang (pola "latest
 * ref"). Ref diperbarui setelah render di-commit, tidak pernah selama render.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
