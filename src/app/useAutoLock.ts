/**
 * Auto-lock (spec §6.2; D-078). Mounted once by the root layout.
 * - pointerdown / keydown on document (capture phase) record activity;
 * - a 1-second interval, running only while someone is logged in, locks when
 *   now - lastActivity >= settings.autoLockMinutes x 60,000 ms;
 * - a change to autoLockMinutes applies immediately (the effect re-subscribes).
 * Lock keeps the basket, draft and Pay session and cancels dialogs (src/app/auth.lock).
 * Time comes from src/app/clock, so Playwright's page.clock drives it.
 */
import { useEffect } from 'react';
import { DEFAULT_SETTINGS } from '../services/setup';
import { useAppStore } from '../store/appStore';
import { useSessionStore } from '../store/sessionStore';
import { lock } from './auth';
import { nowMs } from './clock';

export const AUTO_LOCK_CHECK_MS = 1000;

export function useAutoLock(): void {
  const active = useSessionStore((s) => s.session !== null);
  const minutes = useAppStore((s) => s.settings?.autoLockMinutes ?? DEFAULT_SETTINGS.autoLockMinutes);

  useEffect(() => {
    if (!active) return undefined;
    const touch = (): void => useSessionStore.getState().touch(nowMs());
    document.addEventListener('pointerdown', touch, true);
    document.addEventListener('keydown', touch, true);
    const timer = setInterval(() => {
      const { session, lastActivityMs } = useSessionStore.getState();
      if (session !== null && nowMs() - lastActivityMs >= minutes * 60_000) lock();
    }, AUTO_LOCK_CHECK_MS);
    return () => {
      document.removeEventListener('pointerdown', touch, true);
      document.removeEventListener('keydown', touch, true);
      clearInterval(timer);
    };
  }, [active, minutes]);
}
