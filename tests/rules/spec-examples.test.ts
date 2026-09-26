/**
 * Blind spec-example tests for the rules layer.
 *
 * Source: docs/design-spec.md §5, §7 and §10.1, refined by docs/decisions.md (D-nnn).
 * Every expected pence value was computed BY HAND from the spec and decisions, with the arithmetic
 * in the comments. These tests were written against the exported signatures and JSDoc only,
 * without reading the rule bodies in src/rules/ or the builder's tests in tests/rules/.
 *
 * Notation: "x*20/120 = 62.5 -> 63" means round-half-up (D-002) of that rational.
 */
import { describe, expect, it } from 'vitest';
import type { Action, AuditEvent, Deal, Period, Role, Sale, SaleLine } from '../../src/data/types';
import { expectedCash, periodFigures, zFigures, type PeriodFigures } from '../../src/rules/cashup';
import { memberDiscount } from '../../src/rules/discount';
import { allocate, mulDivRoundHalfUp, roundHalfUp } from '../../src/rules/money';
import { ACTIONS, ACTION_LABELS, can, minRoleFor, overridePrompt } from '../../src/rules/permissions';
import { depositApplied, priceBasket, toSaleLines, type PricedBasket, type PricingLine } from '../../src/rules/pricing';
import { buildRefundLine, buildRefundSale, refundableQuantities } from '../../src/rules/refund';
import { validateSale } from '../../src/rules/sale';
import {
  applyTender,
  startTendering,
  tenderSequenceProblems,
  type TenderOutcome,
  type TenderState,
} from '../../src/rules/tender';
import { lineVat, vatSummary, vatTotals } from '../../src/rules/vat';

// ---------------------------------------------------------------------------
// Fixtures and helpers (local to this file on purpose: no shared fixtures)
// ---------------------------------------------------------------------------

const AT = '2026-09-26T12:00:00.000Z';
const DEVICE = '3f9c2a01-7b4d-4e8a-9c1f-000000000000';
const T_DEAL_1 = '2026-09-01T09:00:00.000Z';
const T_DEAL_2 = '2026-09-02T09:00:00.000Z';
const T_SALE = '2026-09-26T13:05:12.345Z';

function pl(
  productId: string,
  qty: number,
  unitPricePence: number,
  opts: { vatRate?: number; eligible?: boolean } = {},
): PricingLine {
  return {
    productId,
    name: productId,
    qty,
    unitPricePence,
    vatRate: opts.vatRate ?? 20,
    memberDiscountEligible: opts.eligible ?? true,
  };
}

function nForPrice(id: string, name: string, n: number, pricePence: number, productIds: string[], createdAt = T_DEAL_1): Deal {
  return { id, deviceId: DEVICE, createdAt, updatedAt: createdAt, name, type: 'nForPrice', n, pricePence, productIds, active: true };
}

function nForM(id: string, name: string, n: number, m: number, productIds: string[], createdAt = T_DEAL_1): Deal {
  return { id, deviceId: DEVICE, createdAt, updatedAt: createdAt, name, type: 'nForM', n, m, productIds, active: true };
}

function price(
  lines: PricingLine[],
  opts: { deals?: Deal[]; memberPercent?: number | null; depositBalance?: number | null } = {},
): PricedBasket {
  return priceBasket({
    lines,
    deals: opts.deals ?? [],
    at: AT,
    memberDiscountPercent: opts.memberPercent ?? null,
    depositBalancePence: opts.depositBalance ?? null,
  });
}

interface LineFigures {
  id: string;
  gross: number;
  deal: number;
  member: number;
  final: number;
  vat: number;
  net: number;
}

/** Hand-computed line figures, in basket order. */
function L(id: string, gross: number, deal: number, member: number, final: number, vat: number, net: number): LineFigures {
  return { id, gross, deal, member, final, vat, net };
}

function figs(p: PricedBasket): LineFigures[] {
  return p.lines.map((l) => ({
    id: l.productId,
    gross: l.grossPence,
    deal: l.dealDiscountPence,
    member: l.memberDiscountPence,
    final: l.finalPence,
    vat: l.vatPence,
    net: l.netPence,
  }));
}

