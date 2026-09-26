/**
 * Property / invariant tests for the pure rules (spec §7, §6.4, §6.8, §6.11; D-001..D-045).
 *
 * Every property runs RUNS (500) random cases from a seeded mulberry32 PRNG. Each case has its own
 * seed, derived from the property's fixed base seed and the case index, so a failure names the seed,
 * the generated input and any choices made while checking (the trace). Re-running the generator with
 * makeRng(<case seed>) reproduces the case exactly.
 *
 * Expected figures are recomputed here with an independent BigInt round-half-up (never by calling the
 * helper under test), and every assertion is to the penny.
 */
import { describe, expect, it } from 'vitest';
import type { AuditEvent, Category, Deal, NewSale, Period, Product, Sale, SaleLine, TenderType } from '../../src/data/types';
import { periodFigures, type PeriodFigures } from '../../src/rules/cashup';
import {
  MAX_PERMUTED_DEALS,
  applyDeals,
  canonicalDealOrder,
  evaluateDeal,
  expandUnits,
  isDealActiveAt,
  isDealWellFormed,
  type DealLineInput,
  type DealUnit,
  type DealsResult,
} from '../../src/rules/deals';
import { priceBasket, toSaleLines, type PricedBasket, type PricingInput, type PricingLine } from '../../src/rules/pricing';
import { buildRefundSale, refundableQuantities, refundedQuantities, type RefundRequestLine } from '../../src/rules/refund';
import { productSalesReport, vatReport } from '../../src/rules/reports';
import { validateSale } from '../../src/rules/sale';
import { stockMovementsForSale } from '../../src/rules/stock';
import { QUICK_CASH_PENCE, applyTender, startTendering, tenderSequenceProblems, type TenderRequest, type TenderState } from '../../src/rules/tender';
import { localDateRange } from '../../src/rules/time';

// ---------------------------------------------------------------------------
// Seeded PRNG and the property runner
// ---------------------------------------------------------------------------

const RUNS = 500;

