/**
 * Refunds (spec §6.8; D-035..D-039). Pure: the service loads the original sale and its
 * existing refunds and passes them in.
 */
import type { NewSale, Pence, Sale, SaleLine, TenderType } from '../data/types';
import { mulDivRoundHalfUp, negate, sumPence } from './money';

/** One line of a refund request. */
export interface RefundRequestLine {
  /** Index into original.lines. */
  lineIndex: number;
  /** Units to refund now, 0..available (0 = not refunded). */
  qty: number;
  /** true = return to stock (default), false = waste (D-039). Ignored for untracked products. */
  returnToStock: boolean;
}

export interface RefundRequest {
  original: Sale;
  /** Every kind 'refund' sale with refundOfSaleId === original.id. */
  existingRefunds: readonly Sale[];
  lines: readonly RefundRequestLine[];
  tenderType: TenderType;
  /** The logged-in manager (or requester when overridden). */
  staffId: string;
}

export type RefundBuildResult = { ok: true; sale: NewSale } | { ok: false; errors: string[] };

/** Only kind 'sale' can be refunded (D-035). */
export function isRefundable(sale: Sale): boolean {
  return sale.kind === 'sale';
}

/**
 * Per original line index: units already refunded = sum of |qty| of refund lines with that
 * refundOfLineIndex (D-036). Refunds of other sales, and lines pointing outside the original, are
 * ignored.
 */
export function refundedQuantities(original: Sale, existingRefunds: readonly Sale[]): number[] {
  const refunded = original.lines.map(() => 0);
  for (const refund of existingRefunds) {
    if (refund.kind !== 'refund' || refund.refundOfSaleId !== original.id) continue;
    for (const line of refund.lines) {
      const index = line.refundOfLineIndex;
      if (index === undefined || refunded[index] === undefined) continue;
      refunded[index] += Math.abs(line.qty);
    }
  }
  return refunded;
}

/** Per original line index: original qty - already refunded, never below 0 (D-036). */
export function refundableQuantities(original: Sale, existingRefunds: readonly Sale[]): number[] {
  const refunded = refundedQuantities(original, existingRefunds);
  return original.lines.map((line, i) => Math.max(0, line.qty - (refunded[i] ?? 0)));
}

/**
 * Cumulative share (D-037): mulDivRoundHalfUp(total, unitsDone, totalUnits). The refund
 * amount for q more units after r is share(X, r + q, Q) - share(X, r, Q).
 * Throws RangeError unless 0 <= unitsDone <= totalUnits and totalUnits >= 1.
 */
export function cumulativeShare(total: Pence, unitsDone: number, totalUnits: number): Pence {
  if (!Number.isSafeInteger(totalUnits) || totalUnits < 1) throw new RangeError('totalUnits must be an integer >= 1');
  if (!Number.isSafeInteger(unitsDone) || unitsDone < 0 || unitsDone > totalUnits) {
    throw new RangeError(`unitsDone must be an integer 0..${totalUnits}`);
  }
  return mulDivRoundHalfUp(total, unitsDone, totalUnits);
}

/** Cumulative refunded figures of one original line, as positive magnitudes (D-125). */
export interface RefundedFigures {
  dealDiscountPence: Pence;
  memberDiscountPence: Pence;
  finalPence: Pence;
  vatPence: Pence;
}

/**
 * What the first `unitsDone` units of `originalLine` refund in total, as positive magnitudes
 * (D-037 refined by D-125). With Q = original qty, unit = unit price and the D-037 final
 * f(c) = c*unit - cumulativeShare(deal, c, Q) - cumulativeShare(member, c, Q):
 * deal = cumulativeShare(deal, unitsDone, Q); vat = cumulativeShare(vat, unitsDone, Q);
 * final = max(f(0..unitsDone)), so it never falls as more units are refunded;
 * member = unitsDone*unit - deal - final.
 * Deal and VAT are always exactly D-037. The final and member differ from D-037 only where D-037's
 * final has fallen (both shares rounded up together): the member share is then 1p lower. It depends
 * only on unitsDone, never on how earlier refunds were split, and at unitsDone = Q it is exactly the
 * original line's figures.
 * Example: A x5 @100, deal 496, member 1, final 3, vat 1: finals after 0..5 units 0,1,2,2,2,3
 * (D-037 alone: 0,1,2,1,2,3).
 * Throws RangeError unless 0 <= unitsDone <= original qty.
 */
export function cumulativeRefund(originalLine: SaleLine, unitsDone: number): RefundedFigures {
  const Q = originalLine.qty;
  const unit = originalLine.unitPricePence;
  const deal = cumulativeShare(originalLine.dealDiscountPence, unitsDone, Q);
  const vat = cumulativeShare(originalLine.vatPence, unitsDone, Q);
  let final = 0; // f(0)
  for (let c = 1; c <= unitsDone; c += 1) {
    const d037Final = c * unit - cumulativeShare(originalLine.dealDiscountPence, c, Q) - cumulativeShare(originalLine.memberDiscountPence, c, Q);
    final = Math.max(final, d037Final);
  }
  return { dealDiscountPence: deal, memberDiscountPence: unitsDone * unit - deal - final, finalPence: final, vatPence: vat };
}

