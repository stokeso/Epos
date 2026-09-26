/**
 * Till screen use cases: catalogue, basket pricing view, void, no sale
 * (spec §6.3, §7; D-008, D-009, D-043, D-085, D-086).
 *
 * Adding a product and attaching/detaching a member or booking are pure basket changes
 * (rules/basket.ts) made by the UI store after it has checked that a period is open. The member
 * or booking comes from members.searchMembers / bookings.listAttachableBookings.
 * The UI saves the draft after every basket change (services/draft.ts).
 */
import { AppError } from '../data/errors';
import type { BasketLine, Booking, Category, Member, Product, Tab } from '../data/types';
import { reduceLine, type BasketState } from '../rules/basket';
import { priceBasket, type PricedBasket, type PricingLine } from '../rules/pricing';
import { nowIso, type ServiceContext } from './context';
import { assertAuthorised, auditActor, overrideEvents, type Authorisation } from './override';
import { requireOpenPeriod } from './periods';
import { getSettings } from './settings';
import { compareIds, compareText, productsById, validationError } from './shared';

export interface TillCatalogue {
  /** Non-deleted categories sorted by sortOrder, then name. */
  categories: Category[];
  /** Active, non-deleted products sorted by sortOrder, then name. */
  products: Product[];
}

export async function loadTillCatalogue(ctx: ServiceContext): Promise<TillCatalogue> {
  const categories = (await ctx.repos.categories.list()).sort(
    (a, b) => a.sortOrder - b.sortOrder || compareText(a.name, b.name) || compareIds(a.id, b.id),
  );
  const products = (await ctx.repos.products.list())
    .filter((p) => p.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || compareText(a.name, b.name) || compareIds(a.id, b.id));
  return { categories, products };
}

/** A basket line priced from its CURRENT product record (D-009). */
export function toPricingLine(line: BasketLine, product: Product): PricingLine {
  return {
    productId: product.id,
    name: product.name,
    qty: line.qty,
    unitPricePence: product.pricePence,
    vatRate: product.vatRate,
    memberDiscountEligible: product.memberDiscountEligible,
  };
}

/** Resolves lines against a product map; lines whose product record is missing are dropped. */
export function pricingLinesFrom(lines: readonly BasketLine[], products: ReadonlyMap<string, Product>): PricingLine[] {
  const resolved: PricingLine[] = [];
  for (const line of lines) {
    const product = products.get(line.productId);
    if (product !== undefined) resolved.push(toPricingLine(line, product));
  }
  return resolved;
}

/**
 * Resolves basket lines against CURRENT product records (D-009), in order. Inactive or
 * soft-deleted products still resolve; lines whose product record is missing are dropped.
 */
export async function resolvePricingLines(ctx: ServiceContext, lines: readonly BasketLine[]): Promise<PricingLine[]> {
  return pricingLinesFrom(lines, await productsById(ctx));
}

export interface BasketView {
  priced: PricedBasket;
  member?: Member;
  booking?: Booking;
  /** The attached booking's unused balance. */
  bookingBalancePence?: number;
  tab?: Tab;
}

/**
 * Prices the basket for display at now (D-011): current products, every deal,
 * settings.memberDiscountPercent if a member is attached, the booking's balance if a booking is
 * attached. A memberId whose record is missing gets no discount (Pay rejects it); a booking that
 * is missing or not open applies no deposit (Pay rejects it).
 */
export async function viewBasket(ctx: ServiceContext, basket: BasketState): Promise<BasketView> {
  const { repos } = ctx;
  const settings = await getSettings(ctx);
  const lines = await resolvePricingLines(ctx, basket.lines);
  const deals = await repos.deals.list();
  const member = basket.memberId === undefined ? undefined : await repos.members.get(basket.memberId);
  const booking = basket.bookingId === undefined ? undefined : await repos.bookings.get(basket.bookingId);
  const bookingBalancePence = booking === undefined ? undefined : await repos.sales.bookingBalance(booking.id);
  const tab = basket.tabId === undefined ? undefined : await repos.tabs.get(basket.tabId);
  const priced = priceBasket({
    lines,
    deals,
    at: nowIso(ctx),
    memberDiscountPercent: member === undefined ? null : settings.memberDiscountPercent,
    depositBalancePence: booking !== undefined && booking.status === 'open' ? (bookingBalancePence ?? 0) : null,
  });
  return {
    priced,
    ...(member === undefined ? {} : { member }),
    ...(booking === undefined ? {} : { booking, bookingBalancePence: bookingBalancePence ?? 0 }),
    ...(tab === undefined ? {} : { tab }),
  };
}

/**
 * Void (D-085). auth.action 'voidLine'; needs an open period; qty 1..line qty. One append of
 * [...overrideEvents, void { productId, productName (current), qty, unitPricePence (current),
 * tabId? }] with periodId (one transaction). Returns the reduced basket only AFTER the write commits.
 */
export async function voidLine(
  ctx: ServiceContext,
  auth: Authorisation,
  basket: BasketState,
  productId: string,
  qty: number,
): Promise<BasketState> {
  assertAuthorised(auth, 'voidLine');
  const period = await requireOpenPeriod(ctx);
  const line = basket.lines.find((l) => l.productId === productId);
  if (line === undefined) throw new AppError('NOT_FOUND', 'That item is not in the basket');
  if (!Number.isInteger(qty) || qty < 1 || qty > line.qty) {
    throw validationError({ qty: `Choose 1 to ${line.qty} to void` });
  }
  const reduced = reduceLine(basket, productId, qty);
  const product = await ctx.repos.products.get(productId);
  await ctx.repos.auditEvents.append([
    ...overrideEvents(auth, period.id),
    {
      type: 'void',
      ...auditActor(auth),
      periodId: period.id,
      detail: {
        productId,
        productName: product?.name ?? 'Unknown product',
        qty,
        unitPricePence: product?.pricePence ?? 0,
        ...(basket.tabId === undefined ? {} : { tabId: basket.tabId }),
      },
    },
  ]);
  return reduced;
}

/**
 * No sale (D-086). auth.action 'noSale'; needs an open period. Appends [...overrideEvents,
 * noSale {}] with periodId in one call. Prints nothing; the UI shows a 'Drawer opened' toast.
 */
export async function recordNoSale(ctx: ServiceContext, auth: Authorisation): Promise<void> {
  assertAuthorised(auth, 'noSale');
  const period = await requireOpenPeriod(ctx);
  await ctx.repos.auditEvents.append([
    ...overrideEvents(auth, period.id),
    { type: 'noSale', ...auditActor(auth), periodId: period.id, detail: {} },
  ]);
}
