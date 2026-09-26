/**
 * The UI clock (D-101). Every UI time read goes through here (or through ServiceContext.now,
 * which bootstrap wires to the same function), so Playwright's page.clock controls auto-lock,
 * the lockout countdown and the backup reminder.
 */
import type { IsoInstant } from '../data/types';

/** Epoch milliseconds (Date.now()). */
export function nowMs(): number {
  return Date.now();
}

/** A Date for now. This is the clock handed to the adapter and the ServiceContext. */
export function now(): Date {
  return new Date(Date.now());
}

/** ISO-8601 UTC instant for now (D-049). */
export function nowIso(): IsoInstant {
  return now().toISOString();
}
