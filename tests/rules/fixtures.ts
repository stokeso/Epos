/**
 * Shared builders for the rules tests. Not a test file itself (vitest only runs *.test.ts).
 * Every figure the tests assert is hand-computed in the test files; these helpers only build inputs.
 */
import type { AuditEvent, Category, Deal, NewSale, Period, Product, Sale } from '../../src/data/types';
import type { PricingLine } from '../../src/rules/pricing';
import { priceBasket, toSaleLines } from '../../src/rules/pricing';
import { buildRefundSale } from '../../src/rules/refund';

export const DEVICE = 'device-1';
export const T0 = '2026-09-01T09:00:00.000Z';
/** 2026-09-26 14:05 London (BST). */
export const AT = '2026-09-26T13:05:12.345Z';

type DealExtras = Partial<Omit<Deal, 'type' | 'n' | 'pricePence' | 'm' | 'productIds'>>;

export function nForPrice(id: string, n: number, pricePence: number, productIds: string[], extras: DealExtras = {}): Deal {
  return {
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    name: id,
    type: 'nForPrice',
    n,
    pricePence,
    productIds,
    active: true,
    ...extras,
  };
}

export function nForM(id: string, n: number, m: number, productIds: string[], extras: DealExtras = {}): Deal {
  return {
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    name: id,
    type: 'nForM',
    n,
    m,
    productIds,
    active: true,
    ...extras,
  };
}

/** A pricing line; VAT 20% and member-eligible unless overridden. */
export function pline(
  productId: string,
  qty: number,
  unitPricePence: number,
  opts: { vatRate?: number; eligible?: boolean; name?: string } = {},
): PricingLine {
  return {
    productId,
    name: opts.name ?? productId,
    qty,
    unitPricePence,
    vatRate: opts.vatRate ?? 20,
    memberDiscountEligible: opts.eligible ?? true,
  };
}

export interface StoredMeta {
  id: string;
  periodId: string;
  createdAt: string;
  receiptNumber: string;
}

/** Adds the fields the data layer would add at commit. */
export function toStoredSale(sale: NewSale, meta: StoredMeta): Sale {
  return {
    ...sale,
    id: meta.id,
    deviceId: DEVICE,
    createdAt: meta.createdAt,
    updatedAt: meta.createdAt,
    periodId: meta.periodId,
    receiptNumber: meta.receiptNumber,
  };
}

export function makeProduct(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    name: id,
    categoryId: 'cat-draught',
    pricePence: 450,
    vatRate: 20,
    memberDiscountEligible: true,
    stockTracked: true,
    stockUnit: 'pint',
    lowStockLevel: 10,
    buttonColour: '#b45309',
    sortOrder: 1,
    active: true,
    ...overrides,
  };
}

export function makeCategory(id: string, overrides: Partial<Category> = {}): Category {
  return {
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    name: id,
    sortOrder: 1,
    colour: '#b45309',
    ...overrides,
  };
}

export function makePeriod(id: string, floatPence: number, overrides: Partial<Period> = {}): Period {
  return {
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    openedAt: T0,
    openedBy: 'staff-manager',
    floatPence,
    ...overrides,
  };
}

let auditSeq = 0;
export function auditEvent(type: 'void' | 'noSale' | 'override', periodId: string | undefined): AuditEvent {
  auditSeq += 1;
  const base = {
    id: `audit-${auditSeq}`,
    deviceId: DEVICE,
    createdAt: AT,
    updatedAt: AT,
    staffId: 'staff-sue',
    ...(periodId === undefined ? {} : { periodId }),
  };
  if (type === 'void') {
    return { ...base, type, detail: { productId: 'lager', productName: 'Lager', qty: 1, unitPricePence: 450 } };
  }
  if (type === 'noSale') {
    return { ...base, type, detail: {} };
  }
  return { ...base, type, detail: { action: 'voidLine' } };
}

