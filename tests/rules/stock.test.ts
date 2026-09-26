import { describe, expect, it } from 'vitest';
import type { NewSale } from '../../src/data/types';
import { buildRefundSale } from '../../src/rules/refund';
import { REFUND_WASTE_NOTE, stockMovementsForSale } from '../../src/rules/stock';
import { d042Scenario } from './fixtures';

const scenario = d042Scenario();
const tracked = (ids: string[]) => (productId: string) => ids.includes(productId);

function refundOf(lines: { lineIndex: number; qty: number; returnToStock: boolean }[]): NewSale {
  const r = buildRefundSale({ original: scenario.sales.s1, existingRefunds: [], lines, tenderType: 'cash', staffId: 'staff-manager' });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.sale;
}

describe('stockMovementsForSale (D-079, D-039)', () => {
  it("writes -qty 'sale' movements for tracked lines only, in line order", () => {
    // S1: Lager x3 (tracked), Crisps x2 (tracked).
    expect(stockMovementsForSale(scenario.newSales.s1, tracked(['lager', 'crisps']))).toEqual([
      { productId: 'lager', qty: -3, reason: 'sale', note: '' },
      { productId: 'crisps', qty: -2, reason: 'sale', note: '' },
    ]);
    expect(stockMovementsForSale(scenario.newSales.s1, tracked(['crisps']))).toEqual([
      { productId: 'crisps', qty: -2, reason: 'sale', note: '' },
    ]);
    expect(stockMovementsForSale(scenario.newSales.s1, tracked([]))).toEqual([]);
  });

  it('writes nothing for a deposit', () => {
    expect(stockMovementsForSale(scenario.newSales.s2, () => true)).toEqual([]);
  });

  it("returns refunded units to stock with one +q 'refund' movement", () => {
    // Refund 1 Lager to stock: 47 -> 48.
    expect(stockMovementsForSale(refundOf([{ lineIndex: 0, qty: 1, returnToStock: true }]), tracked(['lager']))).toEqual([
      { productId: 'lager', qty: 1, reason: 'refund', note: '' },
    ]);
  });

  it("records wasted refunds as +q 'refund' then -q 'waste' (net 0)", () => {
    const moves = stockMovementsForSale(
      refundOf([
        { lineIndex: 0, qty: 2, returnToStock: false },
        { lineIndex: 1, qty: 1, returnToStock: true },
      ]),
      tracked(['lager', 'crisps']),
    );
    expect(moves).toEqual([
      { productId: 'lager', qty: 2, reason: 'refund', note: '' },
      { productId: 'lager', qty: -2, reason: 'waste', note: REFUND_WASTE_NOTE },
      { productId: 'crisps', qty: 1, reason: 'refund', note: '' },
    ]);
    expect(REFUND_WASTE_NOTE).toBe('Refund - wasted');
    expect(moves.filter((m) => m.productId === 'lager').reduce((a, m) => a + m.qty, 0)).toBe(0);
  });

  it('writes nothing for untracked refunded products', () => {
    expect(stockMovementsForSale(refundOf([{ lineIndex: 0, qty: 1, returnToStock: false }]), tracked([]))).toEqual([]);
  });
});
