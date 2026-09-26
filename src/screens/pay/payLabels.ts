/**
 * Display labels for the Pay screen. Money text always comes from rules/money.formatPence (D-005).
 */
import type { TenderType } from '../../data/types';
import { formatPence } from '../../rules/money';

/** Tender names as printed on the receipt (D-107). */
export const TENDER_LABELS = { cash: 'Cash', card: 'Card' } as const satisfies Record<TenderType, string>;

/**
 * Quick cash button names (D-030; architecture §7.4 stable selectors): '£5', '£10', '£20', '£50'.
 * formatPence with the '.00' of a whole-pound note dropped.
 */
export function quickCashLabel(pence: number): string {
  return formatPence(pence).replace(/\.00$/, '');
}
