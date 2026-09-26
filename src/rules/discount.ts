/**
 * Member discount (spec §7.3; D-019, D-020). Pure.
 */
import type { Pence } from '../data/types';
import { allocate, assertPence, mulDivRoundHalfUp, sumPence } from './money';

/** The fields member discount needs from a basket line (line index = array position). */
export interface MemberDiscountLine {
  /** gross - deal discount (>= 0). */
  postDealPence: Pence;
  eligible: boolean;
}

export interface MemberDiscountResult {
  /** Sum of postDealPence over eligible lines. */
  basePence: Pence;
  /** mulDivRoundHalfUp(base, percent, 100); 0 when percent is null. */
  discountPence: Pence;
  /** Per line (same indices as input); ineligible lines get 0; sums to discountPence. */
  perLine: Pence[];
}

/**
 * Member discount (D-020). percent === null means no member attached: all zeros.
 * discount = mulDivRoundHalfUp(base, percent, 100), spread with allocate(discount, postDeal of
 * eligible lines, priority = postDeal DESC then lineIndex ASC).
 * Examples: postDeal [900 elig, 250 elig] at 15% -> base 1150, discount 173 (172.5), perLine [135, 38].
 * [410, 410, 410] at 15% -> 185 (184.5), perLine [61, 62, 62].
 * [900 elig, 1200 inelig] at 15% -> 135, perLine [135, 0].
 * Throws RangeError for a percent that is not an integer 0..100 or a negative/non-integer amount.
 */
export function memberDiscount(lines: readonly MemberDiscountLine[], percent: number | null): MemberDiscountResult {
  if (percent !== null && (!Number.isInteger(percent) || percent < 0 || percent > 100)) {
    throw new RangeError(`memberDiscountPercent must be an integer 0..100 (got ${String(percent)})`);
  }
  lines.forEach((line, i) => {
    assertPence(line.postDealPence, `Line ${i} post-deal amount`);
    if (line.postDealPence < 0) throw new RangeError(`Line ${i}: post-deal amount must be >= 0`);
  });

  const eligibleIndices = lines.flatMap((line, i) => (line.eligible ? [i] : []));
  const weights = eligibleIndices.map((i) => lines[i]?.postDealPence ?? 0);
  const basePence = sumPence(weights);
  const perLine = lines.map(() => 0);
  if (percent === null) return { basePence, discountPence: 0, perLine };

  const discountPence = mulDivRoundHalfUp(basePence, percent, 100);
  // Priority over positions in `weights`: post-deal DESC, then line index ASC.
  const priority = weights
    .map((_, position) => position)
    .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || (eligibleIndices[a] ?? 0) - (eligibleIndices[b] ?? 0));
  const shares = allocate(discountPence, weights, priority);
  shares.forEach((share, position) => {
    const lineIndex = eligibleIndices[position];
    if (lineIndex !== undefined) perLine[lineIndex] = share;
  });
  return { basePence, discountPence, perLine };
}
