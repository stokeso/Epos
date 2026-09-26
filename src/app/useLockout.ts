import { useEffect, useReducer } from 'react';
import { PIN_LOCKOUT_MS } from '../rules/lockout';
import { useSessionStore } from '../store/sessionStore';
import { nowMs } from './clock';

/**
 * Milliseconds left on the shared PIN lockout (D-076), re-rendering every 250 ms while it runs.
 * Used by the login screen and the override dialog.
 */
export function useLockoutRemaining(): number {
  const lockedUntil = useSessionStore((s) => s.pinAttempts.lockedUntilMs);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (lockedUntil === null) return undefined;
    const timer = setInterval(() => {
      tick();
      if (nowMs() >= lockedUntil) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  return lockedUntil === null ? 0 : Math.max(0, lockedUntil - nowMs());
}

/** 'Too many attempts. Try again in 27 s' (D-076): the visible countdown, not read out every second. */
export function lockoutMessage(remainingMs: number): string {
  return `Too many attempts. Try again in ${Math.ceil(remainingMs / 1000)} s`;
}

/**
 * What a screen reader hears about the lockout, once when it starts and once when it ends
 * (PinKeypad `announcement`; D-135). '' when there has been no lockout.
 */
export function useLockoutAnnouncement(remainingMs: number): string {
  const lockedUntil = useSessionStore((s) => s.pinAttempts.lockedUntilMs);
  if (lockedUntil === null) return '';
  if (remainingMs > 0) return `Too many attempts. The keypad is locked for ${PIN_LOCKOUT_MS / 1000} seconds.`;
  return 'The keypad is unlocked. You can enter a PIN again.';
}
