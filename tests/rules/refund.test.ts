import { describe, expect, it } from 'vitest';
import type { NewSale, Sale, SaleLine } from '../../src/data/types';
import {
  buildRefundLine,
  buildRefundSale,
  cumulativeRefund,
  cumulativeShare,
  isRefundable,
  refundMagnitude,
  refundableQuantities,
  refundedQuantities,
  type RefundBuildResult,
  type RefundRequest,
} from '../../src/rules/refund';
import { validateSale } from '../../src/rules/sale';
import { lineVat } from '../../src/rules/vat';
import { d042Scenario, toStoredSale } from './fixtures';

const scenario = d042Scenario();
const S1 = scenario.sales.s1; // Lager x3 {gross 1350, deal 450, member 135, final 765, vat 128}; Crisps x2 {member 38, final 212}
const LAGER = S1.lines[0]!;

function stored(sale: RefundBuildResult, id: string): Sale {
  if (!sale.ok) throw new Error(sale.errors.join('; '));
  return toStoredSale(sale.sale, { id, periodId: 'period-7', createdAt: '2026-09-27T12:00:00.000Z', receiptNumber: `3F9C-${id}` });
}

const request = (overrides: Partial<RefundRequest> = {}): RefundRequest => ({
  original: S1,
  existingRefunds: [],
  lines: [{ lineIndex: 0, qty: 1, returnToStock: true }],
  tenderType: 'cash',
  staffId: 'staff-manager',
  ...overrides,
});

describe('isRefundable (D-035)', () => {
  it('only kind sale can be refunded', () => {
    expect(isRefundable(S1)).toBe(true);
    expect(isRefundable(scenario.sales.s2)).toBe(false); // deposit
    expect(isRefundable(scenario.sales.s4)).toBe(false); // refund
  });
});

describe('cumulativeShare (D-037)', () => {
  it('is round-half-up(total x done / units)', () => {
    expect(cumulativeShare(128, 0, 3)).toBe(0);
    expect(cumulativeShare(128, 1, 3)).toBe(43); // 42.67
    expect(cumulativeShare(128, 2, 3)).toBe(85); // 85.33
    expect(cumulativeShare(128, 3, 3)).toBe(128);
    expect(cumulativeShare(1530, 1, 4)).toBe(383); // 382.5
  });

  it('throws RangeError for impossible unit counts', () => {
    expect(() => cumulativeShare(128, 4, 3)).toThrow(RangeError);
    expect(() => cumulativeShare(128, -1, 3)).toThrow(RangeError);
    expect(() => cumulativeShare(128, 0, 0)).toThrow(RangeError);
  });
});

