import { describe, expect, it } from 'vitest';
import type { Deal } from '../../src/data/types';
import {
  MAX_PERMUTED_DEALS,
  applyDeals,
  canonicalDealOrder,
  compareUnits,
  evaluateDeal,
  expandUnits,
  isDealActiveAt,
  isDealWellFormed,
  type DealLineInput,
  type DealUnit,
} from '../../src/rules/deals';
import { AT, nForM, nForPrice } from './fixtures';

const T_DELETED = '2026-09-10T00:00:00.000Z';

const l = (productId: string, qty: number, unitPricePence: number): DealLineInput => ({ productId, qty, unitPricePence });
const u = (lineIndex: number, unitIndex: number, productId: string, pricePence: number): DealUnit => ({
  lineIndex,
  unitIndex,
  productId,
  pricePence,
});

describe('isDealActiveAt (D-012)', () => {
  const deal = nForPrice('d', 2, 800, ['lager']);

  it('applies an active deal with no dates', () => {
    expect(isDealActiveAt(deal, AT)).toBe(true);
  });

  it('never applies an inactive or soft-deleted deal', () => {
    expect(isDealActiveAt({ ...deal, active: false }, AT)).toBe(false);
    expect(isDealActiveAt({ ...deal, deletedAt: '2026-09-02T00:00:00.000Z' }, AT)).toBe(false);
  });

  it('has an inclusive start and an exclusive end', () => {
    // End date 30/09/2026 -> endsAt 2026-09-30T23:00:00.000Z.
    const windowed = { ...deal, startsAt: '2026-09-25T23:00:00.000Z', endsAt: '2026-09-30T23:00:00.000Z' };
    expect(isDealActiveAt(windowed, '2026-09-25T22:59:59.999Z')).toBe(false);
    expect(isDealActiveAt(windowed, '2026-09-25T23:00:00.000Z')).toBe(true);
    expect(isDealActiveAt(windowed, '2026-09-30T22:59:59.999Z')).toBe(true);
    expect(isDealActiveAt(windowed, '2026-09-30T23:00:00.000Z')).toBe(false);
  });

  it('throws RangeError for an invalid pricing instant', () => {
    expect(() => isDealActiveAt(deal, 'yesterday')).toThrow(RangeError);
  });
});

describe('expandUnits and compareUnits (D-014)', () => {
  it('expands lines in basket order', () => {
    expect(expandUnits([l('lager', 2, 450), l('bitter', 1, 420)])).toEqual([
      u(0, 0, 'lager', 450),
      u(0, 1, 'lager', 450),
      u(1, 0, 'bitter', 420),
    ]);
    expect(expandUnits([])).toEqual([]);
  });

  it('rejects invalid quantities or prices', () => {
    expect(() => expandUnits([l('x', -1, 100)])).toThrow(RangeError);
    expect(() => expandUnits([l('x', 1.5, 100)])).toThrow(RangeError);
    expect(() => expandUnits([l('x', 1, -100)])).toThrow(RangeError);
  });

  it('orders by price DESC, then line ASC, then unit ASC', () => {
    const units = [u(2, 0, 'c', 400), u(1, 1, 'b', 450), u(0, 0, 'a', 350), u(1, 0, 'b', 450), u(3, 0, 'd', 450)];
    expect([...units].sort(compareUnits)).toEqual([
      u(1, 0, 'b', 450),
      u(1, 1, 'b', 450),
      u(3, 0, 'd', 450),
      u(2, 0, 'c', 400),
      u(0, 0, 'a', 350),
    ]);
    expect(compareUnits(u(0, 0, 'a', 450), u(0, 0, 'a', 450))).toBe(0);
  });
});

describe('canonicalDealOrder (D-018)', () => {
  it('sorts by createdAt, then id by plain string comparison, without mutating', () => {
    const a = nForPrice('b-deal', 2, 800, ['x'], { createdAt: '2026-09-02T00:00:00.000Z' });
    const b = nForPrice('a-deal', 2, 800, ['x'], { createdAt: '2026-09-03T00:00:00.000Z' });
    const c = nForPrice('Z-deal', 2, 800, ['x'], { createdAt: '2026-09-02T00:00:00.000Z' });
    const input = [b, a, c];
    // 'Z' (0x5A) sorts before 'b' (0x62) in plain comparison.
    expect(canonicalDealOrder(input).map((d) => d.id)).toEqual(['Z-deal', 'b-deal', 'a-deal']);
    expect(input.map((d) => d.id)).toEqual(['a-deal', 'b-deal', 'Z-deal']);
  });
});

