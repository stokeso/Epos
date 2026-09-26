/**
 * Small shared hooks for screens and components.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

/** The layout breakpoint: at or above this width the till shows the side basket panel. */
export const WIDE_QUERY = '(min-width: 900px)';

/** Live result of a CSS media query (false where matchMedia is unavailable). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** True at >= 900 px wide (landscape tablet): side basket panel. False: bottom sheet. */
export function useIsWide(): boolean {
  return useMediaQuery(WIDE_QUERY);
}

/** `value`, updated only after it has stopped changing for `delayMs` (for search boxes). */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
