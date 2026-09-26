import { describe, expect, it } from 'vitest';
import type { Deal } from '../../src/data/types';
import { depositApplied, priceBasket, toSaleLines, type PricedBasket, type PricingInput } from '../../src/rules/pricing';
import { AT, nForM, nForPrice, pline } from './fixtures';

function price(input: Partial<PricingInput> & Pick<PricingInput, 'lines'>): PricedBasket {
  return priceBasket({ deals: [], at: AT, memberDiscountPercent: null, depositBalancePence: null, ...input });
}

/** The invariants every priced basket must satisfy (spec §7). */
function expectConsistent(p: PricedBasket): void {
  const sum = (f: (l: PricedBasket['lines'][number]) => number) => p.lines.reduce((a, l) => a + f(l), 0);
  for (const l of p.lines) {
    expect(l.grossPence).toBe(l.qty * l.unitPricePence);
    expect(l.finalPence).toBe(l.grossPence - l.dealDiscountPence - l.memberDiscountPence);
    expect(l.netPence).toBe(l.finalPence - l.vatPence);
    expect(l.finalPence).toBeGreaterThanOrEqual(0);
  }
  expect(p.grossPence).toBe(sum((l) => l.grossPence));
  expect(p.dealDiscountPence).toBe(sum((l) => l.dealDiscountPence));
  expect(p.dealLines.reduce((a, d) => a + d.savingPence, 0)).toBe(p.dealDiscountPence);
  expect(p.memberDiscountPence).toBe(sum((l) => l.memberDiscountPence));
  expect(p.subtotalPence).toBe(sum((l) => l.finalPence));
  expect(p.subtotalPence).toBe(p.grossPence - p.dealDiscountPence - p.memberDiscountPence);
  expect(p.totalPence).toBe(p.subtotalPence - p.depositAppliedPence);
  expect(p.vatSummary.reduce((a, r) => a + r.grossPence, 0)).toBe(p.subtotalPence);
  expect(p.vatSummary.reduce((a, r) => a + r.vatPence, 0)).toBe(sum((l) => l.vatPence));
}

const figures = (p: PricedBasket) =>
  p.lines.map((l) => ({
    gross: l.grossPence,
    deal: l.dealDiscountPence,
    member: l.memberDiscountPence,
    final: l.finalPence,
    vat: l.vatPence,
    net: l.netPence,
  }));