describe('evaluateDeal (D-014..D-016)', () => {
  it('nForPrice with equal prices: 2 for £8 on Lager x2 @450 saves 100, split 50/50', () => {
    const ev = evaluateDeal(nForPrice('d', 2, 800, ['lager']), expandUnits([l('lager', 2, 450)]));
    expect(ev.savingPence).toBe(100); // 900 - 800
    expect(ev.groups).toHaveLength(1);
    expect(ev.groups[0]).toMatchObject({ dealId: 'd', savingPence: 100, shares: [50, 50] });
  });

  it('leaves the cheapest, latest-added unit over (D-014)', () => {
    const ev = evaluateDeal(nForPrice('d', 2, 800, ['lager']), expandUnits([l('lager', 3, 450)]));
    expect(ev.groups).toHaveLength(1);
    expect(ev.groups[0]!.units).toEqual([u(0, 0, 'lager', 450), u(0, 1, 'lager', 450)]);
  });

  it('nForPrice with mixed prices: 3 for £10 on A 350, B 450, C 400', () => {
    const units = expandUnits([l('a', 1, 350), l('b', 1, 450), l('c', 1, 400)]);
    const ev = evaluateDeal(nForPrice('d', 3, 1000, ['a', 'b', 'c']), units);
    // Sorted B 450, C 400, A 350; saving 1200 - 1000 = 200.
    // Shares 200*450/1200 = 75, 200*400/1200 = 66.67 -> 67, 200*350/1200 = 58.33 -> 58.
    expect(ev.savingPence).toBe(200);
    expect(ev.groups[0]!.units.map((x) => x.productId)).toEqual(['b', 'c', 'a']);
    expect(ev.groups[0]!.shares).toEqual([75, 67, 58]);
  });

  it('does not apply a group that would raise the price (D-015)', () => {
    // 2 for £10 on Lager x2 @450: saving 900 - 1000 = -100.
    const ev = evaluateDeal(nForPrice('d', 2, 1000, ['lager']), expandUnits([l('lager', 2, 450)]));
    expect(ev).toMatchObject({ groups: [], savingPence: 0 });
  });

  it('does not apply a group whose saving is exactly 0', () => {
    const ev = evaluateDeal(nForPrice('d', 2, 900, ['lager']), expandUnits([l('lager', 2, 450)]));
    expect(ev.groups).toEqual([]);
  });

  it('stops at the first group that does not save (D-015 second-group example)', () => {
    // 3 for £10 on A x2 @500, B x2 @400, C x3 @200. Sorted 500,500,400,400,200,200,200.
    // Group 1 (500,500,400) = 1400 saves 400: shares 142.86 -> 143, 143, 114.29 -> 114.
    // Group 2 (400,200,200) = 800 saves -200: not applied.
    const units = expandUnits([l('a', 2, 500), l('b', 2, 400), l('c', 3, 200)]);
    const ev = evaluateDeal(nForPrice('d', 3, 1000, ['a', 'b', 'c']), units);
    expect(ev.savingPence).toBe(400);
    expect(ev.groups).toHaveLength(1);
    expect(ev.groups[0]!.shares).toEqual([143, 143, 114]);
  });

  it('nForM with mixed prices: 3 for 2 on A 500, B 400, C 300 (D-016)', () => {
    // Free unit = the cheapest (300). Spread over all three: 300*[500,400,300]/1200 = 125, 100, 75.
    const units = expandUnits([l('a', 1, 500), l('b', 1, 400), l('c', 1, 300)]);
    const ev = evaluateDeal(nForM('d', 3, 2, ['a', 'b', 'c']), units);
    expect(ev.savingPence).toBe(300);
    expect(ev.groups[0]!.shares).toEqual([125, 100, 75]);
  });

  it('nForM rounding case: A 450, B 420, C 390 (D-016)', () => {
    // Saving 390; 390*450/1260 = 139.29 -> 139; 390*420/1260 = 130; 390*390/1260 = 120.71 -> 121. Sum 390.
    const units = expandUnits([l('a', 1, 450), l('b', 1, 420), l('c', 1, 390)]);
    const ev = evaluateDeal(nForM('d', 3, 2, ['a', 'b', 'c']), units);
    expect(ev.groups[0]!.shares).toEqual([139, 130, 121]);
  });

  it('nForM with n - m = 2 free units: 4 for 2 on 500, 400, 300, 200', () => {
    // Free = 300 + 200 = 500. W = 1400: 178.57 -> 179, 142.86 -> 143, 107.14 -> 107, 71.43 -> 71. Sum 500.
    const units = expandUnits([l('a', 1, 500), l('b', 1, 400), l('c', 1, 300), l('d', 1, 200)]);
    const ev = evaluateDeal(nForM('d', 4, 2, ['a', 'b', 'c', 'd']), units);
    expect(ev.savingPence).toBe(500);
    expect(ev.groups[0]!.shares).toEqual([179, 143, 107, 71]);
  });

  it('handles zero-price units', () => {
    // 3 for 2 where the free unit costs 0: saving 0, not applied.
    const free = evaluateDeal(nForM('d', 3, 2, ['a', 'z']), expandUnits([l('a', 2, 300), l('z', 1, 0)]));
    expect(free.groups).toEqual([]);
    // 2 for £3 on 400 + 0: saving 100, all on the priced unit.
    const priced = evaluateDeal(nForPrice('d', 2, 300, ['a', 'z']), expandUnits([l('a', 1, 400), l('z', 1, 0)]));
    expect(priced.groups[0]!.shares).toEqual([100, 0]);
  });

  it('never applies an nForPrice deal priced above MAX_PRICE_PENCE (D-121)', () => {
    // If it applied: 2 x 999,999 - 1,000,000 = 999,998 saving.
    const lines = [l('magnum', 2, 999_999)];
    const deal = nForPrice('d', 2, 1_000_000, ['magnum']);
    expect(evaluateDeal(deal, expandUnits(lines)).groups).toEqual([]);
    expect(applyDeals(lines, [deal], AT).totalSavingPence).toBe(0);
  });

  it('ignores units the deal does not cover', () => {
    const ev = evaluateDeal(nForPrice('d', 2, 800, ['lager']), expandUnits([l('lager', 1, 450), l('bitter', 1, 420)]));
    expect(ev.groups).toEqual([]);
  });

  it.each<[string, Deal]>([
    ['n = 1', nForPrice('d', 1, 100, ['lager'])],
    ['n = 100', nForPrice('d', 100, 100, ['lager'])],
    ['fractional n', nForPrice('d', 2.5, 100, ['lager'])],
    ['nForPrice price 0', nForPrice('d', 2, 0, ['lager'])],
    ['nForPrice without a price', { ...nForPrice('d', 2, 800, ['lager']), pricePence: undefined }],
    ['nForM m = n', nForM('d', 2, 2, ['lager'])],
    ['nForM m = 0', nForM('d', 2, 0, ['lager'])],
    ['nForM without m', { ...nForM('d', 2, 1, ['lager']), m: undefined }],
  ])('never applies a deal with invalid parameters (%s, D-121)', (_label, deal) => {
    const units = expandUnits([l('lager', 4, 450)]);
    expect(evaluateDeal(deal, units)).toMatchObject({ groups: [], savingPence: 0 });
    expect(applyDeals([l('lager', 4, 450)], [deal], AT)).toEqual({ lineDealDiscounts: [0], dealLines: [], totalSavingPence: 0 });
  });
});

