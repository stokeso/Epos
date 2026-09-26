/**
 * Pay: the frozen pricing, tendering and sale/deposit commit (spec §6.4, §6.7, §8;
 * D-011, D-024, D-027, D-029..D-034, D-056).
 *
 * The PaySession lives in the UI pay store (memory only). It survives an auto-lock but not a
 * page refresh (D-033). While any tender has been taken the basket cannot be edited; the only
 * exits are completing or 'Cancel payment' (discards every tender).
 */
import { AppError } from '../data/errors';
import type { Booking, NewSale, Sale, SaleStockMovementInput } from '../data/types';
import { hasNoLines, type BasketState } from '../rules/basket';
import { canTakeDeposit } from '../rules/booking';
import { priceBasket, toSaleLines, type PricedBasket } from '../rules/pricing';
import { validateSale } from '../rules/sale';
import { stockMovementsForSale } from '../rules/stock';
import { applyTender, startTendering, type TenderRejection, type TenderRequest, type TenderState } from '../rules/tender';
import { validateDepositAmount } from '../rules/validation';
import { nowIso, type ServiceContext } from './context';
import { assertAuthorised, overrideEvents, type Authorisation } from './override';
import { requireOpenPeriod } from './periods';
import { receiptAfterCommit } from './receipts';
import { getSettings } from './settings';
import { productsById, validationError } from './shared';
import { pricingLinesFrom } from './till';

export interface SalePaySession {
  /** ctx.newId(); lets the UI ignore a stale completion. */
  id: string;
  kind: 'sale';
  /** The basket as it was when Pay opened. */
  basket: BasketState;
  /** Frozen pricing at Pay open (D-011). */
  priced: PricedBasket;
  tender: TenderState;
}

export interface DepositPaySession {
  id: string;
  kind: 'deposit';
  booking: Booking;
  amountPence: number;
  tender: TenderState;
}

export type PaySession = SalePaySession | DepositPaySession;

/** Copies the basket so later UI changes can never alter an open Pay session. */
function snapshotBasket(basket: BasketState): BasketState {
  return {
    lines: basket.lines.map((line) => ({ productId: line.productId, qty: line.qty })),
    ...(basket.memberId === undefined ? {} : { memberId: basket.memberId }),
    ...(basket.bookingId === undefined ? {} : { bookingId: basket.bookingId }),
    ...(basket.tabId === undefined ? {} : { tabId: basket.tabId }),
  };
}

/**
 * Opens Pay for the basket (D-011): needs an open period and >= 1 line; prices once at now with
 * the booking balance read now; startTendering(priced.totalPence).
 * Fails early (nothing written) when a line's product record is missing (NOT_FOUND), the member
 * record is missing (NOT_FOUND), the booking is missing or not open (BOOKING_NOT_OPEN) or the
 * loaded tab is no longer open (TAB_NOT_OPEN); commitSale re-checks the last two (D-056).
 */
export async function openSalePayment(ctx: ServiceContext, basket: BasketState): Promise<SalePaySession> {
  const { repos } = ctx;
  await requireOpenPeriod(ctx);
  if (hasNoLines(basket)) throw new AppError('VALIDATION', 'The basket is empty');

  const products = await productsById(ctx);
  const lines = pricingLinesFrom(basket.lines, products);
  if (lines.length !== basket.lines.length) {
    throw new AppError('NOT_FOUND', 'An item in the basket no longer exists; void it and try again');
  }
  if (basket.tabId !== undefined) {
    const tab = await repos.tabs.get(basket.tabId);
    if (tab === undefined || tab.deletedAt !== undefined || tab.status !== 'open') {
      throw new AppError('TAB_NOT_OPEN', 'That tab is no longer open');
    }
  }
  if (basket.memberId !== undefined && (await repos.members.get(basket.memberId)) === undefined) {
    throw new AppError('NOT_FOUND', 'That member no longer exists; detach the member and try again');
  }
  let depositBalancePence: number | null = null;
  if (basket.bookingId !== undefined) {
    const booking = await repos.bookings.get(basket.bookingId);
    if (booking === undefined || booking.deletedAt !== undefined || booking.status !== 'open') {
      throw new AppError('BOOKING_NOT_OPEN', 'That booking is no longer open');
    }
    depositBalancePence = await repos.sales.bookingBalance(booking.id);
  }

  const settings = await getSettings(ctx);
  const priced = priceBasket({
    lines,
    deals: await repos.deals.list(),
    at: nowIso(ctx),
    memberDiscountPercent: basket.memberId === undefined ? null : settings.memberDiscountPercent,
    depositBalancePence,
  });
  return { id: ctx.newId(), kind: 'sale', basket: snapshotBasket(basket), priced, tender: startTendering(priced.totalPence) };
}

/**
 * Opens Pay for a deposit (D-027): needs an open period; the booking must be open; amount integer
 * 1..MAX_KEYPAD_PENCE.
 */
export async function openDepositPayment(ctx: ServiceContext, bookingId: string, amountPence: number): Promise<DepositPaySession> {
  await requireOpenPeriod(ctx);
  if (!validateDepositAmount(amountPence)) {
    throw validationError({ amountPence: 'A deposit must be £0.01 to £99,999.99' });
  }
  const booking = await ctx.repos.bookings.get(bookingId);
  if (booking === undefined) throw new AppError('NOT_FOUND', 'That booking no longer exists');
  if (booking.deletedAt !== undefined || !canTakeDeposit(booking)) {
    throw new AppError('BOOKING_NOT_OPEN', 'Deposits can only be taken on open bookings');
  }
  return { id: ctx.newId(), kind: 'deposit', booking, amountPence, tender: startTendering(amountPence) };
}