/** mulberry32: a small, fast 32-bit PRNG; the same seed always gives the same stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  readonly seed: number;
  /** [0, 1) */
  next(): number;
  /** Integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number;
  bool(p?: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (items.length === 0 || item === undefined) throw new Error('pick() from an empty list');
    return item;
  };
  return {
    seed,
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick,
    weighted: <T,>(entries: readonly (readonly [T, number])[]): T => {
      const totalWeight = entries.reduce((a, [, w]) => a + w, 0);
      let roll = next() * totalWeight;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll < 0) return value;
      }
      const last = entries[entries.length - 1];
      if (last === undefined) throw new Error('weighted() from an empty list');
      return last[0];
    },
    shuffle: <T,>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        const a = copy[i] as T;
        copy[i] = copy[j] as T;
        copy[j] = a;
      }
      return copy;
    },
  };
}

/** A distinct, reproducible seed per case. */
function caseSeed(baseSeed: number, index: number): number {
  return (Math.imul(baseSeed ^ 0x5bd1e995, 0x01000193) + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}

type Trace = (label: string, value: unknown) => void;

/**
 * Runs `check` on RUNS generated inputs. `check` may draw further choices from `rng` (the same
 * deterministic stream) and should record them with `trace` so a failure prints them.
 */
function forAll<T>(
  label: string,
  baseSeed: number,
  generate: (rng: Rng) => T,
  check: (input: T, rng: Rng, trace: Trace) => void,
  runs = RUNS,
): void {
  for (let index = 0; index < runs; index += 1) {
    const seed = caseSeed(baseSeed, index);
    const rng = makeRng(seed);
    const input = generate(rng);
    const traced: unknown[] = [];
    try {
      check(input, rng, (name, value) => traced.push({ [name]: value }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          `Property "${label}" failed on case ${index} of ${runs} (base seed ${baseSeed}, case seed ${seed}).`,
          `Reproduce with the generator on makeRng(${seed}).`,
          `Input: ${JSON.stringify(input)}`,
          ...(traced.length > 0 ? [`Trace: ${JSON.stringify(traced)}`] : []),
          `Reason: ${reason}`,
        ].join('\n'),
        { cause: error },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Independent reference maths (BigInt round half up, D-002)
// ---------------------------------------------------------------------------

function rhu(num: bigint, den: bigint): bigint {
  const negative = num < 0n;
  const a = negative ? -num : num;
  let q = a / den;
  if (2n * (a % den) >= den) q += 1n;
  return negative ? -q : q;
}

/** round-half-up(a * b / den) as a Number (never -0). */
function mulDivRhu(a: number, b: number, den: number): number {
  const value = Number(rhu(BigInt(a) * BigInt(b), BigInt(den)));
  return value === 0 ? 0 : value;
}

/** p === 0 ? 0 : -p (so expected values are never -0). */
const neg = (p: number): number => (p === 0 ? 0 : -p);
const sum = (values: readonly number[]): number => values.reduce((a, v) => a + v, 0);

/** Every number anywhere inside `value` must be a safe integer and never -0 (D-001, D-003). */
function expectAllIntegers(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error(`${path} = ${String(value)} is not an integer (or is -0)`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => expectAllIntegers(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) expectAllIntegers(item, `${path}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const DEVICE = 'device-1';
const AT = '2026-09-26T13:05:12.345Z';
const PRODUCT_POOL = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] as const;
/** Real-looking prices, with many repeats so ties in the deal sort order are common. */
const COMMON_PRICES = [0, 100, 120, 125, 150, 220, 250, 380, 400, 420, 450, 480, 500, 550, 1500, 1900, 2295, 2600];
const DEAL_CREATED = ['2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z', '2026-09-03T09:00:00.000Z'];
const HOUR = 3_600_000;

function genPrice(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.pick(COMMON_PRICES), 45],
    [() => rng.int(1, 3000), 40],
    [() => rng.int(3000, 100_000), 10],
    [() => rng.int(100_000, 999_999), 5],
  ])();
}

function genVatRate(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => 20, 60],
    [() => 0, 25],
    [() => 5, 10],
    [() => rng.int(0, 100), 5],
  ])();
}

function genQty(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.int(1, 4), 60],
    [() => rng.int(5, 12), 30],
    [() => rng.int(13, 40), 9],
    [() => rng.int(41, 999), 1],
  ])();
}

function genLines(rng: Rng, maxLines = 6): PricingLine[] {
  const count = rng.weighted([
    [1, 20],
    [2, 25],
    [3, 25],
    [4, 15],
    [5, 10],
    [6, 5],
  ] as const);
  return rng
    .shuffle(PRODUCT_POOL)
    .slice(0, Math.min(count, maxLines))
    .map((productId) => ({
      productId,
      name: `Product ${productId}`,
      qty: genQty(rng),
      unitPricePence: genPrice(rng),
      vatRate: genVatRate(rng),
      memberDiscountEligible: rng.bool(0.75),
    }));
}

function genDeal(rng: Rng, index: number, lines: readonly PricingLine[]): Deal {
  const inBasket = new Set(lines.map((l) => l.productId));
  let productIds: string[] = PRODUCT_POOL.filter((id) => rng.bool(inBasket.has(id) ? 0.6 : 0.15));
  if (productIds.length === 0) productIds = [rng.pick(lines.length > 0 ? lines.map((l) => l.productId) : [...PRODUCT_POOL])];
  const n = rng.weighted<() => number>([
    [() => 2, 45],
    [() => 3, 35],
    [() => rng.int(4, 5), 15],
    [() => rng.int(6, 12), 5],
  ])();
  const type = rng.bool() ? 'nForPrice' : 'nForM';
  const covered = lines.filter((l) => productIds.includes(l.productId));
  const typical = covered.length > 0 ? rng.pick(covered).unitPricePence : genPrice(rng);
  const price = Math.max(1, Math.min(999_999, Math.floor((n * Math.max(typical, 1) * rng.int(30, 115)) / 100)));
  const base = {
    id: `deal-${String.fromCharCode(97 + rng.int(0, 25))}${index}`,
    deviceId: DEVICE,
    createdAt: rng.pick(DEAL_CREATED),
    updatedAt: rng.pick(DEAL_CREATED),
    name: `Deal ${index}`,
    n,
    productIds,
    active: rng.bool(0.92),
  };
  let deal: Deal =
    type === 'nForPrice' ? { ...base, type, pricePence: price } : { ...base, type, m: rng.int(1, n - 1) };
  if (rng.bool(0.15)) {
    // Validity windows around AT, including both boundaries (start inclusive, end exclusive; D-012).
    const atMs = Date.parse(AT);
    const start = rng.pick([atMs - 5 * HOUR, atMs, atMs + 1, atMs + HOUR]);
    const end = rng.pick([atMs, atMs + 1, atMs + 5 * HOUR, atMs - 1]);
    deal = {
      ...deal,
      ...(rng.bool() ? { startsAt: new Date(start).toISOString() } : {}),
      ...(rng.bool() ? { endsAt: new Date(end).toISOString() } : {}),
    };
  }
  if (rng.bool(0.03)) {
    // Malformed parameters must be ignored by pricing, never thrown on (D-121).
    deal = rng.pick<Deal>([
      { ...deal, n: 1 },
      { ...base, type: 'nForPrice', pricePence: 0 },
      { ...base, type: 'nForPrice', pricePence: 1_000_000 },
      { ...base, type: 'nForM', m: n },
      { ...base, type: 'nForM' },
      { ...deal, n: 2.5 },
    ]);
  }
  return deal;
}

function genDeals(rng: Rng, lines: readonly PricingLine[]): Deal[] {
  const count = rng.weighted<() => number>([
    [() => 0, 10],
    [() => 1, 25],
    [() => 2, 25],
    [() => 3, 15],
    [() => rng.int(4, 6), 20],
    [() => rng.int(7, 9), 5],
  ])();
  return Array.from({ length: count }, (_, i) => genDeal(rng, i, lines));
}

function genMemberPercent(rng: Rng): number | null {
  return rng.weighted<() => number | null>([
    [() => null, 40],
    [() => 15, 35],
    [() => 100, 5],
    [() => rng.int(0, 100), 20],
  ])();
}

function genBalance(rng: Rng, lines: readonly PricingLine[]): number | null {
  const gross = sum(lines.map((l) => l.qty * l.unitPricePence));
  return rng.weighted<() => number | null>([
    [() => null, 55],
    [() => 0, 5],
    [() => rng.int(1, Math.max(1, gross)), 15],
    [() => gross, 5],
    [() => rng.int(gross, 2 * gross + 1), 15],
    [() => 9_999_999, 5],
  ])();
}

function genPricingInput(rng: Rng): PricingInput {
  const lines = genLines(rng);
  return { lines, deals: genDeals(rng, lines), at: AT, memberDiscountPercent: genMemberPercent(rng), depositBalancePence: genBalance(rng, lines) };
}

// ---------------------------------------------------------------------------
// Tender intents: data generated up front, resolved against the remaining balance
// ---------------------------------------------------------------------------

type TenderIntent =
  | { type: 'card'; mode: 'full' }
  | { type: 'card'; mode: 'part'; percent: number }
  | { type: 'cash'; mode: 'quick'; pence: number }
  | { type: 'cash'; mode: 'exact' }
  | { type: 'cash'; mode: 'amount'; pence: number };

function genIntent(rng: Rng): TenderIntent {
  return rng.weighted<() => TenderIntent>([
    [() => ({ type: 'card', mode: 'full' }), 12],
    [() => ({ type: 'card', mode: 'part', percent: rng.pick([0, 1, 10, 50, 99, 100, 101, 150, 400]) }), 25],
    [() => ({ type: 'cash', mode: 'quick', pence: rng.pick(QUICK_CASH_PENCE) }), 25],
    [() => ({ type: 'cash', mode: 'exact' }), 10],
    [() => ({ type: 'cash', mode: 'amount', pence: rng.weighted<() => number>([[() => 0, 1], [() => rng.int(1, 999), 5], [() => rng.int(1000, 60_000), 4]])() }), 28],
  ])();
}

const genIntents = (rng: Rng): TenderIntent[] => Array.from({ length: rng.int(1, 12) }, () => genIntent(rng));

function resolveIntent(intent: TenderIntent, remaining: number): TenderRequest {
  switch (intent.mode) {
    case 'full':
      return { type: 'card', amountPence: null };
    case 'part':
      return { type: 'card', amountPence: Math.floor((remaining * intent.percent) / 100) };
    case 'quick':
    case 'amount':
      return { type: 'cash', amountPence: intent.pence };
    case 'exact':
      return { type: 'cash', amountPence: remaining };
  }
}

/** Applies the intents in order (skipping rejections), then settles any remainder by card. */
function tenderToCompletion(totalPence: number, intents: readonly TenderIntent[]): TenderState {
  let state = startTendering(totalPence);
  for (const intent of intents) {
    if (state.complete) break;
    const outcome = applyTender(state, resolveIntent(intent, state.remainingPence));
    if (outcome.ok) state = outcome.state;
  }
  if (!state.complete) {
    const outcome = applyTender(state, { type: 'card', amountPence: null });
    if (!outcome.ok) throw new Error(`Card for the remaining balance was rejected: ${outcome.message}`);
    state = outcome.state;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Sale builders
// ---------------------------------------------------------------------------

function newSaleFrom(priced: PricedBasket, input: PricingInput, tender: TenderState): NewSale {
  return {
    staffId: 'staff-1',
    kind: 'sale',
    ...(input.memberDiscountPercent === null ? {} : { memberId: 'member-1' }),
    ...(input.depositBalancePence === null ? {} : { bookingId: 'booking-1' }),
    lines: toSaleLines(priced),
    dealLines: priced.dealLines,
    memberDiscountPence: priced.memberDiscountPence,
    depositAppliedPence: priced.depositAppliedPence,
    totalPence: priced.totalPence,
    tenders: tender.tenders,
    changePence: tender.changePence,
  };
}

function stored(sale: NewSale, id: string, periodId: string, createdAt: string): Sale {
  return { ...sale, id, deviceId: DEVICE, createdAt, updatedAt: createdAt, periodId, receiptNumber: `3F9C-${id}` };
}

// ---------------------------------------------------------------------------
// Deal helpers
// ---------------------------------------------------------------------------

function nForPriceDeal(id: string, n: number, pricePence: number, productIds: string[]): Deal {
  const createdAt = '2026-09-01T09:00:00.000Z';
  return { id, deviceId: DEVICE, createdAt, updatedAt: createdAt, name: id, type: 'nForPrice', n, pricePence, productIds, active: true };
}

const unitKey = (unit: DealUnit): string => `${unit.lineIndex}:${unit.unitIndex}`;

function qualifyingCount(deal: Deal, lines: readonly DealLineInput[]): number {
  const covered = new Set(deal.productIds);
  return sum(lines.filter((l) => covered.has(l.productId)).map((l) => l.qty));
}

/** Deals that could apply at AT: active, well formed and with >= n qualifying units (D-018, D-121). */
function candidateDeals(deals: readonly Deal[], lines: readonly DealLineInput[]): Deal[] {
  return canonicalDealOrder(deals.filter((d) => isDealActiveAt(d, AT) && isDealWellFormed(d) && qualifyingCount(d, lines) >= d.n));
}

/** Total saving when the deals are applied one after another, each on the units left over. */
function sequentialSaving(order: readonly Deal[], units: readonly DealUnit[]): number {
  let available = [...units];
  let total = 0;
  for (const deal of order) {
    const evaluation = evaluateDeal(deal, available);
    const taken = new Set(evaluation.groups.flatMap((g) => g.units.map(unitKey)));
    available = available.filter((u) => !taken.has(unitKey(u)));
    total += evaluation.savingPence;
  }
  return total;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/**
 * Searches for an order of the APPLIED deals in which applying each (evaluateDeal on the units not
 * yet used) reproduces its deal line exactly and, in the end, every line's deal discount. Units are
 * removed once used, so a witness proves each unit counts towards at most one deal (spec §7.2).
 */
function disjointAssignmentWitness(lines: readonly DealLineInput[], deals: readonly Deal[], result: DealsResult): boolean {
  const byId = new Map(deals.map((d) => [d.id, d]));
  const applied = result.dealLines.map((dealLine) => ({ dealLine, deal: byId.get(dealLine.dealId) }));
  const used = applied.map(() => false);
  const search = (available: readonly DealUnit[], discounts: readonly number[], depth: number): boolean => {
    if (depth === applied.length) return discounts.every((d, i) => d === result.lineDealDiscounts[i]);
    for (let i = 0; i < applied.length; i += 1) {
      const entry = applied[i];
      if (used[i] || entry === undefined || entry.deal === undefined) continue;
      const evaluation = evaluateDeal(entry.deal, available);
      if (evaluation.savingPence !== entry.dealLine.savingPence || evaluation.groups.length !== entry.dealLine.groupCount) continue;
      const taken = new Set<string>();
      const next = [...discounts];
      let clash = false;
      for (const group of evaluation.groups) {
        if (group.units.length !== entry.deal.n || sum(group.shares) !== group.savingPence) clash = true;
        group.units.forEach((unit, j) => {
          if (taken.has(unitKey(unit))) clash = true;
          taken.add(unitKey(unit));
          next[unit.lineIndex] = (next[unit.lineIndex] ?? 0) + (group.shares[j] ?? 0);
        });
      }
      if (clash) continue;
      used[i] = true;
      const found = search(
        available.filter((u) => !taken.has(unitKey(u))),
        next,
        depth + 1,
      );
      used[i] = false;
      if (found) return true;
    }
    return false;
  };
  return search(expandUnits(lines), lines.map(() => 0), 0);
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('pricing invariants (spec §7; D-010, D-017, D-020, D-021, D-023)', () => {
  it('every figure is an integer and each line is gross - deal - member = final = VAT + net', () => {
    forAll('pricing arithmetic', 0x5eed0001, genPricingInput, (input) => {
      const priced = priceBasket(input);
      expectAllIntegers(priced);
      expect(priced.lines).toHaveLength(input.lines.length);
      priced.lines.forEach((line, i) => {
        const source = input.lines[i];
        if (source === undefined) throw new Error('missing source line');
        expect(line.productId, `line ${i} productId`).toBe(source.productId);
        expect(line.grossPence, `line ${i} gross`).toBe(source.qty * source.unitPricePence);
        expect(line.finalPence, `line ${i} final`).toBe(line.grossPence - line.dealDiscountPence - line.memberDiscountPence);
        expect(line.vatPence, `line ${i} VAT`).toBe(mulDivRhu(line.finalPence, line.vatRate, 100 + line.vatRate));
        expect(line.vatPence + line.netPence, `line ${i} VAT + net`).toBe(line.finalPence);
        expect(line.finalPence, `line ${i} final >= 0`).toBeGreaterThanOrEqual(0);
      });
      expect(priced.grossPence).toBe(sum(priced.lines.map((l) => l.grossPence)));
      expect(priced.dealDiscountPence).toBe(sum(priced.lines.map((l) => l.dealDiscountPence)));
      expect(priced.memberDiscountPence).toBe(sum(priced.lines.map((l) => l.memberDiscountPence)));
      expect(priced.subtotalPence).toBe(sum(priced.lines.map((l) => l.finalPence)));
      expect(priced.subtotalPence - priced.depositAppliedPence, 'sum of finals - deposit applied = total').toBe(priced.totalPence);
      expect(priced.grossPence - priced.dealDiscountPence - priced.memberDiscountPence).toBe(priced.subtotalPence);
      expect(sum(priced.dealLines.map((d) => d.savingPence)), 'deal lines sum to the line deal discounts').toBe(priced.dealDiscountPence);

      // VAT summary: one row per rate present, rate DESC, summing the line figures (D-021).
      const byRate = new Map<number, { gross: number; vat: number }>();
      for (const line of priced.lines) {
        const row = byRate.get(line.vatRate) ?? { gross: 0, vat: 0 };
        byRate.set(line.vatRate, { gross: row.gross + line.finalPence, vat: row.vat + line.vatPence });
      }
      const expectedRows = [...byRate.entries()]
        .sort(([a], [b]) => b - a)
        .map(([vatRate, r]) => ({ vatRate, grossPence: r.gross, vatPence: r.vat, netPence: r.gross - r.vat }));
      expect(priced.vatSummary).toEqual(expectedRows);
    });
  });

  it('0 <= deal discount <= gross per line and per basket, and member discount fits in what is left', () => {
    forAll('discount bounds', 0x5eed0002, genPricingInput, (input) => {
      const priced = priceBasket(input);
      priced.lines.forEach((line, i) => {
        expect(line.dealDiscountPence, `line ${i} deal >= 0`).toBeGreaterThanOrEqual(0);
        expect(line.dealDiscountPence, `line ${i} deal <= gross`).toBeLessThanOrEqual(line.grossPence);
        expect(line.memberDiscountPence, `line ${i} member >= 0`).toBeGreaterThanOrEqual(0);
        expect(line.memberDiscountPence, `line ${i} member <= gross - deal`).toBeLessThanOrEqual(line.grossPence - line.dealDiscountPence);
      });
      expect(priced.dealDiscountPence).toBeGreaterThanOrEqual(0);
      expect(priced.dealDiscountPence).toBeLessThanOrEqual(priced.grossPence);
    });
  });

  it('member discount = round-half-up(base x pct / 100), spread over eligible lines only and summing exactly', () => {
    forAll('member discount', 0x5eed0003, genPricingInput, (input) => {
      const priced = priceBasket(input);
      const pct = input.memberDiscountPercent;
      const eligible = priced.lines.filter((l) => l.memberDiscountEligible);
      const base = sum(eligible.map((l) => l.grossPence - l.dealDiscountPence));
      const expected = pct === null ? 0 : mulDivRhu(base, pct, 100);
      expect(priced.memberDiscountPence, `round-half-up(${base} x ${String(pct)} / 100)`).toBe(expected);
      expect(sum(priced.lines.map((l) => l.memberDiscountPence)), 'lines sum to the sale member discount').toBe(expected);
      priced.lines.forEach((line, i) => {
        if (!line.memberDiscountEligible || pct === null) {
          expect(line.memberDiscountPence, `line ${i} gets no member discount`).toBe(0);
          return;
        }
        // Proportional spread (D-020): each share is within k pence of its exact share, k = eligible lines.
        const postDeal = line.grossPence - line.dealDiscountPence;
        if (base > 0) {
          const error = BigInt(line.memberDiscountPence) * BigInt(base) - BigInt(expected) * BigInt(postDeal);
          const absError = error < 0n ? -error : error;
          expect(absError <= BigInt(eligible.length) * BigInt(base), `line ${i} share ${line.memberDiscountPence} is proportional`).toBe(true);
        }
      });
    });
  });

  it('deposit applied = min(balance, total after discounts) and the total is never negative', () => {
    forAll('deposit applied', 0x5eed0004, genPricingInput, (input) => {
      const priced = priceBasket(input);
      const balance = input.depositBalancePence;
      const expected = balance === null ? 0 : Math.min(balance, priced.subtotalPence);
      expect(priced.depositAppliedPence).toBe(expected);
      expect(priced.totalPence).toBe(priced.subtotalPence - expected);
      expect(priced.totalPence).toBeGreaterThanOrEqual(0);
      // The deposit is sale-level only: line figures and VAT are the same as without a booking.
      const withoutBooking = priceBasket({ ...input, depositBalancePence: null });
      expect(priced.lines).toEqual(withoutBooking.lines);
      expect(priced.vatSummary).toEqual(withoutBooking.vatSummary);
    });
  });
});

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

describe('deal invariants (spec §7.2; D-014..D-018, D-121)', () => {
  it('deals never raise a price, and every deal line is a real, applicable deal in canonical order', () => {
    forAll('deals never raise a price', 0x5eed0101, genPricingInput, (input) => {
      const withDeals = priceBasket(input);
      const noDeals = priceBasket({ ...input, deals: [] });
      withDeals.lines.forEach((line, i) => {
        expect(line.grossPence - line.dealDiscountPence, `line ${i} post-deal <= gross`).toBeLessThanOrEqual(line.grossPence);
      });
      expect(withDeals.subtotalPence, 'subtotal with deals <= without').toBeLessThanOrEqual(noDeals.subtotalPence);
      expect(withDeals.totalPence, 'total with deals <= without').toBeLessThanOrEqual(noDeals.totalPence);

      const canonical = canonicalDealOrder(input.deals).map((d) => d.id);
      let lastPosition = -1;
      const seen = new Set<string>();
      for (const dealLine of withDeals.dealLines) {
        const deal = input.deals.find((d) => d.id === dealLine.dealId);
        expect(deal, `deal line ${dealLine.dealId} refers to an input deal`).toBeDefined();
        if (deal === undefined) continue;
        expect(isDealActiveAt(deal, AT) && isDealWellFormed(deal), `${deal.id} is active and well formed`).toBe(true);
        expect(seen.has(deal.id), `${deal.id} appears once`).toBe(false);
        seen.add(deal.id);
        const position = canonical.indexOf(deal.id);
        expect(position, 'deal lines are in canonical order').toBeGreaterThan(lastPosition);
        lastPosition = position;
        expect(dealLine.savingPence).toBeGreaterThanOrEqual(1);
        expect(dealLine.groupCount).toBeGreaterThanOrEqual(1);
        expect(dealLine.groupCount * deal.n, `${deal.id} uses no more units than qualify`).toBeLessThanOrEqual(qualifyingCount(deal, input.lines));
        expect(dealLine.name).toBe(deal.name);
      }
    });
  });

  it('each unit is used by at most one deal (a disjoint assignment reproduces every figure)', () => {
    forAll('each unit used once', 0x5eed0102, genPricingInput, (input) => {
      const result = applyDeals(input.lines, input.deals, AT);
      expect(sum(result.lineDealDiscounts)).toBe(result.totalSavingPence);
      expect(sum(result.dealLines.map((d) => d.savingPence))).toBe(result.totalSavingPence);
      expect(disjointAssignmentWitness(input.lines, input.deals, result), 'a disjoint unit assignment reproduces the result').toBe(true);
    });
  });

  it('the overlapping-deal choice is at least as good as any single deal alone, and as any order (<= 6 candidates)', () => {
    forAll('overlap choice is optimal', 0x5eed0103, genPricingInput, (input, rng, trace) => {
      const result = applyDeals(input.lines, input.deals, AT);
      const units = expandUnits(input.lines);
      for (const deal of input.deals.filter((d) => isDealActiveAt(d, AT))) {
        const alone = evaluateDeal(deal, units).savingPence;
        expect(alone, `${deal.id} alone saves ${alone}`).toBeLessThanOrEqual(result.totalSavingPence);
      }
      const candidates = candidateDeals(input.deals, input.lines);
      if (candidates.length === 0) {
        expect(result.totalSavingPence).toBe(0);
        return;
      }
      if (candidates.length > MAX_PERMUTED_DEALS) return; // greedy: only the single-deal bound is promised
      const orders = candidates.length <= 5 ? permutations(candidates) : Array.from({ length: 40 }, () => rng.shuffle(candidates));
      let best = 0;
      for (const order of orders) {
        const saving = sequentialSaving(order, units);
        best = Math.max(best, saving);
        if (saving > result.totalSavingPence) trace('betterOrder', order.map((d) => d.id));
        expect(saving, 'no order of the candidate deals saves more').toBeLessThanOrEqual(result.totalSavingPence);
      }
      if (candidates.length <= 5) expect(result.totalSavingPence, 'the best order is the one chosen').toBe(best);
    });
  });

  /*
   * "Adding a qualifying unit never raises the price paid by more than its unit price" is NOT
   * guaranteed by D-018 when deals overlap: each deal takes ALL of its qualifying units not yet
   * consumed and the search is over deal orders only. Minimal case (checked by hand against D-018):
   * A "Any 3 for £6.48" (nForPrice 3/648 on {Lager, Crisps}, created first), B "Lager 2 for 1"
   * (nForM 2/1 on {Lager}). Lager x5 @450: [A,B] saves 702 + 450 = 1152, total 1098. Add Crisps
   * @93: [A,B] now forms a 2nd A group (450,450,93) saving 345 and leaves nothing for B, 1047;
   * [B,A] saves 900; total 1296 = 1098 + 198 > 1098 + 93. So the property is asserted where the
   * decisions do guarantee it: a unit no deal covers, and deals whose products don't overlap.
   */
  it('adding a unit that no deal covers raises the price paid by exactly its unit price (no member, no booking)', () => {
    forAll(
      'adding an uncovered unit',
      0x5eed0104,
      (rng) => {
        const input = { ...genPricingInput(rng), memberDiscountPercent: null, depositBalancePence: null };
        const covered = new Set(input.deals.flatMap((d) => d.productIds));
        const uncovered = PRODUCT_POOL.filter((id) => !covered.has(id));
        const productId = uncovered.length > 0 ? rng.pick(uncovered) : null;
        return { input, productId, newUnitPrice: genPrice(rng), newVatRate: genVatRate(rng) };
      },
      ({ input, productId, newUnitPrice, newVatRate }) => {
        if (productId === null) return;
        const { lines, unitPrice } = withOneMoreUnit(input.lines, productId, newUnitPrice, newVatRate);
        if (lines === null) return;
        const before = priceBasket(input);
        const after = priceBasket({ ...input, lines });
        expect(after.totalPence).toBe(before.totalPence + unitPrice);
        expect(after.dealLines).toEqual(before.dealLines);
        expect(after.lines.slice(0, before.lines.length).map((l) => l.dealDiscountPence)).toEqual(before.lines.map((l) => l.dealDiscountPence));
      },
    );
  });

  it('when no unit qualifies for two deals, adding a qualifying unit raises the price paid by at most its unit price', () => {
    forAll(
      'adding a covered unit (non-overlapping deals)',
      0x5eed0105,
      (rng) => {
        const input = { ...genPricingInput(rng), memberDiscountPercent: null, depositBalancePence: null };
        // Make the deals' product sets disjoint: each product stays with the first deal that claims it.
        const claimed = new Set<string>();
        const deals = rng.shuffle(input.deals).flatMap((deal) => {
          const productIds = deal.productIds.filter((id) => !claimed.has(id));
          productIds.forEach((id) => claimed.add(id));
          return productIds.length === 0 ? [] : [{ ...deal, productIds }];
        });
        const covered = [...new Set(deals.filter((d) => isDealActiveAt(d, AT)).flatMap((d) => d.productIds))];
        const productId = covered.length > 0 ? rng.pick(covered) : rng.pick([...PRODUCT_POOL]);
        return { input: { ...input, deals }, productId, newUnitPrice: genPrice(rng), newVatRate: genVatRate(rng) };
      },
      ({ input, productId, newUnitPrice, newVatRate }) => {
        const { lines, unitPrice } = withOneMoreUnit(input.lines, productId, newUnitPrice, newVatRate);
        if (lines === null) return;
        const before = priceBasket(input);
        const after = priceBasket({ ...input, lines });
        expect(after.totalPence, `total ${before.totalPence} -> ${after.totalPence} after adding a unit at ${unitPrice}`).toBeLessThanOrEqual(
          before.totalPence + unitPrice,
        );
        expect(after.dealDiscountPence, 'total saving never falls when a unit is added').toBeGreaterThanOrEqual(before.dealDiscountPence);
      },
    );
  });
});

/** The basket with one more unit of `productId` (a new last line if absent); null at the 999 cap. */
function withOneMoreUnit(
  lines: readonly PricingLine[],
  productId: string,
  newUnitPrice: number,
  newVatRate: number,
): { lines: PricingLine[] | null; unitPrice: number } {
  const index = lines.findIndex((l) => l.productId === productId);
  const existing = lines[index];
  if (existing === undefined) {
    return {
      lines: [...lines, { productId, name: `Product ${productId}`, qty: 1, unitPricePence: newUnitPrice, vatRate: newVatRate, memberDiscountEligible: true }],
      unitPrice: newUnitPrice,
    };
  }
  if (existing.qty >= 999) return { lines: null, unitPrice: existing.unitPricePence };
  return { lines: lines.map((l, i) => (i === index ? { ...l, qty: l.qty + 1 } : l)), unitPrice: existing.unitPricePence };
}

// ---------------------------------------------------------------------------
// Tenders
// ---------------------------------------------------------------------------

function genTotal(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => 0, 5],
    [() => rng.int(1, 100), 10],
    [() => rng.int(100, 10_000), 60],
    [() => rng.int(10_000, 200_000), 20],
    [() => rng.int(200_000, 9_999_999), 5],
  ])();
}

describe('tender invariants (spec §6.4; D-029..D-032)', () => {
  it('a completed tendering has tenders - change = total, change only from a final cash tender, and no card over the balance', () => {
    forAll(
      'tendering',
      0x5eed0201,
      (rng) => ({ totalPence: genTotal(rng), intents: Array.from({ length: rng.int(1, 25) }, () => genIntent(rng)) }),
      ({ totalPence, intents }, _rng, trace) => {
        let state = startTendering(totalPence);
        expect(state.complete).toBe(totalPence === 0);
        for (const intent of intents) {
          if (state.complete) break;
          const remaining = state.remainingPence;
          expect(remaining, 'remaining = total - tenders').toBe(totalPence - sum(state.tenders.map((t) => t.amountPence)));
          const request = resolveIntent(intent, remaining);
          const outcome = applyTender(state, request);
          trace('step', { request, ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason });
          const amount = request.amountPence ?? (request.type === 'card' ? remaining : 0);
          if (amount < 1) {
            expect(outcome.ok ? 'accepted' : outcome.reason).toBe('amountTooSmall');
            continue;
          }
          if (request.type === 'card' && amount > remaining) {
            expect(outcome.ok ? 'accepted' : outcome.reason, 'card above the balance is rejected').toBe('cardExceedsBalance');
            continue;
          }
          if (!outcome.ok) throw new Error(`Tender unexpectedly rejected: ${outcome.message}`);
          const next = outcome.state;
          expect(next.tenders).toEqual([...state.tenders, { type: request.type, amountPence: amount }]);
          const paid = sum(next.tenders.map((t) => t.amountPence));
          if (paid >= totalPence) {
            expect(next).toMatchObject({ complete: true, remainingPence: 0, changePence: paid - totalPence });
          } else {
            expect(next).toMatchObject({ complete: false, remainingPence: totalPence - paid, changePence: 0 });
          }
          state = next;
        }
        if (!state.complete) {
          const outcome = applyTender(state, { type: 'card', amountPence: null });
          if (!outcome.ok) throw new Error(`Card for the whole balance rejected: ${outcome.message}`);
          expect(outcome.state.changePence).toBe(0);
          state = outcome.state;
        }
        // The completed tendering.
        const paid = sum(state.tenders.map((t) => t.amountPence));
        expect(paid - state.changePence, 'tenders - change = total').toBe(totalPence);
        expect(state.changePence).toBeGreaterThanOrEqual(0);
        const last = state.tenders[state.tenders.length - 1];
        if (state.changePence > 0) {
          expect(last?.type, 'only cash gives change').toBe('cash');
          expect(state.changePence).toBeLessThan(last?.amountPence ?? 0);
        }
        let running = 0;
        for (const tender of state.tenders) {
          expect(tender.amountPence).toBeGreaterThanOrEqual(1);
          if (tender.type === 'card') expect(tender.amountPence, 'card never exceeds the remaining balance').toBeLessThanOrEqual(totalPence - running);
          running += tender.amountPence;
        }
        if (totalPence === 0) expect(state.tenders).toEqual([]);
        expect(tenderSequenceProblems(totalPence, state.tenders, state.changePence)).toEqual([]);
        const after = applyTender(state, { type: 'cash', amountPence: 500 });
        expect(after.ok ? 'accepted' : after.reason, 'nothing more can be tendered').toBe('nothingDue');
      },
    );
  });

  it('a completed sale built from any priced basket and tender sequence passes validateSale', () => {
    forAll(
      'completed sale is valid',
      0x5eed0202,
      (rng) => ({ input: genPricingInput(rng), intents: genIntents(rng) }),
      ({ input, intents }) => {
        const priced = priceBasket(input);
        const tender = tenderToCompletion(priced.totalPence, intents);
        const sale = newSaleFrom(priced, input, tender);
        expect(validateSale(sale)).toEqual([]);
        expect(sum(sale.tenders.map((t) => t.amountPence)) - sale.changePence).toBe(sale.totalPence);
        if (sale.changePence > 0) expect(sale.tenders[sale.tenders.length - 1]?.type).toBe('cash');
        // Stock: one -qty 'sale' movement per tracked line (D-079).
        const tracked = (productId: string): boolean => productId.charCodeAt(1) % 2 === 0;
        const movements = stockMovementsForSale(sale, tracked);
        expect(movements).toEqual(
          sale.lines.filter((l) => tracked(l.productId)).map((l) => ({ productId: l.productId, qty: -l.qty, reason: 'sale', note: '' })),
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

interface RefundRun {
  original: Sale;
  refunds: Sale[];
  noise: Sale[];
  movements: { productId: string; qty: number }[];
}

const isTrackedForTest = (productId: string): boolean => productId.charCodeAt(1) % 2 === 0;

/**
 * Sells a random priced basket, then refunds it in random partial steps until nothing is left.
 * `onRefund` sees every built refund (and the request behind it) before it is stored.
 */
function runRefunds(
  input: PricingInput,
  intents: readonly TenderIntent[],
  rng: Rng,
  trace: Trace,
  onRefund: (refund: NewSale, request: readonly RefundRequestLine[], tenderType: TenderType, refunds: readonly Sale[], original: Sale) => void,
): RefundRun {
  const priced = priceBasket(input);
  const original = stored(newSaleFrom(priced, input, tenderToCompletion(priced.totalPence, intents)), 'orig', 'period-1', AT);
  expect(validateSale(original)).toEqual([]);
  // A refund of ANOTHER sale must never count against this one (D-036).
  const noise: Sale[] = rng.bool(0.2)
    ? [
        stored(
          { ...original, kind: 'refund', refundOfSaleId: 'another-sale', lines: original.lines.map((l, i) => ({ ...l, qty: -999, refundOfLineIndex: i, returnToStock: true })) },
          'noise',
          'period-1',
          AT,
        ),
      ]
    : [];
  const refunds: Sale[] = [];
  const movements = [...stockMovementsForSale(original, isTrackedForTest)];
  let step = 0;
  for (;;) {
    const existing = [...refunds, ...noise];
    const available = refundableQuantities(original, existing);
    const refunded = refundedQuantities(original, existing);
    original.lines.forEach((line, j) => {
      expect(refunded[j], `line ${j}: refunded never exceeds sold`).toBeLessThanOrEqual(line.qty);
      expect((refunded[j] ?? 0) + (available[j] ?? 0)).toBe(line.qty);
    });
    if (available.every((a) => a === 0)) break;
    step += 1;

    // An attempt to refund one more than is left is always rejected (D-036).
    if (rng.bool(0.15)) {
      const j = rng.int(0, original.lines.length - 1);
      const over = buildRefundSale({
        original,
        existingRefunds: existing,
        lines: [{ lineIndex: j, qty: (available[j] ?? 0) + 1, returnToStock: true }],
        tenderType: 'cash',
        staffId: 'manager',
      });
      expect(over.ok, `refunding ${(available[j] ?? 0) + 1} of line ${j} is rejected`).toBe(false);
    }

    let request: RefundRequestLine[] = original.lines.flatMap((_, j) => {
      const left = available[j] ?? 0;
      if (left === 0 || !rng.bool(0.6)) return [];
      return [{ lineIndex: j, qty: rng.bool(0.3) ? left : rng.int(1, left), returnToStock: rng.bool(0.7) }];
    });
    if (request.length === 0) {
      const j = available.findIndex((a) => a > 0);
      request = [{ lineIndex: j, qty: rng.int(1, available[j] ?? 1), returnToStock: rng.bool(0.7) }];
    }
    request = rng.shuffle(request);
    const tenderType: TenderType = rng.bool() ? 'cash' : 'card';
    trace('refund', { step, request, tenderType });
    const built = buildRefundSale({ original, existingRefunds: rng.shuffle(existing), lines: request, tenderType, staffId: 'manager' });
    if (!built.ok) throw new Error(`Refund rejected: ${built.errors.join('; ')}`);
    onRefund(built.sale, request, tenderType, refunds, original);
    movements.push(...stockMovementsForSale(built.sale, isTrackedForTest));
    refunds.push(stored(built.sale, `refund-${step}`, 'period-1', AT));
  }
  return { original, refunds, noise, movements };
}

const genRefundCase = (rng: Rng): { input: PricingInput; intents: TenderIntent[] } => ({ input: genPricingInput(rng), intents: genIntents(rng) });

describe('refund invariants (spec §6.8; D-036..D-039)', () => {
  it('any sequence of partial refunds sums exactly (negated) to each original line; refunded qty never exceeds sold', () => {
    forAll('partial refunds sum exactly', 0x5eed0301, genRefundCase, ({ input, intents }, rng, trace) => {
      const { original, refunds, noise, movements } = runRefunds(input, intents, rng, trace, (refund, request, tenderType, earlier, sold) => {
        expectAllIntegers(refund);
        expect(refund.kind).toBe('refund');
        expect(refund.refundOfSaleId).toBe(sold.id);
        expect(refund.lines.map((l) => l.refundOfLineIndex)).toEqual([...request].sort((a, b) => a.lineIndex - b.lineIndex).map((r) => r.lineIndex));
        for (const line of refund.lines) {
          expect(line.qty).toBeLessThanOrEqual(-1);
          // (+ 0 turns this test's own -0, from -qty x a 0p price, into 0.)
          expect(line.finalPence).toBe(line.qty * line.unitPricePence - line.dealDiscountPence - line.memberDiscountPence + 0);
        }
        expect(refund.totalPence).toBe(sum(refund.lines.map((l) => l.finalPence)));
        expect(refund.memberDiscountPence).toBe(sum(refund.lines.map((l) => l.memberDiscountPence)));
        expect(refund.tenders).toEqual(refund.totalPence === 0 ? [] : [{ type: tenderType, amountPence: refund.totalPence }]);
        expect(sum(refund.tenders.map((t) => t.amountPence)) - refund.changePence).toBe(refund.totalPence);

        // Cumulative sums after this refund equal the cumulative shares of the original (D-037), with
        // D-125's refinement: the cumulative final is the running maximum of D-037's final over
        // 0..done units (so no refund line's final is positive, D-032) and the member share is the
        // rest. Deal and VAT are always exactly D-037.
        const all = [...earlier.map((r) => r.lines), refund.lines].flat();
        sold.lines.forEach((line, j) => {
          const refundLines = all.filter((l) => l.refundOfLineIndex === j);
          const done = neg(sum(refundLines.map((l) => l.qty)));
          const d037Final = (c: number) =>
            c * line.unitPricePence - mulDivRhu(line.dealDiscountPence, c, line.qty) - mulDivRhu(line.memberDiscountPence, c, line.qty);
          const deal = mulDivRhu(line.dealDiscountPence, done, line.qty);
          const final = Math.max(...Array.from({ length: done + 1 }, (_, c) => d037Final(c)));
          const member = done * line.unitPricePence - deal - final;
          if (final === d037Final(done)) expect(member, `line ${j}: D-037 member after ${done}`).toBe(mulDivRhu(line.memberDiscountPence, done, line.qty));
          expect(sum(refundLines.map((l) => l.dealDiscountPence)), `line ${j} deal after ${done}`).toBe(neg(deal));
          expect(sum(refundLines.map((l) => l.memberDiscountPence)), `line ${j} member after ${done}`).toBe(neg(member));
          expect(sum(refundLines.map((l) => l.vatPence)), `line ${j} VAT after ${done}`).toBe(neg(mulDivRhu(line.vatPence, done, line.qty)));
          expect(sum(refundLines.map((l) => l.finalPence)), `line ${j} final after ${done}`).toBe(neg(final));
        });
      });

      // Fully refunded: every line nets to exactly zero.
      original.lines.forEach((line: SaleLine, j) => {
        const refundLines = refunds.flatMap((r) => r.lines.filter((l) => l.refundOfLineIndex === j));
        expect(sum(refundLines.map((l) => l.qty)), `line ${j} qty`).toBe(neg(line.qty));
        expect(sum(refundLines.map((l) => l.qty * l.unitPricePence)), `line ${j} gross`).toBe(neg(line.qty * line.unitPricePence));
        expect(sum(refundLines.map((l) => l.dealDiscountPence)), `line ${j} deal`).toBe(neg(line.dealDiscountPence));
        expect(sum(refundLines.map((l) => l.memberDiscountPence)), `line ${j} member`).toBe(neg(line.memberDiscountPence));
        expect(sum(refundLines.map((l) => l.finalPence)), `line ${j} final`).toBe(neg(line.finalPence));
        expect(sum(refundLines.map((l) => l.vatPence)), `line ${j} VAT`).toBe(neg(line.vatPence));
      });
      expect(sum(refunds.map((r) => r.memberDiscountPence))).toBe(neg(original.memberDiscountPence));
      expect(sum(refunds.map((r) => r.totalPence))).toBe(neg(sum(original.lines.map((l) => l.finalPence))));
      const after = buildRefundSale({
        original,
        existingRefunds: [...refunds, ...noise],
        lines: [{ lineIndex: 0, qty: 1, returnToStock: true }],
        tenderType: 'cash',
        staffId: 'manager',
      });
      expect(after.ok, 'nothing is left to refund').toBe(false);

      // Stock: sold -q, returned +q, wasted +q -q (D-039, D-079).
      for (const line of original.lines) {
        const onHand = sum(movements.filter((m) => m.productId === line.productId).map((m) => m.qty));
        const returned = -sum(refunds.flatMap((r) => r.lines).filter((l) => l.productId === line.productId && l.returnToStock === true).map((l) => l.qty));
        expect(onHand, `${line.productId} stock`).toBe(isTrackedForTest(line.productId) ? -line.qty + returned : 0);
      }
    });
  });

  it('every partial refund of an allowed quantity is a valid refund sale: no refund figure is positive (D-032)', () => {
    forAll('partial refunds are valid sales', 0x5eed0302, genRefundCase, ({ input, intents }, rng, trace) => {
      runRefunds(input, intents, rng, trace, (refund) => {
        for (const line of refund.lines) {
          const figures = { deal: line.dealDiscountPence, member: line.memberDiscountPence, final: line.finalPence, vat: line.vatPence };
          for (const [name, value] of Object.entries(figures)) {
            expect(value, `refund line ${String(line.refundOfLineIndex)} ${name} must be <= 0 (D-032)`).toBeLessThanOrEqual(0);
          }
        }
        expect(refund.totalPence, 'a refund total is never positive (D-032)').toBeLessThanOrEqual(0);
        expect(validateSale(refund)).toEqual([]);
      });
    });
  });

  it('example: refunding 1 of 2 units of a line with a 1p deal saving and 100% member discount is a valid refund', () => {
    // Minimal case found by the property above. The original line: Lager x2 @450, deal "2 for
    // £8.99" (saving 1), member 100% (899), final 0, VAT 0. D-037 shares for 1 of 2 units:
    // deal rhu(1/2) = 1, member rhu(899/2) = 450, so final = 450 - 1 - 450 = -1 and the refund line
    // would store finalPence +1 (a refund that charges 1p), which D-032 forbids.
    const deal = nForPriceDeal('deal-2for899', 2, 899, ['lager']);
    const input: PricingInput = {
      lines: [{ productId: 'lager', name: 'Lager', qty: 2, unitPricePence: 450, vatRate: 20, memberDiscountEligible: true }],
      deals: [deal],
      at: AT,
      memberDiscountPercent: 100,
      depositBalancePence: null,
    };
    const priced = priceBasket(input);
    expect(priced.lines[0]).toMatchObject({ grossPence: 900, dealDiscountPence: 1, memberDiscountPence: 899, finalPence: 0, vatPence: 0 });
    const original = stored(newSaleFrom(priced, input, startTendering(0)), 'orig', 'period-1', AT);
    expect(validateSale(original)).toEqual([]);
    const built = buildRefundSale({ original, existingRefunds: [], lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash', staffId: 'manager' });
    if (!built.ok) throw new Error(built.errors.join('; '));
    expect(built.sale.lines[0]?.finalPence, 'the refund line final').toBeLessThanOrEqual(0);
    expect(built.sale.totalPence, 'the refund total').toBeLessThanOrEqual(0);
    expect(validateSale(built.sale)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// X/Z figures and reports over random periods (rules level)
// ---------------------------------------------------------------------------

const PERIOD = 'period-A';
const OTHER_PERIOD = 'period-B';
const CATEGORIES: Category[] = [
  { id: 'cat-1', deviceId: DEVICE, createdAt: AT, updatedAt: AT, name: 'Draught', sortOrder: 1, colour: '#b45309' },
  { id: 'cat-2', deviceId: DEVICE, createdAt: AT, updatedAt: AT, name: 'Snacks', sortOrder: 2, colour: '#15803d' },
  { id: 'cat-3', deviceId: DEVICE, createdAt: AT, updatedAt: AT, name: 'Old', sortOrder: 3, colour: '#475569', deletedAt: AT },
];
/** p7 has no product record (a name fallback); p6 is in a deleted category (Uncategorised). */
const PRODUCTS: Product[] = PRODUCT_POOL.filter((id) => id !== 'p7').map((id, i) => ({
  id,
  deviceId: DEVICE,
  createdAt: AT,
  updatedAt: AT,
  name: `Product ${id}`,
  categoryId: id === 'p6' ? 'cat-3' : i % 2 === 0 ? 'cat-1' : 'cat-2',
  pricePence: 100,
  vatRate: 20,
  memberDiscountEligible: true,
  stockTracked: true,
  stockUnit: 'unit',
  lowStockLevel: 0,
  buttonColour: '#000000',
  sortOrder: i,
  active: true,
}));

interface RandomPeriod {
  period: Period;
  sales: Sale[];
  auditEvents: AuditEvent[];
}

function genPeriod(rng: Rng): RandomPeriod {
  const period: Period = { id: PERIOD, deviceId: DEVICE, createdAt: AT, updatedAt: AT, openedAt: AT, openedBy: 'manager', floatPence: rng.int(0, 30_000) };
  const sales: Sale[] = [];
  let clockMs = Date.parse('2026-09-26T09:00:00.000Z');
  const count = rng.int(0, 12);
  for (let i = 0; i < count; i += 1) {
    clockMs += rng.int(1, 40) * 60_000;
    const createdAt = new Date(clockMs).toISOString();
    const periodId = rng.bool(0.85) ? PERIOD : OTHER_PERIOD;
    const originals = sales.filter((s) => s.kind === 'sale' && refundableQuantities(s, sales.filter((r) => r.refundOfSaleId === s.id)).some((q) => q > 0));
    const kind = rng.weighted<'sale' | 'deposit' | 'refund'>([
      ['sale', 60],
      ['deposit', 15],
      ['refund', originals.length > 0 ? 25 : 0],
    ]);
    if (kind === 'sale') {
      const lines = genLines(rng, 4).map((l) => ({ ...l, qty: Math.min(l.qty, 12) }));
      const input: PricingInput = { lines, deals: genDeals(rng, lines), at: AT, memberDiscountPercent: genMemberPercent(rng), depositBalancePence: genBalance(rng, lines) };
      const priced = priceBasket(input);
      sales.push(stored(newSaleFrom(priced, input, tenderToCompletion(priced.totalPence, genIntents(rng))), `sale-${i}`, periodId, createdAt));
    } else if (kind === 'deposit') {
      const amount = rng.int(1, 50_000);
      const tender = tenderToCompletion(amount, genIntents(rng));
      const deposit: NewSale = {
        staffId: 'staff-1',
        kind: 'deposit',
        bookingId: 'booking-1',
        lines: [],
        dealLines: [],
        memberDiscountPence: 0,
        depositAppliedPence: 0,
        totalPence: amount,
        tenders: tender.tenders,
        changePence: tender.changePence,
      };
      sales.push(stored(deposit, `deposit-${i}`, periodId, createdAt));
    } else {
      const original = rng.pick(originals);
      const existing = sales.filter((r) => r.refundOfSaleId === original.id);
      const available = refundableQuantities(original, existing);
      let request: RefundRequestLine[] = original.lines.flatMap((_, j) =>
        (available[j] ?? 0) > 0 && rng.bool(0.6) ? [{ lineIndex: j, qty: rng.int(1, available[j] ?? 1), returnToStock: rng.bool() }] : [],
      );
      if (request.length === 0) {
        const j = available.findIndex((a) => a > 0);
        request = [{ lineIndex: j, qty: 1, returnToStock: true }];
      }
      const built = buildRefundSale({ original, existingRefunds: existing, lines: request, tenderType: rng.bool() ? 'cash' : 'card', staffId: 'manager' });
      if (!built.ok) throw new Error(`Refund rejected while generating: ${built.errors.join('; ')}`);
      sales.push(stored(built.sale, `refund-${i}`, periodId, createdAt));
    }
  }
  const auditEvents: AuditEvent[] = Array.from({ length: rng.int(0, 6) }, (_, i) => {
    const periodId = rng.weighted<string | undefined>([
      [PERIOD, 70],
      [OTHER_PERIOD, 20],
      [undefined, 10],
    ]);
    const base = { id: `audit-${i}`, deviceId: DEVICE, createdAt: AT, updatedAt: AT, staffId: 'sue', ...(periodId === undefined ? {} : { periodId }) };
    return rng.weighted<AuditEvent>([
      [{ ...base, type: 'void', detail: { productId: 'p0', productName: 'P0', qty: 1, unitPricePence: 100 } }, 1],
      [{ ...base, type: 'noSale', detail: {} }, 1],
      [{ ...base, type: 'override', detail: { action: 'voidLine' } }, 1],
    ]);
  });
  return { period, sales: rng.shuffle(sales), auditEvents };
}

/** X/Z figures summed independently from the receipts (D-041). */
function expectedFigures(input: RandomPeriod): PeriodFigures {
  const inPeriod = input.sales.filter((s) => s.periodId === input.period.id);
  const SL = inPeriod.filter((s) => s.kind === 'sale').flatMap((s) => s.lines);
  const RL = inPeriod.filter((s) => s.kind === 'refund').flatMap((s) => s.lines);
  const takings = inPeriod.filter((s) => s.kind !== 'refund');
  const refunds = inPeriod.filter((s) => s.kind === 'refund');
  const tenders = (sales: readonly Sale[], type: TenderType): number => sum(sales.flatMap((s) => s.tenders.filter((t) => t.type === type).map((t) => t.amountPence)));
  const cashTendered = tenders(takings, 'cash');
  const change = sum(inPeriod.map((s) => s.changePence));
  const cashRefunded = neg(tenders(refunds, 'cash'));
  const cardTendered = tenders(takings, 'card');
  const cardRefunded = neg(tenders(refunds, 'card'));
  const byRate = new Map<number, { gross: number; vat: number }>();
  for (const line of [...SL, ...RL]) {
    const row = byRate.get(line.vatRate) ?? { gross: 0, vat: 0 };
    byRate.set(line.vatRate, { gross: row.gross + line.finalPence, vat: row.vat + line.vatPence });
  }
  const events = input.auditEvents.filter((e) => e.periodId === input.period.id);
  const float = input.period.floatPence;
  return {
    grossSalesPence: sum(SL.map((l) => l.qty * l.unitPricePence)),
    dealDiscountsPence: sum(SL.map((l) => l.dealDiscountPence)),
    memberDiscountsPence: sum(SL.map((l) => l.memberDiscountPence)),
    refundsPence: neg(sum(RL.map((l) => l.finalPence))),
    netTakingsPence: sum([...SL, ...RL].map((l) => l.finalPence)),
    depositsTakenPence: sum(inPeriod.filter((s) => s.kind === 'deposit').map((s) => s.totalPence)),
    depositsAppliedPence: sum(inPeriod.filter((s) => s.kind === 'sale').map((s) => s.depositAppliedPence)),
    cashTenderedPence: cashTendered,
    changeGivenPence: change,
    cashRefundedPence: cashRefunded,
    cashTotalPence: cashTendered - change - cashRefunded,
    cardTenderedPence: cardTendered,
    cardRefundedPence: cardRefunded,
    cardTotalPence: cardTendered - cardRefunded,
    vatByRate: [...byRate.entries()].sort(([a], [b]) => b - a).map(([vatRate, r]) => ({ vatRate, grossPence: r.gross, vatPence: r.vat, netPence: r.gross - r.vat })),
    floatPence: float,
    expectedCashPence: float + cashTendered - change - cashRefunded,
    noSaleCount: events.filter((e) => e.type === 'noSale').length,
    voidCount: events.filter((e) => e.type === 'void').length,
  };
}

describe('period and report invariants over random periods (spec §6.11, §7; D-041..D-045)', () => {
  it('X/Z figures equal the sums of the period receipts and satisfy the D-042 reconciliation identities', () => {
    forAll('period figures', 0x5eed0401, genPeriod, (input) => {
      const figures = periodFigures(input);
      expectAllIntegers(figures);
      expect(figures).toEqual(expectedFigures(input));
      const inPeriod = input.sales.filter((s) => s.periodId === PERIOD);
      const finals = sum(inPeriod.filter((s) => s.kind !== 'deposit').flatMap((s) => s.lines.map((l) => l.finalPence)));
      // D-042 (1)..(6)
      expect(figures.netTakingsPence, '(1)').toBe(finals);
      expect(figures.cashTotalPence + figures.cardTotalPence, '(2)').toBe(figures.netTakingsPence - figures.depositsAppliedPence + figures.depositsTakenPence);
      expect(figures.expectedCashPence, '(3)').toBe(figures.floatPence + figures.cashTotalPence);
      expect(sum(figures.vatByRate.map((r) => r.grossPence)), '(4)').toBe(figures.netTakingsPence);
      for (const row of figures.vatByRate) expect(row.netPence + row.vatPence, '(4) per rate').toBe(row.grossPence);
      expect(figures.grossSalesPence - figures.dealDiscountsPence - figures.memberDiscountsPence, '(5)').toBe(
        sum(inPeriod.filter((s) => s.kind === 'sale').flatMap((s) => s.lines.map((l) => l.finalPence))),
      );
      for (const sale of inPeriod) expect(sum(sale.tenders.map((t) => t.amountPence)) - sale.changePence, '(6)').toBe(sale.totalPence);
      expect(figures.expectedCashPence, 'expected cash = float + cash tendered - change - cash refunded').toBe(
        figures.floatPence + figures.cashTenderedPence - figures.changeGivenPence - figures.cashRefundedPence,
      );
    });
  });

  it('product sales and VAT reports equal the sums of the receipt lines, and their totals agree', () => {
    forAll('reports', 0x5eed0402, genPeriod, (input) => {
      const range = localDateRange('2026-09-26', '2026-09-26');
      if (range === null) throw new Error('bad range');
      const lines = input.sales.filter((s) => s.kind !== 'deposit').flatMap((s) => s.lines);
      const vat = vatReport(input.sales, range);
      const byRate = new Map<number, { gross: number; vat: number }>();
      for (const line of lines) {
        const row = byRate.get(line.vatRate) ?? { gross: 0, vat: 0 };
        byRate.set(line.vatRate, { gross: row.gross + line.finalPence, vat: row.vat + line.vatPence });
      }
      expect(vat.rows).toEqual(
        [...byRate.entries()].sort(([a], [b]) => b - a).map(([vatRate, r]) => ({ vatRate, grossPence: r.gross, vatPence: r.vat, netPence: r.gross - r.vat })),
      );
      expect(vat.totals.grossPence).toBe(sum(lines.map((l) => l.finalPence)));
      expect(vat.totals.vatPence).toBe(sum(lines.map((l) => l.vatPence)));
      expect(vat.totals.netPence).toBe(vat.totals.grossPence - vat.totals.vatPence);

      const report = productSalesReport({ sales: input.sales, products: PRODUCTS, categories: CATEGORIES, range });
      expect(report.totalTakingsPence, 'product sales total = VAT report total gross').toBe(vat.totals.grossPence);
      expect(report.totalQty).toBe(sum(lines.map((l) => l.qty)));
      const rows = report.categories.flatMap((c) => c.products);
      expect(rows.map((r) => r.productId).sort()).toEqual([...new Set(lines.map((l) => l.productId))].sort());
      for (const row of rows) {
        const own = lines.filter((l) => l.productId === row.productId);
        expect(row.qty, `${row.productId} qty`).toBe(sum(own.map((l) => l.qty)));
        expect(row.takingsPence, `${row.productId} takings`).toBe(sum(own.map((l) => l.finalPence)));
      }
      for (const category of report.categories) {
        expect(category.qty).toBe(sum(category.products.map((p) => p.qty)));
        expect(category.takingsPence).toBe(sum(category.products.map((p) => p.takingsPence)));
      }
    });
  });
});
