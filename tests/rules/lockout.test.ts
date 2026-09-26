import { describe, expect, it } from 'vitest';
import {
  INITIAL_PIN_ATTEMPTS,
  MAX_PIN_FAILURES,
  PIN_LOCKOUT_MS,
  lockoutRemainingMs,
  recordPinFailure,
  recordPinSuccess,
  type PinAttemptState,
} from '../../src/rules/lockout';

const NOW = 1_790_000_000_000;

function failTimes(n: number, state: PinAttemptState = INITIAL_PIN_ATTEMPTS, now = NOW): PinAttemptState {
  let s = state;
  for (let i = 0; i < n; i += 1) s = recordPinFailure(s, now);
  return s;
}

describe('PIN lockout (D-076)', () => {
  it('uses 5 failures and 30 seconds', () => {
    expect(MAX_PIN_FAILURES).toBe(5);
    expect(PIN_LOCKOUT_MS).toBe(30_000);
    expect(INITIAL_PIN_ATTEMPTS).toEqual({ consecutiveFailures: 0, lockedUntilMs: null });
  });

  it('counts failures without locking below the limit', () => {
    const s = failTimes(4);
    expect(s).toEqual({ consecutiveFailures: 4, lockedUntilMs: null });
    expect(lockoutRemainingMs(s, NOW)).toBe(0);
  });

  it('locks for 30 seconds on the 5th failure and restarts the count', () => {
    const s = failTimes(5);
    expect(s).toEqual({ consecutiveFailures: 0, lockedUntilMs: NOW + 30_000 });
    expect(lockoutRemainingMs(s, NOW)).toBe(30_000);
    expect(lockoutRemainingMs(s, NOW + 12_345)).toBe(17_655);
    expect(lockoutRemainingMs(s, NOW + 30_000)).toBe(0);
    expect(lockoutRemainingMs(s, NOW + 99_999)).toBe(0);
  });

  it('starts a fresh count after the lockout', () => {
    const locked = failTimes(5);
    const later = NOW + 31_000;
    const s = recordPinFailure(locked, later);
    expect(s.consecutiveFailures).toBe(1);
    expect(lockoutRemainingMs(s, later)).toBe(0);
    const lockedAgain = failTimes(4, s, later);
    expect(lockoutRemainingMs(lockedAgain, later)).toBe(30_000);
  });

  it('resets on any success', () => {
    expect(recordPinSuccess()).toEqual({ consecutiveFailures: 0, lockedUntilMs: null });
    expect(lockoutRemainingMs(recordPinSuccess(), NOW)).toBe(0);
  });

  it('never mutates the previous state', () => {
    const s = failTimes(2);
    recordPinFailure(s, NOW);
    expect(s).toEqual({ consecutiveFailures: 2, lockedUntilMs: null });
    expect(INITIAL_PIN_ATTEMPTS).toEqual({ consecutiveFailures: 0, lockedUntilMs: null });
  });
});
