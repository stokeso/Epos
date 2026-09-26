/**
 * VAT per line and VAT summaries (spec §7.5; D-021, D-022).
 * Reports and receipts SUM stored line figures; they never recompute VAT from a rate total.
 */
import type { Pence, SaleLine, VatRate } from '../data/types';
import { mulDivRoundHalfUp, sumPence } from './money';

/** Rates the back office offers, highest first (D-022). */
export const VAT_RATE_CHOICES = [20, 5, 0] as const;

/** One row per VAT rate. netPence = grossPence - vatPence. */
export interface VatSummaryRow {
  vatRate: VatRate;
  grossPence: Pence;
  vatPence: Pence;
  netPence: Pence;
}

/** The fields a VAT summary needs from a line. */
export type VatLine = Pick<SaleLine, 'vatRate' | 'finalPence' | 'vatPence'>;

/** True for an integer VAT rate 0..100 (D-001, D-022). */
export function isValidVatRate(rate: number): boolean {
  return Number.isInteger(rate) && rate >= 0 && rate <= 100;
}

/**
 * Line VAT for sale-kind lines (D-021): mulDivRoundHalfUp(finalPence, vatRate, 100 + vatRate).
 * Examples: (450, 20) -> 75; (2295, 20) -> 383 (382.5); (1250, 20) -> 208; (250, 0) -> 0.
 * Symmetric for negative amounts and never -0. Throws RangeError for a rate outside 0..100.
 * Refund lines do NOT use this: see rules/refund.ts (D-037).
 */
export function lineVat(finalPence: Pence, vatRate: VatRate): Pence {
  if (!isValidVatRate(vatRate)) throw new RangeError(`vatRate must be an integer 0..100 (got ${String(vatRate)})`);
  return mulDivRoundHalfUp(finalPence, vatRate, 100 + vatRate);
}

/**
 * VAT summary (D-021): one row per vatRate present, sorted by rate DESC; grossPence = sum of
 * finalPence, vatPence = sum of vatPence, netPence = gross - vat. Refund lines (negative) net off.
 * Example: Lager 450 (VAT 75) + Wine 2295 (VAT 383) + Crisps 250 at 0% ->
 * [{20, gross 2745, vat 458, net 2287}, {0, gross 250, vat 0, net 250}].
 */
export function vatSummary(lines: readonly VatLine[]): VatSummaryRow[] {
  const byRate = new Map<VatRate, { gross: Pence[]; vat: Pence[] }>();
  for (const line of lines) {
    const bucket = byRate.get(line.vatRate) ?? { gross: [], vat: [] };
    bucket.gross.push(line.finalPence);
    bucket.vat.push(line.vatPence);
    byRate.set(line.vatRate, bucket);
  }
  return [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([vatRate, bucket]) => {
      const grossPence = sumPence(bucket.gross);
      const vatPence = sumPence(bucket.vat);
      return { vatRate, grossPence, vatPence, netPence: grossPence - vatPence };
    });
}

/** Column totals of a VAT summary. */
export function vatTotals(rows: readonly VatSummaryRow[]): { grossPence: Pence; vatPence: Pence; netPence: Pence } {
  return {
    grossPence: sumPence(rows.map((r) => r.grossPence)),
    vatPence: sumPence(rows.map((r) => r.vatPence)),
    netPence: sumPence(rows.map((r) => r.netPence)),
  };
}