describe('priceBasket: plain lines (spec §7 steps 1, 5, 6)', () => {
  it('a single item', () => {
    // Lager 450 at 20%: VAT 450*20/120 = 75, net 375.
    const p = price({ lines: [pline('lager', 1, 450)] });
    expect(figures(p)).toEqual([{ gross: 450, deal: 0, member: 0, final: 450, vat: 75, net: 375 }]);
    expect(p).toMatchObject({ grossPence: 450, subtotalPence: 450, depositAppliedPence: 0, totalPence: 450, dealLines: [] });
    expectConsistent(p);
  });

  it('multiple quantities', () => {
    // Lager x3 @450 = 1350; VAT 1350*20/120 = 225; net 1125.
    const p = price({ lines: [pline('lager', 3, 450)] });
    expect(figures(p)).toEqual([{ gross: 1350, deal: 0, member: 0, final: 1350, vat: 225, net: 1125 }]);
    expect(p.totalPence).toBe(1350);
    expectConsistent(p);
  });

  it('copies line identity through and stamps the pricing instant', () => {
    const p = price({ lines: [pline('crisps', 2, 125, { vatRate: 0, eligible: false, name: 'Crisps' })] });
    expect(p.at).toBe(AT);
    expect(p.lines[0]).toMatchObject({
      productId: 'crisps',
      name: 'Crisps',
      qty: 2,
      unitPricePence: 125,
      vatRate: 0,
      memberDiscountEligible: false,
    });
  });

  it('an empty basket prices to zero', () => {
    const p = price({ lines: [], memberDiscountPercent: 15, depositBalancePence: 5000 });
    expect(p).toEqual({
      at: AT,
      lines: [],
      dealLines: [],
      grossPence: 0,
      dealDiscountPence: 0,
      memberDiscountPence: 0,
      subtotalPence: 0,
      depositAppliedPence: 0,
      totalPence: 0,
      vatSummary: [],
    });
  });

  it('zero-price items', () => {
    const p = price({ lines: [pline('water-jug', 2, 0), pline('lager', 1, 450)], memberDiscountPercent: 15 });
    // Base 450 x 15% = 67.5 -> 68, all on the Lager. Lager final 382, VAT 63.67 -> 64.
    expect(figures(p)).toEqual([
      { gross: 0, deal: 0, member: 0, final: 0, vat: 0, net: 0 },
      { gross: 450, deal: 0, member: 68, final: 382, vat: 64, net: 318 },
    ]);
    expectConsistent(p);
  });

  it('1p items', () => {
    // 3 x 1p at 20%: VAT 60/120 = 0.5 -> 1. With a member: 3 x 15% = 0.45 -> 0.
    const p = price({ lines: [pline('mint', 3, 1)], memberDiscountPercent: 15 });
    expect(figures(p)).toEqual([{ gross: 3, deal: 0, member: 0, final: 3, vat: 1, net: 2 }]);
    expectConsistent(p);
  });

  it('large quantities at the maximum price stay exact', () => {
    // 999 x 999,999 = 998,999,001. Member 15%: 149,849,850.15 -> 149,849,850.
    // Final 849,149,151; VAT 849,149,151/6 = 141,524,858.5 -> 141,524,859.
    const p = price({ lines: [pline('magnum', 999, 999_999)], memberDiscountPercent: 15 });
    expect(figures(p)).toEqual([
      { gross: 998_999_001, deal: 0, member: 149_849_850, final: 849_149_151, vat: 141_524_859, net: 707_624_292 },
    ]);
    expectConsistent(p);
  });

  it('throws RangeError for out-of-range lines', () => {
    expect(() => price({ lines: [pline('x', 0, 450)] })).toThrow(RangeError);
    expect(() => price({ lines: [pline('x', 1000, 450)] })).toThrow(RangeError);
    expect(() => price({ lines: [pline('x', 1, -1)] })).toThrow(RangeError);
    expect(() => price({ lines: [pline('x', 1, 4.5)] })).toThrow(RangeError);
    expect(() => price({ lines: [pline('x', 1, 450, { vatRate: 17.5 })] })).toThrow(RangeError);
  });
});

