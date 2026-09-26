import { describe, expect, it } from 'vitest';
import type { Sale } from '../../src/data/types';
import { UNCATEGORISED_ID, UNCATEGORISED_NAME, productSalesReport, vatReport } from '../../src/rules/reports';
import { localDateRange, type LocalDateRange } from '../../src/rules/time';
import { d042Scenario, makeCategory, makeProduct, toStoredSale } from './fixtures';

const scenario = d042Scenario();
const { s1, s2, s3, s4 } = scenario.sales; // all on 26/09/2026 (London)

function range(from: string, to = from): LocalDateRange {
  const r = localDateRange(from, to);
  if (r === null) throw new Error('bad range');
  return r;
}

const categories = [
  makeCategory('cat-snacks', { name: 'Snacks', sortOrder: 6 }),
  makeCategory('cat-draught', { name: 'Draught', sortOrder: 1 }),
  makeCategory('cat-wine', { name: 'Wine', sortOrder: 4 }),
];
const products = [
  makeProduct('lager', { name: 'Fairway Lager', categoryId: 'cat-draught', sortOrder: 2 }),
  makeProduct('crisps', { name: 'Ready Salted Crisps', categoryId: 'cat-snacks', sortOrder: 1, vatRate: 0 }),
  makeProduct('wine', { name: 'House Red (bottle)', categoryId: 'cat-wine', sortOrder: 4 }),
];

describe('productSalesReport (D-044)', () => {
  it('reports the D-042 scenario: quantities and takings net of refunds', () => {
    const report = productSalesReport({ sales: [s1, s2, s3, s4], products, categories, range: range('2026-09-26') });
    expect(report).toEqual({
      range: range('2026-09-26'),
      categories: [
        {
          categoryId: 'cat-draught',
          name: 'Draught',
          qty: 2,
          takingsPence: 510,
          products: [{ productId: 'lager', name: 'Fairway Lager', qty: 2, takingsPence: 510 }], // 3 - 1; 765 - 255
        },
        {
          categoryId: 'cat-wine',
          name: 'Wine',
          qty: 4,
          takingsPence: 9180, // before the 5000 deposit applied
          products: [{ productId: 'wine', name: 'House Red (bottle)', qty: 4, takingsPence: 9180 }],
        },
        {
          categoryId: 'cat-snacks',
          name: 'Snacks',
          qty: 2,
          takingsPence: 212,
          products: [{ productId: 'crisps', name: 'Ready Salted Crisps', qty: 2, takingsPence: 212 }],
        },
      ],
      totalQty: 8,
      totalTakingsPence: 9902,
    });
  });

  it('total takings equal the VAT report total gross for the same range (D-042)', () => {
    const r = range('2026-09-26');
    const sales = [s1, s2, s3, s4];
    expect(productSalesReport({ sales, products, categories, range: r }).totalTakingsPence).toBe(vatReport(sales, r).totals.grossPence);
  });

  it('sorts products by sortOrder then name, and categories by sortOrder then name', () => {
    const cats = [makeCategory('c-b', { name: 'Beers', sortOrder: 1 }), makeCategory('c-a', { name: 'Ales', sortOrder: 1 })];
    const prods = [
      makeProduct('p3', { name: 'Zebra', categoryId: 'c-b', sortOrder: 1 }),
      makeProduct('p2', { name: 'Apple', categoryId: 'c-b', sortOrder: 2 }),
      makeProduct('p1', { name: 'Bitter', categoryId: 'c-b', sortOrder: 1 }),
      makeProduct('p4', { name: 'Mild', categoryId: 'c-a', sortOrder: 9 }),
    ];
    const sale = saleWith(['p2', 'p3', 'p1', 'p4']);
    const report = productSalesReport({ sales: [sale], products: prods, categories: cats, range: range('2026-09-26') });
    expect(report.categories.map((c) => c.name)).toEqual(['Ales', 'Beers']);
    expect(report.categories[1]!.products.map((p) => p.name)).toEqual(['Bitter', 'Zebra', 'Apple']);
  });

  it('groups products with a missing or deleted category under Uncategorised, last', () => {
    const cats = [
      makeCategory('c-live', { name: 'Live', sortOrder: 99 }),
      makeCategory('c-gone', { name: 'Gone', sortOrder: 0, deletedAt: '2026-09-20T00:00:00.000Z' }),
    ];
    const prods = [
      makeProduct('p1', { name: 'Orphan', categoryId: 'c-missing' }),
      makeProduct('p2', { name: 'Deleted-cat item', categoryId: 'c-gone' }),
      makeProduct('p3', { name: 'Normal', categoryId: 'c-live' }),
    ];
    const report = productSalesReport({ sales: [saleWith(['p1', 'p2', 'p3'])], products: prods, categories: cats, range: range('2026-09-26') });
    expect(report.categories.map((c) => [c.categoryId, c.name])).toEqual([
      ['c-live', 'Live'],
      [UNCATEGORISED_ID, UNCATEGORISED_NAME],
    ]);
    expect(report.categories[1]!.products.map((p) => p.name)).toEqual(['Deleted-cat item', 'Orphan']);
    expect(UNCATEGORISED_NAME).toBe('Uncategorised');
  });

  it('uses the current product name, falling back to the most recent nameAtSale', () => {
    const early = saleWith(['gone'], { names: ['Old Name'], createdAt: '2026-09-26T10:00:00.000Z', id: 'e' });
    const late = saleWith(['gone'], { names: ['New Name'], createdAt: '2026-09-26T11:00:00.000Z', id: 'l' });
    const report = productSalesReport({ sales: [late, early], products: [], categories: [], range: range('2026-09-26') });
    expect(report.categories).toEqual([
      {
        categoryId: UNCATEGORISED_ID,
        name: UNCATEGORISED_NAME,
        qty: 2,
        takingsPence: 200,
        products: [{ productId: 'gone', name: 'New Name', qty: 2, takingsPence: 200 }],
      },
    ]);
    // A soft-deleted product still has its current name.
    const renamed = productSalesReport({
      sales: [early],
      products: [makeProduct('gone', { name: 'Renamed', deletedAt: '2026-09-26T12:00:00.000Z' })],
      categories: [makeCategory('cat-draught')],
      range: range('2026-09-26'),
    });
    expect(renamed.categories[0]!.products[0]!.name).toBe('Renamed');
  });

  it('lists a product whose sales were fully refunded (net 0)', () => {
    // A second refund of the remaining 2 Lager units (-510), after S4 refunded 1 (-255).
    const rest: Sale = { ...s4, id: 'sale-r', createdAt: '2026-09-26T15:00:00.000Z', lines: [{ ...s4.lines[0]!, qty: -2, finalPence: -510 }] };
    const report = productSalesReport({ sales: [s1, s4, rest], products, categories, range: range('2026-09-26') });
    const lager = report.categories.find((c) => c.categoryId === 'cat-draught')!.products[0];
    expect(lager).toEqual({ productId: 'lager', name: 'Fairway Lager', qty: 0, takingsPence: 0 });
  });

  it('includes sales by London date, inclusive of both ends, and excludes deposits', () => {
    const at = (createdAt: string, id: string) => ({ ...s1, id, createdAt });
    const sales = [
      at('2026-09-25T22:59:59.999Z', 'before'), // 25/09 23:59 BST
      at('2026-09-25T23:00:00.000Z', 'first'), // 26/09 00:00 BST
      at('2026-09-26T22:59:59.999Z', 'last'), // 26/09 23:59 BST
      at('2026-09-26T23:00:00.000Z', 'after'), // 27/09 00:00 BST
      s2, // deposit
    ];
    const report = productSalesReport({ sales, products, categories, range: range('2026-09-26') });
    expect(report.totalTakingsPence).toBe(2 * 977);
    expect(report.totalQty).toBe(2 * 5);
    const twoDays = productSalesReport({ sales, products, categories, range: range('2026-09-26', '2026-09-27') });
    expect(twoDays.totalTakingsPence).toBe(3 * 977);
  });

  it('is empty when nothing sold', () => {
    const report = productSalesReport({ sales: [s2], products, categories, range: range('2026-09-26') });
    expect(report).toEqual({ range: range('2026-09-26'), categories: [], totalQty: 0, totalTakingsPence: 0 });
  });
});

