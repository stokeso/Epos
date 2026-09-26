/**
 * Multi-buy deals (spec §7.2; D-012..D-018, D-121). Pure.
 */
import type { Deal, IsoInstant, Pence, SaleDealLine } from '../data/types';
import { MAX_PRICE_PENCE, allocate, assertPence, sumPence } from './money';

/** Exhaustive permutation search up to this many candidate deals; greedy above (D-018). */
export const MAX_PERMUTED_DEALS = 6;

/** Deal group size bounds (D-001, D-013). */
export const MIN_DEAL_N = 2;
export const MAX_DEAL_N = 99;

/** The fields deals need from a basket line (line index = array position). */
export interface DealLineInput {
  productId: string;
  qty: number;
  unitPricePence: Pence;
}

/** One unit of a basket line (D-014). */
export interface DealUnit {
  lineIndex: number;
  /** 0..qty-1 within its line. */
  unitIndex: number;
  productId: string;
  pricePence: Pence;
}

/** An applied group of n units (D-015, D-016). */
export interface DealGroup {
  dealId: string;
  /** Sorted by compareUnits. */
  units: DealUnit[];
  /** > 0 */
  savingPence: Pence;
  /** allocate(savingPence, unit prices, [0..n-1]); shares[i] belongs to units[i]. */
  shares: Pence[];
}

/** One deal's result on a set of available units. */
export interface DealEvaluation {
  deal: Deal;
  /** Applied groups only (saving > 0). */
  groups: DealGroup[];
  savingPence: Pence;
}

export interface DealsResult {
  /** Per basket line (same indices as the input lines): sum of its units' shares. */
  lineDealDiscounts: Pence[];
  /** One per deal applied at least once, in canonical deal order (D-017). */
  dealLines: SaleDealLine[];
  totalSavingPence: Pence;
}