describe('buildRefundLine (D-037)', () => {
  it('matches the D-037 table unit by unit', () => {
    // 1st: deal 450/3 = 150, member 135/3 = 45, VAT 128/3 = 42.67 -> 43; final 450 - 150 - 45 = 255.
    const first = buildRefundLine(LAGER, 0, 0, 1, true);
    expect(first).toEqual({
      productId: 'lager',
      nameAtSale: 'Lager',
      qty: -1,
      unitPricePence: 450,
      vatRate: 20,
      dealDiscountPence: -150,
      memberDiscountPence: -45,
      finalPence: -255,
      vatPence: -43,
      refundOfLineIndex: 0,
      returnToStock: true,
    });
    // 2nd: VAT 85 - 43 = 42 (net -213). 3rd: VAT 128 - 85 = 43.
    const second = buildRefundLine(LAGER, 0, 1, 1, false);
    const third = buildRefundLine(LAGER, 0, 2, 1, true);
    expect(second).toMatchObject({ dealDiscountPence: -150, memberDiscountPence: -45, finalPence: -255, vatPence: -42, returnToStock: false });
    expect(second.finalPence - second.vatPence).toBe(-213);
    expect(third).toMatchObject({ dealDiscountPence: -150, memberDiscountPence: -45, finalPence: -255, vatPence: -43 });

    // Sum is exactly the negated original line.
    const all = [first, second, third];
    const sum = (k: 'dealDiscountPence' | 'memberDiscountPence' | 'finalPence' | 'vatPence') => all.reduce((a, l) => a + l[k], 0);
    expect([sum('dealDiscountPence'), sum('memberDiscountPence'), sum('finalPence'), sum('vatPence')]).toEqual([-450, -135, -765, -128]);
  });

  it('refunds 2 units after the first: deal -300, member -90, final -510, VAT -85', () => {
    const line = buildRefundLine(LAGER, 0, 1, 2, true);
    expect(line).toMatchObject({ qty: -2, dealDiscountPence: -300, memberDiscountPence: -90, finalPence: -510, vatPence: -85 });
    expect(line.finalPence - line.vatPence).toBe(-425);
  });

  it('stores 0 rather than -0 for zero figures (D-003)', () => {
    const wine = scenario.sales.s3.lines[0]!;
    const line = buildRefundLine(wine, 0, 0, 1, true);
    expect(Object.is(line.dealDiscountPence, 0)).toBe(true);
    expect(Object.is(line.memberDiscountPence, 0)).toBe(true);
    // D-038: VAT 1530/4 = 382.5 -> 383.
    expect(line).toMatchObject({ qty: -1, finalPence: -2295, vatPence: -383 });
  });

  it('throws RangeError when the quantity is not available', () => {
    expect(() => buildRefundLine(LAGER, 0, 2, 2, true)).toThrow(RangeError);
    expect(() => buildRefundLine(LAGER, 0, 0, 0, true)).toThrow(RangeError);
    expect(() => buildRefundLine(LAGER, 0, -1, 1, true)).toThrow(RangeError);
  });
});

describe('several partial refunds sum exactly to the original (D-037)', () => {
  // Original line: Lager x7 @333 with 3 for 2 (2 groups x 333 = 666) and 15% member:
  // gross 2331, postDeal 1665, member 249.75 -> 250, final 1415, VAT 1415/6 = 235.83 -> 236.
  const original: SaleLine = {
    productId: 'lager',
    nameAtSale: 'Lager',
    qty: 7,
    unitPricePence: 333,
    vatRate: 20,
    dealDiscountPence: 666,
    memberDiscountPence: 250,
    finalPence: 1415,
    vatPence: 236,
  };

  it('refunds 2, then 3, then 2 units', () => {
    // c=2: deal 666*2/7 = 190.29 -> 190; member 250*2/7 = 71.43 -> 71; VAT 236*2/7 = 67.43 -> 67; final 666 - 190 - 71 = 405.
    const a = buildRefundLine(original, 0, 0, 2, true);
    // c=5: deal 475.71 -> 476 (-190 = 286); member 178.57 -> 179 (-71 = 108); VAT 168.57 -> 169 (-67 = 102); final 999 - 286 - 108 = 605.
    const b = buildRefundLine(original, 0, 2, 3, true);
    // c=7: deal 666 - 476 = 190; member 250 - 179 = 71; VAT 236 - 169 = 67; final 666 - 190 - 71 = 405.
    const c = buildRefundLine(original, 0, 5, 2, true);
    expect([a, b, c].map((l) => [l.qty, l.dealDiscountPence, l.memberDiscountPence, l.finalPence, l.vatPence])).toEqual([
      [-2, -190, -71, -405, -67],
      [-3, -286, -108, -605, -102],
      [-2, -190, -71, -405, -67],
    ]);
    const total = (k: 'qty' | 'dealDiscountPence' | 'memberDiscountPence' | 'finalPence' | 'vatPence') => a[k] + b[k] + c[k];
    expect([total('qty'), total('dealDiscountPence'), total('memberDiscountPence'), total('finalPence'), total('vatPence')]).toEqual([
      -7, -666, -250, -1415, -236,
    ]);
  });

  it('every split of the line sums to the negated original', () => {
    const splits = [[7], [1, 1, 1, 1, 1, 1, 1], [3, 4], [4, 3], [1, 5, 1], [2, 2, 2, 1], [6, 1]];
    for (const split of splits) {
      let done = 0;
      const lines = split.map((q) => {
        const l = buildRefundLine(original, 0, done, q, true);
        done += q;
        return l;
      });
      const sum = (k: 'dealDiscountPence' | 'memberDiscountPence' | 'finalPence' | 'vatPence') => lines.reduce((acc, l) => acc + l[k], 0);
      expect([sum('dealDiscountPence'), sum('memberDiscountPence'), sum('finalPence'), sum('vatPence')]).toEqual([-666, -250, -1415, -236]);
    }
  });
});

