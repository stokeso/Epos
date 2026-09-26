import { describe, expect, it } from 'vitest';
import type { NewSale, SaleLine } from '../../src/data/types';
import { formatReceiptNumber, normaliseReceiptQuery, validateSale } from '../../src/rules/sale';
import { d042Scenario } from './fixtures';

const { newSales } = d042Scenario();
const S1 = newSales.s1; // member sale, deal, two lines, cash with change
const S2 = newSales.s2; // deposit
const S3 = newSales.s3; // deposit applied, split tenders
const S4 = newSales.s4; // refund of 1 Lager

/** A copy of `sale` with `patch` applied to line `index`. */
function withLine(sale: NewSale, index: number, patch: Partial<SaleLine>): NewSale {
  return { ...sale, lines: sale.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) };
}

describe('validateSale: valid sales of every kind (D-032)', () => {
  it('accepts the D-042 sales, deposit and refund', () => {
    expect(validateSale(S1)).toEqual([]);
    expect(validateSale(S2)).toEqual([]);
    expect(validateSale(S3)).toEqual([]);
    expect(validateSale(S4)).toEqual([]);
  });

  it('accepts a zero-total sale with no tenders (D-031)', () => {
    // Wine x4 = 9180 fully covered by a 10000 deposit balance.
    const zero: NewSale = { ...S3, depositAppliedPence: 9180, totalPence: 0, tenders: [], changePence: 0 };
    expect(validateSale(zero)).toEqual([]);
  });

  it('accepts a refund of zero value with no tenders', () => {
    const line: SaleLine = {
      productId: 'water-jug',
      nameAtSale: 'Water jug',
      qty: -1,
      unitPricePence: 0,
      vatRate: 20,
      dealDiscountPence: 0,
      memberDiscountPence: 0,
      finalPence: 0,
      vatPence: 0,
      refundOfLineIndex: 0,
      returnToStock: true,
    };
    const refund: NewSale = { ...S4, lines: [line], memberDiscountPence: 0, totalPence: 0, tenders: [] };
    expect(validateSale(refund)).toEqual([]);
  });
});

describe('validateSale: rules for every kind', () => {
  it.each<[string, NewSale]>([
    ['-0 in a money field', { ...S1, depositAppliedPence: -0 }],
    ['-0 in a line field', withLine(S1, 1, { dealDiscountPence: -0 })],
    ['a fractional amount', { ...S2, totalPence: 5000.5, tenders: [{ type: 'cash', amountPence: 5000.5 }] }],
    ['tenders - change != total', { ...S1, changePence: 1000 }],
    ['an unknown kind', { ...S1, kind: 'voucher' as NewSale['kind'] }],
  ])('rejects %s', (_label, sale) => {
    expect(validateSale(sale).length).toBeGreaterThan(0);
  });
});

describe("validateSale: kind 'sale'", () => {
  it.each<[string, NewSale]>([
    ['no lines', { ...S1, lines: [], dealLines: [], memberDiscountPence: 0, totalPence: 0, tenders: [], changePence: 0 }],
    ['duplicate productIds', { ...S1, lines: [S1.lines[0]!, { ...S1.lines[0]!, productId: 'lager' }] }],
    ['a zero qty', withLine(S1, 1, { qty: 0 })],
    ['final != gross - deal - member', withLine(S1, 0, { finalPence: 766 })],
    ['VAT that is not lineVat(final, rate)', withLine(S1, 0, { vatPence: 127 })],
    ['a deal discount above gross', withLine(S1, 1, { dealDiscountPence: 251, memberDiscountPence: 0, finalPence: -1 })],
    ['a negative member discount', withLine(S1, 1, { memberDiscountPence: -1, finalPence: 251 })],
    ['refund fields on a sale line', withLine(S1, 0, { refundOfLineIndex: 0 })],
    ['returnToStock on a sale line', withLine(S1, 0, { returnToStock: true })],
    ['member discount total != sum of lines', { ...S1, memberDiscountPence: 172 }],
    ['deal lines that do not sum to the line deals', { ...S1, dealLines: [{ ...S1.dealLines[0]!, savingPence: 449 }] }],
    ['a deposit applied with no booking', { ...S3, bookingId: undefined }],
    ['a deposit applied above the lines', { ...S3, depositAppliedPence: 9181, totalPence: -1, tenders: [], changePence: 1 }],
    ['a negative deposit applied', { ...S1, depositAppliedPence: -1 }],
    ['total != finals - deposit applied', { ...S3, totalPence: 4181, changePence: 319 }],
    ['a card tender above the remaining amount', { ...S1, tenders: [{ type: 'card', amountPence: 2000 }] }],
    ['a zero total with tenders', { ...S3, depositAppliedPence: 9180, totalPence: 0, tenders: [{ type: 'cash', amountPence: 100 }], changePence: 100 }],
    ['a refundOfSaleId on a sale', { ...S1, refundOfSaleId: 'sale-0' }],
  ])('rejects %s', (_label, sale) => {
    expect(validateSale(sale).length).toBeGreaterThan(0);
  });
});

