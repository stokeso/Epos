/**
 * Basket pricing (spec §7; D-008..D-011, D-017, D-019..D-021, D-023). Pure: `at` is passed in.
 * Recalculated from scratch on every basket change and once more when Pay opens (the Pay freeze).
 */
import type { Deal, IsoInstant, Pence, SaleDealLine, SaleLine, VatRate } from '../data/types';
import { applyDeals } from './deals';
import { memberDiscount } from './discount';
import { MAX_LINE_QTY, MIN_LINE_QTY, assertPence, sumPence } from './money';
import { isValidVatRate, lineVat, vatSummary, type VatSummaryRow } from './vat';

/**
 * A basket line resolved against the CURRENT product record (D-009). Services build these from
 * BasketLine + Product (inactive or soft-deleted products still price).
 */
export interface PricingLine {
  productId: string;
  /** Product name now; becomes SaleLine.nameAtSale. */
  name: string;
  /** 1..999 */
  qty: number;
  unitPricePence: Pence;
  vatRate: VatRate;
  memberDiscountEligible: boolean;
}

export interface PricingInput {
  /** Basket order; unique by productId (D-008). */
  lines: readonly PricingLine[];
  /** Every deal record (pricing filters by validity at `at`). */
  deals: readonly Deal[];
  /** The pricing instant (D-011). */
  at: IsoInstant;
  /** settings.memberDiscountPercent when a member is attached, else null (D-019). */
  memberDiscountPercent: number | null;
  /** The attached booking's unused balance, else null (D-023). */
  depositBalancePence: Pence | null;
}

export interface PricedLine extends PricingLine {
  /** qty * unitPricePence */
  grossPence: Pence;
  dealDiscountPence: Pence;
  memberDiscountPence: Pence;
  /** gross - deal - member (>= 0) */
  finalPence: Pence;
  /** lineVat(finalPence, vatRate) */
  vatPence: Pence;
  /** final - vat (derived) */
  netPence: Pence;
}

export interface PricedBasket {
  /** Pricing instant used. */
  at: IsoInstant;
  lines: PricedLine[];
  /** In canonical deal order; sum of savingPence = dealDiscountPence (D-017). */
  dealLines: SaleDealLine[];
  /** Sum of line gross. */
  grossPence: Pence;
  /** Sum of line deal discounts. */
  dealDiscountPence: Pence;
  /** Sum of line member discounts. */
  memberDiscountPence: Pence;
  /** Sum of line finals. */
  subtotalPence: Pence;
  /** depositApplied(depositBalancePence, subtotalPence) (D-023). */
  depositAppliedPence: Pence;
  /** subtotal - depositApplied (>= 0). */
  totalPence: Pence;
  /** Over the line finals (deposit applied does not change VAT, D-021, D-023). */
  vatSummary: VatSummaryRow[];
}

function assertPricingLine(line: PricingLine, index: number): void {
  if (!Number.isInteger(line.qty) || line.qty < MIN_LINE_QTY || line.qty > MAX_LINE_QTY) {
    throw new RangeError(`Line ${index}: qty must be an integer ${MIN_LINE_QTY}..${MAX_LINE_QTY}`);
  }
  assertPence(line.unitPricePence, `Line ${index} unit price`);
  if (line.unitPricePence < 0) throw new RangeError(`Line ${index}: unit price must be >= 0`);
  if (!isValidVatRate(line.vatRate)) throw new RangeError(`Line ${index}: vatRate must be an integer 0..100`);
}

/**
 * Prices a basket (spec §7 steps 1-6): gross -> deals (rules/deals.applyDeals) -> member
 * discount on post-deal amounts (rules/discount.memberDiscount) -> final -> line VAT -> deposit
 * applied -> total.
 * Example (D-020): Lager x3 @450 (20%, eligible) + Crisps x2 @125 (0%, eligible), deal
 * 'Lager 3 for 2', member at 15% -> Lager {gross 1350, deal 450, member 135, final 765, vat 128},
 * Crisps {gross 250, deal 0, member 38, final 212, vat 0}; subtotal 977; total 977.
 * Throws RangeError for a line outside qty 1..999, a negative or fractional price, a VAT rate
 * outside 0..100, a member percent outside 0..100, or an invalid `at`.
 */
export function priceBasket(input: PricingInput): PricedBasket {
  const { lines, deals, at, memberDiscountPercent, depositBalancePence } = input;
  lines.forEach(assertPricingLine);

  // Step 1: line gross.
  const gross = lines.map((line) => line.qty * line.unitPricePence);
  // Step 2: deals.
  const dealResult = applyDeals(lines, deals, at);
  // Step 3: member discount on post-deal amounts.
  const postDeal = lines.map((_, i) => (gross[i] ?? 0) - (dealResult.lineDealDiscounts[i] ?? 0));
  const member = memberDiscount(
    lines.map((line, i) => ({ postDealPence: postDeal[i] ?? 0, eligible: line.memberDiscountEligible })),
    memberDiscountPercent,
  );
  // Step 5: final, VAT and net per line.
  const pricedLines: PricedLine[] = lines.map((line, i) => {
    const grossPence = gross[i] ?? 0;
    const dealDiscountPence = dealResult.lineDealDiscounts[i] ?? 0;
    const memberDiscountPence = member.perLine[i] ?? 0;
    const finalPence = grossPence - dealDiscountPence - memberDiscountPence;
    const vatPence = lineVat(finalPence, line.vatRate);
    return {
      productId: line.productId,
      name: line.name,
      qty: line.qty,
      unitPricePence: line.unitPricePence,
      vatRate: line.vatRate,
      memberDiscountEligible: line.memberDiscountEligible,
      grossPence,
      dealDiscountPence,
      memberDiscountPence,
      finalPence,
      vatPence,
      netPence: finalPence - vatPence,
    };
  });

  const subtotalPence = sumPence(pricedLines.map((l) => l.finalPence));
  // Steps 4 and 6: deposit applied and total.
  const depositAppliedPence = depositApplied(depositBalancePence, subtotalPence);
  return {
    at,
    lines: pricedLines,
    dealLines: dealResult.dealLines,
    grossPence: sumPence(pricedLines.map((l) => l.grossPence)),
    dealDiscountPence: sumPence(pricedLines.map((l) => l.dealDiscountPence)),
    memberDiscountPence: sumPence(pricedLines.map((l) => l.memberDiscountPence)),
    subtotalPence,
    depositAppliedPence,
    totalPence: subtotalPence - depositAppliedPence,
    vatSummary: vatSummary(pricedLines),
  };
}

/**
 * Deposit applied (D-023): balance === null -> 0; else max(0, min(balance, subtotal)).
 * Examples with subtotal 9180: balance 5000 -> 5000; 9180 -> 9180; 10000 -> 9180.
 */
export function depositApplied(balancePence: Pence | null, subtotalPence: Pence): Pence {
  assertPence(subtotalPence, 'subtotal');
  if (balancePence === null) return 0;
  assertPence(balancePence, 'deposit balance');
  return Math.max(0, Math.min(balancePence, subtotalPence));
}

/** Snapshots priced lines into SaleLines (nameAtSale = name; no refund fields) (D-009). */
export function toSaleLines(priced: PricedBasket): SaleLine[] {
  return priced.lines.map((line) => ({
    productId: line.productId,
    nameAtSale: line.name,
    qty: line.qty,
    unitPricePence: line.unitPricePence,
    vatRate: line.vatRate,
    dealDiscountPence: line.dealDiscountPence,
    memberDiscountPence: line.memberDiscountPence,
    finalPence: line.finalPence,
    vatPence: line.vatPence,
  }));
}