function parseAt(at: IsoInstant): number {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid pricing instant: ${at}`);
  return ms;
}

/**
 * A deal applies at `at` iff active, not deleted, and startsAt <= at (if set) and at < endsAt
 * (if set). Compare with Date.parse (D-012). An unparseable startsAt/endsAt never matches, so such
 * a deal does not apply. Throws RangeError for an invalid `at`.
 */
export function isDealActiveAt(deal: Deal, at: IsoInstant): boolean {
  const atMs = parseAt(at);
  if (deal.active !== true || deal.deletedAt !== undefined) return false;
  if (deal.startsAt !== undefined && !(atMs >= Date.parse(deal.startsAt))) return false;
  if (deal.endsAt !== undefined && !(atMs < Date.parse(deal.endsAt))) return false;
  return true;
}

/**
 * Whether the deal's parameters are within the D-013 ranges (D-121): n an integer 2..99;
 * nForPrice pricePence an integer 1..MAX_PRICE_PENCE; nForM m an integer 1..n-1. Pricing never
 * applies (and never throws on) a deal that fails this.
 */
export function isDealWellFormed(deal: Deal): boolean {
  const { n } = deal;
  if (!Number.isInteger(n) || n < MIN_DEAL_N || n > MAX_DEAL_N) return false;
  if (!Array.isArray(deal.productIds)) return false;
  if (deal.type === 'nForPrice') {
    const price = deal.pricePence;
    return price !== undefined && Number.isInteger(price) && price >= 1 && price <= MAX_PRICE_PENCE;
  }
  if (deal.type === 'nForM') {
    const m = deal.m;
    return m !== undefined && Number.isInteger(m) && m >= 1 && m < n;
  }
  return false;
}

/** Expands lines, in basket order, into qty units each (D-014). */
export function expandUnits(lines: readonly DealLineInput[]): DealUnit[] {
  const units: DealUnit[] = [];
  lines.forEach((line, lineIndex) => {
    if (!Number.isSafeInteger(line.qty) || line.qty < 0) throw new RangeError(`Line ${lineIndex}: qty must be an integer >= 0`);
    assertPence(line.unitPricePence, `Line ${lineIndex} unit price`);
    if (line.unitPricePence < 0) throw new RangeError(`Line ${lineIndex}: unit price must be >= 0`);
    for (let unitIndex = 0; unitIndex < line.qty; unitIndex += 1) {
      units.push({ lineIndex, unitIndex, productId: line.productId, pricePence: line.unitPricePence });
    }
  });
  return units;
}

/** Total order: pricePence DESC, then lineIndex ASC, then unitIndex ASC (D-014). */
export function compareUnits(a: DealUnit, b: DealUnit): number {
  if (a.pricePence !== b.pricePence) return b.pricePence - a.pricePence;
  if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex;
  return a.unitIndex - b.unitIndex;
}

/** Plain code-unit comparison (never locale-aware), for deterministic ordering. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Canonical deal order: createdAt ASC, then id ASC (plain string comparison) (D-018). */
export function canonicalDealOrder(deals: readonly Deal[]): Deal[] {
  return [...deals].sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id));
}

/** The saving of one sorted group, before the "> 0" test (D-015, D-016). */
function groupSaving(deal: Deal, prices: readonly number[]): number {
  if (deal.type === 'nForPrice') return sumPence(prices) - (deal.pricePence ?? 0);
  const free = deal.n - (deal.m ?? deal.n);
  return sumPence(prices.slice(prices.length - free));
}

/** An applied group before its saving is spread: the search only needs the savings. */
interface PlannedGroup {
  units: DealUnit[];
  prices: Pence[];
  savingPence: Pence;
}

interface DealPlan {
  deal: Deal;
  groups: PlannedGroup[];
  savingPence: Pence;
}

/**
 * Forms a well-formed deal's groups from its qualifying units, already sorted by compareUnits
 * (D-014..D-016). Stops at the first group that does not save (D-015).
 */
function planDeal(deal: Deal, sortedQualifying: readonly DealUnit[]): DealPlan {
  const groups: PlannedGroup[] = [];
  let savingPence = 0;
  const n = deal.n;
  for (let start = 0; start + n <= sortedQualifying.length; start += n) {
    const units = sortedQualifying.slice(start, start + n);
    const prices = units.map((unit) => unit.pricePence);
    const saving = groupSaving(deal, prices);
    if (saving <= 0) break;
    groups.push({ units, prices, savingPence: saving });
    savingPence += saving;
  }
  return { deal, groups, savingPence };
}

/** Spreads each group's saving over ALL its units in proportion to price (D-016). */
function spreadPlan(plan: DealPlan): DealEvaluation {
  const order = Array.from({ length: plan.deal.n }, (_, i) => i);
  return {
    deal: plan.deal,
    savingPence: plan.savingPence,
    groups: plan.groups.map((group) => ({
      dealId: plan.deal.id,
      units: group.units,
      savingPence: group.savingPence,
      shares: allocate(group.savingPence, group.prices, order),
    })),
  };
}

/**
 * Evaluates ONE deal on the given available units (D-014..D-016): take units whose productId is
 * in deal.productIds, sort with compareUnits, form consecutive groups of n from the start
 * (leftovers = the last count mod n units). nForPrice saving = sum(group) - pricePence;
 * nForM saving = sum of the last n - m units of the group. A group with saving <= 0 is not
 * applied and its units are not consumed; evaluation stops at the first such group (the list is
 * sorted DESC, so no later group of the same deal saves more).
 * Each applied group's saving is spread over ALL its n units with allocate(saving, prices,
 * [0..n-1]) (the remainder goes to the highest-priced, earliest unit).
 * A deal with invalid parameters (D-121) yields no groups.
 */
export function evaluateDeal(deal: Deal, availableUnits: readonly DealUnit[]): DealEvaluation {
  if (!isDealWellFormed(deal)) return { deal, groups: [], savingPence: 0 };
  const covered = new Set(deal.productIds);
  return spreadPlan(planDeal(deal, availableUnits.filter((unit) => covered.has(unit.productId)).sort(compareUnits)));
}

/** A candidate deal and its qualifying units (sorted), fixed for the whole search. */
interface Candidate {
  deal: Deal;
  qualifying: DealUnit[];
}

const availableFor = (candidate: Candidate, consumed: ReadonlySet<DealUnit>): DealUnit[] =>
  candidate.qualifying.filter((unit) => !consumed.has(unit));

function consume(plan: DealPlan, consumed: Set<DealUnit>): void {
  for (const group of plan.groups) for (const unit of group.units) consumed.add(unit);
}

function release(plan: DealPlan, consumed: Set<DealUnit>): void {
  for (const group of plan.groups) for (const unit of group.units) consumed.delete(unit);
}

/**
 * Every permutation, visited depth-first in lexicographic order of canonical positions (identity
 * first), so a shared prefix is evaluated once. In each order every deal takes the qualifying units
 * not yet consumed. The first permutation with the strictly greatest total saving wins (D-018).
 */
function bestPermutation(candidates: readonly Candidate[]): DealPlan[] {
  const used = candidates.map(() => false);
  const consumed = new Set<DealUnit>();
  const path: DealPlan[] = [];
  let best: { total: number; plans: DealPlan[] } | undefined;
  const visit = (total: number): void => {
    if (path.length === candidates.length) {
      if (best === undefined || total > best.total) best = { total, plans: [...path] };
      return;
    }
    candidates.forEach((candidate, i) => {
      if (used[i]) return;
      const plan = planDeal(candidate.deal, availableFor(candidate, consumed));
      used[i] = true;
      path.push(plan);
      consume(plan, consumed);
      visit(total + plan.savingPence);
      release(plan, consumed);
      path.pop();
      used[i] = false;
    });
  };
  visit(0);
  return best?.plans ?? [];
}

/** Greedy: repeatedly apply the remaining deal with the strictly greatest saving (D-018). */
function greedy(candidates: readonly Candidate[]): DealPlan[] {
  const remaining = [...candidates];
  const consumed = new Set<DealUnit>();
  const applied: DealPlan[] = [];
  for (;;) {
    let bestIndex = -1;
    let bestPlan: DealPlan | undefined;
    remaining.forEach((candidate, index) => {
      const plan = planDeal(candidate.deal, availableFor(candidate, consumed));
      if (plan.savingPence > (bestPlan?.savingPence ?? 0)) {
        bestIndex = index;
        bestPlan = plan;
      }
    });
    if (bestPlan === undefined) return applied;
    consume(bestPlan, consumed);
    applied.push(bestPlan);
    remaining.splice(bestIndex, 1);
  }
}

/**
 * Applies all deals to the basket (D-018). Candidates = deals active at `at`, well formed (D-121)
 * and with >= n qualifying units, in canonical order. With <= MAX_PERMUTED_DEALS candidates,
 * evaluate every permutation in lexicographic order of canonical positions (identity first). In
 * each order, each deal takes the qualifying units not yet consumed and consumes only its applied
 * groups' units. Keep the first permutation with the strictly greatest total saving. With more
 * candidates, use greedy: repeatedly apply the remaining deal with the strictly greatest saving on
 * unconsumed units (earliest canonical wins ties) until none saves > 0.
 * Savings are spread over units (allocate) only for the chosen assignment.
 * Example: Lager x1 @450, Bitter x3 @420; A 'Any 2 pints £7' (nForPrice 2/700 {lager, bitter},
 * created first); B 'Bitter 3 for 2' (nForM 3/2 {bitter}). [A,B] saves 310, [B,A] saves 420, so
 * the result is lineDealDiscounts [0, 420] and dealLines [{B, groupCount 1, savingPence 420}].
 * Throws RangeError for an invalid `at` or an invalid line.
 */
export function applyDeals(lines: readonly DealLineInput[], deals: readonly Deal[], at: IsoInstant): DealsResult {
  parseAt(at);
  const units = expandUnits(lines).sort(compareUnits);
  const candidates: Candidate[] = canonicalDealOrder(deals.filter((deal) => isDealActiveAt(deal, at) && isDealWellFormed(deal)))
    .map((deal) => {
      const covered = new Set(deal.productIds);
      return { deal, qualifying: units.filter((unit) => covered.has(unit.productId)) };
    })
    .filter((candidate) => candidate.qualifying.length >= candidate.deal.n);

  const plans =
    candidates.length === 0 ? [] : candidates.length <= MAX_PERMUTED_DEALS ? bestPermutation(candidates) : greedy(candidates);
  const evaluations = plans.filter((plan) => plan.groups.length > 0).map(spreadPlan);

  const lineDealDiscounts = lines.map(() => 0);
  const byDealId = new Map<string, DealEvaluation>();
  for (const evaluation of evaluations) {
    byDealId.set(evaluation.deal.id, evaluation);
    for (const group of evaluation.groups) {
      group.units.forEach((unit, i) => {
        lineDealDiscounts[unit.lineIndex] = (lineDealDiscounts[unit.lineIndex] ?? 0) + (group.shares[i] ?? 0);
      });
    }
  }

  const dealLines: SaleDealLine[] = [];
  for (const { deal } of candidates) {
    const evaluation = byDealId.get(deal.id);
    if (evaluation === undefined) continue;
    dealLines.push({ dealId: deal.id, name: deal.name, groupCount: evaluation.groups.length, savingPence: evaluation.savingPence });
  }

  return { lineDealDiscounts, dealLines, totalSavingPence: sumPence(dealLines.map((d) => d.savingPence)) };
}
