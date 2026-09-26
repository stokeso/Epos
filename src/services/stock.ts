/**
 * Stock control (spec §6.9; D-079..D-082). Viewing needs no permission; writes need
 * auth.action 'stockControl'. No open period is required (D-068).
 */
import type { StockLevel } from '../data/repos';
import type { Product, StockMovement } from '../data/types';
import { validateGoodsIn, validateStockAdjustment, type StockAdjustmentInput } from '../rules/validation';
import type { ServiceContext } from './context';
import { assertAuthorised, auditActor, overrideEvents, type Authorisation } from './override';
import { categoriesById, compareIds, compareProductsByCategory, openPeriodId, validationError, validOrThrow } from './shared';

/** Non-deleted stockTracked products with on-hand, sorted by category sortOrder, product sortOrder, name. */
export async function listStockLevels(ctx: ServiceContext): Promise<StockLevel[]> {
  const products = (await ctx.repos.products.list()).filter((p) => p.stockTracked);
  const onHand = await ctx.repos.stockMovements.onHandByProduct();
  const order = compareProductsByCategory(await categoriesById(ctx));
  return products.sort(order).map((product) => ({ product, onHand: onHand[product.id] ?? 0 }));
}

/** repos.stockMovements.lowStock() (D-082). */
export function listLowStock(ctx: ServiceContext): Promise<StockLevel[]> {
  return ctx.repos.stockMovements.lowStock();
}

/** A product's movements, newest first. */
export async function stockHistory(ctx: ServiceContext, productId: string): Promise<StockMovement[]> {
  const movements = await ctx.repos.stockMovements.listByProduct(productId);
  return movements.sort((a, b) => compareIds(b.createdAt, a.createdAt) || compareIds(b.id, a.id));
}

/** The product for a stock form: it must exist, not be deleted and be stock-tracked (D-080, D-081). */
async function requireTrackedProduct(ctx: ServiceContext, productId: string): Promise<Product> {
  const product = await ctx.repos.products.get(productId);
  if (product === undefined || product.deletedAt !== undefined || !product.stockTracked) {
    throw validationError({ productId: 'Choose a stock-tracked product' });
  }
  return product;
}

/**
 * Goods in (D-080): non-deleted stockTracked product; validateGoodsIn. transact:
 * stockMovements.add({ reason 'goodsIn', qty +n, staffId: auth.staffId, note }) + overrideEvents.
 * No stockAdjust audit event.
 */
export async function recordGoodsIn(
  ctx: ServiceContext,
  auth: Authorisation,
  input: { productId: string; qty: number; note: string },
): Promise<StockMovement> {
  assertAuthorised(auth, 'stockControl');
  const value = validOrThrow(validateGoodsIn(input));
  await requireTrackedProduct(ctx, value.productId);
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    const movement = await ctx.repos.stockMovements.add({
      productId: value.productId,
      qty: value.qty,
      reason: 'goodsIn',
      staffId: auth.staffId,
      note: value.note,
    });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return movement;
  });
}

/**
 * Adjustment or manual waste (D-081): validateStockAdjustment. transact: stockMovements.add(...) +
 * auditEvents.append([...overrideEvents, stockAdjust { stockMovementId, productId, productName,
 * qty (signed), reason, note }]) with periodId = the open period's id if any.
 */
export async function recordStockAdjustment(
  ctx: ServiceContext,
  auth: Authorisation,
  input: StockAdjustmentInput,
): Promise<StockMovement> {
  assertAuthorised(auth, 'stockControl');
  const value = validOrThrow(validateStockAdjustment(input));
  const product = await requireTrackedProduct(ctx, value.productId);
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    const movement = await ctx.repos.stockMovements.add({
      productId: product.id,
      qty: value.qty,
      reason: value.reason,
      staffId: auth.staffId,
      note: value.note,
    });
    await ctx.repos.auditEvents.append([
      ...overrideEvents(auth, periodId),
      {
        type: 'stockAdjust',
        ...auditActor(auth),
        ...(periodId === undefined ? {} : { periodId }),
        detail: {
          stockMovementId: movement.id,
          productId: product.id,
          productName: product.name,
          qty: value.qty,
          reason: value.reason,
          note: value.note,
        },
      },
    ]);
    return movement;
  });
}
