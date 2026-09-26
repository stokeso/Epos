/**
 * Product sales and VAT reports (spec §6.11; D-044, D-045). Pure: sums stored line figures.
 */
import type { Category, Pence, Product, Sale } from '../data/types';
import { sumPence } from './money';
import { isInRange, type LocalDateRange } from './time';
import { vatSummary, vatTotals, type VatSummaryRow } from './vat';

/** Category id used for products with no (or a deleted) category (D-044). */
export const UNCATEGORISED_ID = 'uncategorised';
export const UNCATEGORISED_NAME = 'Uncategorised';

export interface ProductSalesRow {
  productId: string;
  /** Current product name, else nameAtSale of the most recent line. */
  name: string;
  /** Sum of line qty (refunds net off). */
  qty: number;
  /** Sum of line finalPence (VAT-inclusive, after discounts, before deposits; refunds net off). */
  takingsPence: Pence;
}

export interface CategorySalesRow {
  /** Category id, or UNCATEGORISED_ID. */
  categoryId: string;
  name: string;
  qty: number;
  takingsPence: Pence;
  /** Sorted by product sortOrder, then name. */
  products: ProductSalesRow[];
}

export interface ProductSalesReport {
  range: LocalDateRange;
  /** Sorted by category sortOrder, then name; Uncategorised last. */
  categories: CategorySalesRow[];
  totalQty: number;
  /** = VAT report total gross for the same range (D-042). */
  totalTakingsPence: Pence;
}

export interface ProductSalesInput {
  /** Any sales; filtered to kinds 'sale' and 'refund' with createdAt in range. */
  sales: readonly Sale[];
  /** Include soft-deleted products and categories so names resolve. */
  products: readonly Product[];
  categories: readonly Category[];
  range: LocalDateRange;
}

/** Kinds 'sale' and 'refund' with createdAt in the range (deposits have no lines anyway). */
function reportSales(sales: readonly Sale[], range: LocalDateRange): Sale[] {
  return sales.filter((s) => (s.kind === 'sale' || s.kind === 'refund') && isInRange(s.createdAt, range));
}

/** Deterministic name order: case-insensitive en-GB collation. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en-GB', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareNumbers = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

interface ProductTotals {
  productId: string;
  qty: number;
  takings: Pence[];
  latestName: string;
  latestAt: string;
}

/**
 * Product sales report (D-044). A product appears if it has at least one line in range, even when
 * its net is 0. Category = the product's current categoryId (deleted/missing -> Uncategorised).
 * Example: Lager qty 3 - 1 = 2, takings 765 - 255 = 510.
 */
export function productSalesReport(input: ProductSalesInput): ProductSalesReport {
  const { range } = input;
  const productsById = new Map(input.products.map((p) => [p.id, p]));
  const liveCategories = new Map(input.categories.filter((c) => c.deletedAt === undefined).map((c) => [c.id, c]));

  const totals = new Map<string, ProductTotals>();
  for (const sale of reportSales(input.sales, range)) {
    for (const line of sale.lines) {
      const entry = totals.get(line.productId) ?? {
        productId: line.productId,
        qty: 0,
        takings: [],
        latestName: line.nameAtSale,
        latestAt: sale.createdAt,
      };
      entry.qty += line.qty;
      entry.takings.push(line.finalPence);
      if (sale.createdAt >= entry.latestAt) {
        entry.latestAt = sale.createdAt;
        entry.latestName = line.nameAtSale;
      }
      totals.set(line.productId, entry);
    }
  }

  interface Placed {
    row: ProductSalesRow;
    sortOrder: number;
  }
  const byCategory = new Map<string, Placed[]>();
  for (const entry of totals.values()) {
    const product = productsById.get(entry.productId);
    const category = product === undefined ? undefined : liveCategories.get(product.categoryId);
    const categoryId = category?.id ?? UNCATEGORISED_ID;
    const placed: Placed = {
      row: {
        productId: entry.productId,
        name: product?.name ?? entry.latestName,
        qty: entry.qty,
        takingsPence: sumPence(entry.takings),
      },
      sortOrder: product?.sortOrder ?? Number.MAX_SAFE_INTEGER,
    };
    byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), placed]);
  }

  const categories: CategorySalesRow[] = [...byCategory.entries()]
    .map(([categoryId, placed]) => {
      const products = placed
        .sort((a, b) => compareNumbers(a.sortOrder, b.sortOrder) || compareNames(a.row.name, b.row.name) || compareIds(a.row.productId, b.row.productId))
        .map((p) => p.row);
      const category = liveCategories.get(categoryId);
      return {
        categoryId,
        name: category?.name ?? UNCATEGORISED_NAME,
        qty: products.reduce((a, p) => a + p.qty, 0),
        takingsPence: sumPence(products.map((p) => p.takingsPence)),
        products,
        sortOrder: category?.sortOrder ?? 0,
        uncategorised: category === undefined,
      };
    })
    .sort(
      (a, b) =>
        Number(a.uncategorised) - Number(b.uncategorised) ||
        compareNumbers(a.sortOrder, b.sortOrder) ||
        compareNames(a.name, b.name) ||
        compareIds(a.categoryId, b.categoryId),
    )
    .map(({ categoryId, name, qty, takingsPence, products }) => ({ categoryId, name, qty, takingsPence, products }));

  return {
    range,
    categories,
    totalQty: categories.reduce((a, c) => a + c.qty, 0),
    totalTakingsPence: sumPence(categories.map((c) => c.takingsPence)),
  };
}

export interface VatReport {
  range: LocalDateRange;
  /** vatSummary over lines of kinds 'sale' and 'refund' in range, rate DESC. */
  rows: VatSummaryRow[];
  totals: { grossPence: Pence; vatPence: Pence; netPence: Pence };
}

/** VAT report (D-045). Deposits have no lines, so they are excluded automatically. */
export function vatReport(sales: readonly Sale[], range: LocalDateRange): VatReport {
  const rows = vatSummary(reportSales(sales, range).flatMap((s) => s.lines));
  return { range, rows, totals: vatTotals(rows) };
}