describe('a partial refund never charges the customer (D-125 refines D-037 against D-032)', () => {
  const line = (qty: number, unit: number, deal: number, member: number, vat: number): SaleLine => ({
    productId: 'p',
    nameAtSale: 'P',
    qty,
    unitPricePence: unit,
    vatRate: 20,
    dealDiscountPence: deal,
    memberDiscountPence: member,
    finalPence: qty * unit - deal - member,
    vatPence: vat,
  });
  const figures = (l: SaleLine) => [l.qty, l.dealDiscountPence, l.memberDiscountPence, l.finalPence, l.vatPence];
  const rhu = (x: number, c: number, q: number) => cumulativeShare(x, c, q);

  it('Lager x2 @450, deal 1 ("2 for £8.99"), member 899 (100%), final 0: refunding 1 unit, then the other', () => {
    // D-037 alone: deal rhu(1/2) = 1, member rhu(899/2) = 450, final 450 - 1 - 450 = -1, stored +1.
    // D-125: the cumulative final stays at its running maximum 0, so the member share is 449 now and 450 later.
    const original = line(2, 450, 1, 899, 0);
    const first = buildRefundLine(original, 0, 0, 1, true);
    const second = buildRefundLine(original, 0, 1, 1, true);
    expect(figures(first)).toEqual([-1, -1, -449, 0, 0]);
    expect(figures(second)).toEqual([-1, 0, -450, 0, 0]);
    for (const l of [first, second]) {
      expect(Object.is(l.finalPence, 0) && Object.is(l.vatPence, 0), 'no -0 (D-003)').toBe(true);
    }
    expect(figures(buildRefundLine(original, 0, 0, 2, true))).toEqual([-2, -1, -899, 0, 0]);
  });

  it('A x5 @100, deal 496, member 1 (15%), final 3, VAT 1: refunds of 2, then 1, then 2 units', () => {
    // D-037 finals after 0..5 units: 0, 1, 2, 1, 2, 3 (it falls at unit 3). D-125 finals: 0, 1, 2, 2, 2, 3.
    const original = line(5, 100, 496, 1, 1);
    const slices = [buildRefundLine(original, 0, 0, 2, true), buildRefundLine(original, 0, 2, 1, true), buildRefundLine(original, 0, 3, 2, true)];
    expect(slices.map(figures)).toEqual([
      [-2, -198, 0, -2, 0],
      [-1, -100, 0, 0, -1],
      [-2, -198, -1, -1, 0],
    ]);
    expect(Array.from({ length: 6 }, (_, c) => cumulativeRefund(original, c))).toEqual([
      { dealDiscountPence: 0, memberDiscountPence: 0, finalPence: 0, vatPence: 0 },
      { dealDiscountPence: 99, memberDiscountPence: 0, finalPence: 1, vatPence: 0 },
      { dealDiscountPence: 198, memberDiscountPence: 0, finalPence: 2, vatPence: 0 },
      { dealDiscountPence: 298, memberDiscountPence: 0, finalPence: 2, vatPence: 1 },
      { dealDiscountPence: 397, memberDiscountPence: 1, finalPence: 2, vatPence: 1 },
      { dealDiscountPence: 496, memberDiscountPence: 1, finalPence: 3, vatPence: 1 },
    ]);
  });

  it('cumulativeRefund is the D-037 cumulative share wherever D-037 is valid (the D-037 table)', () => {
    expect(cumulativeRefund(LAGER, 1)).toEqual({ dealDiscountPence: 150, memberDiscountPence: 45, finalPence: 255, vatPence: 43 });
    expect(cumulativeRefund(LAGER, 2)).toEqual({ dealDiscountPence: 300, memberDiscountPence: 90, finalPence: 510, vatPence: 85 });
    expect(cumulativeRefund(LAGER, 3)).toEqual({ dealDiscountPence: 450, memberDiscountPence: 135, finalPence: 765, vatPence: 128 });
    expect(() => cumulativeRefund(LAGER, 4)).toThrow(RangeError);
    expect(() => cumulativeRefund(LAGER, -1)).toThrow(RangeError);
  });

  it('exhaustively over small lines: every split is a valid refund, sums exactly, and equals D-037 wherever D-037 is valid', () => {
    const compositions = (n: number): number[][] =>
      n === 0 ? [[]] : Array.from({ length: n }, (_, i) => i + 1).flatMap((first) => compositions(n - first).map((rest) => [first, ...rest]));
    let clamped = 0;
    for (let Q = 1; Q <= 5; Q += 1) {
      for (let unit = 0; unit <= 4; unit += 1) {
        const gross = Q * unit;
        for (let deal = 0; deal <= gross; deal += 1) {
          for (let member = 0; member <= gross - deal; member += 1) {
            const final = gross - deal - member;
            const original = line(Q, unit, deal, member, lineVat(final, 20));
            const d037Final = (c: number) => c * unit - rhu(deal, c, Q) - rhu(member, c, Q);
            for (const split of compositions(Q)) {
              let done = 0;
              const sums = { deal: 0, member: 0, final: 0, vat: 0 };
              for (const q of split) {
                const refundLine = buildRefundLine(original, 0, done, q, true);
                done += q;
                const label = `Q ${Q} @${unit} deal ${deal} member ${member}, split ${split.join('+')}, after ${done}`;
                const refund: NewSale = {
                  staffId: 'staff-manager',
                  kind: 'refund',
                  refundOfSaleId: 'sale-original',
                  lines: [refundLine],
                  dealLines: [],
                  memberDiscountPence: refundLine.memberDiscountPence,
                  depositAppliedPence: 0,
                  totalPence: refundLine.finalPence,
                  tenders: refundLine.finalPence === 0 ? [] : [{ type: 'cash', amountPence: refundLine.finalPence }],
                  changePence: 0,
                };
                expect(validateSale(refund), label).toEqual([]);
                sums.deal -= refundLine.dealDiscountPence;
                sums.member -= refundLine.memberDiscountPence;
                sums.final -= refundLine.finalPence;
                sums.vat -= refundLine.vatPence;
                // Deal and VAT are always the D-037 cumulative shares; the final is D-037's running maximum.
                const runningMax = Math.max(...Array.from({ length: done + 1 }, (_, j) => d037Final(j)));
                expect(sums, label).toEqual({
                  deal: rhu(deal, done, Q),
                  member: done * unit - rhu(deal, done, Q) - runningMax,
                  final: runningMax,
                  vat: rhu(original.vatPence, done, Q),
                });
                if (runningMax === d037Final(done)) expect(sums.member, `${label}: D-037 member`).toBe(rhu(member, done, Q));
                else clamped += 1;
              }
              expect(sums, `Q ${Q} @${unit} deal ${deal} member ${member}, split ${split.join('+')}: sums to the original`).toEqual({
                deal,
                member,
                final,
                vat: original.vatPence,
              });
            }
          }
        }
      }
    }
    // The search really does reach the lines where D-037 alone would charge the customer.
    expect(clamped).toBeGreaterThan(0);
  });
});