/**
 * The D-042 worked period, built with the real rules:
 * - S1 (member #1042): Lager x3 @450 with "Lager 3 for 2", Crisps x2 @125 at 0%. Total 977; cash 2000, change 1023.
 * - S2: deposit 5000 for "Smith wedding", cash.
 * - S3: Wine x4 @2295 with that booking (balance 5000). Applied 5000, total 4180; card 3000 + cash 1500, change 320.
 * - S4: refund of 1 Lager from S1 by cash: -255 (VAT -43).
 * - One no sale, two voids (and an override, which is not counted).
 */
export function d042Scenario(periodId = 'period-6') {
  const staffId = 'staff-manager';
  const lager3for2 = nForM('deal-lager-3for2', 3, 2, ['lager'], { name: 'Lager 3 for 2' });

  const p1 = priceBasket({
    lines: [pline('lager', 3, 450, { name: 'Lager' }), pline('crisps', 2, 125, { vatRate: 0, name: 'Crisps' })],
    deals: [lager3for2],
    at: AT,
    memberDiscountPercent: 15,
    depositBalancePence: null,
  });
  const s1New: NewSale = {
    staffId,
    kind: 'sale',
    memberId: 'member-1042',
    lines: toSaleLines(p1),
    dealLines: p1.dealLines,
    memberDiscountPence: p1.memberDiscountPence,
    depositAppliedPence: p1.depositAppliedPence,
    totalPence: p1.totalPence,
    tenders: [{ type: 'cash', amountPence: 2000 }],
    changePence: 1023,
  };
  const s1 = toStoredSale(s1New, { id: 'sale-1', periodId, createdAt: '2026-09-26T12:00:00.000Z', receiptNumber: '3F9C-000001' });

  const s2New: NewSale = {
    staffId,
    kind: 'deposit',
    bookingId: 'booking-smith',
    lines: [],
    dealLines: [],
    memberDiscountPence: 0,
    depositAppliedPence: 0,
    totalPence: 5000,
    tenders: [{ type: 'cash', amountPence: 5000 }],
    changePence: 0,
  };
  const s2 = toStoredSale(s2New, { id: 'sale-2', periodId, createdAt: '2026-09-26T12:10:00.000Z', receiptNumber: '3F9C-000002' });

  const p3 = priceBasket({
    lines: [pline('wine', 4, 2295, { name: 'Wine' })],
    deals: [lager3for2],
    at: AT,
    memberDiscountPercent: null,
    depositBalancePence: 5000,
  });
  const s3New: NewSale = {
    staffId,
    kind: 'sale',
    bookingId: 'booking-smith',
    lines: toSaleLines(p3),
    dealLines: p3.dealLines,
    memberDiscountPence: p3.memberDiscountPence,
    depositAppliedPence: p3.depositAppliedPence,
    totalPence: p3.totalPence,
    tenders: [
      { type: 'card', amountPence: 3000 },
      { type: 'cash', amountPence: 1500 },
    ],
    changePence: 320,
  };
  const s3 = toStoredSale(s3New, { id: 'sale-3', periodId, createdAt: '2026-09-26T13:00:00.000Z', receiptNumber: '3F9C-000003' });

  const refund = buildRefundSale({
    original: s1,
    existingRefunds: [],
    lines: [{ lineIndex: 0, qty: 1, returnToStock: true }],
    tenderType: 'cash',
    staffId,
  });
  if (!refund.ok) throw new Error(refund.errors.join('; '));
  const s4New = refund.sale;
  const s4 = toStoredSale(s4New, { id: 'sale-4', periodId, createdAt: '2026-09-26T14:00:00.000Z', receiptNumber: '3F9C-000004' });

  const auditEvents: AuditEvent[] = [
    auditEvent('noSale', periodId),
    auditEvent('void', periodId),
    auditEvent('override', periodId),
    auditEvent('void', periodId),
  ];

  return {
    period: makePeriod(periodId, 10000),
    lager3for2,
    p1,
    p3,
    newSales: { s1: s1New, s2: s2New, s3: s3New, s4: s4New },
    sales: { s1, s2, s3, s4 },
    auditEvents,
  };
}
