/**
 * Tendering (spec §6.4, §8; D-029..D-033). Pure state machine for one Pay session.
 */
import type { Pence, Tender, TenderType } from '../data/types';
import { assertPence, formatPence } from './money';

/** Quick cash buttons: £5, £10, £20, £50 (D-030). */
export const QUICK_CASH_PENCE = [500, 1000, 2000, 5000] as const;

export interface TenderState {
  /** Amount due for the whole Pay session (frozen, D-011). */
  totalPence: Pence;
  /** In the order taken; never merged (D-029). */
  tenders: Tender[];
  /** totalPence - sum(tenders), floored at 0 once complete. */
  remainingPence: Pence;
  /** sum(tenders) >= totalPence (true immediately when totalPence is 0, D-031). */
  complete: boolean;
  /** sum(tenders) - totalPence once complete, else 0. */
  changePence: Pence;
}

/**
 * A tender attempt. For 'card', amountPence null means "the full remaining amount".
 * For 'cash', amountPence is the keypad or quick-cash value ('Exact' passes remainingPence).
 */
export interface TenderRequest {
  type: TenderType;
  amountPence: Pence | null;
}

export type TenderRejection = 'nothingDue' | 'amountTooSmall' | 'cardExceedsBalance';

export type TenderOutcome =
  | { ok: true; state: TenderState }
  | { ok: false; reason: TenderRejection; message: string };

/** Initial state for an amount due (>= 0). Throws RangeError for a negative or fractional total. */
export function startTendering(totalPence: Pence): TenderState {
  assertPence(totalPence, 'total');
  if (totalPence < 0) throw new RangeError('total must be >= 0');
  return { totalPence, tenders: [], remainingPence: totalPence, complete: totalPence === 0, changePence: 0 };
}

/**
 * Applies one tender (D-029):
 * - complete already -> 'nothingDue'.
 * - card: amount = request amount ?? remaining; requires 1 <= amount <= remaining, else
 *   'cardExceedsBalance' with message "Card can't be more than the balance (£x.xx)" (or
 *   'amountTooSmall' for < 1). Nothing is recorded on rejection.
 * - cash: amount must be >= 1 ('amountTooSmall'; null counts as 0); no upper limit.
 * After appending, if sum >= total the state is complete with changePence = sum - total.
 * Example: due 4180: card 5000 -> rejected; card 3000 -> remaining 1180; cash 1500 -> complete,
 * change 320.
 * Throws RangeError for a fractional amount (a programming error, not a user error).
 */
export function applyTender(state: TenderState, request: TenderRequest): TenderOutcome {
  if (state.complete) return { ok: false, reason: 'nothingDue', message: 'Nothing left to pay' };
  const remaining = state.remainingPence;
  const amount = request.amountPence ?? (request.type === 'card' ? remaining : 0);
  assertPence(amount, 'tender amount');
  if (amount < 1) return { ok: false, reason: 'amountTooSmall', message: 'Enter an amount' };
  if (request.type === 'card' && amount > remaining) {
    return { ok: false, reason: 'cardExceedsBalance', message: `Card can't be more than the balance (${formatPence(remaining)})` };
  }
  const tenders: Tender[] = [...state.tenders, { type: request.type, amountPence: amount }];
  if (amount >= remaining) {
    return { ok: true, state: { totalPence: state.totalPence, tenders, remainingPence: 0, complete: true, changePence: amount - remaining } };
  }
  return { ok: true, state: { totalPence: state.totalPence, tenders, remainingPence: remaining - amount, complete: false, changePence: 0 } };
}

/**
 * Checks a stored tender sequence against a total (D-032), for kinds 'sale' and 'deposit':
 * every amount >= 1; replaying in order, each card tender <= remaining before it; only the last
 * tender may take the sum to or past the total; change = sum - total >= 0; change > 0 only if the
 * last tender is cash and change < its amount; total 0 requires tenders [] and change 0.
 * Returns problem messages (empty = valid).
 */
export function tenderSequenceProblems(totalPence: Pence, tenders: readonly Tender[], changePence: Pence): string[] {
  const problems: string[] = [];
  if (totalPence === 0) {
    if (tenders.length > 0) problems.push('A zero total must have no tenders');
    if (changePence !== 0) problems.push('A zero total must have no change');
    return problems;
  }
  if (totalPence < 0) return ['The total must not be negative'];
  if (tenders.length === 0) return ['The tenders do not cover the total'];

  let sum = 0;
  tenders.forEach((tender, i) => {
    if (tender.type !== 'cash' && tender.type !== 'card') problems.push(`Tender ${i + 1} has an unknown type`);
    if (!(tender.amountPence >= 1)) problems.push(`Tender ${i + 1} must be at least 1p`);
    const remaining = totalPence - sum;
    if (tender.type === 'card' && tender.amountPence > remaining) problems.push(`Card tender ${i + 1} is more than the balance`);
    sum += tender.amountPence;
    if (sum >= totalPence && i < tenders.length - 1) problems.push(`Tender ${i + 1} already covered the total`);
  });
  if (sum < totalPence) problems.push('The tenders do not cover the total');
  if (changePence !== sum - totalPence) problems.push('Change must equal tenders minus the total');
  if (changePence < 0) problems.push('Change must not be negative');
  const last = tenders[tenders.length - 1];
  if (changePence > 0 && (last === undefined || last.type !== 'cash' || changePence >= last.amountPence)) {
    problems.push('Only a final cash tender can give change');
  }
  return problems;
}