describe('priceBasket: deals (spec §7 step 2)', () => {
  const twoFor8: Deal = nForPrice('2for8', 2, 800, ['lager'], { name: '2 for £8' });

  it('nForPrice with equal prices', () => {
    // Lager x2 @450, 2 for £8: saving 100 (50/50); final 800, VAT 133.33 -> 133, net 667.
    const p = price({ lines: [pline('lager', 2, 450)], deals: [twoFor8] });
    expect(figures(p)).toEqual([{ gross: 900, deal: 100, member: 0, final: 800, vat: 133, net: 667 }]);
    expect(p.dealLines).toEqual([{ dealId: '2for8', name: '2 for £8', groupCount: 1, savingPence: 100 }]);
    expectConsistent(p);
  });

  it('nForPrice with a leftover unit', () => {
    // Lager x3 @450: one group saves 100, one unit left over. Final 1250, VAT 208.33 -> 208, net 1042.
    const p = price({ lines: [pline('lager', 3, 450)], deals: [twoFor8] });
    expect(figures(p)).toEqual([{ gross: 1350, deal: 100, member: 0, final: 1250, vat: 208, net: 1042 }]);
    expectConsistent(p);
  });

  it('nForPrice with mixed prices', () => {
    // 3 for £10 on A 350, B 450, C 400 (basket order A, B, C). Saving 200 -> B 75, C 67, A 58.
    // Finals A 292 (VAT 48.67 -> 49), B 375 (62.5 -> 63), C 333 (55.5 -> 56). Total 1000.
    const p = price({
      lines: [pline('a', 1, 350), pline('b', 1, 450), pline('c', 1, 400)],
      deals: [nForPrice('3for10', 3, 1000, ['a', 'b', 'c'])],
    });
    expect(figures(p)).toEqual([
      { gross: 350, deal: 58, member: 0, final: 292, vat: 49, net: 243 },
      { gross: 450, deal: 75, member: 0, final: 375, vat: 63, net: 312 },
      { gross: 400, deal: 67, member: 0, final: 333, vat: 56, net: 277 },
    ]);
    expect(p.totalPence).toBe(1000);
    expectConsistent(p);
  });

  it('a deal that would raise the price is not applied', () => {
    // 2 for £10 on Lager x2 @450: saving -100. Final 900, VAT 150.
    const p = price({ lines: [pline('lager', 2, 450)], deals: [nForPrice('2for10', 2, 1000, ['lager'])] });
    expect(figures(p)).toEqual([{ gross: 900, deal: 0, member: 0, final: 900, vat: 150, net: 750 }]);
    expect(p.dealLines).toEqual([]);
    expectConsistent(p);
  });

  it('only groups that save are applied (D-015 second-group example)', () => {
    // 3 for £10 on A x2 @500, B x2 @400, C x3 @200: group 1 saves 400 (143,143,114); group 2 does not.
    const p = price({
      lines: [pline('a', 2, 500), pline('b', 2, 400), pline('c', 3, 200)],
      deals: [nForPrice('3for10', 3, 1000, ['a', 'b', 'c'])],
    });
    expect(p.lines.map((l) => l.dealDiscountPence)).toEqual([286, 114, 0]);
    expect(p.totalPence).toBe(2000); // 2400 - 400
    expect(p.dealLines).toEqual([{ dealId: '3for10', name: '3for10', groupCount: 1, savingPence: 400 }]);
    expectConsistent(p);
  });

  it('nForM with mixed prices', () => {
    // 3 for 2 on A 500, B 400, C 300: saving 300 -> 125, 100, 75. Finals 375, 300, 225 (total 900).
    // VAT 62.5 -> 63, 50, 37.5 -> 38. Nets 312, 250, 187.
    const p = price({
      lines: [pline('a', 1, 500), pline('b', 1, 400), pline('c', 1, 300)],
      deals: [nForM('3for2', 3, 2, ['a', 'b', 'c'])],
    });
    expect(figures(p)).toEqual([
      { gross: 500, deal: 125, member: 0, final: 375, vat: 63, net: 312 },
      { gross: 400, deal: 100, member: 0, final: 300, vat: 50, net: 250 },
      { gross: 300, deal: 75, member: 0, final: 225, vat: 38, net: 187 },
    ]);
    expect(p.totalPence).toBe(900);
    expectConsistent(p);
  });

  it('nForM rounding case: A 450, B 420, C 390', () => {
    const p = price({
      lines: [pline('a', 1, 450), pline('b', 1, 420), pline('c', 1, 390)],
      deals: [nForM('3for2', 3, 2, ['a', 'b', 'c'])],
    });
    // Saving 390 -> 139, 130, 121; finals 311, 290, 269.
    expect(p.lines.map((l) => l.finalPence)).toEqual([311, 290, 269]);
    expectConsistent(p);
  });

  it('an item eligible for two deals: the bigger saving wins (D-018)', () => {
    const A = nForPrice('A', 2, 700, ['lager', 'bitter'], { name: 'Any 2 pints £7', createdAt: '2026-09-01T00:00:00.000Z' });
    const B = nForM('B', 3, 2, ['bitter'], { name: 'Bitter 3 for 2', createdAt: '2026-09-02T00:00:00.000Z' });
    const p = price({ lines: [pline('lager', 1, 450), pline('bitter', 3, 420)], deals: [A, B] });
    // Lager: final 450 (VAT 75). Bitter: deal 420, final 840 (VAT 140). Total 1290.
    expect(figures(p)).toEqual([
      { gross: 450, deal: 0, member: 0, final: 450, vat: 75, net: 375 },
      { gross: 1260, deal: 420, member: 0, final: 840, vat: 140, net: 700 },
    ]);
    expect(p.dealLines).toEqual([{ dealId: 'B', name: 'Bitter 3 for 2', groupCount: 1, savingPence: 420 }]);
    expect(p.totalPence).toBe(1290);
    expectConsistent(p);
  });

  it('respects deal date windows at the pricing instant (D-011, D-012)', () => {
    const windowed = { ...twoFor8, endsAt: '2026-09-30T23:00:00.000Z' };
    const lines = [pline('lager', 2, 450)];
    expect(price({ lines, deals: [windowed], at: '2026-09-30T22:59:59.999Z' }).totalPence).toBe(800);
    expect(price({ lines, deals: [windowed], at: '2026-09-30T23:00:00.000Z' }).totalPence).toBe(900);
  });

  it('ignores inactive deals', () => {
    expect(price({ lines: [pline('lager', 2, 450)], deals: [{ ...twoFor8, active: false }] }).totalPence).toBe(900);
  });

  it('reprices a tab across rounds at settlement (D-062)', () => {
    // Round 1 Lager x2 + round 2 Lager x1 = one line of 3; 3 for 2 saves 450: total 900.
    const p = price({ lines: [pline('lager', 3, 450)], deals: [nForM('3for2', 3, 2, ['lager'])] });
    expect(p.totalPence).toBe(900);
  });

  it('sample deals (D-098): 3 Ready Salted + 1 Chocolate Bar', () => {
    // Snacks 3 for 2: saving 120 (40 per packet). Total 240 + 140 = 380.
    const p = price({
      lines: [pline('ready-salted', 3, 120), pline('chocolate', 1, 140)],
      deals: [nForM('snacks', 3, 2, ['ready-salted', 'peanuts'])],
    });
    expect(p.lines.map((l) => l.dealDiscountPence)).toEqual([120, 0]);
    expect(p.totalPence).toBe(380);
    expectConsistent(p);
  });
});