export type TakeTenderResult =
  | { ok: true; session: PaySession }
  | { ok: false; reason: TenderRejection; message: string };

/** Pure wrapper around rules/tender.applyTender. The UI calls completePayment when session.tender.complete. */
export function takeTender(session: PaySession, request: TenderRequest): TakeTenderResult {
  const outcome = applyTender(session.tender, request);
  if (!outcome.ok) return { ok: false, reason: outcome.reason, message: outcome.message };
  return { ok: true, session: { ...session, tender: outcome.state } };
}

export interface CompletedSale {
  sale: Sale;
  /** Receipt HTML to open in a new tab (D-109). */
  document: string;
}

/** The NewSale for a completed sale session (D-009, D-017, D-019, D-023, D-032). */
function buildSale(session: SalePaySession, staffId: string): NewSale {
  const { basket, priced, tender } = session;
  return {
    staffId,
    kind: 'sale',
    ...(basket.memberId === undefined ? {} : { memberId: basket.memberId }),
    ...(basket.bookingId === undefined ? {} : { bookingId: basket.bookingId }),
    ...(basket.tabId === undefined ? {} : { tabId: basket.tabId }),
    lines: toSaleLines(priced),
    dealLines: priced.dealLines.map((d) => ({ ...d })),
    memberDiscountPence: priced.memberDiscountPence,
    depositAppliedPence: priced.depositAppliedPence,
    totalPence: priced.totalPence,
    tenders: tender.tenders.map((t) => ({ ...t })),
    changePence: tender.changePence,
  };
}

/** The NewSale for a completed deposit session (D-024). */
function buildDeposit(session: DepositPaySession, staffId: string): NewSale {
  return {
    staffId,
    kind: 'deposit',
    bookingId: session.booking.id,
    lines: [],
    dealLines: [],
    memberDiscountPence: 0,
    depositAppliedPence: 0,
    totalPence: session.amountPence,
    tenders: session.tender.tenders.map((t) => ({ ...t })),
    changePence: session.tender.changePence,
  };
}

/** validateSale (D-032) or throw AppError('INVALID_SALE'). */
export function assertValidSale(sale: NewSale): void {
  const problems = validateSale(sale);
  if (problems.length > 0) throw new AppError('INVALID_SALE', `The sale is not valid: ${problems.join('; ')}`);
}

/** Stock movements with the products' CURRENT stockTracked flags (D-079, D-039). */
export async function movementsFor(ctx: ServiceContext, sale: NewSale): Promise<SaleStockMovementInput[]> {
  if (sale.lines.length === 0) return [];
  const products = await productsById(ctx);
  return stockMovementsForSale(sale, (productId) => products.get(productId)?.stockTracked === true);
}

/**
 * commitSale, plus the override event (if any) in the same transaction (D-072). 'sell' and
 * 'bookings' are staff-level actions, so in practice there is never one.
 */
async function commitWithOverride(
  ctx: ServiceContext,
  auth: Authorisation,
  input: { sale: NewSale; stockMovements: SaleStockMovementInput[]; clearDraft: boolean },
): Promise<Sale> {
  if (auth.approvedById === undefined) return ctx.repos.commitSale(input);
  return ctx.repos.transact(async () => {
    const stored = await ctx.repos.commitSale(input);
    await ctx.repos.auditEvents.append(overrideEvents(auth, stored.periodId));
    return stored;
  });
}

/**
 * Commits a completed Pay session (D-056). Requires session.tender.complete.
 * sale: auth.action 'sell'; NewSale from the frozen pricing (lines = toSaleLines, dealLines,
 *   memberId/bookingId/tabId from the basket, tenders, changePence, staffId = auth.staffId);
 *   validateSale; stock movements from rules/stock with products' CURRENT stockTracked;
 *   repos.commitSale({ clearDraft: true }).
 * deposit: auth.action 'bookings'; NewSale { kind 'deposit', bookingId, lines [], dealLines [],
 *   memberDiscountPence 0, depositAppliedPence 0, totalPence amount, tenders, changePence };
 *   no stock movements; clearDraft false.
 * On failure throws (the UI keeps Pay open with its tenders and shows 'Sale not saved: {message}', D-034).
 * Once the commit has succeeded it never throws: the receipt falls back to a minimal document.
 */
export async function completePayment(ctx: ServiceContext, auth: Authorisation, session: PaySession): Promise<CompletedSale> {
  assertAuthorised(auth, session.kind === 'sale' ? 'sell' : 'bookings');
  if (!session.tender.complete) throw new AppError('VALIDATION', 'The amount due has not been paid yet');
  const sale = session.kind === 'sale' ? buildSale(session, auth.staffId) : buildDeposit(session, auth.staffId);
  assertValidSale(sale);
  const stockMovements = await movementsFor(ctx, sale);
  const stored = await commitWithOverride(ctx, auth, { sale, stockMovements, clearDraft: session.kind === 'sale' });
  return { sale: stored, document: await receiptAfterCommit(ctx, stored) };
}
