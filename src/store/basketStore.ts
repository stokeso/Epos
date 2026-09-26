/**
 * The till basket (architecture §5.1, §7.2; D-008, D-033, D-063, D-068, D-085, D-094..D-096).
 *
 * Every change runs services/till.viewBasket (display pricing at now) and services/draft.saveDraft
 * (no debounce). The basket survives a lock; it is restored from the draft after a refresh.
 * Pricing is never computed here: `view` is exactly what viewBasket returns.
 *
 * Guards applied by every mutating action:
 * - adding items and attaching a member or booking need an open period (D-068): a toast
 *   'No trading period open' and nothing changes;
 * - while a sale Pay session has tenders the basket is frozen (D-033): toast
 *   'Finish or cancel the payment first'; a sale Pay session with no tenders is dropped,
 *   because its frozen pricing no longer matches the basket (D-011);
 * - while Pay is opening (payStore.opening) the basket is frozen as well, so a tap can't land
 *   in the basket after openSale has read it (D-130).
 *
 * Changes run one at a time (runBasketExclusive): each reads the basket only when its turn
 * comes, so a void that awaits its audit write never overwrites a product tapped meanwhile, and
 * two quick voids each remove their own unit (D-085, D-130). Only the basket update is
 * serialised; the draft save and re-pricing that follow run as before.
 *
 * D-137:
 * - while a sale Pay session has tenders (the basket is locked), `view.priced` is that session's
 *   frozen pricing, so the till never shows a total other than the one being charged;
 * - a failed draft save is kept in `draftError` (pricing never clears it) until a later save of
 *   the basket succeeds: the next change, or retryDraftSave ('Try again').
 */
import { create } from 'zustand';
import { isAppError } from '../data/errors';
import type { BasketLine } from '../data/types';
import { EMPTY_BASKET, addProduct as addProductRule, type BasketState } from '../rules/basket';
import { MAX_LINE_QTY } from '../rules/money';
import { restoreDraft as restoreDraftService, saveDraft } from '../services/draft';
import type { Authorisation } from '../services/override';
import { viewBasket, voidLine as voidLineService, type BasketView } from '../services/till';
import { getCtx, useAppStore } from './appStore';
import { isBasketFrozen, usePayStore } from './payStore';
import { toast } from './uiStore';

export const NO_PERIOD_MESSAGE = 'No trading period open';
export const PAYMENT_IN_PROGRESS_MESSAGE = 'Finish or cancel the payment first';
export const MAX_QTY_MESSAGE = `Maximum quantity is ${MAX_LINE_QTY}`;
export const DRAFT_SAVE_FAILED_MESSAGE = 'The basket could not be saved as a draft';

export interface BasketStoreState {
  basket: BasketState;
  /**
   * viewBasket(basket) for the latest basket (null until first priced, and for an empty basket).
   * While a sale payment has tenders, `priced` is the Pay session's frozen pricing (D-033, D-137).
   */
  view: BasketView | null;
  /** True while viewBasket is running. */
  pricing: boolean;
  /** The last pricing error message, if any (cleared by the next successful pricing). */
  error: string | null;
  /**
   * Set when the draft could not be saved: the stored draft is behind the basket, so a reload
   * would restore an older basket (spec §8, D-095). Cleared only when a save of the basket
   * succeeds (the next change, or retryDraftSave), never by re-pricing (D-137).
   */
  draftError: string | null;