describe('applyDeals (D-017, D-018)', () => {
  it('returns zeros with no deals or an empty basket', () => {
    expect(applyDeals([l('lager', 2, 450)], [], AT)).toEqual({ lineDealDiscounts: [0], dealLines: [], totalSavingPence: 0 });
    expect(applyDeals([], [nForPrice('d', 2, 800, ['lager'])], AT)).toEqual({
      lineDealDiscounts: [],
      dealLines: [],
      totalSavingPence: 0,
    });
  });

  it('counts groups per deal line: 2 for £8 on Lager x5 @450 (D-017)', () => {
    const r = applyDeals([l('lager', 5, 450)], [nForPrice('d', 2, 800, ['lager'], { name: '2 for £8' })], AT);
    expect(r).toEqual({
      lineDealDiscounts: [200], // 2 groups x 100; 1 leftover
      dealLines: [{ dealId: 'd', name: '2 for £8', groupCount: 2, savingPence: 200 }],
      totalSavingPence: 200,
    });
  });

  it('an item eligible for two deals: the bigger saving wins (D-018 example)', () => {
    // Lager x1 @450, Bitter x3 @420.
    // A (created first) 'Any 2 pints £7': [A,B] -> (450,420) saves 170 + (420,420) saves 140 = 310.
    // B 'Bitter 3 for 2': [B,A] -> B saves 420; A has only the Lager left. 420 > 310.
    const A = nForPrice('A', 2, 700, ['lager', 'bitter'], { name: 'Any 2 pints £7', createdAt: '2026-09-01T00:00:00.000Z' });
    const B = nForM('B', 3, 2, ['bitter'], { name: 'Bitter 3 for 2', createdAt: '2026-09-02T00:00:00.000Z' });
    const lines = [l('lager', 1, 450), l('bitter', 3, 420)];
    const expected = {
      lineDealDiscounts: [0, 420], // 140 per Bitter unit
      dealLines: [{ dealId: 'B', name: 'Bitter 3 for 2', groupCount: 1, savingPence: 420 }],
      totalSavingPence: 420,
    };
    expect(applyDeals(lines, [A, B], AT)).toEqual(expected);
    expect(applyDeals(lines, [B, A], AT)).toEqual(expected);
  });

  it('breaks a tie in favour of the earliest canonical order (D-018)', () => {
    // Two identical 2 for £8 deals on Lager x2 @450 both save 100: credited to X (created first).
    const X = nForPrice('X', 2, 800, ['lager'], { createdAt: '2026-09-01T00:00:00.000Z' });
    const Y = nForPrice('Y', 2, 800, ['lager'], { createdAt: '2026-08-01T12:00:00.000Z' });
    const r1 = applyDeals([l('lager', 2, 450)], [X, { ...Y, createdAt: '2026-09-02T00:00:00.000Z' }], AT);
    expect(r1.dealLines.map((d) => d.dealId)).toEqual(['X']);
    // Y created earlier -> Y wins, whatever the input order.
    const r2 = applyDeals([l('lager', 2, 450)], [X, Y], AT);
    expect(r2.dealLines.map((d) => d.dealId)).toEqual(['Y']);
    // Same createdAt -> id ASC.
    const r3 = applyDeals([l('lager', 2, 450)], [nForPrice('b', 2, 800, ['lager']), nForPrice('a', 2, 800, ['lager'])], AT);
    expect(r3.dealLines.map((d) => d.dealId)).toEqual(['a']);
  });

  it('applies deals on different products together, listed in canonical order', () => {
    const bottles = nForPrice('bottles', 2, 800, ['birdie'], { createdAt: '2026-09-02T00:00:00.000Z' });
    const snacks = nForM('snacks', 3, 2, ['crisps'], { createdAt: '2026-09-01T00:00:00.000Z' });
    const r = applyDeals([l('birdie', 2, 450), l('crisps', 3, 120), l('choc', 1, 140)], [bottles, snacks], AT);
    // Birdie 900 - 800 = 100; crisps: one free packet = 120 (40 each).
    expect(r.lineDealDiscounts).toEqual([100, 120, 0]);
    expect(r.dealLines.map((d) => [d.dealId, d.savingPence])).toEqual([
      ['snacks', 120],
      ['bottles', 100],
    ]);
    expect(r.totalSavingPence).toBe(220);
  });

  it('leaves units of a failing group available to a later deal (D-015)', () => {
    // A: 3 for £10 on {a,b,c}; C: 3 for 2 on {c}. Basket A x2 @500, B x2 @400, C x3 @200.
    // [A,C]: A takes (500,500,400) saving 400; C takes the three 200s saving 200. Total 600.
    // [C,A]: C saves 200; A takes (500,500,400) saving 400. Also 600 -> identity order kept.
    const A = nForPrice('A', 3, 1000, ['a', 'b', 'c'], { createdAt: '2026-09-01T00:00:00.000Z' });
    const C = nForM('C', 3, 2, ['c'], { createdAt: '2026-09-02T00:00:00.000Z' });
    const r = applyDeals([l('a', 2, 500), l('b', 2, 400), l('c', 3, 200)], [A, C], AT);
    // A shares 143,143,114 -> line a 286, line b 114. C shares 200*[200,200,200]/600 -> 67,67,67 = 201, diff -1 -> 66,67,67.
    expect(r.lineDealDiscounts).toEqual([286, 114, 200]);
    expect(r.totalSavingPence).toBe(600);
  });

  it('skips inactive, deleted, expired and future deals', () => {
    const lines = [l('lager', 2, 450)];
    const deals = [
      nForPrice('inactive', 2, 800, ['lager'], { active: false }),
      nForPrice('deleted', 2, 800, ['lager'], { deletedAt: T_DELETED }),
      nForPrice('expired', 2, 800, ['lager'], { endsAt: AT }),
      nForPrice('future', 2, 800, ['lager'], { startsAt: '2026-09-26T13:05:12.346Z' }),
    ];
    expect(applyDeals(lines, deals, AT).dealLines).toEqual([]);
    // The window boundaries: startsAt === at applies.
    expect(applyDeals(lines, [nForPrice('starts', 2, 800, ['lager'], { startsAt: AT })], AT).totalSavingPence).toBe(100);
  });

  it('needs at least n qualifying units', () => {
    expect(applyDeals([l('crisps', 2, 120)], [nForM('d', 3, 2, ['crisps'])], AT).dealLines).toEqual([]);
  });

  it('tie-breaks equal prices across lines by line order', () => {
    // 2 for £8 on {lager, lager2}: units (0,0), (1,0), (1,1) all 450 -> group = (0,0),(1,0); (1,1) left over.
    const r = applyDeals([l('lager', 1, 450), l('lager2', 2, 450)], [nForPrice('d', 2, 800, ['lager', 'lager2'])], AT);
    expect(r.lineDealDiscounts).toEqual([50, 50]);
  });

  it('handles large quantities: Lager x999 @450 with 2 for £8', () => {
    const r = applyDeals([l('lager', 999, 450)], [nForPrice('d', 2, 800, ['lager'])], AT);
    // 499 groups x 100 = 49,900; one unit left over.
    expect(r.lineDealDiscounts).toEqual([49_900]);
    expect(r.dealLines[0]).toMatchObject({ groupCount: 499, savingPence: 49_900 });
  });

  describe('search strategy', () => {
    // Basket P x2 @500, Q x2 @500, plus R1..R5 x2 @100 for filler deals.
    // X: 4 for £12 on {p,q} saves 2000 - 1200 = 800.
    // Y: 2 for £5 on {p} saves 500; Z: 2 for £5 on {q} saves 500. Optimal is Y + Z = 1000 > 800.
    // Each filler Fi: 2 for £1.50 on {ri} saves 50.
    const created = (day: number) => ({ createdAt: `2026-09-0${day}T00:00:00.000Z` });
    const X = nForPrice('X', 4, 1200, ['p', 'q'], created(1));
    const Y = nForPrice('Y', 2, 500, ['p'], created(2));
    const Z = nForPrice('Z', 2, 500, ['q'], created(3));
    const fillers = [1, 2, 3, 4].map((i) => nForPrice(`F${i}`, 2, 150, [`r${i}`], created(4 + i)));
    const lines = [l('p', 2, 500), l('q', 2, 500), ...[1, 2, 3, 4].map((i) => l(`r${i}`, 2, 100))];

    it(`is exhaustive with up to ${MAX_PERMUTED_DEALS} candidates`, () => {
      const deals = [X, Y, Z, ...fillers.slice(0, 3)]; // 6 candidates
      const r = applyDeals(lines, deals, AT);
      expect(r.dealLines.map((d) => d.dealId)).toEqual(['Y', 'Z', 'F1', 'F2', 'F3']);
      expect(r.totalSavingPence).toBe(1000 + 3 * 50);
      expect(r.lineDealDiscounts).toEqual([500, 500, 50, 50, 50, 0]);
    });

    it('is greedy above that', () => {
      const deals = [X, Y, Z, ...fillers]; // 7 candidates
      const r = applyDeals(lines, deals, AT);
      // Greedy takes X (800) first; Y and Z then find nothing.
      expect(r.dealLines.map((d) => d.dealId)).toEqual(['X', 'F1', 'F2', 'F3', 'F4']);
      expect(r.totalSavingPence).toBe(800 + 4 * 50);
      // X spreads 800 over four 500 units: 200 each.
      expect(r.lineDealDiscounts).toEqual([400, 400, 50, 50, 50, 50]);
    });

    it('does not count a deal without enough qualifying units as a candidate', () => {
      // Seven deals, but one has only 1 qualifying unit, so 6 candidates -> exhaustive.
      const orphan = nForPrice('O', 2, 100, ['nothing-here'], created(9));
      const r = applyDeals(lines, [X, Y, Z, ...fillers.slice(0, 3), orphan], AT);
      expect(r.dealLines.map((d) => d.dealId)).toEqual(['Y', 'Z', 'F1', 'F2', 'F3']);
    });
  });

  it('throws RangeError for an invalid pricing instant', () => {
    expect(() => applyDeals([l('lager', 2, 450)], [nForPrice('d', 2, 800, ['lager'])], 'nope')).toThrow(RangeError);
  });
});


