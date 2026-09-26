/**
 * The Pay session (architecture §5.1–5.3, §7.2; D-011, D-029..D-034, D-123).
 *
 * The PaySession (frozen pricing + tenders) lives only here, in memory. It survives a lock
 * (after login the app returns to #/pay) and is lost on refresh (D-033). Nothing is written
 * until complete().
 */
import { create } from 'zustand';
import { isAppError } from '../data/errors';
import { pressMoneyKey, type MoneyKey } from '../rules/money';
import type { TenderRequest } from '../rules/tender';
import type { Authorisation } from '../services/override';
import {
  completePayment,
  openDepositPayment,
  openSalePayment,
  takeTender,
  type CompletedSale,
  type DepositPaySession,
  type PaySession,
  type SalePaySession,
  type TakeTenderResult,
} from '../services/pay';
import { getCtx, useAppStore } from './appStore';
import { runBasketExclusive, useBasketStore } from './basketStore';

export interface PayStoreState {
  session: PaySession | null;
  /**
   * True while openSale runs. The basket is frozen meanwhile (basketStore refuses changes with
   * 'Finish or cancel the payment first'), so Pay always covers exactly the basket (D-130).
   */
  opening: boolean;
  /** The custom-amount keypad value in pence (D-006); cleared after every tender (D-030). */
  keypadPence: number;
  /** True while completePayment runs. */
  committing: boolean;
  /**
   * A tender rejection message, or 'Sale not saved: {message}' ('Deposit not saved: …' for a
   * deposit) after a failed commit (D-034, D-131).
   */
  error: string | null;

  /**
   * Opens Pay for the current basket (openSalePayment: freezes pricing, D-011). Waits for basket
   * changes already under way and freezes the basket until the session is set (D-130). Throws
   * the service's AppError (NO_OPEN_PERIOD, VALIDATION, NOT_FOUND, BOOKING_NOT_OPEN, TAB_NOT_OPEN).
   */
  openSale(): Promise<SalePaySession>;
  /** Opens Pay for a deposit (openDepositPayment). Throws the service's AppError. */
  openDeposit(bookingId: string, amountPence: number): Promise<DepositPaySession>;
  pressKey(key: MoneyKey): void;
  setKeypad(pence: number): void;
  /**
   * One tender (services/pay.takeTender). On success the keypad clears; on rejection `error`
   * holds the message and nothing is recorded. null when there is no session.
   * When the returned session's tender.complete is true, call complete().
   */
  tender(request: TenderRequest): TakeTenderResult | null;
  /**
   * completePayment with an Authorisation for 'sell' (sale) or 'bookings' (deposit).
   * Success: clears the session; for a sale the basket resets (its draft was deleted in the
   * commit). Returns the CompletedSale; the screen then calls openDocument(result.document).
   * Failure: keeps the session and tenders, sets error 'Sale not saved: {message}' (or
   * 'Deposit not saved: …') and returns null. NO_OPEN_PERIOD also refreshes the cached period.
   */
  complete(auth: Authorisation): Promise<CompletedSale | null>;
  /** 'Cancel payment' (after confirmation) or 'Back to basket': discards the session and tenders. */
  clear(): void;
  clearError(): void;
}

function describe(error: unknown): string {
  if (isAppError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export const usePayStore = create<PayStoreState>()((set, get) => ({
  session: null,
  opening: false,
  keypadPence: 0,
  committing: false,
  error: null,

  async openSale() {
    set({ opening: true });
    try {
      // Queued behind any basket change still running (e.g. a void awaiting its audit write),
      // so the frozen pricing is taken from the final basket.
      return await runBasketExclusive(async () => {
        const session = await openSalePayment(getCtx(), useBasketStore.getState().basket);
        set({ session, keypadPence: 0, committing: false, error: null });
        return session;
      });
    } finally {
      set({ opening: false });
    }
  },

  async openDeposit(bookingId, amountPence) {
    const session = await openDepositPayment(getCtx(), bookingId, amountPence);
    set({ session, keypadPence: 0, committing: false, error: null });
    return session;
  },

  pressKey(key) {
    set({ keypadPence: pressMoneyKey(get().keypadPence, key) });
  },

  setKeypad(pence) {
    set({ keypadPence: pence });
  },

  tender(request) {
    const session = get().session;
    if (session === null) return null;
    const result = takeTender(session, request);
    if (result.ok) set({ session: result.session, keypadPence: 0, error: null });
    else set({ error: result.message });
    return result;
  },

  async complete(auth) {
    const session = get().session;
    if (session === null || get().committing) return null;
    set({ committing: true, error: null });
    try {
      const completed = await completePayment(getCtx(), auth, session);
      // Ignore a stale completion if the session was replaced meanwhile.
      if (get().session?.id === session.id) set({ session: null, keypadPence: 0, committing: false, error: null });
      if (session.kind === 'sale') useBasketStore.getState().reset();
      return completed;
    } catch (error) {
      const what = session.kind === 'deposit' ? 'Deposit' : 'Sale';
      set({ committing: false, error: `${what} not saved: ${describe(error)}` });
      // The period was closed elsewhere: the header and the till should say so.
      if (isAppError(error) && error.code === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
      return null;
    }
  },

  clear() {
    set({ session: null, keypadPence: 0, committing: false, error: null });
  },

  clearError() {
    set({ error: null });
  },
}));

/**
 * Drops the Pay session if no tender has been taken on it (and it is not saving), optionally
 * only when `which` matches. Used when its preconditions go away: after a Z close (no period, so
 * it could never be saved) and after its booking is settled or cancelled (D-134). A session with
 * tenders is never dropped: its money is in the drawer (D-033). Returns true when dropped.
 */
export function dropUntenderedPayment(which?: (session: PaySession) => boolean): boolean {
  const pay = usePayStore.getState();
  const { session } = pay;
  if (session === null || pay.committing || session.tender.tenders.length > 0) return false;
  if (which !== undefined && !which(session)) return false;
  pay.clear();
  return true;
}

/** True when a sale Pay session has tenders: the basket is frozen (D-033). */
export function isBasketFrozen(session: PaySession | null): boolean {
  return session !== null && session.kind === 'sale' && session.tender.tenders.length > 0;
}
