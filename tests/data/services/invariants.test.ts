/**
 * Property / invariant tests at the services level (spec §1.1, §6.4, §6.8, §6.11, §7; D-040..D-045,
 * D-079..D-082), on the LocalAdapter over fake-indexeddb.
 *
 * Each case is a random mini-shift driven through the real services by a seeded mulberry32 PRNG:
 * sales (deals, members, deposits applied, split tenders), deposits, tabs opened and settled,
 * refunds (partial, cash or card, return or waste), voids, no sales, goods in, stock adjustments,
 * and sometimes a mid-shift Z close and a new period. The test keeps its OWN tallies (tenders
 * accepted, change, refunds, stock, booking balances, void and no-sale counts) and checks that:
 * - X and Z figures equal the sums of the period's receipts and the D-042 identities hold;
 * - expected cash = float + cash tendered - change - cash refunded, from the tenders actually taken;
 * - the VAT report per rate and the product sales report equal the sums of the receipt lines;
 * - stock on hand = the sum of the movements = the tally; booking balances match the tally.
 * A failure names the shift seed and the trace of operations, so the shift can be replayed.
 */
import { describe, expect, it } from 'vitest';
import { isAppError } from '../../../src/data/errors';
import type { AuditEvent, Product, Sale, TenderType } from '../../../src/data/types';
import { EMPTY_BASKET, type BasketState } from '../../../src/rules/basket';
import type { PeriodFigures } from '../../../src/rules/cashup';
import { QUICK_CASH_PENCE, type TenderRequest } from '../../../src/rules/tender';
import { addDays, localDateRange, londonDateOf } from '../../../src/rules/time';
import type { Session } from '../../../src/services/auth';
import { saveBooking } from '../../../src/services/bookings';
import { saveDeal, saveProduct } from '../../../src/services/catalogue';
import { completePayment, openDepositPayment, openSalePayment, takeTender, type PaySession } from '../../../src/services/pay';
import { confirmZClose, openPeriod, previewZClose, runXRead } from '../../../src/services/periods';
import { commitRefund } from '../../../src/services/refunds';
import { runProductSalesReport, runVatReport } from '../../../src/services/reports';
import { getSettings, saveSettings } from '../../../src/services/settings';
import { listLowStock, listStockLevels, recordGoodsIn, recordStockAdjustment } from '../../../src/services/stock';
import { loadTab, openNewTab } from '../../../src/services/tabs';
import { recordNoSale, voidLine } from '../../../src/services/till';
import { auth, registerCleanup, setupTill, type Till } from './harness';

