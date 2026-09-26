/**
 * Small helpers shared by the service modules. Internal to src/services (screens use the
 * use-case modules, never this file).
 */
import { AppError } from '../data/errors';
import type { Category, Product, Staff } from '../data/types';
import { escapeHtml, RECEIPT_CSP } from '../receipt';
import type { FieldErrors, Validation } from '../rules/validation';
import type { ServiceContext } from './context';

/** AppError('VALIDATION') whose message is the first field error (architecture §4, D-117). */
export function validationError(errors: FieldErrors, fallback = 'Check the details and try again'): AppError {
  const first = Object.values(errors)[0] ?? fallback;
  return new AppError('VALIDATION', first, errors);
}

/** The validator's normalised value, or throws AppError('VALIDATION', firstMessage, fieldErrors). */
export function validOrThrow<T>(result: Validation<T>): T {
  if (result.ok) return result.value;
  throw validationError(result.errors);
}

/** The id of the device's open period, if any (for audit events' periodId, D-083). */
export async function openPeriodId(ctx: ServiceContext): Promise<string | undefined> {
  const period = await ctx.repos.periods.getOpen();
  return period?.id;
}

/** Plain code-unit comparison (deterministic tie-breaks). */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Active, non-deleted staff in login order: createdAt, then id (D-074). These are full records,
 * PIN hashes included, so it stays internal to services (D-073: hashes never enter UI state).
 */
export async function activeStaffInLoginOrder(ctx: ServiceContext): Promise<Staff[]> {
  const staff = await ctx.repos.staff.list();
  return staff
    .filter((s) => s.active && s.deletedAt === undefined)
    .sort((a, b) => compareIds(a.createdAt, b.createdAt) || compareIds(a.id, b.id));
}

/** Case-insensitive en-GB name order with a deterministic tie-break. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en-GB', { sensitivity: 'base' }) || compareIds(a, b);
}

/** Every product record, soft-deleted included (D-009: deleted products still price), by id. */
export async function productsById(ctx: ServiceContext): Promise<Map<string, Product>> {
  const products = await ctx.repos.products.list({ includeDeleted: true });
  return new Map(products.map((p) => [p.id, p]));
}

/** Every category record, soft-deleted included, by id. */
export async function categoriesById(ctx: ServiceContext): Promise<Map<string, Category>> {
  const categories = await ctx.repos.categories.list({ includeDeleted: true });
  return new Map(categories.map((c) => [c.id, c]));
}

/**
 * Products ordered for display: by their category's sortOrder (unknown or deleted categories
 * last), then product sortOrder, then name, then id.
 */
export function compareProductsByCategory(categories: ReadonlyMap<string, Category>) {
  const rank = (product: Product): number => {
    const category = categories.get(product.categoryId);
    return category === undefined || category.deletedAt !== undefined ? Number.MAX_SAFE_INTEGER : category.sortOrder;
  };
  return (a: Product, b: Product): number =>
    rank(a) - rank(b) || a.sortOrder - b.sortOrder || compareText(a.name, b.name) || compareIds(a.id, b.id);
}

/**
 * A minimal document shown when rendering fails AFTER a write has committed (a sale, refund,
 * deposit or Z close). The write stands, so the service must not throw: a throw would make the
 * UI report "Sale not saved" and offer "Try again", which would record the sale twice.
 * It uses the receipt module's escapeHtml and RECEIPT_CSP (D-110), so it cannot drift from them.
 */
export function fallbackDocument(title: string, message: string, detail: string): string {
  return [
    '<!doctype html>',
    '<html lang="en-GB"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${RECEIPT_CSP}">`,
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="font-family:monospace;width:80mm">',
    `<p>${escapeHtml(message)}</p>`,
    `<p>${escapeHtml(detail)}</p>`,
    '</body></html>',
  ].join('');
}

/** A short description of an unknown thrown value. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
