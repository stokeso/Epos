/**
 * Back office: categories, products, deals (spec §6.9; D-013, D-051, D-087, D-105).
 * Viewing needs no permission; every save needs auth.action 'editCatalogue' and writes the
 * override event (if any) in the same transaction. No open period is required.
 */
import { AppError } from '../data/errors';
import type { ListOptions } from '../data/repos';
import type { Category, Deal, NewAuditEvent, NewCategory, NewProduct, Product } from '../data/types';
import { canonicalDealOrder } from '../rules/deals';
import { canDeleteCategory, validateCategory, validateDeal, validateProduct, type DealFormInput } from '../rules/validation';
import type { ServiceContext } from './context';
import { assertAuthorised, auditActor, overrideEvents, type Authorisation } from './override';
import { categoriesById, compareIds, compareProductsByCategory, compareText, openPeriodId, validationError, validOrThrow } from './shared';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Sorted by sortOrder, then name. */
export async function listCategories(ctx: ServiceContext, options?: ListOptions): Promise<Category[]> {
  const categories = await ctx.repos.categories.list(options);
  return categories.sort((a, b) => a.sortOrder - b.sortOrder || compareText(a.name, b.name) || compareIds(a.id, b.id));
}

async function requireCategory(ctx: ServiceContext, id: string): Promise<Category> {
  const category = await ctx.repos.categories.get(id);
  if (category === undefined || category.deletedAt !== undefined) throw new AppError('NOT_FOUND', 'That category no longer exists');
  return category;
}

/** Create (id null) or update; validateCategory (name uniqueness checked inside the transaction). */
export async function saveCategory(ctx: ServiceContext, auth: Authorisation, id: string | null, input: NewCategory): Promise<Category> {
  assertAuthorised(auth, 'editCatalogue');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    if (id !== null) await requireCategory(ctx, id);
    const categories = await ctx.repos.categories.list();
    const value = validOrThrow(validateCategory(input, { categories, ...(id === null ? {} : { editingId: id }) }));
    const saved = id === null ? await ctx.repos.categories.create(value) : await ctx.repos.categories.update(id, value);
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}

/** Soft delete, only when no non-deleted product references it (canDeleteCategory) (D-051). */
export async function deleteCategory(ctx: ServiceContext, auth: Authorisation, id: string): Promise<Category> {
  assertAuthorised(auth, 'editCatalogue');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    await requireCategory(ctx, id);
    if (!canDeleteCategory(id, await ctx.repos.products.list())) {
      throw validationError({ categoryId: 'Move or remove the products in this category first' });
    }
    const deleted = await ctx.repos.categories.softDelete(id);
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return deleted;
  });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** Sorted by category sortOrder, product sortOrder, then name. */
export async function listProducts(ctx: ServiceContext, options?: ListOptions): Promise<Product[]> {
  const products = await ctx.repos.products.list(options);
  return products.sort(compareProductsByCategory(await categoriesById(ctx)));
}

/**
 * Defaults for a new product in a category (D-105): vatRate 20, memberDiscountEligible true,
 * stockTracked true, stockUnit 'unit', lowStockLevel 0, buttonColour = category colour,
 * sortOrder = highest in category + 1 (1 if none), active true, name '', pricePence 0.
 */
export async function newProductDefaults(ctx: ServiceContext, categoryId: string): Promise<NewProduct> {
  const category = await requireCategory(ctx, categoryId);
  const inCategory = (await ctx.repos.products.list()).filter((p) => p.categoryId === categoryId);
  const sortOrder = inCategory.length === 0 ? 1 : Math.max(...inCategory.map((p) => p.sortOrder)) + 1;
  return {
    name: '',
    categoryId,
    pricePence: 0,
    vatRate: 20,
    memberDiscountEligible: true,
    stockTracked: true,
    stockUnit: 'unit',
    lowStockLevel: 0,
    buttonColour: category.colour,
    sortOrder,
    active: true,
  };
}

async function requireProduct(ctx: ServiceContext, id: string): Promise<Product> {
  const product = await ctx.repos.products.get(id);
  if (product === undefined || product.deletedAt !== undefined) throw new AppError('NOT_FOUND', 'That product no longer exists');
  return product;
}

/**
 * Create (id null) or update; validateProduct. On update, when pricePence changes, append
 * priceChange { productId, productName (after save), oldPricePence, newPricePence } in the same
 * transaction (D-087). Creating a product writes no priceChange.
 */
export async function saveProduct(ctx: ServiceContext, auth: Authorisation, id: string | null, input: NewProduct): Promise<Product> {
  assertAuthorised(auth, 'editCatalogue');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    const existing = id === null ? undefined : await requireProduct(ctx, id);
    const value = validOrThrow(
      validateProduct(input, {
        products: await ctx.repos.products.list(),
        categories: await ctx.repos.categories.list(),
        ...(id === null ? {} : { editingId: id }),
      }),
    );
    const events: NewAuditEvent[] = overrideEvents(auth, periodId);
    let saved: Product;
    if (existing === undefined) {
      saved = await ctx.repos.products.create(value);
    } else {
      saved = await ctx.repos.products.update(existing.id, value);
      if (existing.pricePence !== saved.pricePence) {
        events.push({
          type: 'priceChange',
          ...auditActor(auth),
          ...(periodId === undefined ? {} : { periodId }),
          detail: { productId: saved.id, productName: saved.name, oldPricePence: existing.pricePence, newPricePence: saved.pricePence },
        });
      }
    }
    await ctx.repos.auditEvents.append(events);
    return saved;
  });
}

/** Deactivate / reactivate (D-051). */
export async function setProductActive(ctx: ServiceContext, auth: Authorisation, id: string, active: boolean): Promise<Product> {
  assertAuthorised(auth, 'editCatalogue');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    await requireProduct(ctx, id);
    const saved = await ctx.repos.products.update(id, { active });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

/** Sorted by canonical deal order (createdAt, id). */
export async function listDeals(ctx: ServiceContext, options?: ListOptions): Promise<Deal[]> {
  return canonicalDealOrder(await ctx.repos.deals.list(options));
}

async function requireDeal(ctx: ServiceContext, id: string): Promise<Deal> {
  const deal = await ctx.repos.deals.get(id);
  if (deal === undefined || deal.deletedAt !== undefined) throw new AppError('NOT_FOUND', 'That deal no longer exists');
  return deal;
}

/**
 * Create (id null) or update; validateDeal converts the form's local dates to startsAt/endsAt.
 * On update, a field cleared in the form is removed from the record (patch key = undefined, D-050).
 */
export async function saveDeal(ctx: ServiceContext, auth: Authorisation, id: string | null, input: DealFormInput): Promise<Deal> {
  assertAuthorised(auth, 'editCatalogue');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    if (id !== null) await requireDeal(ctx, id);
    const value = validOrThrow(validateDeal(input, { products: await ctx.repos.products.list() }));
    const saved =
      id === null
        ? await ctx.repos.deals.create(value)
        : await ctx.repos.deals.update(id, {
            name: value.name,
            type: value.type,
            n: value.n,
            // Undefined removes the field (D-050): a type change or a cleared date drops it.
            pricePence: value.pricePence,
            m: value.m,
            productIds: value.productIds,
            active: value.active,
            startsAt: value.startsAt,
            endsAt: value.endsAt,
          });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}

/** Deactivate / reactivate (D-051). */
export async function setDealActive(ctx: ServiceContext, auth: Authorisation, id: string, active: boolean): Promise<Deal> {
  assertAuthorised(auth, 'editCatalogue');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    await requireDeal(ctx, id);
    const saved = await ctx.repos.deals.update(id, { active });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}