describe('refundedQuantities / refundableQuantities (D-036)', () => {
  it('sold 3 and refunded 1 earlier: at most 2 more', () => {
    const r1 = stored(buildRefundSale(request()), 'refund-1');
    expect(refundedQuantities(S1, [r1])).toEqual([1, 0]);
    expect(refundableQuantities(S1, [r1])).toEqual([2, 2]);
  });

  it('adds up across several refunds and ignores refunds of other sales', () => {
    const r1 = stored(buildRefundSale(request()), 'refund-1');
    const r2 = stored(
      buildRefundSale(
        request({
          existingRefunds: [r1],
          lines: [
            { lineIndex: 0, qty: 2, returnToStock: true },
            { lineIndex: 1, qty: 1, returnToStock: false },
          ],
        }),
      ),
      'refund-2',
    );
    const other = { ...r1, id: 'refund-x', refundOfSaleId: 'sale-other' };
    expect(refundedQuantities(S1, [r1, r2, other])).toEqual([3, 1]);
    expect(refundableQuantities(S1, [r1, r2, other])).toEqual([0, 1]);
  });

  it('is all zero refunded with no refunds', () => {
    expect(refundedQuantities(S1, [])).toEqual([0, 0]);
    expect(refundableQuantities(S1, [])).toEqual([3, 2]);
  });
});

