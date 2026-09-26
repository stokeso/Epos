/** Wording shared by the Period screen and the Z close wizard. */

/** D-047 wording, singular for one tab. */
export function openTabsWarning(count: number): string {
  return count === 1 ? '1 tab is open and will carry over to the next period' : `${count} tabs are open and will carry over to the next period`;
}

export type VarianceKind = 'short' | 'over' | 'balanced';

/** 'short' below zero, 'over' above, 'balanced' at zero (D-041: variance = declared - expected). */
export function varianceKind(variancePence: number): VarianceKind {
  if (variancePence < 0) return 'short';
  if (variancePence > 0) return 'over';
  return 'balanced';
}

export const VARIANCE_LABELS: Record<VarianceKind, string> = {
  short: 'Short',
  over: 'Over',
  balanced: 'Balanced',
};

/** Z close is refused while a payment (sale or deposit) has tenders taken (D-130). */
export const PAYMENT_IN_PROGRESS_Z_MESSAGE = 'A payment is in progress. Finish or cancel it before closing the period.';

/** True when a Pay session of either kind has tenders: its money is in the drawer but not yet saved. */
export function paymentInProgress(session: { tender: { tenders: readonly unknown[] } } | null): boolean {
  return session !== null && session.tender.tenders.length > 0;
}
