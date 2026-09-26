/**
 * Failed PIN attempt lockout (D-076). Pure; the in-memory state lives in the UI session store and
 * is shared by the login and override dialogs.
 */

export const MAX_PIN_FAILURES = 5;
export const PIN_LOCKOUT_MS = 30_000;

export interface PinAttemptState {
  consecutiveFailures: number;
  /** Epoch ms until which the keypad is disabled, or null. */
  lockedUntilMs: number | null;
}

export const INITIAL_PIN_ATTEMPTS: PinAttemptState = Object.freeze({ consecutiveFailures: 0, lockedUntilMs: null });

/** +1 failure; on reaching MAX_PIN_FAILURES, lock until nowMs + PIN_LOCKOUT_MS and reset the count to 0. */
export function recordPinFailure(state: PinAttemptState, nowMs: number): PinAttemptState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= MAX_PIN_FAILURES) return { consecutiveFailures: 0, lockedUntilMs: nowMs + PIN_LOCKOUT_MS };
  // An expired lockout is dropped; a live one is kept.
  const lockedUntilMs = state.lockedUntilMs !== null && state.lockedUntilMs > nowMs ? state.lockedUntilMs : null;
  return { consecutiveFailures, lockedUntilMs };
}

/** Any success resets the state. */
export function recordPinSuccess(): PinAttemptState {
  return { consecutiveFailures: 0, lockedUntilMs: null };
}

/** Milliseconds left on the lockout (0 when not locked). Drives the countdown. */
export function lockoutRemainingMs(state: PinAttemptState, nowMs: number): number {
  return state.lockedUntilMs === null ? 0 : Math.max(0, state.lockedUntilMs - nowMs);
}