  /** Tap a product (D-008). false when blocked (no period, payment in progress, qty 999). */
  addProduct(productId: string): Promise<boolean>;
  /**
   * Void (D-085): services/till.voidLine with an Authorisation for 'voidLine' from
   * requirePermission. The basket changes only after the audit write commits.
   * Throws the service's AppError (NO_OPEN_PERIOD, VALIDATION, ...) for the screen to show.
   */
  voidLine(auth: Authorisation, productId: string, qty: number): Promise<void>;
  /** Attach (or replace) the member (D-104). false when blocked. */
  attachMember(memberId: string): Promise<boolean>;
  detachMember(): Promise<void>;
  /** Attach (or replace) a booking (D-028). false when blocked. */
  attachBooking(bookingId: string): Promise<boolean>;
  detachBooking(): Promise<void>;
  /**
   * Replace the basket with the result of a tab service (loadTab, openNewTab, addBasketToTab,
   * parkTab) and save the draft. Skips the guards: the service already checked them.
   */
  load(basket: BasketState): Promise<void>;
  /** After a sale commit (the draft was deleted in the same transaction): empty basket, no view. */
  reset(): void;
  /** After login when the basket is empty (D-096). Returns removedCount, or 0 when there was no draft. */
  restoreDraft(): Promise<number>;
  /** Re-price without a change (e.g. the Till screen mounting after a price edit). */
  refresh(): Promise<void>;
  /** Saves the draft of the current basket again ('Try again' after a failed save). true when saved. */
  retryDraftSave(): Promise<boolean>;
}

let pricingSeq = 0;
/** Numbers draft saves, so only the latest save's outcome sets or clears draftError. */
let draftSeq = 0;