function totals(p: PricedBasket) {
  return {
    gross: p.grossPence,
    deal: p.dealDiscountPence,
    member: p.memberDiscountPence,
    subtotal: p.subtotalPence,
    deposit: p.depositAppliedPence,
    total: p.totalPence,
  };
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Spec §7 identities every priced basket must satisfy (lines sum to the basket; reports = receipts). */
function expectConsistent(p: PricedBasket): void {
  for (const l of p.lines) {
    expect(l.grossPence).toBe(l.qty * l.unitPricePence); // §7.1
    expect(l.finalPence).toBe(l.grossPence - l.dealDiscountPence - l.memberDiscountPence); // §7.5
    expect(l.netPence).toBe(l.finalPence - l.vatPence); // §7.5
  }
  expect(sum(p.lines.map((l) => l.finalPence))).toBe(p.subtotalPence);
  expect(p.totalPence).toBe(p.subtotalPence - p.depositAppliedPence); // §7.6
  expect(sum(p.vatSummary.map((r) => r.grossPence))).toBe(p.subtotalPence);
  expect(sum(p.vatSummary.map((r) => r.vatPence))).toBe(sum(p.lines.map((l) => l.vatPence)));
  expect(sum(p.dealLines.map((d) => d.savingPence))).toBe(p.dealDiscountPence);
  expect(sum(p.lines.map((l) => l.dealDiscountPence))).toBe(p.dealDiscountPence);
  expect(sum(p.lines.map((l) => l.memberDiscountPence))).toBe(p.memberDiscountPence);
}

function tenderOk(outcome: TenderOutcome): TenderState {
  if (!outcome.ok) throw new Error(`unexpected tender rejection: ${outcome.reason} (${outcome.message})`);
  return outcome.state;
}

function saleRecord(over: Partial<Sale> & Pick<Sale, 'id' | 'kind' | 'periodId' | 'totalPence'>): Sale {
  return {
    deviceId: DEVICE,
    createdAt: T_SALE,
    updatedAt: T_SALE,
    receiptNumber: `3F9C-${over.id}`,
    staffId: 'staff-manager',
    lines: [],
    dealLines: [],
    memberDiscountPence: 0,
    depositAppliedPence: 0,
    tenders: [],
    changePence: 0,
    ...over,
  };
}

function periodRecord(id: string, floatPence: number): Period {
  return { id, deviceId: DEVICE, createdAt: T_SALE, updatedAt: T_SALE, openedAt: T_SALE, openedBy: 'staff-manager', floatPence };
}

function voidEvent(id: string, periodId: string): AuditEvent {
  return {
    id,
    deviceId: DEVICE,
    createdAt: T_SALE,
    updatedAt: T_SALE,
    type: 'void',
    staffId: 'staff-sue',
    periodId,
    detail: { productId: 'lager', productName: 'Lager', qty: 1, unitPricePence: 450 },
  };
}

function noSaleEvent(id: string, periodId: string): AuditEvent {
  return { id, deviceId: DEVICE, createdAt: T_SALE, updatedAt: T_SALE, type: 'noSale', staffId: 'staff-sue', periodId, detail: {} };
}

function overrideEvent(id: string, periodId: string): AuditEvent {
  return {
    id,
    deviceId: DEVICE,
    createdAt: T_SALE,
    updatedAt: T_SALE,
    type: 'override',
    staffId: 'staff-sam',
    approvedById: 'staff-sue',
    periodId,
    detail: { action: 'voidLine' },
  };
}

// ---------------------------------------------------------------------------
// §10.1: a single item
// ---------------------------------------------------------------------------

describe('§10.1 a single item (§7.1, §7.5)', () => {
  it('Lager x1 @450 at 20%: VAT 450*20/120 = 75, net 375, total 450', () => {
    const p = price([pl('lager', 1, 450)]);
    expect(figs(p)).toEqual([L('lager', 450, 0, 0, 450, 75, 375)]);
    expect(totals(p)).toEqual({ gross: 450, deal: 0, member: 0, subtotal: 450, deposit: 0, total: 450 });
    expect(p.dealLines).toEqual([]);
    expect(p.vatSummary).toEqual([{ vatRate: 20, grossPence: 450, vatPence: 75, netPence: 375 }]);
    expectConsistent(p);
  });

  it('Wine x1 @2295 at 20%: VAT 2295*20/120 = 382.5 -> 383 (half up), net 2295 - 383 = 1912', () => {
    const p = price([pl('wine', 1, 2295)]);
    expect(figs(p)).toEqual([L('wine', 2295, 0, 0, 2295, 383, 1912)]);
    expect(p.totalPence).toBe(2295);
    expectConsistent(p);
  });

  it('Raffle ticket x1 @100 at 0%: VAT 0, net 100, total 100', () => {
    const p = price([pl('raffle', 1, 100, { vatRate: 0, eligible: false })]);
    expect(figs(p)).toEqual([L('raffle', 100, 0, 0, 100, 0, 100)]);
    expect(p.vatSummary).toEqual([{ vatRate: 0, grossPence: 100, vatPence: 0, netPence: 100 }]);
    expectConsistent(p);
  });
});

// ---------------------------------------------------------------------------
// §10.1: multiple quantities
// ---------------------------------------------------------------------------

describe('§10.1 multiple quantities (§7.1 line gross = qty x unit)', () => {
  it('Lager x3 @450: gross 3*450 = 1350; VAT 1350*20/120 = 225; net 1125', () => {
    const p = price([pl('lager', 3, 450)]);
    expect(figs(p)).toEqual([L('lager', 1350, 0, 0, 1350, 225, 1125)]);
    expect(p.totalPence).toBe(1350);
    expectConsistent(p);
  });

  it('x3 @130 at 20%: gross 390; VAT is on the LINE 390*20/120 = 65 (per unit would be 3 x 21.67 -> 3 x 22 = 66); net 325', () => {
    const p = price([pl('scratchings', 3, 130)]);
    expect(figs(p)).toEqual([L('scratchings', 390, 0, 0, 390, 65, 325)]);
    expectConsistent(p);
  });

  it('x3 @125 at 20%: gross 375; VAT 375*20/120 = 62.5 -> 63 (half up); net 312', () => {
    const p = price([pl('scratchings', 3, 125)]);
    expect(figs(p)).toEqual([L('scratchings', 375, 0, 0, 375, 63, 312)]);
    expectConsistent(p);
  });

  it('Bitter x2 @420 + Fairway x3 @480: 840 (VAT 140) + 1440 (VAT 240) = 2280, summary 20% net 1900 VAT 380', () => {
    // 840*20/120 = 140; 1440*20/120 = 240.
    const p = price([pl('bitter', 2, 420), pl('fairway', 3, 480)]);
    expect(figs(p)).toEqual([L('bitter', 840, 0, 0, 840, 140, 700), L('fairway', 1440, 0, 0, 1440, 240, 1200)]);
    expect(totals(p)).toEqual({ gross: 2280, deal: 0, member: 0, subtotal: 2280, deposit: 0, total: 2280 });
    expect(p.vatSummary).toEqual([{ vatRate: 20, grossPence: 2280, vatPence: 380, netPence: 1900 }]);
    expectConsistent(p);
  });
});

// ---------------------------------------------------------------------------
// §10.1: nForPrice (equal prices, mixed prices, leftover unit, would raise the price)
// ---------------------------------------------------------------------------

describe('§10.1 nForPrice with equal prices (§7.2, D-014, D-015, D-017)', () => {
  const twoFor8 = nForPrice('deal-2for8', '2 for £8', 2, 800, ['lager']);

  it('2 for £8 on Lager x2 @450: saving 900 - 800 = 100 (50/50); final 800; VAT 800*20/120 = 133.33 -> 133; net 667', () => {
    const p = price([pl('lager', 2, 450)], { deals: [twoFor8] });
    expect(figs(p)).toEqual([L('lager', 900, 100, 0, 800, 133, 667)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-2for8', name: '2 for £8', groupCount: 1, savingPence: 100 }]);
    expect(totals(p)).toEqual({ gross: 900, deal: 100, member: 0, subtotal: 800, deposit: 0, total: 800 });
    expectConsistent(p);
  });

  it('2 for £8 on Lager x5 @450: 2 groups x 100 = 200, 1 leftover; final 2250 - 200 = 2050; VAT 41000/120 = 341.67 -> 342', () => {
    const p = price([pl('lager', 5, 450)], { deals: [twoFor8] });
    expect(figs(p)).toEqual([L('lager', 2250, 200, 0, 2050, 342, 1708)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-2for8', name: '2 for £8', groupCount: 2, savingPence: 200 }]);
    expectConsistent(p);
  });

  it('3 for £10 on three different 450 lines: saving 1350 - 1000 = 350, remainder on the first (highest, earliest) unit', () => {
    // allocate(350, [450,450,450]): each 350*450/1350 = 116.67 -> 117; sum 351, diff -1 on priority[0] = A -> [116,117,117].
    // A: final 450 - 116 = 334, VAT 6680/120 = 55.67 -> 56, net 278. B, C: final 333, VAT 6660/120 = 55.5 -> 56, net 277.
    const deal = nForPrice('deal-3for10', '3 for £10', 3, 1000, ['a', 'b', 'c']);
    const p = price([pl('a', 1, 450), pl('b', 1, 450), pl('c', 1, 450)], { deals: [deal] });
    expect(figs(p)).toEqual([L('a', 450, 116, 0, 334, 56, 278), L('b', 450, 117, 0, 333, 56, 277), L('c', 450, 117, 0, 333, 56, 277)]);
    expect(p.totalPence).toBe(1000);
    expectConsistent(p);
  });
});

describe('§10.1 nForPrice with mixed prices (§7.2 last bullet, D-015, D-004)', () => {
  it('D-015: 3 for £10 on A 350, B 450, C 400 (basket order A,B,C): saving 200 -> B 75, C 67, A 58; total 1000', () => {
    // Sorted B 450, C 400, A 350; sum 1200; saving 200.
    // Shares: B 200*450/1200 = 75; C 200*400/1200 = 66.67 -> 67; A 200*350/1200 = 58.33 -> 58; sum 200.
    // Finals: A 292 (VAT 5840/120 = 48.67 -> 49), B 375 (VAT 62.5 -> 63), C 333 (VAT 55.5 -> 56).
    const deal = nForPrice('deal-3for10', '3 for £10', 3, 1000, ['a', 'b', 'c']);
    const p = price([pl('a', 1, 350), pl('b', 1, 450), pl('c', 1, 400)], { deals: [deal] });
    expect(figs(p)).toEqual([L('a', 350, 58, 0, 292, 49, 243), L('b', 450, 75, 0, 375, 63, 312), L('c', 400, 67, 0, 333, 56, 277)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-3for10', name: '3 for £10', groupCount: 1, savingPence: 200 }]);
    expect(p.totalPence).toBe(1000);
    expectConsistent(p);
  });

  it('3 for £10 on A 500, B 300, C 300: saving 100; rounding leaves +1 which goes to the highest-priced unit A', () => {
    // Sum 1100, saving 100. Shares: A 100*500/1100 = 45.45 -> 45; B, C 100*300/1100 = 27.27 -> 27; sum 99, diff +1 -> A 46.
    // A: final 454, VAT 9080/120 = 75.67 -> 76, net 378. B, C: final 273, VAT 5460/120 = 45.5 -> 46, net 227.
    const deal = nForPrice('deal-3for10', '3 for £10', 3, 1000, ['a', 'b', 'c']);
    const p = price([pl('a', 1, 500), pl('b', 1, 300), pl('c', 1, 300)], { deals: [deal] });
    expect(figs(p)).toEqual([L('a', 500, 46, 0, 454, 76, 378), L('b', 300, 27, 0, 273, 46, 227), L('c', 300, 27, 0, 273, 46, 227)]);
    expect(p.totalPence).toBe(1000);
    expectConsistent(p);
  });

  it('Any 2 bottles for £8 on Stout 400 (line 0) + Birdie 450 (line 1): saving 50 -> Birdie 26, Stout 24', () => {
    // Sorted Birdie 450, Stout 400; sum 850; saving 50. Birdie 50*450/850 = 26.47 -> 26; Stout 50*400/850 = 23.53 -> 24.
    // Stout: final 376, VAT 7520/120 = 62.67 -> 63, net 313. Birdie: final 424, VAT 8480/120 = 70.67 -> 71, net 353.
    const deal = nForPrice('deal-bottles', 'Any 2 bottles for £8', 2, 800, ['birdie', 'stout']);
    const p = price([pl('stout', 1, 400), pl('birdie', 1, 450)], { deals: [deal] });
    expect(figs(p)).toEqual([L('stout', 400, 24, 0, 376, 63, 313), L('birdie', 450, 26, 0, 424, 71, 353)]);
    expect(p.totalPence).toBe(800);
    expectConsistent(p);
  });
});

describe('§10.1 nForPrice with a leftover unit (D-014)', () => {
  it('D-014: 2 for £8 on Lager x3 @450: one group saves 100, one unit left over; final 1250, VAT 25000/120 = 208.33 -> 208', () => {
    const deal = nForPrice('deal-2for8', '2 for £8', 2, 800, ['lager']);
    const p = price([pl('lager', 3, 450)], { deals: [deal] });
    expect(figs(p)).toEqual([L('lager', 1350, 100, 0, 1250, 208, 1042)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-2for8', name: '2 for £8', groupCount: 1, savingPence: 100 }]);
    expectConsistent(p);
  });

  it('mixed prices: the cheapest unit is the leftover (Birdie 450, Stout 400, Albatross 430 -> Stout left over)', () => {
    // Sorted Birdie 450, Albatross 430, Stout 400. Group (450,430) = 880 -> saving 80; Stout is the leftover.
    // Birdie 80*450/880 = 40.91 -> 41; Albatross 80*430/880 = 39.09 -> 39; sum 80.
    // Birdie final 409 (VAT 8180/120 = 68.17 -> 68); Stout 400 (VAT 66.67 -> 67); Albatross 391 (VAT 7820/120 = 65.17 -> 65).
    const deal = nForPrice('deal-bottles', 'Any 2 bottles for £8', 2, 800, ['birdie', 'bogey', 'albatross', 'stout']);
    const p = price([pl('birdie', 1, 450), pl('stout', 1, 400), pl('albatross', 1, 430)], { deals: [deal] });
    expect(figs(p)).toEqual([
      L('birdie', 450, 41, 0, 409, 68, 341),
      L('stout', 400, 0, 0, 400, 67, 333),
      L('albatross', 430, 39, 0, 391, 65, 326),
    ]);
    expect(p.totalPence).toBe(1200); // 1280 - 80
    expectConsistent(p);
  });

  it('equal prices: among equals the LATEST added unit is the leftover (Birdie x1 line 0, Bogey x2 line 1, all 450)', () => {
    // Sorted (450,line0,u0), (450,line1,u0), (450,line1,u1): group = Birdie u0 + Bogey u0 (50/50); leftover Bogey u1.
    // Birdie: deal 50, final 400, VAT 66.67 -> 67, net 333. Bogey: deal 50, final 850, VAT 17000/120 = 141.67 -> 142, net 708.
    const deal = nForPrice('deal-bottles', 'Any 2 bottles for £8', 2, 800, ['birdie', 'bogey']);
    const p = price([pl('birdie', 1, 450), pl('bogey', 2, 450)], { deals: [deal] });
    expect(figs(p)).toEqual([L('birdie', 450, 50, 0, 400, 67, 333), L('bogey', 900, 50, 0, 850, 142, 708)]);
    expect(p.totalPence).toBe(1250);
    expectConsistent(p);
  });
});

describe('§10.1 nForPrice that would raise the price is not applied (§7.2 bullet 3, D-015)', () => {
  it('D-015: 2 for £10 on Lager x2 @450: saving 900 - 1000 = -100 -> not applied; final 900, VAT 150, no deal line', () => {
    const deal = nForPrice('deal-2for10', '2 for £10', 2, 1000, ['lager']);
    const p = price([pl('lager', 2, 450)], { deals: [deal] });
    expect(figs(p)).toEqual([L('lager', 900, 0, 0, 900, 150, 750)]);
    expect(p.dealLines).toEqual([]);
    expect(p.totalPence).toBe(900);
    expectConsistent(p);
  });

  it('saving exactly 0 (2 for £9 on Lager x2 @450) is "<= 0" so not applied', () => {
    const deal = nForPrice('deal-2for9', '2 for £9', 2, 900, ['lager']);
    const p = price([pl('lager', 2, 450)], { deals: [deal] });
    expect(figs(p)).toEqual([L('lager', 900, 0, 0, 900, 150, 750)]);
    expect(p.dealLines).toEqual([]);
  });

  it('D-015: second group fails. 3 for £10 on A x2 @500, B x2 @400, C x3 @200 -> only group 1 applied', () => {
    // Sorted 500,500,400,400,200,200,200. Group 1 (500,500,400) = 1400 -> saving 400: 400*500/1400 = 142.86 -> 143 (x2),
    // 400*400/1400 = 114.29 -> 114; sum 400. Group 2 (400,200,200) = 800 -> saving -200 -> not applied.
    // A: deal 286, final 714, VAT 714/6 = 119. B: deal 114, final 686, VAT 114.33 -> 114. C: final 600, VAT 100.
    const deal = nForPrice('deal-3for10', '3 for £10', 3, 1000, ['a', 'b', 'c']);
    const p = price([pl('a', 2, 500), pl('b', 2, 400), pl('c', 3, 200)], { deals: [deal] });
    expect(figs(p)).toEqual([L('a', 1000, 286, 0, 714, 119, 595), L('b', 800, 114, 0, 686, 114, 572), L('c', 600, 0, 0, 600, 100, 500)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-3for10', name: '3 for £10', groupCount: 1, savingPence: 400 }]);
    expect(p.totalPence).toBe(2000);
    expectConsistent(p);
  });

  it('a price-raising deal does not consume units: a later deal still gets them (D-015)', () => {
    // R '2 for £10' (created first) saves -100 on Lager x2 @450 -> not applied, units stay free.
    // S '2 for £8' then saves 100. Either order gives 100, and only S appears in dealLines.
    const r = nForPrice('deal-r', '2 for £10', 2, 1000, ['lager'], T_DEAL_1);
    const s = nForPrice('deal-s', '2 for £8', 2, 800, ['lager'], T_DEAL_2);
    const p = price([pl('lager', 2, 450)], { deals: [r, s] });
    expect(figs(p)).toEqual([L('lager', 900, 100, 0, 800, 133, 667)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-s', name: '2 for £8', groupCount: 1, savingPence: 100 }]);
  });
});

// ---------------------------------------------------------------------------
// §10.1: nForM with mixed prices
// ---------------------------------------------------------------------------

describe('§10.1 nForM with mixed prices (§7.2 bullet 4, D-016)', () => {
  it('D-016: 3 for 2 on A 500, B 400, C 300: C free -> saving 300, spread 125/100/75 over ALL units', () => {
    // allocate(300, [500,400,300]): 300*500/1200 = 125; 100; 75.
    // Finals 375 (VAT 7500/120 = 62.5 -> 63), 300 (VAT 50), 225 (VAT 4500/120 = 37.5 -> 38). Nets 312, 250, 187.
    const deal = nForM('deal-3for2', '3 for 2', 3, 2, ['a', 'b', 'c']);
    const p = price([pl('a', 1, 500), pl('b', 1, 400), pl('c', 1, 300)], { deals: [deal] });
    expect(figs(p)).toEqual([L('a', 500, 125, 0, 375, 63, 312), L('b', 400, 100, 0, 300, 50, 250), L('c', 300, 75, 0, 225, 38, 187)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-3for2', name: '3 for 2', groupCount: 1, savingPence: 300 }]);
    expect(p.totalPence).toBe(900);
    expectConsistent(p);
  });

  it('D-016 rounding case: A 450, B 420, C 390 -> saving 390 -> shares 139, 130, 121 -> finals 311, 290, 269', () => {
    // 390*450/1260 = 139.29 -> 139; 390*420/1260 = 130; 390*390/1260 = 120.71 -> 121; sum 390.
    // VAT: 311 -> 6220/120 = 51.83 -> 52; 290 -> 48.33 -> 48; 269 -> 44.83 -> 45.
    const deal = nForM('deal-3for2', '3 for 2', 3, 2, ['a', 'b', 'c']);
    const p = price([pl('a', 1, 450), pl('b', 1, 420), pl('c', 1, 390)], { deals: [deal] });
    expect(figs(p)).toEqual([L('a', 450, 139, 0, 311, 52, 259), L('b', 420, 130, 0, 290, 48, 242), L('c', 390, 121, 0, 269, 45, 224)]);
    expect(p.totalPence).toBe(870);
    expectConsistent(p);
  });

  it('Snacks 3 for 2: Crisps x2 @120, Peanuts @150, Scratchings @150 -> one Crisps free, the other Crisps left over', () => {
    // Sorted Peanuts 150 (line 1), Scratchings 150 (line 2), Crisps u0 120, Crisps u1 120.
    // Group (150,150,120): free = the 1 cheapest = 120. Shares 120*150/420 = 42.86 -> 43 (x2), 120*120/420 = 34.29 -> 34.
    // Crisps: gross 240, deal 34, final 206, VAT 4120/120 = 34.33 -> 34. Peanuts/Scratchings: final 107, VAT 17.83 -> 18.
    const deal = nForM('deal-snacks', 'Snacks 3 for 2', 3, 2, ['crisps', 'peanuts', 'scratchings']);
    const p = price([pl('crisps', 2, 120), pl('peanuts', 1, 150), pl('scratchings', 1, 150)], { deals: [deal] });
    expect(figs(p)).toEqual([
      L('crisps', 240, 34, 0, 206, 34, 172),
      L('peanuts', 150, 43, 0, 107, 18, 89),
      L('scratchings', 150, 43, 0, 107, 18, 89),
    ]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-snacks', name: 'Snacks 3 for 2', groupCount: 1, savingPence: 120 }]);
    expect(p.totalPence).toBe(420); // 540 - 120
    expectConsistent(p);
  });

  it('4 for 2 on A 600, B 500, C 400, D 300: the n-m = 2 cheapest are free -> saving 700', () => {
    // allocate(700, [600,500,400,300]), W 1800: 233.33 -> 233; 194.44 -> 194; 155.56 -> 156; 116.67 -> 117; sum 700.
    // Finals 367 (VAT 61.17 -> 61), 306 (51), 244 (40.67 -> 41), 183 (30.5 -> 31).
    const deal = nForM('deal-4for2', '4 for 2', 4, 2, ['a', 'b', 'c', 'd']);
    const p = price([pl('a', 1, 600), pl('b', 1, 500), pl('c', 1, 400), pl('d', 1, 300)], { deals: [deal] });
    expect(figs(p)).toEqual([
      L('a', 600, 233, 0, 367, 61, 306),
      L('b', 500, 194, 0, 306, 51, 255),
      L('c', 400, 156, 0, 244, 41, 203),
      L('d', 300, 117, 0, 183, 31, 152),
    ]);
    expect(p.totalPence).toBe(1100);
    expectConsistent(p);
  });
});

// ---------------------------------------------------------------------------
// §10.1: an item eligible for two deals (the bigger saving wins)
// ---------------------------------------------------------------------------

describe('§10.1 an item eligible for two deals: the bigger saving wins (§7.2 bullet 5, D-018)', () => {
  it('D-018: Lager x1 @450, Bitter x3 @420; A "Any 2 pints £7" (first) vs B "Bitter 3 for 2" -> B wins 420 > 310', () => {
    // [A,B]: A groups (450,420) saves 170 and (420,420) saves 140 = 310; B gets nothing.
    // [B,A]: B saves one free Bitter = 420; A has only the Lager left. 420 > 310.
    // Bitter shares allocate(420,[420,420,420]) = 140 each. Lager final 450 (VAT 75); Bitter final 840 (VAT 140).
    const a = nForPrice('deal-a', 'Any 2 pints £7', 2, 700, ['lager', 'bitter'], T_DEAL_1);
    const b = nForM('deal-b', 'Bitter 3 for 2', 3, 2, ['bitter'], T_DEAL_2);
    const p = price([pl('lager', 1, 450), pl('bitter', 3, 420)], { deals: [a, b] });
    expect(figs(p)).toEqual([L('lager', 450, 0, 0, 450, 75, 375), L('bitter', 1260, 420, 0, 840, 140, 700)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-b', name: 'Bitter 3 for 2', groupCount: 1, savingPence: 420 }]);
    expect(p.totalPence).toBe(1290);
    expectConsistent(p);
  });

  it('Birdie x1 @450, Stout x2 @400; P "Any 2 for £8" (first) vs Q "Stout 2 for £6" -> Q wins 200 > 50', () => {
    // [P,Q]: P groups (450,400) = 850 -> 50; one Stout left, Q needs 2 -> 0. Total 50.
    // [Q,P]: Q (400,400) = 800 -> 200; P has only Birdie. Total 200.
    // Stout: deal 200 (100 each), final 600, VAT 100. Birdie: final 450, VAT 75. Total 1050.
    const pDeal = nForPrice('deal-p', 'Any 2 for £8', 2, 800, ['birdie', 'stout'], T_DEAL_1);
    const qDeal = nForPrice('deal-q', 'Stout 2 for £6', 2, 600, ['stout'], T_DEAL_2);
    const p = price([pl('birdie', 1, 450), pl('stout', 2, 400)], { deals: [pDeal, qDeal] });
    expect(figs(p)).toEqual([L('birdie', 450, 0, 0, 450, 75, 375), L('stout', 800, 200, 0, 600, 100, 500)]);
    expect(p.dealLines).toEqual([{ dealId: 'deal-q', name: 'Stout 2 for £6', groupCount: 1, savingPence: 200 }]);
    expect(p.totalPence).toBe(1050);
    expectConsistent(p);
  });

  it('both deals applied to disjoint units when that is best: X "Bitter 3 for 2" + Y "Any 3 pints £9" -> 960', () => {
    // Lager x3 @480, Bitter x3 @420. X (first) nForM 3/2 {bitter}; Y nForPrice 3/900 {lager, bitter}.
    // [X,Y]: X frees one Bitter = 420; Y on Lager x3: 1440 - 900 = 540. Total 960.
    // [Y,X]: Y (480x3) = 540 and (420x3) = 1260 - 900 = 360 -> 900; X has no Bitter left. 960 > 900.
    // Lager: deal 540 (180 each), final 900, VAT 150. Bitter: deal 420 (140 each), final 840, VAT 140. Total 1740.
    // dealLines in canonical order (X created first).
    const x = nForM('deal-x', 'Bitter 3 for 2', 3, 2, ['bitter'], T_DEAL_1);
    const y = nForPrice('deal-y', 'Any 3 pints £9', 3, 900, ['lager', 'bitter'], T_DEAL_2);
    const p = price([pl('lager', 3, 480), pl('bitter', 3, 420)], { deals: [y, x] });
    expect(figs(p)).toEqual([L('lager', 1440, 540, 0, 900, 150, 750), L('bitter', 1260, 420, 0, 840, 140, 700)]);
    expect(p.dealLines).toEqual([
      { dealId: 'deal-x', name: 'Bitter 3 for 2', groupCount: 1, savingPence: 420 },
      { dealId: 'deal-y', name: 'Any 3 pints £9', groupCount: 1, savingPence: 540 },
    ]);
    expect(p.totalPence).toBe(1740);
    expectConsistent(p);
  });

  it('D-018 tie: identical deals X (created first) and Y both save 100 -> credited to X, whatever the input order', () => {
    const x = nForPrice('deal-x', '2 for £8', 2, 800, ['lager'], T_DEAL_1);
    const y = nForPrice('deal-y', '2 for £8 (copy)', 2, 800, ['lager'], T_DEAL_2);
    const p = price([pl('lager', 2, 450)], { deals: [y, x] });
    expect(p.dealLines).toEqual([{ dealId: 'deal-x', name: '2 for £8', groupCount: 1, savingPence: 100 }]);
    expect(p.totalPence).toBe(800);
  });

  it('D-018 tie with the same createdAt: the lower id (plain string order) wins', () => {
    const b = nForPrice('deal-b', 'B 2 for £8', 2, 800, ['lager'], T_DEAL_1);
    const a = nForPrice('deal-a', 'A 2 for £8', 2, 800, ['lager'], T_DEAL_1);
    const p = price([pl('lager', 2, 450)], { deals: [b, a] });
    expect(p.dealLines).toEqual([{ dealId: 'deal-a', name: 'A 2 for £8', groupCount: 1, savingPence: 100 }]);
  });
});

// ---------------------------------------------------------------------------
// §10.1: member discount with and without deals, half-penny rounding, remainder spreading
// ---------------------------------------------------------------------------

describe('§10.1 member discount: rounding primitives (D-002, D-004)', () => {
  it('half-penny rounds UP, not to even: 1030*15/100 = 154.5 -> 155; 1150 -> 172.5 -> 173; 1230 -> 184.5 -> 185', () => {
    expect(mulDivRoundHalfUp(1030, 15, 100)).toBe(155); // banker's rounding would give 154
    expect(mulDivRoundHalfUp(1150, 15, 100)).toBe(173); // banker's rounding would give 172
    expect(mulDivRoundHalfUp(1230, 15, 100)).toBe(185);
    expect(roundHalfUp(5, 2)).toBe(3);
    expect(roundHalfUp(-5, 2)).toBe(-3);
    expect(Object.is(roundHalfUp(-1, 3), 0)).toBe(true); // never -0 (D-003)
  });

  it('allocate spreads with the remainder on priority[0] (D-004 examples)', () => {
    expect(allocate(200, [450, 400, 350], [0, 1, 2])).toEqual([75, 67, 58]);
    expect(allocate(185, [410, 410, 410], [0, 1, 2])).toEqual([61, 62, 62]); // 62*3 = 186, diff -1
    expect(allocate(1, [450, 450], [0, 1])).toEqual([0, 1]); // 0.5 -> 1 each = 2, diff -1 on index 0
  });
});

describe('§10.1 member discount without deals (§7.3, D-020)', () => {
  it('D-020: Lager x2 @450 + Crisps 130 (0%): base 1030 -> 154.5 -> 155 -> Lager 135, Crisps 20; total 875', () => {
    // allocate(155, [900,130]): 155*900/1030 = 135.44 -> 135; 155*130/1030 = 19.56 -> 20; sum 155.
    // Lager final 765, VAT 15300/120 = 127.5 -> 128, net 637. Crisps final 110, VAT 0.
    const p = price([pl('lager', 2, 450), pl('crisps', 1, 130, { vatRate: 0 })], { memberPercent: 15 });
    expect(figs(p)).toEqual([L('lager', 900, 0, 135, 765, 128, 637), L('crisps', 130, 0, 20, 110, 0, 110)]);
    expect(totals(p)).toEqual({ gross: 1030, deal: 0, member: 155, subtotal: 875, deposit: 0, total: 875 });
    expectConsistent(p);
  });

  it('D-020 remainder tie: three eligible 410 lines, base 1230 -> 185; 62+62+62 = 186, -1 on line 0 -> [61,62,62]', () => {
    // Finals 349 (VAT 6980/120 = 58.17 -> 58), 348 (VAT 58), 348 (VAT 58). Total 1230 - 185 = 1045.
    const p = price([pl('a', 1, 410), pl('b', 1, 410), pl('c', 1, 410)], { memberPercent: 15 });
    expect(figs(p)).toEqual([L('a', 410, 0, 61, 349, 58, 291), L('b', 410, 0, 62, 348, 58, 290), L('c', 410, 0, 62, 348, 58, 290)]);
    expect(p.memberDiscountPence).toBe(185);
    expect(p.totalPence).toBe(1045);
    expectConsistent(p);
  });

  it('remainder goes to the LARGEST line, not line 0: [150, 410, 410] base 970 -> 145.5 -> 146 -> [23, 61, 62]', () => {
    // 146*150/970 = 22.58 -> 23; 146*410/970 = 61.71 -> 62 (x2); sum 147, diff -1.
    // Priority = postDeal DESC then index: [1, 2, 0] -> line 1 takes the -1 -> 61.
    // Finals 127 (VAT 21.17 -> 21), 349 (VAT 58), 348 (VAT 58). Total 970 - 146 = 824.
    const p = price([pl('peanuts', 1, 150), pl('b', 1, 410), pl('c', 1, 410)], { memberPercent: 15 });
    expect(figs(p)).toEqual([
      L('peanuts', 150, 0, 23, 127, 21, 106),
      L('b', 410, 0, 61, 349, 58, 291),
      L('c', 410, 0, 62, 348, 58, 290),
    ]);
    expect(p.totalPence).toBe(824);
    expectConsistent(p);
  });

  it('positive remainder: three 229 lines, base 687 -> 103.05 -> 103; 34.33 -> 34 each = 102, +1 on line 0 -> [35,34,34]', () => {
    // Finals 194 (VAT 32.33 -> 32), 195 (VAT 32.5 -> 33), 195 (VAT 33). Total 687 - 103 = 584.
    const p = price([pl('a', 1, 229), pl('b', 1, 229), pl('c', 1, 229)], { memberPercent: 15 });
    expect(figs(p)).toEqual([L('a', 229, 0, 35, 194, 32, 162), L('b', 229, 0, 34, 195, 33, 162), L('c', 229, 0, 34, 195, 33, 162)]);
    expect(p.totalPence).toBe(584);
    expectConsistent(p);
  });

  it('D-019: the percent is a parameter (10%: base 1000 -> 100) and no member (null) means no discount at all', () => {
    const tenPercent = price([pl('a', 2, 500)], { memberPercent: 10 });
    expect(figs(tenPercent)).toEqual([L('a', 1000, 0, 100, 900, 150, 750)]);
    const noMember = price([pl('a', 2, 500)], { memberPercent: null });
    expect(figs(noMember)).toEqual([L('a', 1000, 0, 0, 1000, 167, 833)]); // 1000*20/120 = 166.67 -> 167
    expect(noMember.memberDiscountPence).toBe(0);
  });

  it('memberDiscount() directly: [900 elig, 250 elig] at 15% -> base 1150, 172.5 -> 173, perLine [135, 38]', () => {
    // 173*900/1150 = 135.39 -> 135; 173*250/1150 = 37.61 -> 38.
    expect(
      memberDiscount(
        [
          { postDealPence: 900, eligible: true },
          { postDealPence: 250, eligible: true },
        ],
        15,
      ),
    ).toEqual({ basePence: 1150, discountPence: 173, perLine: [135, 38] });
    expect(memberDiscount([{ postDealPence: 900, eligible: true }], null)).toEqual({ basePence: 900, discountPence: 0, perLine: [0] });
  });
});

describe('§10.1 member discount with deals (§7.3 base is post-deal, D-020)', () => {
  it('D-020 / D-042 S1: Lager x3 @450 "3 for 2" + Crisps x2 @125 (0%), member 15% -> total 977', () => {
    // Deal: one free Lager = 450 (150 per unit); Lager postDeal 900; Crisps postDeal 250.
    // Base 1150 -> 172.5 -> 173; allocate -> Lager 135 (135.39), Crisps 38 (37.61).
    // Lager final 1350 - 450 - 135 = 765, VAT 127.5 -> 128, net 637. Crisps final 212, VAT 0.
    const deal = nForM('deal-lager-3for2', 'Lager 3 for 2', 3, 2, ['lager']);
    const p = price([pl('lager', 3, 450), pl('crisps', 2, 125, { vatRate: 0 })], { deals: [deal], memberPercent: 15 });
    expect(figs(p)).toEqual([L('lager', 1350, 450, 135, 765, 128, 637), L('crisps', 250, 0, 38, 212, 0, 212)]);
    expect(totals(p)).toEqual({ gross: 1600, deal: 450, member: 173, subtotal: 977, deposit: 0, total: 977 });
    expect(p.dealLines).toEqual([{ dealId: 'deal-lager-3for2', name: 'Lager 3 for 2', groupCount: 1, savingPence: 450 }]);
    expect(p.vatSummary).toEqual([
      { vatRate: 20, grossPence: 765, vatPence: 128, netPence: 637 },
      { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
    ]);
    expectConsistent(p);
  });

  it('D-098: 2 x Birdie ("Any 2 bottles for £8") + Fairway 480 with a member: base 800 + 480 = 1280 -> 192 = 120 + 72', () => {
    // Birdie: deal 100, postDeal 800, member 192*800/1280 = 120 -> final 680, VAT 113.33 -> 113.
    // Fairway: member 192*480/1280 = 72 -> final 408, VAT 68. Total 1088.
    const deal = nForPrice('deal-bottles', 'Any 2 bottles for £8', 2, 800, ['birdie', 'bogey', 'albatross', 'eagle', 'clubhouse']);
    const p = price([pl('birdie', 2, 450), pl('fairway', 1, 480)], { deals: [deal], memberPercent: 15 });
    expect(figs(p)).toEqual([L('birdie', 900, 100, 120, 680, 113, 567), L('fairway', 480, 0, 72, 408, 68, 340)]);
    expect(p.totalPence).toBe(1088);
    expectConsistent(p);
  });

  it('deal + half-penny share + remainder on the largest post-deal line: Lager x2 "2 for £8" + two 410 lines', () => {
    // Lager postDeal 900 - 100 = 800; others 410, 410. Base 1620 -> 243 (exact).
    // Shares: 243*800/1620 = 120; 243*410/1620 = 61.5 -> 62 (x2); sum 244, diff -1 on priority[0] = Lager -> 119.
    // Lager final 900 - 100 - 119 = 681, VAT 13620/120 = 113.5 -> 114, net 567. Others final 348, VAT 58, net 290.
    // Total 1720 - 100 - 243 = 1377.
    const deal = nForPrice('deal-2for8', '2 for £8', 2, 800, ['lager']);
    const p = price([pl('lager', 2, 450), pl('b', 1, 410), pl('c', 1, 410)], { deals: [deal], memberPercent: 15 });
    expect(figs(p)).toEqual([L('lager', 900, 100, 119, 681, 114, 567), L('b', 410, 0, 62, 348, 58, 290), L('c', 410, 0, 62, 348, 58, 290)]);
    expect(totals(p)).toEqual({ gross: 1720, deal: 100, member: 243, subtotal: 1377, deposit: 0, total: 1377 });
    expectConsistent(p);
  });
});

// ---------------------------------------------------------------------------
// §10.1: a member-ineligible item in a member basket
// ---------------------------------------------------------------------------

describe('§10.1 a member-ineligible item in a member basket (§7.3 base = eligible lines only)', () => {
  it('D-020: Lager x2 @450 + Cigar 1200 (ineligible): base 900 -> 135, all on the Lager; total 765 + 1200 = 1965', () => {
    // Cigar VAT 1200*20/120 = 200.
    const p = price([pl('lager', 2, 450), pl('cigar', 1, 1200, { eligible: false })], { memberPercent: 15 });
    expect(figs(p)).toEqual([L('lager', 900, 0, 135, 765, 128, 637), L('cigar', 1200, 0, 0, 1200, 200, 1000)]);
    expect(totals(p)).toEqual({ gross: 2100, deal: 0, member: 135, subtotal: 1965, deposit: 0, total: 1965 });
    expectConsistent(p);
  });

  it('Bitter x2 @420 + Raffle 100 (0%, ineligible) + Buffet 1500 (20%, ineligible): base 840 -> 126 on Bitter only', () => {
    // 840*15/100 = 126. Bitter final 714, VAT 714/6 = 119. Raffle 100, VAT 0. Buffet 1500, VAT 250.
    // Total 714 + 100 + 1500 = 2314. Summary 20%: gross 2214, VAT 369, net 1845; 0%: 100, 0, 100.
    const p = price(
      [pl('bitter', 2, 420), pl('raffle', 1, 100, { vatRate: 0, eligible: false }), pl('buffet', 1, 1500, { eligible: false })],
      { memberPercent: 15 },
    );
    expect(figs(p)).toEqual([
      L('bitter', 840, 0, 126, 714, 119, 595),
      L('raffle', 100, 0, 0, 100, 0, 100),
      L('buffet', 1500, 0, 0, 1500, 250, 1250),
    ]);
    expect(p.totalPence).toBe(2314);
    expect(p.vatSummary).toEqual([
      { vatRate: 20, grossPence: 2214, vatPence: 369, netPence: 1845 },
      { vatRate: 0, grossPence: 100, vatPence: 0, netPence: 100 },
    ]);
    expectConsistent(p);
  });

  it('an ineligible item still takes deals (D-014): Birdie + ineligible Guest Ale in "2 for £8", member base = Birdie only', () => {
    // Group (450,450) -> 100, 50 each. Birdie postDeal 400 (eligible) -> member 60; Guest Ale postDeal 400 (ineligible) -> 0.
    // Birdie final 340, VAT 56.67 -> 57. Guest Ale final 400, VAT 66.67 -> 67. Total 740.
    const deal = nForPrice('deal-bottles', 'Any 2 for £8', 2, 800, ['birdie', 'guest']);
    const p = price([pl('birdie', 1, 450), pl('guest', 1, 450, { eligible: false })], { deals: [deal], memberPercent: 15 });
    expect(figs(p)).toEqual([L('birdie', 450, 50, 60, 340, 57, 283), L('guest', 450, 50, 0, 400, 67, 333)]);
    expect(p.totalPence).toBe(740);
    expectConsistent(p);
  });
});

// ---------------------------------------------------------------------------
// §10.1: VAT at 20% and 0%, and a mixed basket, with line totals matching the basket total
// ---------------------------------------------------------------------------

describe('§10.1 VAT at 20% and 0% (§7.5, D-021)', () => {
  it('lineVat: 450@20 -> 75; 2295@20 -> 382.5 -> 383; 1250@20 -> 208.33 -> 208; 250@0 -> 0', () => {
    expect(lineVat(450, 20)).toBe(75);
    expect(lineVat(2295, 20)).toBe(383);
    expect(lineVat(1250, 20)).toBe(208);
    expect(lineVat(250, 0)).toBe(0);
  });

  it('lineVat uses rate/(100+rate): 5% on 1050 -> 5250/105 = 50; 5% on 1000 -> 47.62 -> 48', () => {
    expect(lineVat(1050, 5)).toBe(50);
    expect(lineVat(1000, 5)).toBe(48);
  });

  it('0% basket: Crisps x2 @125 at 0% -> VAT 0, net 250, one 0% row', () => {
    const p = price([pl('crisps', 2, 125, { vatRate: 0 })]);
    expect(figs(p)).toEqual([L('crisps', 250, 0, 0, 250, 0, 250)]);
    expect(p.vatSummary).toEqual([{ vatRate: 0, grossPence: 250, vatPence: 0, netPence: 250 }]);
  });
});

describe('§10.1 VAT on a mixed basket; line totals match the basket total (D-021)', () => {
  it('D-021: Lager 450 + Wine 2295 + Crisps x2 @125 (0%) -> 2995; 20% net 2287 VAT 458 gross 2745; 0% 250', () => {
    // VAT 75 + 383 = 458 at 20%; gross 450 + 2295 = 2745; net 2287.
    const p = price([pl('lager', 1, 450), pl('wine', 1, 2295), pl('crisps', 2, 125, { vatRate: 0 })]);
    expect(figs(p)).toEqual([L('lager', 450, 0, 0, 450, 75, 375), L('wine', 2295, 0, 0, 2295, 383, 1912), L('crisps', 250, 0, 0, 250, 0, 250)]);
    expect(p.vatSummary).toEqual([
      { vatRate: 20, grossPence: 2745, vatPence: 458, netPence: 2287 },
      { vatRate: 0, grossPence: 250, vatPence: 0, netPence: 250 },
    ]);
    expect(vatTotals(p.vatSummary)).toEqual({ grossPence: 2995, vatPence: 458, netPence: 2537 });
    expect(p.totalPence).toBe(2995);
    expectConsistent(p);
  });

  it('D-021: VAT is summed from lines, never recomputed from the rate total: Wine + Prosecco 2295 each -> 383 + 383 = 766 (not 765)', () => {
    const p = price([pl('wine', 1, 2295), pl('prosecco', 1, 2295)]);
    expect(p.vatSummary).toEqual([{ vatRate: 20, grossPence: 4590, vatPence: 766, netPence: 3824 }]);
    expect(vatSummary([
      { vatRate: 20, finalPence: 2295, vatPence: 383 },
      { vatRate: 20, finalPence: 2295, vatPence: 383 },
    ])).toEqual([{ vatRate: 20, grossPence: 4590, vatPence: 766, netPence: 3824 }]);
  });

  it('three rates sorted DESC: Lager 450 (20%), Item 1000 (5%), Raffle 100 (0%) -> rows 20, 5, 0; totals 1550 / 123 / 1427', () => {
    // VAT: 75 + 48 (1000*5/105 = 47.62 -> 48) + 0 = 123.
    const p = price([pl('raffle', 1, 100, { vatRate: 0 }), pl('fuel', 1, 1000, { vatRate: 5 }), pl('lager', 1, 450)]);
    expect(p.vatSummary).toEqual([
      { vatRate: 20, grossPence: 450, vatPence: 75, netPence: 375 },
      { vatRate: 5, grossPence: 1000, vatPence: 48, netPence: 952 },
      { vatRate: 0, grossPence: 100, vatPence: 0, netPence: 100 },
    ]);
    expect(vatTotals(p.vatSummary)).toEqual({ grossPence: 1550, vatPence: 123, netPence: 1427 });
    expectConsistent(p);
  });

  it('snapshot to SaleLines (D-009) and the resulting sale passes validateSale (D-032): S1 with cash 2000, change 1023', () => {
    const deal = nForM('deal-lager-3for2', 'Lager 3 for 2', 3, 2, ['lager']);
    const p = price([pl('lager', 3, 450), pl('crisps', 2, 125, { vatRate: 0 })], { deals: [deal], memberPercent: 15 });
    const lines = toSaleLines(p);
    expect(lines).toEqual([
      { productId: 'lager', nameAtSale: 'lager', qty: 3, unitPricePence: 450, vatRate: 20, dealDiscountPence: 450, memberDiscountPence: 135, finalPence: 765, vatPence: 128 },
      { productId: 'crisps', nameAtSale: 'crisps', qty: 2, unitPricePence: 125, vatRate: 0, dealDiscountPence: 0, memberDiscountPence: 38, finalPence: 212, vatPence: 0 },
    ]);
    const problems = validateSale({
      staffId: 'staff-1',
      kind: 'sale',
      memberId: 'member-1042',
      lines,
      dealLines: p.dealLines,
      memberDiscountPence: p.memberDiscountPence,
      depositAppliedPence: p.depositAppliedPence,
      totalPence: p.totalPence,
      tenders: [{ type: 'cash', amountPence: 2000 }],
      changePence: 1023, // 2000 - 977
    });
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §10.1: split cash + card; change from cash only; card above balance rejected
// ---------------------------------------------------------------------------

describe('§10.1 split cash + card (§6.4, D-029)', () => {
  it('D-029 / S3: due 4180: card 3000 leaves 1180; cash 1500 completes with change 1500 - 1180 = 320', () => {
    let s = startTendering(4180);
    expect(s).toEqual({ totalPence: 4180, tenders: [], remainingPence: 4180, complete: false, changePence: 0 });
    s = tenderOk(applyTender(s, { type: 'card', amountPence: 3000 }));
    expect(s.remainingPence).toBe(1180);
    expect(s.complete).toBe(false);
    s = tenderOk(applyTender(s, { type: 'cash', amountPence: 1500 }));
    expect(s.complete).toBe(true);
    expect(s.changePence).toBe(320);
    expect(s.remainingPence).toBe(0);
    expect(s.tenders).toEqual([
      { type: 'card', amountPence: 3000 },
      { type: 'cash', amountPence: 1500 },
    ]);
    // D-032 identity: 3000 + 1500 - 320 = 4180.
    expect(tenderSequenceProblems(4180, s.tenders, s.changePence)).toEqual([]);
  });

  it('D-098: due 1088: card 500 leaves 588; cash 1000 -> change 412', () => {
    let s = startTendering(1088);
    s = tenderOk(applyTender(s, { type: 'card', amountPence: 500 }));
    expect(s.remainingPence).toBe(588);
    s = tenderOk(applyTender(s, { type: 'cash', amountPence: 1000 }));
    expect(s.complete).toBe(true);
    expect(s.changePence).toBe(412);
  });

  it('D-029: due 4180: cash 1000, then card with an empty keypad (null) takes the remaining 3180, change 0', () => {
    let s = startTendering(4180);
    s = tenderOk(applyTender(s, { type: 'cash', amountPence: 1000 }));
    expect(s.remainingPence).toBe(3180);
    s = tenderOk(applyTender(s, { type: 'card', amountPence: null }));
    expect(s.complete).toBe(true);
    expect(s.changePence).toBe(0);
    expect(s.tenders).toEqual([
      { type: 'cash', amountPence: 1000 },
      { type: 'card', amountPence: 3180 },
    ]);
  });
});

describe('§10.1 change from cash only (§6.4, D-029, D-030)', () => {
  it('due 977: a £20 note gives change 2000 - 977 = 1023, and the whole note is stored', () => {
    const s = tenderOk(applyTender(startTendering(977), { type: 'cash', amountPence: 2000 }));
    expect(s).toEqual({ totalPence: 977, tenders: [{ type: 'cash', amountPence: 2000 }], remainingPence: 0, complete: true, changePence: 1023 });
  });

  it('D-030: due 977: £5 leaves 477; Exact tenders 477 -> change 0, tenders [500, 477] never merged', () => {
    let s = tenderOk(applyTender(startTendering(977), { type: 'cash', amountPence: 500 }));
    expect(s.remainingPence).toBe(477);
    s = tenderOk(applyTender(s, { type: 'cash', amountPence: s.remainingPence }));
    expect(s.complete).toBe(true);
    expect(s.changePence).toBe(0);
    expect(s.tenders).toEqual([
      { type: 'cash', amountPence: 500 },
      { type: 'cash', amountPence: 477 },
    ]);
  });

  it('D-030: due 320: £5 completes with change 180', () => {
    const s = tenderOk(applyTender(startTendering(320), { type: 'cash', amountPence: 500 }));
    expect(s.changePence).toBe(180);
  });

  it('a card can only ever complete exactly: card for the full 977 -> change 0', () => {
    const s = tenderOk(applyTender(startTendering(977), { type: 'card', amountPence: null }));
    expect(s.complete).toBe(true);
    expect(s.changePence).toBe(0);
    expect(s.tenders).toEqual([{ type: 'card', amountPence: 977 }]);
  });

  it('a stored sequence where the card creates the change is invalid (D-032)', () => {
    // cash 1500 then card 3000 on 4180: the card exceeds the 2680 remaining.
    expect(
      tenderSequenceProblems(
        4180,
        [
          { type: 'cash', amountPence: 1500 },
          { type: 'card', amountPence: 3000 },
        ],
        320,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('§10.1 card above the balance is rejected (§6.4, §8, D-029)', () => {
  it('due 4180: card 5000 is rejected with the balance in the message, nothing recorded', () => {
    const s0 = startTendering(4180);
    const out = applyTender(s0, { type: 'card', amountPence: 5000 });
    expect(out).toEqual({ ok: false, reason: 'cardExceedsBalance', message: "Card can't be more than the balance (£41.80)" });
    expect(s0.tenders).toEqual([]);
  });

  it('after card 3000 (remaining 1180): card 1181 rejected; card 1180 accepted and completes', () => {
    const s1 = tenderOk(applyTender(startTendering(4180), { type: 'card', amountPence: 3000 }));
    const rejected = applyTender(s1, { type: 'card', amountPence: 1181 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe('cardExceedsBalance');
      expect(rejected.message).toBe("Card can't be more than the balance (£11.80)");
    }
    const s2 = tenderOk(applyTender(s1, { type: 'card', amountPence: 1180 }));
    expect(s2.complete).toBe(true);
    expect(s2.changePence).toBe(0);
  });

  it('a stored card tender above the total is an invalid sequence', () => {
    expect(tenderSequenceProblems(4180, [{ type: 'card', amountPence: 5000 }], 820).length).toBeGreaterThan(0);
  });

  it('cash 0 is too small, and a completed session takes nothing more', () => {
    expect(applyTender(startTendering(977), { type: 'cash', amountPence: 0 })).toMatchObject({ ok: false, reason: 'amountTooSmall' });
    const done = tenderOk(applyTender(startTendering(977), { type: 'cash', amountPence: 977 }));
    expect(applyTender(done, { type: 'cash', amountPence: 100 })).toMatchObject({ ok: false, reason: 'nothingDue' });
  });
});

// ---------------------------------------------------------------------------
// §10.1: deposit smaller than, equal to and larger than the bill
// ---------------------------------------------------------------------------

describe('§10.1 deposit smaller than / equal to / larger than the bill (§7.4, D-023)', () => {
  // Wine x4 @2295 = 9180; VAT 9180*20/120 = 1530 exactly; net 7650.
  const wine4 = [pl('wine', 4, 2295)];
  const wineSummary = [{ vatRate: 20, grossPence: 9180, vatPence: 1530, netPence: 7650 }];

  it('balance 5000 < bill 9180: applied 5000, total 4180; lines and VAT unchanged', () => {
    const p = price(wine4, { depositBalance: 5000 });
    expect(figs(p)).toEqual([L('wine', 9180, 0, 0, 9180, 1530, 7650)]);
    expect(totals(p)).toEqual({ gross: 9180, deal: 0, member: 0, subtotal: 9180, deposit: 5000, total: 4180 });
    expect(p.vatSummary).toEqual(wineSummary);
    expectConsistent(p);
  });

  it('balance 9180 = bill: applied 9180, total 0', () => {
    const p = price(wine4, { depositBalance: 9180 });
    expect(totals(p)).toEqual({ gross: 9180, deal: 0, member: 0, subtotal: 9180, deposit: 9180, total: 0 });
    expect(p.vatSummary).toEqual(wineSummary);
    // D-031: a zero total needs no tenders.
    expect(startTendering(p.totalPence)).toEqual({ totalPence: 0, tenders: [], remainingPence: 0, complete: true, changePence: 0 });
  });

  it('balance 10000 > bill: applied min(10000, 9180) = 9180, total 0, 10000 - 9180 = 820 stays on the booking', () => {
    const p = price(wine4, { depositBalance: 10000 });
    expect(totals(p)).toEqual({ gross: 9180, deal: 0, member: 0, subtotal: 9180, deposit: 9180, total: 0 });
    expect(10000 - p.depositAppliedPence).toBe(820);
    expect(p.vatSummary).toEqual(wineSummary);
  });

  it('depositApplied(): null -> 0; 5000 -> 5000; 9180 -> 9180; 10000 -> 9180 (subtotal 9180)', () => {
    expect(depositApplied(null, 9180)).toBe(0);
    expect(depositApplied(5000, 9180)).toBe(5000);
    expect(depositApplied(9180, 9180)).toBe(9180);
    expect(depositApplied(10000, 9180)).toBe(9180);
  });

  it('D-028: balance 7000 vs bill 9000 -> applied 7000, due 2000; vs bill 5000 -> applied 5000, due 0 (2000 remains)', () => {
    // Buffet x6 @1500 = 9000 (VAT 1500); Function buffet x2 @2500 = 5000 (VAT 5000/6 = 833.33 -> 833).
    const big = price([pl('buffet', 6, 1500, { eligible: false })], { depositBalance: 7000 });
    expect(totals(big)).toEqual({ gross: 9000, deal: 0, member: 0, subtotal: 9000, deposit: 7000, total: 2000 });
    const small = price([pl('function', 2, 2500, { eligible: false })], { depositBalance: 7000 });
    expect(figs(small)).toEqual([L('function', 5000, 0, 0, 5000, 833, 4167)]);
    expect(totals(small)).toEqual({ gross: 5000, deal: 0, member: 0, subtotal: 5000, deposit: 5000, total: 0 });
  });

  it('the deposit comes off AFTER member discount (§7.4): Lager x2 @450 member -> 765; balance 500 -> 265; balance 1000 -> 0', () => {
    const smaller = price([pl('lager', 2, 450)], { memberPercent: 15, depositBalance: 500 });
    expect(totals(smaller)).toEqual({ gross: 900, deal: 0, member: 135, subtotal: 765, deposit: 500, total: 265 });
    const equal = price([pl('lager', 2, 450)], { memberPercent: 15, depositBalance: 765 });
    expect(totals(equal)).toEqual({ gross: 900, deal: 0, member: 135, subtotal: 765, deposit: 765, total: 0 });
    const larger = price([pl('lager', 2, 450)], { memberPercent: 15, depositBalance: 1000 });
    expect(totals(larger)).toEqual({ gross: 900, deal: 0, member: 135, subtotal: 765, deposit: 765, total: 0 });
    expect(larger.vatSummary).toEqual([{ vatRate: 20, grossPence: 765, vatPence: 128, netPence: 637 }]);
  });
});

// ---------------------------------------------------------------------------
// §10.1: a partial refund
// ---------------------------------------------------------------------------

// D-042 S1 as stored (hand figures from D-020): Lager x3 and Crisps x2, member #1042, cash 2000, change 1023.
const S1_LAGER: SaleLine = {
  productId: 'lager',
  nameAtSale: 'Lager',
  qty: 3,
  unitPricePence: 450,
  vatRate: 20,
  dealDiscountPence: 450,
  memberDiscountPence: 135,
  finalPence: 765,
  vatPence: 128,
};
const S1_CRISPS: SaleLine = {
  productId: 'crisps',
  nameAtSale: 'Crisps',
  qty: 2,
  unitPricePence: 125,
  vatRate: 0,
  dealDiscountPence: 0,
  memberDiscountPence: 38,
  finalPence: 212,
  vatPence: 0,
};
const S1 = saleRecord({
  id: 'sale-s1',
  kind: 'sale',
  periodId: 'period-6',
  memberId: 'member-1042',
  lines: [S1_LAGER, S1_CRISPS],
  dealLines: [{ dealId: 'deal-lager-3for2', name: 'Lager 3 for 2', groupCount: 1, savingPence: 450 }],
  memberDiscountPence: 173,
  totalPence: 977,
  tenders: [{ type: 'cash', amountPence: 2000 }],
  changePence: 1023,
});

// D-042 S4: refund of 1 Lager from S1 by cash.
// deal 450*1/3 = 150; member 135*1/3 = 45; final 450 - 150 - 45 = 255; VAT 128*1/3 = 42.67 -> 43.
const S4_LINE: SaleLine = {
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
};
const S4 = saleRecord({
  id: 'sale-s4',
  kind: 'refund',
  periodId: 'period-6',
  memberId: 'member-1042',
  refundOfSaleId: 'sale-s1',
  lines: [S4_LINE],
  memberDiscountPence: -45,
  totalPence: -255,
  tenders: [{ type: 'cash', amountPence: -255 }],
});

describe('§10.1 a partial refund (§6.8, D-036..D-038)', () => {
  it('the hand-built S1 and S4 records satisfy the sale invariants (cross-check of the hand figures)', () => {
    expect(validateSale(S1)).toEqual([]);
    expect(validateSale(S4)).toEqual([]);
  });

  it('D-037: refund 1 of 3 Lagers -> deal -150, member -45, final -255, VAT -43 (42.67), net -212', () => {
    expect(buildRefundLine(S1_LAGER, 0, 0, 1, true)).toEqual(S4_LINE);
  });

  it('D-037: the 2nd single-unit refund takes VAT 128*2/3 = 85.33 -> 85, minus 43 = 42; the 3rd takes 128 - 85 = 43', () => {
    expect(buildRefundLine(S1_LAGER, 0, 1, 1, true)).toEqual({ ...S4_LINE, vatPence: -42 });
    expect(buildRefundLine(S1_LAGER, 0, 2, 1, true)).toEqual({ ...S4_LINE, vatPence: -43 });
    // Sum of the three: deal -450, member -135, final -765, VAT -128 = the negated original.
  });

  it('D-037: 2 units after the first -> deal 450 - 150 = 300, member 135 - 45 = 90, final 900 - 390 = 510, VAT 128 - 43 = 85', () => {
    expect(buildRefundLine(S1_LAGER, 0, 1, 2, false)).toEqual({
      ...S4_LINE,
      qty: -2,
      dealDiscountPence: -300,
      memberDiscountPence: -90,
      finalPence: -510,
      vatPence: -85,
      returnToStock: false,
    });
  });

  it('D-003: refunding 1 of 2 Crisps (0%, no deal) stores deal 0 and VAT 0, never -0; member 38*1/2 = 19; final 125 - 19 = 106', () => {
    const line = buildRefundLine(S1_CRISPS, 1, 0, 1, true);
    expect(line).toEqual({
      productId: 'crisps',
      nameAtSale: 'Crisps',
      qty: -1,
      unitPricePence: 125,
      vatRate: 0,
      dealDiscountPence: 0,
      memberDiscountPence: -19,
      finalPence: -106,
      vatPence: 0,
      refundOfLineIndex: 1,
      returnToStock: true,
    });
    expect(Object.is(line.dealDiscountPence, 0)).toBe(true);
    expect(Object.is(line.vatPence, 0)).toBe(true);
  });

  it('D-038 / D-042 S4: buildRefundSale for 1 Lager of S1 by cash -> total -255, tenders [cash -255], change 0', () => {
    const result = buildRefundSale({
      original: S1,
      existingRefunds: [],
      lines: [
        { lineIndex: 0, qty: 1, returnToStock: true },
        { lineIndex: 1, qty: 0, returnToStock: true },
      ],
      tenderType: 'cash',
      staffId: 'staff-manager',
    });
    expect(result).toEqual({
      ok: true,
      sale: {
        staffId: 'staff-manager',
        kind: 'refund',
        memberId: 'member-1042',
        refundOfSaleId: 'sale-s1',
        lines: [S4_LINE],
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

  it('a second partial refund after S4: 1 Lager (VAT -42) + 1 Crisps (-106) by card -> member -45 - 19 = -64, total -361', () => {
    // Lager: final -255, VAT -(85 - 43) = -42. Crisps: final -106, VAT 0. Total -255 - 106 = -361.
    const result = buildRefundSale({
      original: S1,
      existingRefunds: [S4],
      lines: [
        { lineIndex: 0, qty: 1, returnToStock: true },
        { lineIndex: 1, qty: 1, returnToStock: false },
      ],
      tenderType: 'card',
      staffId: 'staff-manager',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sale.lines).toEqual([
      { ...S4_LINE, vatPence: -42 },
      {
        productId: 'crisps',
        nameAtSale: 'Crisps',
        qty: -1,
        unitPricePence: 125,
        vatRate: 0,
        dealDiscountPence: 0,
        memberDiscountPence: -19,
        finalPence: -106,
        vatPence: 0,
        refundOfLineIndex: 1,
        returnToStock: false,
      },
    ]);
    expect(result.sale.memberDiscountPence).toBe(-64);
    expect(result.sale.totalPence).toBe(-361);
    expect(result.sale.tenders).toEqual([{ type: 'card', amountPence: -361 }]);
    expect(result.sale.changePence).toBe(0);
    expect(validateSale(result.sale)).toEqual([]);
  });

  it('D-036: refundable quantities: S1 [3,2]; after S4 [2,2]; more than what is left is rejected', () => {
    expect(refundableQuantities(S1, [])).toEqual([3, 2]);
    expect(refundableQuantities(S1, [S4])).toEqual([2, 2]);
    const tooMany = buildRefundSale({
      original: S1,
      existingRefunds: [S4],
      lines: [{ lineIndex: 0, qty: 3, returnToStock: true }],
      tenderType: 'cash',
      staffId: 'staff-manager',
    });
    expect(tooMany.ok).toBe(false);
  });

  it('D-038: refunding 1 Wine from a bill that had a deposit applied: final -2295, VAT -(1530/4 = 382.5 -> 383); no booking', () => {
    const wineLine: SaleLine = {
      productId: 'wine',
      nameAtSale: 'Wine',
      qty: 4,
      unitPricePence: 2295,
      vatRate: 20,
      dealDiscountPence: 0,
      memberDiscountPence: 0,
      finalPence: 9180,
      vatPence: 1530,
    };
    const s3 = saleRecord({
      id: 'sale-s3',
      kind: 'sale',
      periodId: 'period-6',
      bookingId: 'booking-smith',
      lines: [wineLine],
      depositAppliedPence: 5000,
      totalPence: 4180,
      tenders: [
        { type: 'card', amountPence: 3000 },
        { type: 'cash', amountPence: 1500 },
      ],
      changePence: 320,
    });
    const result = buildRefundSale({
      original: s3,
      existingRefunds: [],
      lines: [{ lineIndex: 0, qty: 1, returnToStock: true }],
      tenderType: 'cash',
      staffId: 'staff-manager',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sale.lines).toEqual([
      {
        productId: 'wine',
        nameAtSale: 'Wine',
        qty: -1,
        unitPricePence: 2295,
        vatRate: 20,
        dealDiscountPence: 0,
        memberDiscountPence: 0,
        finalPence: -2295,
        vatPence: -383,
        refundOfLineIndex: 0,
        returnToStock: true,
      },
    ]);
    expect(result.sale.totalPence).toBe(-2295);
    expect(Object.is(result.sale.memberDiscountPence, 0)).toBe(true);
    expect(result.sale.depositAppliedPence).toBe(0);
    expect(result.sale.bookingId).toBeUndefined();
    expect(result.sale.tenders).toEqual([{ type: 'cash', amountPence: -2295 }]);
    // The next single Wine refund: VAT round(1530*2/4 = 765) - 383 = 382.
    expect(buildRefundLine(wineLine, 0, 1, 1, true).vatPence).toBe(-382);
  });
});

// ---------------------------------------------------------------------------
// §10.1: Z expected cash with float, change, cash refunds and deposits
// ---------------------------------------------------------------------------

describe('§10.1 Z expected cash with float, change, cash refunds and deposits (§7 cash-up, D-041, D-042)', () => {
  it('expectedCash = float + cash tendered - change - cash refunded: 10000 + 8500 - 1343 - 255 = 16902', () => {
    expect(expectedCash({ floatPence: 10000, cashTenderedPence: 8500, changeGivenPence: 1343, cashRefundedPence: 255 })).toBe(16902);
    expect(expectedCash({ floatPence: 15000, cashTenderedPence: 3000, changeGivenPence: 1160, cashRefundedPence: 420 })).toBe(16420);
    expect(expectedCash({ floatPence: 10000, cashTenderedPence: 0, changeGivenPence: 0, cashRefundedPence: 0 })).toBe(10000);
  });

  it('D-042 worked period: float 10000; S1 sale, S2 deposit, S3 bill with deposit applied, S4 cash refund; 1 no sale, 2 voids', () => {
    const period = periodRecord('period-6', 10000);
    const s2 = saleRecord({
      id: 'sale-s2',
      kind: 'deposit',
      periodId: 'period-6',
      bookingId: 'booking-smith',
      totalPence: 5000,
      tenders: [{ type: 'cash', amountPence: 5000 }],
    });
    const s3 = saleRecord({
      id: 'sale-s3',
      kind: 'sale',
      periodId: 'period-6',
      bookingId: 'booking-smith',
      lines: [
        { productId: 'wine', nameAtSale: 'Wine', qty: 4, unitPricePence: 2295, vatRate: 20, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: 9180, vatPence: 1530 },
      ],
      depositAppliedPence: 5000,
      totalPence: 4180,
      tenders: [
        { type: 'card', amountPence: 3000 },
        { type: 'cash', amountPence: 1500 },
      ],
      changePence: 320,
    });
    expect(validateSale(s2)).toEqual([]);
    expect(validateSale(s3)).toEqual([]);
    const events = [
      noSaleEvent('ev-1', 'period-6'),
      voidEvent('ev-2', 'period-6'),
      overrideEvent('ev-3', 'period-6'), // overrides are not counted (D-043)
      voidEvent('ev-4', 'period-6'),
    ];
    const f = periodFigures({ period, sales: [S1, s2, s3, S4], auditEvents: events });
    const expected: PeriodFigures = {
      grossSalesPence: 10780, // 1350 + 250 + 9180
      dealDiscountsPence: 450,
      memberDiscountsPence: 173, // 135 + 38
      refundsPence: 255,
      netTakingsPence: 9902, // 10780 - 450 - 173 - 255
      depositsTakenPence: 5000,
      depositsAppliedPence: 5000,
      cashTenderedPence: 8500, // 2000 + 5000 + 1500
      changeGivenPence: 1343, // 1023 + 320
      cashRefundedPence: 255,
      cashTotalPence: 6902, // 8500 - 1343 - 255
      cardTenderedPence: 3000,
      cardRefundedPence: 0,
      cardTotalPence: 3000,
      vatByRate: [
        { vatRate: 20, grossPence: 9690, vatPence: 1615, netPence: 8075 }, // 765 + 9180 - 255; 128 + 1530 - 43
        { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
      ],
      floatPence: 10000,
      expectedCashPence: 16902, // 10000 + 8500 - 1343 - 255
      noSaleCount: 1,
      voidCount: 2,
    };
    expect(f).toEqual(expected);
    // D-042 identities.
    expect(f.cashTotalPence + f.cardTotalPence).toBe(f.netTakingsPence - f.depositsAppliedPence + f.depositsTakenPence);
    expect(f.expectedCashPence).toBe(f.floatPence + f.cashTotalPence);
    expect(sum(f.vatByRate.map((r) => r.grossPence))).toBe(f.netTakingsPence);
    // Z: declared 16900 -> variance 16900 - 16902 = -2 (short).
    const z = zFigures(f, 16900);
    expect(z.declaredCashPence).toBe(16900);
    expect(z.variancePence).toBe(-2);
    expect(z.expectedCashPence).toBe(16902);
  });

  it('a period with deposit change, card and cash refunds, and records from another period that must be ignored', () => {
    // float 15000.
    // T1 sale Bitter x2 @420 = 840 (VAT 140), cash 1000, change 160.
    // T2 sale Buffet x2 @1500 = 3000 (VAT 500), card 3000.
    // T3 deposit 2500 by card. T4 deposit 1000, cash 2000, change 1000.
    // T5 refund 1 Buffet from T2 by card: -1500, VAT -(500*1/2) = -250.
    // T6 refund 1 Bitter from T1 by cash: -420, VAT -(140*1/2) = -70.
    // T7 sale in period-5 (ignored); a void in period-5 (ignored); an override (never counted).
    const bitter: SaleLine = { productId: 'bitter', nameAtSale: 'Bitter', qty: 2, unitPricePence: 420, vatRate: 20, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: 840, vatPence: 140 };
    const buffet: SaleLine = { productId: 'buffet', nameAtSale: 'Buffet', qty: 2, unitPricePence: 1500, vatRate: 20, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: 3000, vatPence: 500 };
    const sales: Sale[] = [
      saleRecord({ id: 't1', kind: 'sale', periodId: 'period-7', lines: [bitter], totalPence: 840, tenders: [{ type: 'cash', amountPence: 1000 }], changePence: 160 }),
      saleRecord({ id: 't2', kind: 'sale', periodId: 'period-7', lines: [buffet], totalPence: 3000, tenders: [{ type: 'card', amountPence: 3000 }] }),
      saleRecord({ id: 't3', kind: 'deposit', periodId: 'period-7', bookingId: 'booking-a', totalPence: 2500, tenders: [{ type: 'card', amountPence: 2500 }] }),
      saleRecord({ id: 't4', kind: 'deposit', periodId: 'period-7', bookingId: 'booking-b', totalPence: 1000, tenders: [{ type: 'cash', amountPence: 2000 }], changePence: 1000 }),
      saleRecord({
        id: 't5',
        kind: 'refund',
        periodId: 'period-7',
        refundOfSaleId: 't2',
        lines: [{ ...buffet, qty: -1, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: -1500, vatPence: -250, refundOfLineIndex: 0, returnToStock: true }],
        totalPence: -1500,
        tenders: [{ type: 'card', amountPence: -1500 }],
      }),
      saleRecord({
        id: 't6',
        kind: 'refund',
        periodId: 'period-7',
        refundOfSaleId: 't1',
        lines: [{ ...bitter, qty: -1, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: -420, vatPence: -70, refundOfLineIndex: 0, returnToStock: true }],
        totalPence: -420,
        tenders: [{ type: 'cash', amountPence: -420 }],
      }),
      saleRecord({
        id: 't7',
        kind: 'sale',
        periodId: 'period-5',
        lines: [{ productId: 'lager', nameAtSale: 'Lager', qty: 1, unitPricePence: 450, vatRate: 20, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: 450, vatPence: 75 }],
        totalPence: 450,
        tenders: [{ type: 'cash', amountPence: 450 }],
      }),
    ];
    for (const s of sales) expect(validateSale(s)).toEqual([]);
    const events = [
      voidEvent('e1', 'period-7'),
      noSaleEvent('e2', 'period-7'),
      noSaleEvent('e3', 'period-7'),
      voidEvent('e4', 'period-5'),
      overrideEvent('e5', 'period-7'),
    ];
    const f = periodFigures({ period: periodRecord('period-7', 15000), sales, auditEvents: events });
    expect(f).toEqual({
      grossSalesPence: 3840, // 840 + 3000
      dealDiscountsPence: 0,
      memberDiscountsPence: 0,
      refundsPence: 1920, // 1500 + 420
      netTakingsPence: 1920, // 3840 - 1920
      depositsTakenPence: 3500, // 2500 + 1000
      depositsAppliedPence: 0,
      cashTenderedPence: 3000, // 1000 (T1) + 2000 (T4)
      changeGivenPence: 1160, // 160 + 1000
      cashRefundedPence: 420,
      cashTotalPence: 1420, // 3000 - 1160 - 420
      cardTenderedPence: 5500, // 3000 + 2500
      cardRefundedPence: 1500,
      cardTotalPence: 4000, // 5500 - 1500
      vatByRate: [{ vatRate: 20, grossPence: 1920, vatPence: 320, netPence: 1600 }], // 140 + 500 - 250 - 70 = 320
      floatPence: 15000,
      expectedCashPence: 16420, // 15000 + 3000 - 1160 - 420
      noSaleCount: 2,
      voidCount: 1,
    } satisfies PeriodFigures);
    // Identity 2: 1420 + 4000 = 5420 = 1920 - 0 + 3500.
    expect(f.cashTotalPence + f.cardTotalPence).toBe(5420);
    // Z: declared 16500 -> +80 (over).
    expect(zFigures(f, 16500).variancePence).toBe(80);
  });

  it('a deposit applied never touches the drawer: deposit 5000 by card, then a 9180 bill with 5000 applied paid by cash 5000', () => {
    // Bill total 9180 - 5000 = 4180, cash 5000, change 820. Expected cash = 2000 + 5000 - 820 - 0 = 6180.
    const sales: Sale[] = [
      saleRecord({ id: 'd1', kind: 'deposit', periodId: 'period-8', bookingId: 'booking-c', totalPence: 5000, tenders: [{ type: 'card', amountPence: 5000 }] }),
      saleRecord({
        id: 'b1',
        kind: 'sale',
        periodId: 'period-8',
        bookingId: 'booking-c',
        lines: [
          { productId: 'wine', nameAtSale: 'Wine', qty: 4, unitPricePence: 2295, vatRate: 20, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: 9180, vatPence: 1530 },
        ],
        depositAppliedPence: 5000,
        totalPence: 4180,
        tenders: [{ type: 'cash', amountPence: 5000 }],
        changePence: 820,
      }),
    ];
    const f = periodFigures({ period: periodRecord('period-8', 2000), sales, auditEvents: [] });
    expect(f.cashTenderedPence).toBe(5000);
    expect(f.changeGivenPence).toBe(820);
    expect(f.cashTotalPence).toBe(4180);
    expect(f.cardTotalPence).toBe(5000);
    expect(f.depositsTakenPence).toBe(5000);
    expect(f.depositsAppliedPence).toBe(5000);
    expect(f.netTakingsPence).toBe(9180);
    expect(f.expectedCashPence).toBe(6180);
    expect(f.vatByRate).toEqual([{ vatRate: 20, grossPence: 9180, vatPence: 1530, netPence: 7650 }]);
    // Identity 2: 4180 + 5000 = 9180 - 5000 + 5000.
    expect(f.cashTotalPence + f.cardTotalPence).toBe(9180);
    // Z declared exactly 6180 -> variance 0 (and never -0).
    expect(Object.is(zFigures(f, 6180).variancePence, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §10.1: the permission matrix in section 5
// ---------------------------------------------------------------------------

describe('§10.1 the §5 permission matrix (D-069)', () => {
  // Transcribed by hand from the spec §5 table: [action, row wording, staff, supervisor, manager].
  const SPEC_MATRIX: ReadonlyArray<readonly [Action, string, boolean, boolean, boolean]> = [
    ['sell', 'Sell, take payment', true, true, true],
    ['tabs', 'Open, add to, settle tabs', true, true, true],
    ['attachMember', 'Attach member', true, true, true],
    ['bookings', 'Create booking, take deposit, apply deposit', true, true, true],
    ['voidLine', 'Void a basket line', false, true, true],
    ['noSale', 'No sale (open drawer)', false, true, true],
    ['xRead', 'X read', false, true, true],
    ['refund', 'Refund', false, false, true],
    ['openClosePeriod', 'Open period, Z close', false, false, true],
    ['editCatalogue', 'Edit products, prices, categories, deals', false, false, true],
    ['stockControl', 'Goods in, stock adjustment', false, false, true],
    ['manageMembersStaffSettings', 'Manage members, staff, settings', false, false, true],
    ['salesReports', 'Product sales and VAT reports', false, false, true],
    ['backup', 'Export / import backup', false, false, true],
  ];
  const ROLES: readonly Role[] = ['staff', 'supervisor', 'manager'];

  const cases: Array<[Role, Action, boolean]> = SPEC_MATRIX.flatMap(([action, , staff, supervisor, manager]) =>
    ROLES.map((role, i): [Role, Action, boolean] => [role, action, [staff, supervisor, manager][i] === true]),
  );

  it.each(cases)('can(%s, %s) === %s', (role, action, allowed) => {
    expect(can(role, action)).toBe(allowed);
  });

  it('ACTIONS lists exactly the 14 §5 rows in order, with the spec wording', () => {
    expect([...ACTIONS]).toEqual(SPEC_MATRIX.map(([action]) => action));
    for (const [action, label] of SPEC_MATRIX) expect(ACTION_LABELS[action]).toBe(label);
  });

  it('minimum roles and override prompts (D-069, D-071)', () => {
    expect(minRoleFor('sell')).toBe('staff');
    expect(minRoleFor('voidLine')).toBe('supervisor');
    expect(minRoleFor('refund')).toBe('manager');
    expect(overridePrompt('voidLine')).toBe('Supervisor or manager PIN');
    expect(overridePrompt('noSale')).toBe('Supervisor or manager PIN');
    expect(overridePrompt('refund')).toBe('Manager PIN');
    expect(overridePrompt('backup')).toBe('Manager PIN');
  });

  it('D-069 examples: staff cannot void, supervisor can; supervisor cannot refund; manager can back up', () => {
    expect(can('staff', 'voidLine')).toBe(false);
    expect(can('supervisor', 'voidLine')).toBe(true);
    expect(can('supervisor', 'refund')).toBe(false);
    expect(can('manager', 'backup')).toBe(true);
  });
});