describe('buildRefundSale (D-038)', () => {
  it('a partial refund: 1 Lager from S1 by cash', () => {
    const result = buildRefundSale(request());
    expect(result).toEqual({
      ok: true,
      sale: {
        staffId: 'staff-manager',
        kind: 'refund',
        refundOfSaleId: 'sale-1',
        memberId: 'member-1042',
        lines: [
          {
            productId: 'lager',
            nameAtSale: 'Lager',
            qty: -1,
            unitPricePence: 450,
            vatRate: 20,
            dealDiscountPence: -150,
            memberDiscountPence: -45,
            finalPence: -255,
            vatPence: -43,
            refundOfLineIndex: 0,
            returnToStock: true,
          },
        ],
        dealLines: [],
        memberDiscountPence: -45,
        depositAppliedPence: 0,
        totalPence: -255,
        tenders: [{ type: 'cash', amountPence: -255 }],
        changePence: 0,
      },
    });
    if (result.ok) expect(validateSale(result.sale)).toEqual([]);
  });

  it('refunds a deposit-applied bill by card without touching the booking (D-038)', () => {
    // Wine x4 @2295 had 5000 of deposit applied. Refund 1 Wine: final -2295, VAT -383.
    const result = buildRefundSale(request({ original: scenario.sales.s3, tenderType: 'card' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sale).toMatchObject({
      kind: 'refund',
      refundOfSaleId: 'sale-3',
      depositAppliedPence: 0,
      totalPence: -2295,
      tenders: [{ type: 'card', amountPence: -2295 }],
      memberDiscountPence: 0,
    });
    expect(Object.keys(result.sale)).not.toContain('bookingId');
    expect(Object.keys(result.sale)).not.toContain('memberId');
    expect(Object.is(result.sale.memberDiscountPence, 0)).toBe(true);
    expect(validateSale(result.sale)).toEqual([]);
  });

  it('orders lines by original line index and skips zero quantities', () => {
    const result = buildRefundSale(
      request({
        lines: [
          { lineIndex: 1, qty: 2, returnToStock: false },
          { lineIndex: 0, qty: 0, returnToStock: true },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Crisps x2 fully: member -38, final -212, VAT 0.
    expect(result.sale.lines).toEqual([
      {
        productId: 'crisps',
        nameAtSale: 'Crisps',
        qty: -2,
        unitPricePence: 125,
        vatRate: 0,
        dealDiscountPence: 0,
        memberDiscountPence: -38,
        finalPence: -212,
        vatPence: 0,
        refundOfLineIndex: 1,
        returnToStock: false,
      },
    ]);
    expect(result.sale).toMatchObject({ memberDiscountPence: -38, totalPence: -212 });
  });

  it('refunding everything in three refunds sums to exactly the original', () => {
    const r1 = stored(buildRefundSale(request()), 'refund-1');
    const r2 = stored(buildRefundSale(request({ existingRefunds: [r1], lines: [{ lineIndex: 1, qty: 1, returnToStock: true }] })), 'refund-2');
    const r3 = stored(
      buildRefundSale(
        request({
          existingRefunds: [r1, r2],
          lines: [
            { lineIndex: 0, qty: 2, returnToStock: true },
            { lineIndex: 1, qty: 1, returnToStock: true },
          ],
        }),
      ),
      'refund-3',
    );
    const refunds = [r1, r2, r3];
    expect(refunds.reduce((a, r) => a + r.totalPence, 0)).toBe(-S1.totalPence); // -977
    expect(refunds.reduce((a, r) => a + r.memberDiscountPence, 0)).toBe(-S1.memberDiscountPence); // -173
    const vat = refunds.flatMap((r) => r.lines).reduce((a, l) => a + l.vatPence, 0);
    expect(vat).toBe(-128);
    expect(refundableQuantities(S1, refunds)).toEqual([0, 0]);
    // Nothing left: a fourth refund is rejected.
    expect(buildRefundSale(request({ existingRefunds: refunds })).ok).toBe(false);
  });

  it('a zero-value refund has no tender', () => {
    const freebie = toStoredSale(
      {
        ...scenario.newSales.s1,
        memberId: undefined,
        lines: [
          {
            productId: 'water-jug',
            nameAtSale: 'Water jug',
            qty: 1,
            unitPricePence: 0,
            vatRate: 20,
            dealDiscountPence: 0,
            memberDiscountPence: 0,
            finalPence: 0,
            vatPence: 0,
          },
        ],
        dealLines: [],
        memberDiscountPence: 0,
        totalPence: 0,
        tenders: [],
        changePence: 0,
      },
      { id: 'sale-free', periodId: 'period-6', createdAt: '2026-09-26T12:00:00.000Z', receiptNumber: '3F9C-000009' },
    );
    const result = buildRefundSale(request({ original: freebie }));
    expect(result).toMatchObject({ ok: true, sale: { totalPence: 0, tenders: [], changePence: 0 } });
    if (result.ok) {
      expect(Object.is(result.sale.totalPence, 0)).toBe(true);
      expect(validateSale(result.sale)).toEqual([]);
    }
  });

  it.each<[string, Partial<RefundRequest>]>([
    ['a deposit receipt', { original: scenario.sales.s2 }],
    ['a refund receipt', { original: scenario.sales.s4 }],
    ['no line with qty > 0', { lines: [{ lineIndex: 0, qty: 0, returnToStock: true }] }],
    ['no lines at all', { lines: [] }],
    ['an unknown line index', { lines: [{ lineIndex: 2, qty: 1, returnToStock: true }] }],
    ['a negative line index', { lines: [{ lineIndex: -1, qty: 1, returnToStock: true }] }],
    ['more than was sold', { lines: [{ lineIndex: 0, qty: 4, returnToStock: true }] }],
    ['a negative quantity', { lines: [{ lineIndex: 0, qty: -1, returnToStock: true }] }],
    ['a fractional quantity', { lines: [{ lineIndex: 0, qty: 1.5, returnToStock: true }] }],
    [
      'the same line twice',
      {
        lines: [
          { lineIndex: 0, qty: 1, returnToStock: true },
          { lineIndex: 0, qty: 1, returnToStock: true },
        ],
      },
    ],
  ])('rejects %s', (_label, overrides) => {
    expect(buildRefundSale(request(overrides))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.any(String)]) });
  });

  it('rejects more than what has not already been refunded', () => {
    const r1 = stored(buildRefundSale(request()), 'refund-1');
    expect(buildRefundSale(request({ existingRefunds: [r1], lines: [{ lineIndex: 0, qty: 3, returnToStock: true }] })).ok).toBe(false);
    expect(buildRefundSale(request({ existingRefunds: [r1], lines: [{ lineIndex: 0, qty: 2, returnToStock: true }] })).ok).toBe(true);
  });
});

describe('refundMagnitude', () => {
  it('is the positive size of a refund', () => {
    expect(refundMagnitude({ totalPence: -255 })).toBe(255);
    expect(Object.is(refundMagnitude({ totalPence: 0 }), 0)).toBe(true);
  });
});