/**
 * Builds one refund line (D-037, D-125) for `qty` more units of `originalLine` after
 * `alreadyRefunded`: each figure is cumulativeRefund(done) - cumulativeRefund(alreadyRefunded), so
 * gross = qty * unit and final = gross - deal - member, and no figure can have the wrong sign;
 * stored negated with negate(): qty -q, dealDiscountPence -deal, memberDiscountPence -member,
 * finalPence -final, vatPence -vat; productId, nameAtSale, unitPricePence and vatRate copied;
 * refundOfLineIndex and returnToStock set.
 * Example: original Lager {qty 3, gross 1350, deal 450, member 135, final 765, vat 128}; first
 * refund of 1 -> {qty -1, deal -150, member -45, final -255, vat -43}; second of 1 -> vat -42;
 * third -> vat -43 (sums to exactly the negated original).
 * Throws RangeError unless 1 <= qty and alreadyRefunded + qty <= original qty.
 */
export function buildRefundLine(
  originalLine: SaleLine,
  lineIndex: number,
  alreadyRefunded: number,
  qty: number,
  returnToStock: boolean,
): SaleLine {
  const Q = originalLine.qty;
  if (!Number.isSafeInteger(qty) || qty < 1) throw new RangeError('Refund qty must be an integer >= 1');
  if (!Number.isSafeInteger(alreadyRefunded) || alreadyRefunded < 0 || alreadyRefunded + qty > Q) {
    throw new RangeError(`Only ${Math.max(0, Q - alreadyRefunded)} unit(s) can be refunded`);
  }
  const before = cumulativeRefund(originalLine, alreadyRefunded);
  const after = cumulativeRefund(originalLine, alreadyRefunded + qty);
  const deal = after.dealDiscountPence - before.dealDiscountPence;
  const member = after.memberDiscountPence - before.memberDiscountPence;
  const vat = after.vatPence - before.vatPence;
  const final = qty * originalLine.unitPricePence - deal - member;
  return {
    productId: originalLine.productId,
    nameAtSale: originalLine.nameAtSale,
    qty: negate(qty),
    unitPricePence: originalLine.unitPricePence,
    vatRate: originalLine.vatRate,
    dealDiscountPence: negate(deal),
    memberDiscountPence: negate(member),
    finalPence: negate(final),
    vatPence: negate(vat),
    refundOfLineIndex: lineIndex,
    returnToStock,
  };
}

/**
 * Builds the refund sale (D-038): kind 'refund', refundOfSaleId, memberId copied from the
 * original (if set), no bookingId/tabId, lines for each request line with qty > 0 (in original
 * line order), dealLines [], memberDiscountPence = sum(line member), depositAppliedPence 0,
 * totalPence = sum(line finals), tenders [] if total is 0 else [{ type: tenderType, amountPence:
 * total }], changePence 0. Errors: original not refundable, unknown line index, a line index given
 * twice, qty not an integer in 0..available, or no line with qty > 0.
 */
export function buildRefundSale(request: RefundRequest): RefundBuildResult {
  const { original, existingRefunds, tenderType, staffId } = request;
  if (!isRefundable(original)) return { ok: false, errors: ["This receipt can't be refunded"] };

  const errors: string[] = [];
  const refunded = refundedQuantities(original, existingRefunds);
  const available = refundableQuantities(original, existingRefunds);
  const seen = new Set<number>();
  const chosen: RefundRequestLine[] = [];
  for (const line of request.lines) {
    const { lineIndex, qty } = line;
    const originalLine = Number.isInteger(lineIndex) ? original.lines[lineIndex] : undefined;
    if (originalLine === undefined) {
      errors.push(`Line ${String(lineIndex)} is not on the original receipt`);
      continue;
    }
    if (seen.has(lineIndex)) {
      errors.push(`${originalLine.nameAtSale} is listed more than once`);
      continue;
    }
    seen.add(lineIndex);
    const max = available[lineIndex] ?? 0;
    if (!Number.isInteger(qty) || qty < 0 || qty > max) {
      errors.push(`${originalLine.nameAtSale}: choose 0 to ${max} to refund`);
      continue;
    }
    if (qty > 0) chosen.push(line);
  }
  if (errors.length === 0 && chosen.length === 0) errors.push('Choose at least one item to refund');
  if (errors.length > 0) return { ok: false, errors };

  const lines = [...chosen]
    .sort((a, b) => a.lineIndex - b.lineIndex)
    .map((line) => {
      const originalLine = original.lines[line.lineIndex];
      if (originalLine === undefined) throw new RangeError('unreachable: line checked above');
      return buildRefundLine(originalLine, line.lineIndex, refunded[line.lineIndex] ?? 0, line.qty, line.returnToStock);
    });
  const totalPence = sumPence(lines.map((l) => l.finalPence));
  const sale: NewSale = {
    staffId,
    kind: 'refund',
    refundOfSaleId: original.id,
    ...(original.memberId === undefined ? {} : { memberId: original.memberId }),
    lines,
    dealLines: [],
    memberDiscountPence: sumPence(lines.map((l) => l.memberDiscountPence)),
    depositAppliedPence: 0,
    totalPence,
    tenders: totalPence === 0 ? [] : [{ type: tenderType, amountPence: totalPence }],
    changePence: 0,
  };
  return { ok: true, sale };
}

/** Refund total as a positive magnitude for display: negate(sale.totalPence). */
export function refundMagnitude(refund: Pick<Sale, 'totalPence'>): Pence {
  return negate(refund.totalPence);
}