describe('priceBasket: member discount (spec §7 step 3)', () => {
  it('with a deal, including half-penny rounding (D-020)', () => {
    // Lager x3 @450 with 3 for 2 (deal 450, postDeal 900) + Crisps x2 @125 at 0% (postDeal 250).
    // Base 1150 x 15% = 172.5 -> 173; shares 135 and 38.
    const p = price({
      lines: [pline('lager', 3, 450), pline('crisps', 2, 125, { vatRate: 0 })],
      deals: [nForM('lager3for2', 3, 2, ['lager'])],
      memberDiscountPercent: 15,
    });
    expect(figures(p)).toEqual([
      { gross: 1350, deal: 450, member: 135, final: 765, vat: 128, net: 637 },
      { gross: 250, deal: 0, member: 38, final: 212, vat: 0, net: 212 },
    ]);
    expect(p).toMatchObject({ grossPence: 1600, dealDiscountPence: 450, memberDiscountPence: 173, subtotalPence: 977, totalPence: 977 });
    expect(p.vatSummary).toEqual([
      { vatRate: 20, grossPence: 765, vatPence: 128, netPence: 637 },
      { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
    ]);
    expectConsistent(p);
  });

  it('without deals (D-020)', () => {
    // Lager x2 @450 + Crisps 130 at 0%. Base 1030 -> 154.5 -> 155. Lager 135, Crisps 20. Total 875.
    const p = price({
      lines: [pline('lager', 2, 450), pline('crisps', 1, 130, { vatRate: 0 })],
      memberDiscountPercent: 15,
    });
    expect(p.lines.map((l) => l.memberDiscountPence)).toEqual([135, 20]);
    expect(p.totalPence).toBe(875);
    expectConsistent(p);
  });

  it('spreads the remainder so the lines sum exactly to the discount (D-020)', () => {
    // Three eligible lines of 410: 185 -> [61, 62, 62]; finals 349, 348, 348.
    const p = price({
      lines: [pline('a', 1, 410), pline('b', 1, 410), pline('c', 1, 410)],
      memberDiscountPercent: 15,
    });
    expect(p.lines.map((l) => l.memberDiscountPence)).toEqual([61, 62, 62]);
    expect(p.lines.map((l) => l.finalPence)).toEqual([349, 348, 348]);
    expect(p.memberDiscountPence).toBe(185);
    expectConsistent(p);
  });

  it('a member-ineligible item in a member basket (D-020)', () => {
    // Lager x2 @450 + Cigar 1200 (ineligible). Base 900 -> 135, all on the Lager. Total 765 + 1200 = 1965.
    const p = price({
      lines: [pline('lager', 2, 450), pline('cigar', 1, 1200, { eligible: false })],
      memberDiscountPercent: 15,
    });
    expect(figures(p)).toEqual([
      { gross: 900, deal: 0, member: 135, final: 765, vat: 128, net: 637 },
      { gross: 1200, deal: 0, member: 0, final: 1200, vat: 200, net: 1000 },
    ]);
    expect(p.totalPence).toBe(1965);
    expectConsistent(p);
  });

  it('an all-ineligible member basket gets no discount', () => {
    const p = price({ lines: [pline('raffle', 3, 100, { vatRate: 0, eligible: false })], memberDiscountPercent: 15 });
    expect(p.memberDiscountPence).toBe(0);
    expect(p.totalPence).toBe(300);
  });

  it('no member attached means no discount', () => {
    const p = price({ lines: [pline('lager', 2, 450)], memberDiscountPercent: null });
    expect(p.memberDiscountPence).toBe(0);
  });

  it('sample data examples (D-098)', () => {
    const bottles = nForPrice('bottles', 2, 800, ['birdie', 'bogey']);
    // 2 x Birdie with a member: 800 x 15% = 120; total 680; VAT 113.33 -> 113.
    const p1 = price({ lines: [pline('birdie', 2, 450)], deals: [bottles], memberDiscountPercent: 15 });
    expect(figures(p1)).toEqual([{ gross: 900, deal: 100, member: 120, final: 680, vat: 113, net: 567 }]);
    // 2 x Birdie + 1 x Fairway Lager 480 with a member: base 1280 -> 192 (120 and 72).
    // Finals 680 (VAT 113) and 408 (VAT 68). Total 1088.
    const p2 = price({
      lines: [pline('birdie', 2, 450), pline('fairway', 1, 480)],
      deals: [bottles],
      memberDiscountPercent: 15,
    });
    expect(figures(p2)).toEqual([
      { gross: 900, deal: 100, member: 120, final: 680, vat: 113, net: 567 },
      { gross: 480, deal: 0, member: 72, final: 408, vat: 68, net: 340 },
    ]);
    expect(p2.totalPence).toBe(1088);
    expectConsistent(p2);
  });
});

describe('priceBasket: VAT (spec §7 step 5)', () => {
  it('a mixed basket: line totals match the basket total (D-021)', () => {
    // Lager 450 (VAT 75), Wine 2295 (VAT 383), Crisps x2 @125 at 0%. Total 2995.
    const p = price({
      lines: [pline('lager', 1, 450), pline('wine', 1, 2295), pline('crisps', 2, 125, { vatRate: 0 })],
    });
    expect(p.lines.map((l) => l.vatPence)).toEqual([75, 383, 0]);
    expect(p.totalPence).toBe(2995);
    expect(p.vatSummary).toEqual([
      { vatRate: 20, grossPence: 2745, vatPence: 458, netPence: 2287 },
      { vatRate: 0, grossPence: 250, vatPence: 0, netPence: 250 },
    ]);
    expectConsistent(p);
  });

  it('20% only and 0% only', () => {
    expect(price({ lines: [pline('wine', 1, 1250)] }).vatSummary).toEqual([
      { vatRate: 20, grossPence: 1250, vatPence: 208, netPence: 1042 },
    ]);
    expect(price({ lines: [pline('raffle', 5, 100, { vatRate: 0 })] }).vatSummary).toEqual([
      { vatRate: 0, grossPence: 500, vatPence: 0, netPence: 500 },
    ]);
  });

  it('sums line VAT per rate (two 2295 lines give 766, not 765)', () => {
    const p = price({ lines: [pline('wine', 1, 2295), pline('prosecco', 1, 2295)] });
    expect(p.vatSummary).toEqual([{ vatRate: 20, grossPence: 4590, vatPence: 766, netPence: 3824 }]);
  });
});

describe('priceBasket: deposit applied (spec §7 steps 4, 6; D-023)', () => {
  // Wine x4 @2295 = 9180, VAT 1530.
  const lines = [pline('wine', 4, 2295)];
  const vat = [{ vatRate: 20, grossPence: 9180, vatPence: 1530, netPence: 7650 }];

  it('a deposit smaller than the bill', () => {
    const p = price({ lines, depositBalancePence: 5000 });
    expect(p).toMatchObject({ subtotalPence: 9180, depositAppliedPence: 5000, totalPence: 4180, vatSummary: vat });
    expect(p.lines[0]).toMatchObject({ finalPence: 9180, vatPence: 1530 });
    expectConsistent(p);
  });

  it('a deposit equal to the bill', () => {
    const p = price({ lines, depositBalancePence: 9180 });
    expect(p).toMatchObject({ depositAppliedPence: 9180, totalPence: 0, vatSummary: vat });
  });

  it('a deposit larger than the bill: the bill goes to £0 and the rest stays on the booking', () => {
    const p = price({ lines, depositBalancePence: 10000 });
    expect(p).toMatchObject({ depositAppliedPence: 9180, totalPence: 0, vatSummary: vat });
    expect(10000 - p.depositAppliedPence).toBe(820);
  });

  it('applies after member discount and deals', () => {
    // Lager x3 3-for-2 + Crisps with a member = 977; balance 500 -> total 477.
    const p = price({
      lines: [pline('lager', 3, 450), pline('crisps', 2, 125, { vatRate: 0 })],
      deals: [nForM('lager3for2', 3, 2, ['lager'])],
      memberDiscountPercent: 15,
      depositBalancePence: 500,
    });
    expect(p).toMatchObject({ subtotalPence: 977, depositAppliedPence: 500, totalPence: 477 });
    expectConsistent(p);
  });
});

describe('depositApplied (D-023)', () => {
  it.each([
    [null, 9180, 0],
    [5000, 9180, 5000],
    [9180, 9180, 9180],
    [10000, 9180, 9180],
    [0, 9180, 0],
    [5000, 0, 0],
    [-100, 9180, 0],
  ])('balance %s on subtotal %i -> %i', (balance, subtotal, applied) => {
    expect(depositApplied(balance, subtotal)).toBe(applied);
  });
});

describe('toSaleLines (D-009)', () => {
  it('snapshots priced lines without refund fields or derived net', () => {
    const p = price({
      lines: [pline('lager', 3, 450, { name: 'Lager' }), pline('crisps', 2, 125, { vatRate: 0, name: 'Crisps' })],
      deals: [nForM('lager3for2', 3, 2, ['lager'])],
      memberDiscountPercent: 15,
    });
    const lines = toSaleLines(p);
    expect(lines).toEqual([
      {
        productId: 'lager',
        nameAtSale: 'Lager',
        qty: 3,
        unitPricePence: 450,
        vatRate: 20,
        dealDiscountPence: 450,
        memberDiscountPence: 135,
        finalPence: 765,
        vatPence: 128,
      },
      {
        productId: 'crisps',
        nameAtSale: 'Crisps',
        qty: 2,
        unitPricePence: 125,
        vatRate: 0,
        dealDiscountPence: 0,
        memberDiscountPence: 38,
        finalPence: 212,
        vatPence: 0,
      },
    ]);
    expect(Object.keys(lines[0]!)).not.toContain('refundOfLineIndex');
    expect(Object.keys(lines[0]!)).not.toContain('returnToStock');
  });
});