describe('applyDeals matches a literal reference implementation of D-018', () => {
  /** Permutations of 0..k-1 in lexicographic order (identity first). */
  function permutations(k: number): number[][] {
    if (k === 0) return [[]];
    const out: number[][] = [];
    const walk = (prefix: number[], rest: number[]) => {
      if (rest.length === 0) out.push(prefix);
      rest.forEach((x, i) => walk([...prefix, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    walk([], Array.from({ length: k }, (_, i) => i));
    return out;
  }

  /** D-018 read literally: evaluate every order with the public evaluateDeal, keep the first strictly best. */
  function reference(lines: DealLineInput[], deals: Deal[]) {
    const units = expandUnits(lines);
    const key = (x: DealUnit) => `${x.lineIndex}:${x.unitIndex}`;
    const candidates = canonicalDealOrder(deals.filter((d) => isDealActiveAt(d, AT) && isDealWellFormed(d))).filter(
      (d) => units.filter((x) => d.productIds.includes(x.productId)).length >= d.n,
    );
    let best: ReturnType<typeof evaluateDeal>[] = [];
    let bestTotal = -1;
    for (const order of permutations(candidates.length)) {
      let available = units;
      const evaluations = order.map((i) => {
        const ev = evaluateDeal(candidates[i]!, available);
        const used = new Set(ev.groups.flatMap((g) => g.units.map(key)));
        available = available.filter((x) => !used.has(key(x)));
        return ev;
      });
      const total = evaluations.reduce((a, ev) => a + ev.savingPence, 0);
      if (total > bestTotal) {
        bestTotal = total;
        best = evaluations;
      }
    }
    const lineDealDiscounts = lines.map(() => 0);
    for (const ev of best) {
      for (const g of ev.groups) g.units.forEach((x, i) => (lineDealDiscounts[x.lineIndex] = (lineDealDiscounts[x.lineIndex] ?? 0) + (g.shares[i] ?? 0)));
    }
    const dealLines = candidates.flatMap((d) => {
      const ev = best.find((e) => e.deal.id === d.id && e.groups.length > 0);
      return ev ? [{ dealId: d.id, name: d.name, groupCount: ev.groups.length, savingPence: ev.savingPence }] : [];
    });
    return { lineDealDiscounts, dealLines, totalSavingPence: dealLines.reduce((a, d) => a + d.savingPence, 0) };
  }

  /** mulberry32: a small deterministic PRNG (test inputs only; no money maths). */
  function prng(seed: number): (n: number) => number {
    let a = seed;
    return (n: number) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
  }

  it('on 400 seeded random baskets with overlapping deals, zero-price and 1p items', () => {
    const rand = prng(20260926);
    const products = ['a', 'b', 'c', 'd', 'e'];
    const prices = [0, 1, 99, 120, 350, 420, 450, 2295];
    let applied = 0;
    for (let c = 0; c < 400; c += 1) {
      const lines = products.filter(() => rand(3) > 0).map((p) => l(p, 1 + rand(6), prices[rand(prices.length)] ?? 0));
      const deals = Array.from({ length: 1 + rand(5) }, (_, i) => {
        const ids = products.filter(() => rand(2) === 0);
        const n = 2 + rand(3);
        const extras = { createdAt: `2026-09-0${1 + rand(3)}T00:00:00.000Z`, name: `deal ${i}` };
        return rand(2) === 0 ? nForPrice(`d${rand(10)}${i}`, n, 1 + rand(1500), ids, extras) : nForM(`d${rand(10)}${i}`, n, 1 + rand(n - 1), ids, extras);
      });
      const actual = applyDeals(lines, deals, AT);
      expect(actual).toEqual(reference(lines, deals));
      if (actual.dealLines.length > 1) applied += 1;
    }
    // The generator really does exercise overlapping multi-deal baskets.
    expect(applied).toBeGreaterThan(20);
  });
});