function describe(error: unknown): string {
  if (isAppError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the till shows: while a sale payment has tenders, the basket is locked and the customer is
 * being charged the Pay session's frozen pricing (D-011, D-033), so that is the pricing shown,
 * whatever has changed since (a price, a deal, the member discount %). D-137.
 */
function withFrozenPricing(view: BasketView): BasketView {
  const session = usePayStore.getState().session;
  if (!isBasketFrozen(session) || session?.kind !== 'sale') return view;
  return { ...view, priced: session.priced };
}

/** Guard for a basket change: payment lock (D-033). Returns false when the change must not happen. */
function passPaymentGuard(): boolean {
  const pay = usePayStore.getState();
  if (pay.opening) {
    toast(PAYMENT_IN_PROGRESS_MESSAGE, { tone: 'warning' });
    return false;
  }
  const session = pay.session;
  if (session === null || session.kind !== 'sale') return true;
  if (session.tender.tenders.length > 0) {
    toast(PAYMENT_IN_PROGRESS_MESSAGE, { tone: 'warning' });
    return false;
  }
  // No tenders yet: the frozen pricing is stale once the basket changes, so drop it (D-011).
  pay.clear();
  return true;
}

/** The tail of the basket-change queue (runBasketExclusive). */
let basketQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` after every earlier basket change (and Pay opening) has finished, and makes later
 * ones wait for it. A task that throws rejects its own promise only; the queue carries on.
 * Never call it from inside another exclusive task (it would wait for itself).
 */
export function runBasketExclusive<T>(task: () => T | Promise<T>): Promise<T> {
  const run = basketQueue.then(task);
  basketQueue = run.catch(() => undefined);
  return run;
}

function passPeriodGuard(): boolean {
  if (useAppStore.getState().openPeriod !== null) return true;
  toast(NO_PERIOD_MESSAGE, { tone: 'warning' });
  return false;
}

export const useBasketStore = create<BasketStoreState>()((set, get) => {
  /** Prices `basket` for display; ignores results that a newer change has overtaken. */
  async function reprice(basket: BasketState): Promise<void> {
    const seq = ++pricingSeq;
    if (basket.lines.length === 0 && basket.memberId === undefined && basket.bookingId === undefined && basket.tabId === undefined) {
      set({ view: null, pricing: false });
      return;
    }
    set({ pricing: true });
    try {
      const view = await viewBasket(getCtx(), basket);
      if (seq === pricingSeq) set({ view: withFrozenPricing(view), pricing: false, error: null });
    } catch (error) {
      if (seq === pricingSeq) set({ pricing: false, error: describe(error) });
    }
  }

  /**
   * Saves `basket` as the draft. The latest save decides draftError: a failure sets it, a success
   * clears it (that save holds the whole basket, so the stored draft has caught up). true when saved.
   */
  async function storeDraft(basket: BasketState): Promise<boolean> {
    const seq = ++draftSeq;
    try {
      await saveDraft(getCtx(), basket);
      if (seq === draftSeq) set({ draftError: null });
      return true;
    } catch (error) {
      if (seq === draftSeq) set({ draftError: describe(error) });
      return false;
    }
  }

  /** Saves the draft and re-prices `basket` (every change, D-095). */
  async function persist(basket: BasketState): Promise<void> {
    const draft = storeDraft(basket).then((saved) => {
      if (!saved) toast(DRAFT_SAVE_FAILED_MESSAGE, { tone: 'danger' });
    });
    await Promise.all([draft, reprice(basket)]);
  }

  /**
   * One basket change: `update` gets the latest basket when this change's turn comes and returns
   * the next one (or null for no change). Then the draft is saved and the basket re-priced.
   */
  async function change(update: (current: BasketState) => BasketState | null | Promise<BasketState | null>): Promise<BasketState | null> {
    const next = await runBasketExclusive(async () => {
      const updated = await update(get().basket);
      if (updated !== null) set({ basket: updated });
      return updated;
    });
    if (next !== null) await persist(next);
    return next;
  }

  return {
    basket: EMPTY_BASKET,
    view: null,
    pricing: false,
    error: null,
    draftError: null,

    async addProduct(productId) {
      if (!passPeriodGuard() || !passPaymentGuard()) return false;
      const next = await change((current) => {
        const added = addProductRule(current, productId);
        return added === current ? null : added;
      });
      if (next === null) {
        toast(MAX_QTY_MESSAGE, { tone: 'warning' });
        return false;
      }
      return true;
    },

    async voidLine(auth, productId, qty) {
      if (!passPaymentGuard()) return;
      // The void is taken from the basket as it is when its turn comes, and the reduced basket
      // is set before the next change reads it (D-085: one void event per unit removed).
      await change((current) => voidLineService(getCtx(), auth, current, productId, qty));
    },

    async attachMember(memberId) {
      if (!passPeriodGuard() || !passPaymentGuard()) return false;
      await change((current) => ({ ...current, memberId }));
      return true;
    },

    async detachMember() {
      if (!passPaymentGuard()) return;
      await change(({ memberId: _removed, ...rest }) => rest);
    },

    async attachBooking(bookingId) {
      if (!passPeriodGuard() || !passPaymentGuard()) return false;
      await change((current) => ({ ...current, bookingId }));
      return true;
    },

    async detachBooking() {
      if (!passPaymentGuard()) return;
      await change(({ bookingId: _removed, ...rest }) => rest);
    },

    async load(basket) {
      await change(() => copyBasket(basket));
    },

    reset() {
      pricingSeq += 1;
      draftSeq += 1;
      set({ basket: EMPTY_BASKET, view: null, pricing: false, error: null, draftError: null });
    },

    async restoreDraft() {
      const restored = await runBasketExclusive(async () => {
        const found = await restoreDraftService(getCtx());
        if (found !== null) set({ basket: found.basket });
        return found;
      });
      if (restored === null) return 0;
      await reprice(restored.basket);
      return restored.removedCount;
    },

    async refresh() {
      await reprice(get().basket);
    },

    async retryDraftSave() {
      // Read the basket in turn, after any change still being made (D-130).
      const basket = await runBasketExclusive(() => get().basket);
      return storeDraft(basket);
    },
  };
});

function copyBasket(basket: BasketState): BasketState {
  const lines: BasketLine[] = basket.lines.map((line) => ({ productId: line.productId, qty: line.qty }));
  return {
    lines,
    ...(basket.memberId === undefined ? {} : { memberId: basket.memberId }),
    ...(basket.bookingId === undefined ? {} : { bookingId: basket.bookingId }),
    ...(basket.tabId === undefined ? {} : { tabId: basket.tabId }),
  };
}

/** Number of units in the basket (sum of qty). */
export function basketUnitCount(basket: BasketState): number {
  return basket.lines.reduce((sum, line) => sum + line.qty, 0);
}