describe("validateSale: kind 'deposit'", () => {
  it.each<[string, NewSale]>([
    ['lines', { ...S2, lines: S1.lines }],
    ['deal lines', { ...S2, dealLines: S1.dealLines }],
    ['no booking', { ...S2, bookingId: undefined }],
    ['a member', { ...S2, memberId: 'member-1042' }],
    ['a tab', { ...S2, tabId: 'tab-1' }],
    ['a refundOfSaleId', { ...S2, refundOfSaleId: 'sale-1' }],
    ['a member discount', { ...S2, memberDiscountPence: 1 }],
    ['a deposit applied', { ...S2, depositAppliedPence: 1 }],
    ['a zero amount', { ...S2, totalPence: 0, tenders: [] }],
    ['an amount above the keypad maximum', { ...S2, totalPence: 10_000_000, tenders: [{ type: 'cash', amountPence: 10_000_000 }] }],
    ['a card above the amount', { ...S2, tenders: [{ type: 'card', amountPence: 6000 }], changePence: 1000 }],
  ])('rejects %s', (_label, sale) => {
    expect(validateSale(sale).length).toBeGreaterThan(0);
  });

  it('allows cash change on a deposit', () => {
    expect(validateSale({ ...S2, tenders: [{ type: 'cash', amountPence: 6000 }], changePence: 1000 })).toEqual([]);
  });
});

describe("validateSale: kind 'refund'", () => {
  it.each<[string, NewSale]>([
    ['no refundOfSaleId', { ...S4, refundOfSaleId: undefined }],
    ['a booking', { ...S4, bookingId: 'booking-smith' }],
    ['a tab', { ...S4, tabId: 'tab-1' }],
    ['no lines', { ...S4, lines: [], memberDiscountPence: 0, totalPence: 0, tenders: [] }],
    ['a positive qty', withLine(S4, 0, { qty: 1 })],
    ['a missing refundOfLineIndex', withLine(S4, 0, { refundOfLineIndex: undefined })],
    ['a missing returnToStock', withLine(S4, 0, { returnToStock: undefined })],
    [
      'a repeated refundOfLineIndex',
      {
        ...S4,
        lines: [S4.lines[0]!, S4.lines[0]!],
        memberDiscountPence: -90,
        totalPence: -510,
        tenders: [{ type: 'cash', amountPence: -510 }],
      },
    ],
    ['final != qty*unit - deal - member', withLine(S4, 0, { finalPence: -256 })],
    ['a positive deal discount', withLine(S4, 0, { dealDiscountPence: 150, finalPence: -555 })],
    ['a positive VAT', withLine(S4, 0, { vatPence: 43 })],
    ['deal lines', { ...S4, dealLines: S1.dealLines }],
    ['member discount != sum of lines', { ...S4, memberDiscountPence: 0 }],
    ['a deposit applied', { ...S4, depositAppliedPence: -1 }],
    ['total != sum of finals', { ...S4, totalPence: -250, tenders: [{ type: 'cash', amountPence: -250 }] }],
    ['change', { ...S4, tenders: [{ type: 'cash', amountPence: -250 }], changePence: 5 }],
    [
      'two tenders',
      {
        ...S4,
        tenders: [
          { type: 'cash', amountPence: -155 },
          { type: 'card', amountPence: -100 },
        ],
      },
    ],
    ['a positive tender', { ...S4, totalPence: -255, tenders: [{ type: 'cash', amountPence: 255 }], changePence: 510 }],
    ['no tender on a non-zero total', { ...S4, tenders: [], changePence: -255 }],
  ])('rejects %s', (_label, sale) => {
    expect(validateSale(sale).length).toBeGreaterThan(0);
  });
});

describe('formatReceiptNumber (D-059)', () => {
  it('pads to 6 digits and grows past them without truncating', () => {
    expect(formatReceiptNumber('TILL1', 42)).toBe('TILL1-000042');
    expect(formatReceiptNumber('3F9C', 42)).toBe('3F9C-000042');
    expect(formatReceiptNumber('BAR1', 58)).toBe('BAR1-000058');
    expect(formatReceiptNumber('3F9C', 999_999)).toBe('3F9C-999999');
    expect(formatReceiptNumber('3F9C', 1_234_567)).toBe('3F9C-1234567');
  });

  it('throws RangeError for a non-positive or fractional number', () => {
    expect(() => formatReceiptNumber('3F9C', 0)).toThrow(RangeError);
    expect(() => formatReceiptNumber('3F9C', 1.5)).toThrow(RangeError);
  });
});

describe('normaliseReceiptQuery (D-035, D-122)', () => {
  it.each([
    ['3f9c-42', '3F9C-000042'],
    ['  3F9C-000042 ', '3F9C-000042'],
    ['bar1-58', 'BAR1-000058'],
    ['3f9c-1234567', '3F9C-1234567'],
    ['3f9c-0000042', '3F9C-000042'], // D-122: leading zeros are dropped before padding
    ['3f9c-0', '3F9C-000000'],
    ['abc', 'ABC'], // not a receipt pattern: trimmed and upper-cased only
    ['toolong1-42', 'TOOLONG1-42'],
  ])('%j -> %j', (text, normalised) => {
    expect(normaliseReceiptQuery(text)).toBe(normalised);
  });

  it('returns null for empty input', () => {
    expect(normaliseReceiptQuery('')).toBeNull();
    expect(normaliseReceiptQuery('   ')).toBeNull();
  });
});
