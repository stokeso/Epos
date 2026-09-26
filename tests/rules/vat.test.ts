import { describe, expect, it } from 'vitest';
import { negate } from '../../src/rules/money';
import { VAT_RATE_CHOICES, lineVat, vatSummary, vatTotals, type VatLine } from '../../src/rules/vat';

const v = (vatRate: number, finalPence: number, vatPence: number): VatLine => ({ vatRate, finalPence, vatPence });

describe('VAT_RATE_CHOICES (D-022)', () => {
  it('offers 20, 5 and 0, highest first', () => {
    expect([...VAT_RATE_CHOICES]).toEqual([20, 5, 0]);
  });
});

describe('lineVat (D-021)', () => {
  it.each([
    [450, 20, 75], // 9000/120 = 75
    [2295, 20, 383], // 45900/120 = 382.5 -> 383
    [1250, 20, 208], // 25000/120 = 208.33 -> 208
    [765, 20, 128], // 15300/120 = 127.5 -> 128
    [800, 20, 133], // 16000/120 = 133.33 -> 133
    [9180, 20, 1530], // exact
    [3, 20, 1], // 1p items: 60/120 = 0.5 -> 1
    [1, 20, 0], // 20/120 = 0.17 -> 0
    [250, 0, 0],
    [1050, 5, 50], // 5250/105 = 50
    [1000, 5, 48], // 5000/105 = 47.62 -> 48
  ])('lineVat(%i, %i%%) = %i', (final, rate, vat) => {
    expect(lineVat(final, rate)).toBe(vat);
  });

  it('is symmetric for negative amounts and never returns -0', () => {
    expect(lineVat(-765, 20)).toBe(-128);
    expect(lineVat(-1250, 20)).toBe(-208);
    expect(lineVat(-3, 20)).toBe(-1); // -0.5 -> -1 (away from zero)
    expect(Object.is(lineVat(-2, 20), 0)).toBe(true); // -0.33 -> 0, not -0
    expect(Object.is(lineVat(0, 20), 0)).toBe(true);
    for (const final of [1, 2, 3, 7, 255, 765, 2295, 12345]) {
      expect(lineVat(-final, 20)).toBe(negate(lineVat(final, 20)));
    }
  });

  it('throws RangeError for an invalid rate or amount', () => {
    expect(() => lineVat(100, 17.5)).toThrow(RangeError);
    expect(() => lineVat(100, -1)).toThrow(RangeError);
    expect(() => lineVat(100, 101)).toThrow(RangeError);
    expect(() => lineVat(1.5, 20)).toThrow(RangeError);
  });
});

describe('vatSummary and vatTotals (D-021)', () => {
  it('sums line figures per rate, rate DESC', () => {
    // Lager 450 (VAT 75) + Wine 2295 (VAT 383) + Crisps x2 @125 at 0%.
    const rows = vatSummary([v(20, 450, 75), v(0, 250, 0), v(20, 2295, 383)]);
    expect(rows).toEqual([
      { vatRate: 20, grossPence: 2745, vatPence: 458, netPence: 2287 },
      { vatRate: 0, grossPence: 250, vatPence: 0, netPence: 250 },
    ]);
    expect(vatTotals(rows)).toEqual({ grossPence: 2995, vatPence: 458, netPence: 2537 });
  });

  it('sums line VAT rather than recomputing it from the rate total', () => {
    // Wine 2295 + Prosecco 2295: 383 + 383 = 766, whereas 4590 x 20/120 = 765.
    expect(vatSummary([v(20, 2295, 383), v(20, 2295, 383)])).toEqual([
      { vatRate: 20, grossPence: 4590, vatPence: 766, netPence: 3824 },
    ]);
  });

  it('nets refund lines off', () => {
    // Lager final 765 / VAT 128, then a refund of -255 / -43.
    expect(vatSummary([v(20, 765, 128), v(20, -255, -43)])).toEqual([
      { vatRate: 20, grossPence: 510, vatPence: 85, netPence: 425 },
    ]);
  });

  it('orders 20, 5, 0 whatever the input order', () => {
    const rows = vatSummary([v(0, 100, 0), v(5, 1050, 50), v(20, 450, 75)]);
    expect(rows.map((r) => r.vatRate)).toEqual([20, 5, 0]);
  });

  it('keeps a row for a rate whose lines net to 0', () => {
    expect(vatSummary([v(20, 450, 75), v(20, -450, -75)])).toEqual([{ vatRate: 20, grossPence: 0, vatPence: 0, netPence: 0 }]);
  });

  it('is empty for no lines', () => {
    expect(vatSummary([])).toEqual([]);
    expect(vatTotals([])).toEqual({ grossPence: 0, vatPence: 0, netPence: 0 });
  });
});