describe('vatReport (D-045)', () => {
  it('reports the D-042 scenario', () => {
    const report = vatReport([s1, s2, s3, s4], range('2026-09-26'));
    expect(report).toEqual({
      range: range('2026-09-26'),
      rows: [
        { vatRate: 20, grossPence: 9690, vatPence: 1615, netPence: 8075 },
        { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
      ],
      totals: { grossPence: 9902, vatPence: 1615, netPence: 8287 },
    });
  });

  it('excludes sales outside the range', () => {
    const report = vatReport([s1, s2, s3, s4], range('2026-09-27'));
    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({ grossPence: 0, vatPence: 0, netPence: 0 });
  });
});

/** A sale of one unit (100p, 20%) of each product id, in order. */
function saleWith(productIds: string[], opts: { names?: string[]; createdAt?: string; id?: string } = {}): Sale {
  return toStoredSale(
    {
      staffId: 'staff-manager',
      kind: 'sale',
      lines: productIds.map((productId, i) => ({
        productId,
        nameAtSale: opts.names?.[i] ?? productId,
        qty: 1,
        unitPricePence: 100,
        vatRate: 20,
        dealDiscountPence: 0,
        memberDiscountPence: 0,
        finalPence: 100,
        vatPence: 17,
      })),
      dealLines: [],
      memberDiscountPence: 0,
      depositAppliedPence: 0,
      totalPence: 100 * productIds.length,
      tenders: [{ type: 'cash', amountPence: 100 * productIds.length }],
      changePence: 0,
    },
    {
      id: opts.id ?? 'sale-x',
      periodId: 'period-6',
      createdAt: opts.createdAt ?? '2026-09-26T12:00:00.000Z',
      receiptNumber: '3F9C-000099',
    },
  );
}