registerCleanup();

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

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
  int(lo: number, hi: number): number;
  bool(p?: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return {
    int,
    bool: (p = 0.5) => next() < p,
    pick: <T,>(items: readonly T[]): T => {
      const item = items[int(0, items.length - 1)];
      if (items.length === 0 || item === undefined) throw new Error('pick() from an empty list');
      return item;
    },
    weighted: <T,>(entries: readonly (readonly [T, number])[]): T => {
      let roll = next() * entries.reduce((a, [, w]) => a + w, 0);
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

// ---------------------------------------------------------------------------
// Independent reference maths
// ---------------------------------------------------------------------------

function mulDivRhu(a: number, b: number, den: number): number {
  const num = BigInt(a) * BigInt(b);
  const d = BigInt(den);
  const negative = num < 0n;
  const abs = negative ? -num : num;
  let q = abs / d;
  if (2n * (abs % d) >= d) q += 1n;
  const value = Number(negative ? -q : q);
  return value === 0 ? 0 : value;
}

const neg = (p: number): number => (p === 0 ? 0 : -p);
const sum = (values: readonly number[]): number => values.reduce((a, v) => a + v, 0);

// ---------------------------------------------------------------------------
// The shift model (the test's own tallies)
// ---------------------------------------------------------------------------

interface PeriodTally {
  periodId: string;
  float: number;
  cashTendered: number;
  cardTendered: number;
  change: number;
  cashRefunded: number;
  cardRefunded: number;
  voids: number;
  noSales: number;
}

interface Shift {
  till: Till;
  rng: Rng;
  trace: string[];
  products: Product[];
  memberPercent: number;
  /** Every committed Sale record, in commit order. */
  receipts: Sale[];
  /** Expected on-hand per stock-tracked product. */
  stock: Map<string, number>;
  /** Expected unused deposit balance per booking. */
  balances: Map<string, number>;
  /** Units refunded so far per original sale line. */
  refunded: Map<string, number[]>;
  openTabs: string[];
  tally: PeriodTally;
  labelCounter: number;
  zCount: number;
}

const newTally = (periodId: string, float: number): PeriodTally => ({
  periodId,
  float,
  cashTendered: 0,
  cardTendered: 0,
  change: 0,
  cashRefunded: 0,
  cardRefunded: 0,
  voids: 0,
  noSales: 0,
});

const productById = (shift: Shift, id: string): Product => {
  const product = shift.products.find((p) => p.id === id);
  if (product === undefined) throw new Error(`Unknown product ${id}`);
  return product;
};

function randomBasketLines(shift: Shift, maxLines = 4): BasketState['lines'] {
  const { rng } = shift;
  return rng
    .shuffle(shift.products)
    .slice(0, rng.int(1, maxLines))
    .map((p) => ({ productId: p.id, qty: rng.weighted<() => number>([[() => rng.int(1, 3), 70], [() => rng.int(4, 7), 30]])() }));
}

function randomRequest(rng: Rng, remaining: number): TenderRequest {
  return rng.weighted<() => TenderRequest>([
    [() => ({ type: 'card', amountPence: null }), 18],
    [() => ({ type: 'card', amountPence: Math.floor((remaining * rng.pick([1, 30, 50, 99, 100, 150])) / 100) }), 20],
    [() => ({ type: 'cash', amountPence: rng.pick(QUICK_CASH_PENCE) }), 27],
    [() => ({ type: 'cash', amountPence: remaining }), 15],
    [() => ({ type: 'cash', amountPence: rng.int(1, 2 * remaining + 1) }), 20],
  ])();
}

/**
 * Takes random tenders until the session is complete, recording what was ACCEPTED. Checks the
 * card cap and change rules on every step (D-029).
 */
function tender<S extends PaySession>(shift: Shift, session: S): { session: S; taken: { type: TenderType; amountPence: number }[] } {
  let current: PaySession = session;
  const taken: { type: TenderType; amountPence: number }[] = [];
  for (let guard = 0; !current.tender.complete; guard += 1) {
    const remaining = current.tender.remainingPence;
    const request: TenderRequest = guard > 25 ? { type: 'card', amountPence: null } : randomRequest(shift.rng, remaining);
    const amount = request.amountPence ?? (request.type === 'card' ? remaining : 0);
    const result = takeTender(current, request);
    if (request.type === 'card' && amount > remaining) {
      expect(result.ok, `card ${amount} over the balance ${remaining} is rejected`).toBe(false);
      continue;
    }
    if (amount < 1) {
      expect(result.ok).toBe(false);
      continue;
    }
    if (!result.ok) throw new Error(`Tender rejected: ${result.message}`);
    taken.push({ type: request.type, amountPence: amount });
    current = result.session;
  }
  return { session: current as S, taken };
}

function recordTenders(shift: Shift, sale: Sale, taken: readonly { type: TenderType; amountPence: number }[]): void {
  const paid = sum(taken.map((t) => t.amountPence));
  expect(sale.tenders, 'the stored tenders are exactly those taken, in order').toEqual(taken);
  expect(sale.changePence, 'change = tendered - total').toBe(paid - sale.totalPence);
  shift.tally.cashTendered += sum(taken.filter((t) => t.type === 'cash').map((t) => t.amountPence));
  shift.tally.cardTendered += sum(taken.filter((t) => t.type === 'card').map((t) => t.amountPence));
  shift.tally.change += paid - sale.totalPence;
}

function seller(shift: Shift): Session {
  const { till, rng } = shift;
  return rng.pick([till.staff, till.supervisor, till.manager]);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function payBasket(shift: Shift, basket: BasketState): Promise<Sale> {
  const { h } = shift.till;
  const balanceBefore = basket.bookingId === undefined ? null : (shift.balances.get(basket.bookingId) ?? 0);
  const { session, taken } = tender(shift, await openSalePayment(h.ctx, basket));
  const { sale } = await completePayment(h.ctx, auth(seller(shift), 'sell'), session);
  shift.trace.push(`sale ${sale.receiptNumber} total ${sale.totalPence} tenders ${JSON.stringify(taken)}`);

  // The receipt's own arithmetic (spec §7), recomputed.
  const finals = sum(sale.lines.map((l) => l.finalPence));
  for (const line of sale.lines) {
    const product = productById(shift, line.productId);
    expect(line.unitPricePence).toBe(product.pricePence);
    expect(line.finalPence).toBe(line.qty * line.unitPricePence - line.dealDiscountPence - line.memberDiscountPence);
    expect(line.vatPence).toBe(mulDivRhu(line.finalPence, line.vatRate, 100 + line.vatRate));
    expect(line.dealDiscountPence).toBeGreaterThanOrEqual(0);
    expect(line.dealDiscountPence).toBeLessThanOrEqual(line.qty * line.unitPricePence);
    expect(line.memberDiscountPence).toBeGreaterThanOrEqual(0);
  }
  const base = sum(sale.lines.filter((l) => productById(shift, l.productId).memberDiscountEligible).map((l) => l.qty * l.unitPricePence - l.dealDiscountPence));
  expect(sale.memberDiscountPence, 'member discount = round-half-up(base x pct / 100)').toBe(basket.memberId === undefined ? 0 : mulDivRhu(base, shift.memberPercent, 100));
  expect(sale.memberDiscountPence).toBe(sum(sale.lines.map((l) => l.memberDiscountPence)));
  expect(sale.depositAppliedPence, 'deposit applied = min(balance, total after discounts)').toBe(balanceBefore === null ? 0 : Math.min(balanceBefore, finals));
  expect(sale.totalPence).toBe(finals - sale.depositAppliedPence);
  expect(sale.periodId).toBe(shift.tally.periodId);

  recordTenders(shift, sale, taken);
  if (basket.bookingId !== undefined) shift.balances.set(basket.bookingId, (balanceBefore ?? 0) - sale.depositAppliedPence);
  for (const line of sale.lines) {
    if (productById(shift, line.productId).stockTracked) shift.stock.set(line.productId, (shift.stock.get(line.productId) ?? 0) - line.qty);
  }
  shift.refunded.set(sale.id, sale.lines.map(() => 0));
  shift.receipts.push(sale);
  return sale;
}

async function opSale(shift: Shift): Promise<void> {
  const { rng, till } = shift;
  const attachable = [...shift.balances.entries()].filter(([, balance]) => balance > 0).map(([id]) => id);
  const basket: BasketState = {
    lines: randomBasketLines(shift),
    ...(rng.bool(0.4) ? { memberId: till.c.member.id } : {}),
    ...(attachable.length > 0 && rng.bool(0.35) ? { bookingId: rng.pick(attachable) } : {}),
  };
  await payBasket(shift, basket);
}

async function opDeposit(shift: Shift): Promise<void> {
  const { rng, till } = shift;
  const { h, staff } = till;
  let bookingId = shift.balances.size > 0 && rng.bool(0.5) ? rng.pick([...shift.balances.keys()]) : undefined;
  if (bookingId === undefined) {
    const booking = await saveBooking(h.ctx, auth(staff, 'bookings'), null, {
      type: rng.pick(['wedding', 'society', 'eventTicket', 'other'] as const),
      name: `Booking ${shift.balances.size + 1}`,
      date: '2026-11-14',
      notes: '',
    });
    bookingId = booking.id;
    shift.balances.set(bookingId, 0);
  }
  const amount = rng.weighted<() => number>([[() => rng.int(1, 999), 20], [() => rng.int(1000, 30_000), 80]])();
  const { session, taken } = tender(shift, await openDepositPayment(h.ctx, bookingId, amount));
  const { sale } = await completePayment(h.ctx, auth(seller(shift), 'bookings'), session);
  shift.trace.push(`deposit ${sale.receiptNumber} ${amount} tenders ${JSON.stringify(taken)}`);
  expect(sale).toMatchObject({ kind: 'deposit', bookingId, totalPence: amount, lines: [], memberDiscountPence: 0, depositAppliedPence: 0 });
  expect(sale.periodId).toBe(shift.tally.periodId);
  recordTenders(shift, sale, taken);
  shift.balances.set(bookingId, (shift.balances.get(bookingId) ?? 0) + amount);
  shift.receipts.push(sale);
}

async function opRefund(shift: Shift): Promise<boolean> {
  const { rng, till } = shift;
  const { h, manager } = till;
  const originals = shift.receipts.filter((s) => {
    const done = shift.refunded.get(s.id);
    return s.kind === 'sale' && done !== undefined && s.lines.some((l, j) => l.qty > (done[j] ?? 0));
  });
  if (originals.length === 0) return false;
  const original = rng.pick(originals);
  const done = shift.refunded.get(original.id) ?? [];
  const available = original.lines.map((l, j) => l.qty - (done[j] ?? 0));

  if (rng.bool(0.15)) {
    // Refunding more than is left is refused and writes nothing (D-036).
    const j = rng.int(0, original.lines.length - 1);
    const outboxBefore = await h.repos.outbox.count();
    let refused: unknown;
    try {
      await commitRefund(h.ctx, auth(manager, 'refund'), { originalSaleId: original.id, lines: [{ lineIndex: j, qty: (available[j] ?? 0) + 1, returnToStock: true }], tenderType: 'cash' });
    } catch (error) {
      refused = error;
    }
    expect(isAppError(refused) && refused.code === 'VALIDATION', `over-refund of line ${j} is refused`).toBe(true);
    expect(await h.repos.outbox.count()).toBe(outboxBefore);
  }

  let lines = original.lines.flatMap((_, j) => {
    const left = available[j] ?? 0;
    return left > 0 && rng.bool(0.6) ? [{ lineIndex: j, qty: rng.int(1, left), returnToStock: rng.bool(0.7) }] : [];
  });
  if (lines.length === 0) {
    const j = available.findIndex((a) => a > 0);
    lines = [{ lineIndex: j, qty: 1, returnToStock: true }];
  }
  const tenderType: TenderType = rng.bool(0.6) ? 'cash' : 'card';
  shift.trace.push(`refund of ${original.receiptNumber} ${JSON.stringify(lines)} by ${tenderType}`);
  const { sale: refund } = await commitRefund(h.ctx, auth(manager, 'refund'), { originalSaleId: original.id, lines, tenderType });
  shift.trace.push(`  -> ${refund.receiptNumber} total ${refund.totalPence}`);

  expect(refund).toMatchObject({ kind: 'refund', refundOfSaleId: original.id, changePence: 0, depositAppliedPence: 0 });
  expect(refund.periodId).toBe(shift.tally.periodId);
  expect(refund.totalPence).toBe(sum(refund.lines.map((l) => l.finalPence)));
  expect(refund.totalPence).toBeLessThanOrEqual(0);
  expect(refund.tenders).toEqual(refund.totalPence === 0 ? [] : [{ type: tenderType, amountPence: refund.totalPence }]);
  if (tenderType === 'cash') shift.tally.cashRefunded += neg(refund.totalPence);
  else shift.tally.cardRefunded += neg(refund.totalPence);

  for (const line of refund.lines) {
    const j = line.refundOfLineIndex ?? -1;
    done[j] = (done[j] ?? 0) - line.qty;
    expect(done[j], 'refunded never exceeds sold').toBeLessThanOrEqual(original.lines[j]?.qty ?? 0);
    const product = productById(shift, line.productId);
    // Return to stock: +q; waste: +q then -q (D-039). Untracked products move nothing.
    if (product.stockTracked && line.returnToStock === true) shift.stock.set(line.productId, (shift.stock.get(line.productId) ?? 0) - line.qty);
  }
  shift.refunded.set(original.id, done);
  shift.receipts.push(refund);
  return true;
}

async function opOpenTab(shift: Shift): Promise<void> {
  const { rng, till } = shift;
  shift.labelCounter += 1;
  const basket: BasketState = { lines: randomBasketLines(shift, 3), ...(rng.bool(0.4) ? { memberId: till.c.member.id } : {}) };
  const labelType = rng.bool() ? 'table' : 'name';
  const { tab } = await openNewTab(till.h.ctx, auth(till.staff, 'tabs'), basket, labelType, labelType === 'table' ? `${shift.labelCounter}` : `Guest ${shift.labelCounter}`);
  shift.trace.push(`open tab ${tab.label} ${JSON.stringify(basket.lines)}`);
  shift.openTabs.push(tab.id);
}

async function opSettleTab(shift: Shift): Promise<boolean> {
  const { rng, till } = shift;
  if (shift.openTabs.length === 0) return false;
  const tabId = rng.pick(shift.openTabs);
  const basket = await loadTab(till.h.ctx, auth(till.staff, 'tabs'), EMPTY_BASKET, tabId);
  shift.trace.push(`settle tab ${tabId}`);
  const sale = await payBasket(shift, basket);
  expect(sale.tabId).toBe(tabId);
  expect((await till.h.repos.tabs.get(tabId))?.status).toBe('settled');
  shift.openTabs = shift.openTabs.filter((id) => id !== tabId);
  return true;
}

async function opVoid(shift: Shift): Promise<void> {
  const { rng, till } = shift;
  const basket: BasketState = { lines: randomBasketLines(shift, 3) };
  const line = rng.pick(basket.lines);
  await voidLine(till.h.ctx, auth(till.supervisor, 'voidLine'), basket, line.productId, rng.int(1, line.qty));
  shift.trace.push(`void ${line.productId}`);
  shift.tally.voids += 1;
}

async function opNoSale(shift: Shift): Promise<void> {
  await recordNoSale(shift.till.h.ctx, auth(shift.till.supervisor, 'noSale'));
  shift.trace.push('no sale');
  shift.tally.noSales += 1;
}

async function opGoodsIn(shift: Shift): Promise<void> {
  const { rng, till } = shift;
  const product = rng.pick(shift.products.filter((p) => p.stockTracked));
  const qty = rng.int(1, 60);
  await recordGoodsIn(till.h.ctx, auth(till.manager, 'stockControl'), { productId: product.id, qty, note: 'Delivery' });
  shift.trace.push(`goods in ${product.name} ${qty}`);
  shift.stock.set(product.id, (shift.stock.get(product.id) ?? 0) + qty);
}

async function opAdjust(shift: Shift): Promise<void> {
  const { rng, till } = shift;
  const product = rng.pick(shift.products.filter((p) => p.stockTracked));
  const kind = rng.bool() ? 'adjustment' : 'waste';
  const qty = kind === 'waste' ? rng.int(1, 5) : rng.pick([-1, 1]) * rng.int(1, 10);
  const movement = await recordStockAdjustment(till.h.ctx, auth(till.manager, 'stockControl'), { productId: product.id, kind, qty, note: 'Stock count' });
  shift.trace.push(`${kind} ${product.name} ${qty}`);
  expect(movement.qty).toBe(kind === 'waste' ? -qty : qty);
  shift.stock.set(product.id, (shift.stock.get(product.id) ?? 0) + movement.qty);
}

// ---------------------------------------------------------------------------
// Period checks: X read and Z close against the receipts and the tallies
// ---------------------------------------------------------------------------

function figuresFromReceipts(receipts: readonly Sale[], tally: PeriodTally): PeriodFigures {
  const SL = receipts.filter((s) => s.kind === 'sale').flatMap((s) => s.lines);
  const RL = receipts.filter((s) => s.kind === 'refund').flatMap((s) => s.lines);
  const byRate = new Map<number, { gross: number; vat: number }>();
  for (const line of [...SL, ...RL]) {
    const row = byRate.get(line.vatRate) ?? { gross: 0, vat: 0 };
    byRate.set(line.vatRate, { gross: row.gross + line.finalPence, vat: row.vat + line.vatPence });
  }
  const tenders = (kinds: readonly Sale['kind'][], type: TenderType): number =>
    sum(receipts.filter((s) => kinds.includes(s.kind)).flatMap((s) => s.tenders.filter((t) => t.type === type).map((t) => t.amountPence)));
  const cashTendered = tenders(['sale', 'deposit'], 'cash');
  const cardTendered = tenders(['sale', 'deposit'], 'card');
  const change = sum(receipts.map((s) => s.changePence));
  const cashRefunded = neg(tenders(['refund'], 'cash'));
  const cardRefunded = neg(tenders(['refund'], 'card'));
  return {
    grossSalesPence: sum(SL.map((l) => l.qty * l.unitPricePence)),
    dealDiscountsPence: sum(SL.map((l) => l.dealDiscountPence)),
    memberDiscountsPence: sum(SL.map((l) => l.memberDiscountPence)),
    refundsPence: neg(sum(RL.map((l) => l.finalPence))),
    netTakingsPence: sum([...SL, ...RL].map((l) => l.finalPence)),
    depositsTakenPence: sum(receipts.filter((s) => s.kind === 'deposit').map((s) => s.totalPence)),
    depositsAppliedPence: sum(receipts.filter((s) => s.kind === 'sale').map((s) => s.depositAppliedPence)),
    cashTenderedPence: cashTendered,
    changeGivenPence: change,
    cashRefundedPence: cashRefunded,
    cashTotalPence: cashTendered - change - cashRefunded,
    cardTenderedPence: cardTendered,
    cardRefundedPence: cardRefunded,
    cardTotalPence: cardTendered - cardRefunded,
    vatByRate: [...byRate.entries()].sort(([a], [b]) => b - a).map(([vatRate, r]) => ({ vatRate, grossPence: r.gross, vatPence: r.vat, netPence: r.gross - r.vat })),
    floatPence: tally.float,
    expectedCashPence: tally.float + cashTendered - change - cashRefunded,
    noSaleCount: tally.noSales,
    voidCount: tally.voids,
  };
}

function expectReconciles(figures: PeriodFigures, receipts: readonly Sale[]): void {
  const lineFinals = sum(receipts.filter((s) => s.kind !== 'deposit').flatMap((s) => s.lines.map((l) => l.finalPence)));
  expect(figures.netTakingsPence, 'D-042 (1)').toBe(lineFinals);
  expect(figures.cashTotalPence + figures.cardTotalPence, 'D-042 (2)').toBe(figures.netTakingsPence - figures.depositsAppliedPence + figures.depositsTakenPence);
  expect(figures.expectedCashPence, 'D-042 (3)').toBe(figures.floatPence + figures.cashTotalPence);
  expect(sum(figures.vatByRate.map((r) => r.grossPence)), 'D-042 (4)').toBe(figures.netTakingsPence);
  for (const row of figures.vatByRate) expect(row.netPence + row.vatPence, 'D-042 (4) per rate').toBe(row.grossPence);
  expect(figures.grossSalesPence - figures.dealDiscountsPence - figures.memberDiscountsPence, 'D-042 (5)').toBe(
    sum(receipts.filter((s) => s.kind === 'sale').flatMap((s) => s.lines.map((l) => l.finalPence))),
  );
  for (const sale of receipts) expect(sum(sale.tenders.map((t) => t.amountPence)) - sale.changePence, `D-042 (6) ${sale.receiptNumber}`).toBe(sale.totalPence);
}

async function xAndZ(shift: Shift): Promise<void> {
  const { rng, till } = shift;
  const { h, manager, supervisor } = till;
  const { tally } = shift;
  const receipts = shift.receipts.filter((s) => s.periodId === tally.periodId);
  const expected = figuresFromReceipts(receipts, tally);

  // The drawer, from the tenders this test actually took (not from stored records).
  expect(expected.cashTenderedPence, 'cash tendered').toBe(tally.cashTendered);
  expect(expected.cardTenderedPence, 'card tendered').toBe(tally.cardTendered);
  expect(expected.changeGivenPence, 'change given').toBe(tally.change);
  expect(expected.cashRefundedPence, 'cash refunded').toBe(tally.cashRefunded);
  expect(expected.cardRefundedPence, 'card refunded').toBe(tally.cardRefunded);
  expect(expected.expectedCashPence, 'expected cash = float + cash tendered - change - cash refunded').toBe(
    tally.float + tally.cashTendered - tally.change - tally.cashRefunded,
  );

  const x = await runXRead(h.ctx, auth(supervisor, 'xRead'));
  expect(x.period.id).toBe(tally.periodId);
  expect(x.figures, 'X read = the sum of the receipts').toEqual(expected);
  expectReconciles(x.figures, receipts);

  const declared = Math.max(0, expected.expectedCashPence + rng.int(-500, 500));
  const preview = await previewZClose(h.ctx, declared);
  expect(preview).toEqual({ expectedCashPence: expected.expectedCashPence, declaredCashPence: declared, variancePence: declared - expected.expectedCashPence });
  const z = await confirmZClose(h.ctx, auth(manager, 'openClosePeriod'), EMPTY_BASKET, declared);
  shift.zCount += 1;
  shift.trace.push(`Z ${shift.zCount} declared ${declared}`);
  expect(z.figures, 'Z report = the sum of the receipts').toEqual({ ...expected, declaredCashPence: declared, variancePence: declared - expected.expectedCashPence });
  expect(z.period).toMatchObject({ id: tally.periodId, declaredCashPence: declared, zNumber: shift.zCount });
  const zEvents = (await h.repos.auditEvents.listByPeriod(tally.periodId)).filter((e): e is Extract<AuditEvent, { type: 'zClose' }> => e.type === 'zClose');
  expect(zEvents.map((e) => e.detail)).toEqual([
    { zNumber: shift.zCount, floatPence: tally.float, expectedCashPence: expected.expectedCashPence, declaredCashPence: declared, variancePence: declared - expected.expectedCashPence },
  ]);
}

// ---------------------------------------------------------------------------
// End-of-shift checks: reports, stock, bookings, receipt numbers
// ---------------------------------------------------------------------------

async function checkReports(shift: Shift, fromDate: string, toDate: string): Promise<void> {
  const { h, manager } = shift.till;
  const range = localDateRange(fromDate, toDate);
  if (range === null) throw new Error(`bad range ${fromDate}..${toDate}`);
  const inRange = shift.receipts.filter((s) => s.kind !== 'deposit' && range.fromInclusive <= s.createdAt && s.createdAt < range.toExclusive);
  const lines = inRange.flatMap((s) => s.lines);

  const vat = await runVatReport(h.ctx, auth(manager, 'salesReports'), fromDate, toDate);
  const byRate = new Map<number, { gross: number; vat: number }>();
  for (const line of lines) {
    const row = byRate.get(line.vatRate) ?? { gross: 0, vat: 0 };
    byRate.set(line.vatRate, { gross: row.gross + line.finalPence, vat: row.vat + line.vatPence });
  }
  expect(vat.rows, `VAT report ${fromDate}..${toDate} per rate = sum of line figures`).toEqual(
    [...byRate.entries()].sort(([a], [b]) => b - a).map(([vatRate, r]) => ({ vatRate, grossPence: r.gross, vatPence: r.vat, netPence: r.gross - r.vat })),
  );
  expect(vat.totals).toEqual({ grossPence: sum(lines.map((l) => l.finalPence)), vatPence: sum(lines.map((l) => l.vatPence)), netPence: sum(lines.map((l) => l.finalPence - l.vatPence)) });

  const sales = await runProductSalesReport(h.ctx, auth(manager, 'salesReports'), fromDate, toDate);
  const rows = sales.categories.flatMap((c) => c.products);
  expect(rows.map((r) => r.productId).sort(), `products listed ${fromDate}..${toDate}`).toEqual([...new Set(lines.map((l) => l.productId))].sort());
  for (const row of rows) {
    const own = lines.filter((l) => l.productId === row.productId);
    expect(row.qty, `${row.name} qty`).toBe(sum(own.map((l) => l.qty)));
    expect(row.takingsPence, `${row.name} takings`).toBe(sum(own.map((l) => l.finalPence)));
    expect(row.name).toBe(productById(shift, row.productId).name);
  }
  for (const category of sales.categories) {
    expect(category.qty).toBe(sum(category.products.map((p) => p.qty)));
    expect(category.takingsPence).toBe(sum(category.products.map((p) => p.takingsPence)));
    for (const p of category.products) expect(productById(shift, p.productId).categoryId).toBe(category.categoryId);
  }
  expect(sales.totalTakingsPence, 'product sales total = VAT report total gross').toBe(vat.totals.grossPence);
  expect(sales.totalQty).toBe(sum(lines.map((l) => l.qty)));
}

async function checkStock(shift: Shift): Promise<void> {
  const { h } = shift.till;
  const levels = await listStockLevels(h.ctx);
  const tracked = shift.products.filter((p) => p.stockTracked);
  expect(levels.map((l) => l.product.id).sort()).toEqual(tracked.map((p) => p.id).sort());
  for (const level of levels) {
    const movements = await h.repos.stockMovements.listByProduct(level.product.id);
    expect(level.onHand, `${level.product.name}: on hand = the sum of its movements`).toBe(sum(movements.map((m) => m.qty)));
    expect(level.onHand, `${level.product.name}: on hand = the test's tally`).toBe(shift.stock.get(level.product.id) ?? 0);
    expect(await h.repos.stockMovements.onHand(level.product.id)).toBe(level.onHand);
  }
  for (const product of shift.products.filter((p) => !p.stockTracked)) {
    expect(await h.repos.stockMovements.listByProduct(product.id), `${product.name} is untracked`).toEqual([]);
  }
  const low = await listLowStock(h.ctx);
  const expectedLow = levels.filter((l) => l.product.active && l.onHand <= l.product.lowStockLevel);
  expect(low.map((l) => l.product.id).sort()).toEqual(expectedLow.map((l) => l.product.id).sort());
  const gaps = low.map((l) => l.onHand - l.product.lowStockLevel);
  expect(gaps, 'low-stock list sorted by (on hand - low level)').toEqual([...gaps].sort((a, b) => a - b));
}

async function checkBookingsAndReceipts(shift: Shift): Promise<void> {
  const { h } = shift.till;
  for (const [bookingId, balance] of shift.balances) {
    const fromReceipts =
      sum(shift.receipts.filter((s) => s.kind === 'deposit' && s.bookingId === bookingId).map((s) => s.totalPence)) -
      sum(shift.receipts.filter((s) => s.kind === 'sale' && s.bookingId === bookingId).map((s) => s.depositAppliedPence));
    expect(fromReceipts).toBe(balance);
    expect(await h.repos.sales.bookingBalance(bookingId), `booking ${bookingId} balance`).toBe(balance);
  }
  const { devicePrefix } = await getSettings(h.ctx);
  expect(shift.receipts.map((s) => s.receiptNumber)).toEqual(shift.receipts.map((_, i) => `${devicePrefix}-${String(i + 1).padStart(6, '0')}`));
  for (const sale of shift.receipts) {
    const paid = sum(sale.tenders.map((t) => t.amountPence));
    expect(paid - sale.changePence, `${sale.receiptNumber}: tenders - change = total`).toBe(sale.totalPence);
    const last = sale.tenders[sale.tenders.length - 1];
    if (sale.changePence > 0) {
      expect(last?.type, `${sale.receiptNumber}: only cash gives change`).toBe('cash');
      expect(sale.changePence).toBeLessThan(last?.amountPence ?? 0);
    }
    let running = 0;
    for (const t of sale.tenders) {
      if (sale.kind !== 'refund' && t.type === 'card') expect(t.amountPence, `${sale.receiptNumber}: card within the balance`).toBeLessThanOrEqual(sale.totalPence - running);
      running += t.amountPence;
    }
  }
  expect(await h.repos.sales.list()).toHaveLength(shift.receipts.length);
}

// ---------------------------------------------------------------------------
// The shift driver
// ---------------------------------------------------------------------------

const SHIFTS = 20;
const BASE_SEED = 0x5eed5000;
const STARTS = ['2026-09-26T10:00:00.000Z', '2026-09-26T20:30:00.000Z', '2026-10-24T21:00:00.000Z'] as const;
const MINUTE = 60_000;

type Op = 'sale' | 'deposit' | 'refund' | 'openTab' | 'settleTab' | 'void' | 'noSale' | 'goodsIn' | 'adjust' | 'zClose';

async function runShift(seed: number, trace: string[]): Promise<void> {
  const rng = makeRng(seed);
  const start = rng.pick(STARTS);
  const float = rng.int(0, 20_000);
  trace.push(`start ${start} float ${float}`);
  const till = await setupTill({ start, floatPence: float });
  const { h, manager, c } = till;

  // Randomise the catalogue: member percent, overlapping deals and an extra product.
  const settings = await getSettings(h.ctx);
  const memberPercent = rng.pick([10, 15, 15, 20, 25]);
  if (memberPercent !== settings.memberDiscountPercent) {
    await saveSettings(h.ctx, auth(manager, 'manageMembersStaffSettings'), {
      clubName: settings.clubName,
      receiptFooter: settings.receiptFooter,
      autoLockMinutes: settings.autoLockMinutes,
      memberDiscountPercent: memberPercent,
      devicePrefix: settings.devicePrefix,
    });
  }
  if (rng.bool(0.6)) {
    const pricePence = rng.int(700, 1000);
    await saveDeal(h.ctx, auth(manager, 'editCatalogue'), null, { name: 'Any 2 pints', type: 'nForPrice', n: 2, pricePence, productIds: [c.lager.id, c.bitter.id], active: true });
    trace.push(`deal Any 2 pints ${pricePence}`);
  }
  if (rng.bool(0.4)) {
    await saveDeal(h.ctx, auth(manager, 'editCatalogue'), null, { name: 'Crisps 3 for 2', type: 'nForM', n: 3, m: 2, productIds: [c.crisps.id], active: true });
    trace.push('deal Crisps 3 for 2');
  }
  if (rng.bool(0.7)) {
    const stockTracked = rng.bool(0.6);
    const extra = await saveProduct(h.ctx, auth(manager, 'editCatalogue'), null, {
      name: 'Prosecco',
      categoryId: c.wine.id,
      pricePence: rng.int(500, 3000),
      vatRate: 5,
      memberDiscountEligible: rng.bool(),
      stockTracked,
      stockUnit: 'glass',
      lowStockLevel: stockTracked ? rng.int(0, 10) : 0,
      buttonColour: c.wine.colour,
      sortOrder: 2,
      active: true,
    });
    trace.push(`product Prosecco ${extra.pricePence} tracked ${String(stockTracked)}`);
    if (stockTracked) await recordGoodsIn(h.ctx, auth(manager, 'stockControl'), { productId: extra.id, qty: rng.int(0, 1) === 0 ? 5 : 30, note: 'Opening stock' });
  }

  const products = await h.repos.products.list();
  const onHand = await h.repos.stockMovements.onHandByProduct();
  expect([onHand[c.lager.id], onHand[c.bitter.id], onHand[c.crisps.id], onHand[c.wineBottle.id]]).toEqual([48, 48, 36, 12]);
  const period = await h.repos.periods.getOpen();
  if (period === undefined) throw new Error('no open period');
  const shift: Shift = {
    till,
    rng,
    trace,
    products,
    memberPercent,
    receipts: [],
    stock: new Map(products.filter((p) => p.stockTracked).map((p) => [p.id, onHand[p.id] ?? 0])),
    balances: new Map(),
    refunded: new Map(),
    openTabs: [],
    tally: newTally(period.id, float),
    labelCounter: 0,
    zCount: 0,
  };

  const opCount = rng.int(10, 18);
  let midShiftZ = false;
  for (let i = 0; i < opCount; i += 1) {
    h.clock.advance(rng.int(1, 45) * MINUTE);
    const op = rng.weighted<Op>([
      ['sale', 36],
      ['deposit', 10],
      ['refund', 14],
      ['openTab', 8],
      ['settleTab', 8],
      ['void', 5],
      ['noSale', 4],
      ['goodsIn', 5],
      ['adjust', 5],
      ['zClose', midShiftZ || i < 4 ? 0 : 5],
    ]);
    switch (op) {
      case 'sale':
        await opSale(shift);
        break;
      case 'deposit':
        await opDeposit(shift);
        break;
      case 'refund':
        if (!(await opRefund(shift))) await opSale(shift);
        break;
      case 'openTab':
        await opOpenTab(shift);
        break;
      case 'settleTab':
        if (!(await opSettleTab(shift))) await opOpenTab(shift);
        break;
      case 'void':
        await opVoid(shift);
        break;
      case 'noSale':
        await opNoSale(shift);
        break;
      case 'goodsIn':
        await opGoodsIn(shift);
        break;
      case 'adjust':
        await opAdjust(shift);
        break;
      case 'zClose': {
        midShiftZ = true;
        await xAndZ(shift);
        const nextFloat = rng.int(0, 20_000);
        const next = await openPeriod(h.ctx, auth(manager, 'openClosePeriod'), nextFloat);
        trace.push(`open period float ${nextFloat}`);
        shift.tally = newTally(next.id, nextFloat);
        break;
      }
    }
  }
  // Settle a carried tab in the final period now and then, then close the day.
  if (shift.openTabs.length > 0 && rng.bool(0.5)) await opSettleTab(shift);
  h.clock.advance(5 * MINUTE);
  await xAndZ(shift);

  // Reports: each London date the shift touched, the whole span, and an empty day before it.
  const dates = [...new Set(shift.receipts.map((s) => londonDateOf(s.createdAt)))].sort();
  const first = dates[0] ?? londonDateOf(start);
  const last = dates[dates.length - 1] ?? first;
  for (const date of dates) await checkReports(shift, date, date);
  await checkReports(shift, first, last);
  await checkReports(shift, addDays(first, -1), addDays(first, -1));
  await checkStock(shift);
  await checkBookingsAndReceipts(shift);
}

describe('services invariants over random mini-shifts (LocalAdapter, fake-indexeddb)', () => {
  for (let index = 0; index < SHIFTS; index += 1) {
    const seed = (BASE_SEED + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
    it(`shift ${index} (seed ${seed}): X/Z, cash-up, VAT, product sales and stock all reconcile to the receipts`, async () => {
      const trace: string[] = [];
      try {
        await runShift(seed, trace);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Shift seed ${seed} failed.\nTrace:\n  ${trace.join('\n  ')}\nReason: ${reason}`, { cause: error });
      }
    }, 60_000);
  }
});

describe('services example found by the rules properties', () => {
  it('a partial refund of a line with a 1p deal saving and 100% member discount can be committed (D-032 vs D-037)', async () => {
    // Lager x2 @450, deal "2 for £8.99" (saving 1p), member discount 100%: line deal 1, member 899,
    // final 0, total 0. Refunding 1 of the 2 must be possible (spec §6.8) and pay out <= 0.
    const { h, manager, c } = await setupTill();
    const settings = await getSettings(h.ctx);
    await saveSettings(h.ctx, auth(manager, 'manageMembersStaffSettings'), {
      clubName: settings.clubName,
      receiptFooter: settings.receiptFooter,
      autoLockMinutes: settings.autoLockMinutes,
      memberDiscountPercent: 100,
      devicePrefix: settings.devicePrefix,
    });
    await saveDeal(h.ctx, auth(manager, 'editCatalogue'), null, { name: '2 for £8.99', type: 'nForPrice', n: 2, pricePence: 899, productIds: [c.lager.id], active: true });
    const pay = await openSalePayment(h.ctx, { lines: [{ productId: c.lager.id, qty: 2 }], memberId: c.member.id });
    expect(pay.priced.lines[0]).toMatchObject({ dealDiscountPence: 1, memberDiscountPence: 899, finalPence: 0 });
    const { sale } = await completePayment(h.ctx, auth(manager, 'sell'), pay);
    expect(sale.totalPence).toBe(0);

    let outcome: unknown;
    try {
      outcome = (await commitRefund(h.ctx, auth(manager, 'refund'), { originalSaleId: sale.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' })).sale;
    } catch (error) {
      outcome = isAppError(error) ? `AppError ${error.code}: ${error.message}` : error;
    }
    expect(outcome, 'the partial refund commits').toMatchObject({ kind: 'refund', refundOfSaleId: sale.id });
    const refund = outcome as Sale;
    expect(refund.totalPence).toBeLessThanOrEqual(0);
    expect(refund.lines[0]?.finalPence).toBeLessThanOrEqual(0);
  });
});
