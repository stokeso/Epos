/**
 * The logged-in session (architecture §7.2; D-074, D-076, D-078, D-093, D-112).
 * Never persisted: a refresh always returns to the login screen.
 * The failed-PIN lockout state is shared by the login keypad and the override dialog (D-076).
 */
import { create } from 'zustand';
import { INITIAL_PIN_ATTEMPTS, lockoutRemainingMs, recordPinFailure, recordPinSuccess, type PinAttemptState } from '../rules/lockout';
import type { Session } from '../services/auth';

/** In-flow banners shown to managers after login (D-093, D-112). */
export interface BannerFlags {
  /** 'No backup in the last 7 days — Back up now'. */
  backupDue: boolean;
  /** STORAGE_WARNING. */
  storageWarning: boolean;
}

export type BannerKey = keyof BannerFlags;

export interface SessionState {
  session: Session | null;
  pinAttempts: PinAttemptState;
  /** Epoch ms of the last pointerdown/keydown (auto-lock, D-078). */
  lastActivityMs: number;
  /** Which banners apply to this login (computed at sign-in). */
  banners: BannerFlags;
  /** Banners dismissed for the current login only. */
  dismissed: Readonly<Record<BannerKey, boolean>>;

  /** Starts a session (use src/app/auth.signIn, which also restores the draft and banners). */
  start(session: Session, nowMs: number): void;
  /** Ends the session (lock, logout, after import). The basket and Pay session are NOT touched. */
  end(): void;
  /** Records activity for auto-lock. */
  touch(nowMs: number): void;
  /** A wrong PIN (login or override). Returns the new state. */
  pinFailed(nowMs: number): PinAttemptState;
  /** A right PIN resets the count. */
  pinSucceeded(): void;
  /** ms left on the lockout (0 when not locked). */
  lockoutRemaining(nowMs: number): number;
  setBanners(banners: Partial<BannerFlags>): void;
  dismissBanner(key: BannerKey): void;
}

const NO_BANNERS: BannerFlags = { backupDue: false, storageWarning: false };
const NOT_DISMISSED: Record<BannerKey, boolean> = { backupDue: false, storageWarning: false };

export const useSessionStore = create<SessionState>()((set, get) => ({
  session: null,
  pinAttempts: INITIAL_PIN_ATTEMPTS,
  lastActivityMs: 0,
  banners: NO_BANNERS,
  dismissed: NOT_DISMISSED,

  start(session, nowMs) {
    set({ session, pinAttempts: recordPinSuccess(), lastActivityMs: nowMs, banners: NO_BANNERS, dismissed: NOT_DISMISSED });
  },

  end() {
    set({ session: null, banners: NO_BANNERS, dismissed: NOT_DISMISSED });
  },

  touch(nowMs) {
    set({ lastActivityMs: nowMs });
  },

  pinFailed(nowMs) {
    const pinAttempts = recordPinFailure(get().pinAttempts, nowMs);
    set({ pinAttempts });
    return pinAttempts;
  },

  pinSucceeded() {
    set({ pinAttempts: recordPinSuccess() });
  },

  lockoutRemaining(nowMs) {
    return lockoutRemainingMs(get().pinAttempts, nowMs);
  },

  setBanners(banners) {
    set({ banners: { ...get().banners, ...banners } });
  },

  dismissBanner(key) {
    set({ dismissed: { ...get().dismissed, [key]: true } });
  },
}));

/** The current session (null when locked). */
export function useSession(): Session | null {
  return useSessionStore((s) => s.session);
}
