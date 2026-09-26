/**
 * What the refund will pay back, shown before the commit. It is not a second implementation of
 * the refund maths: each figure is rules/refund.buildRefundLine (D-037, D-125), the same function
 * services/refunds.commitRefund builds the refund sale with. The figures depend only on how many
 * units of the line have been refunded (D-125), so the preview equals the committed refund unless
 * another refund of the same sale is made in between (the service re-checks inside its
 * transaction).
 */
import type { Pence } from '../../data/types';
import { negate, sumPence } from '../../rules/money';
import { buildRefundLine } from '../../rules/refund';
import type { RefundableLine } from '../../services/refunds';

/** The positive amount refunded for `qty` more units of `line` (0 when qty is 0). */
export function lineRefundPence(line: RefundableLine, qty: number): Pence {
  if (qty <= 0) return 0;
  // Stock choice does not change any money figure.
  return negate(buildRefundLine(line.line, line.lineIndex, line.refundedQty, qty, true).finalPence);
}

/** The positive refund total for the chosen quantities (by original line index). */
export function refundTotalPence(lines: readonly RefundableLine[], quantities: ReadonlyMap<number, number>): Pence {
  return sumPence(lines.map((line) => lineRefundPence(line, quantities.get(line.lineIndex) ?? 0)));
}
