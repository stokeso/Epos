/**
 * Pure basket state transitions (spec §6.3, §6.6; D-008, D-063, D-085, D-095).
 * The basket is unpriced: lines are {productId, qty}, priced on demand via rules/pricing.ts.
 * Every function returns a new object; inputs are never mutated.
 */
import type { BasketLine, TabLine } from '../data/types';
import { MAX_LINE_QTY } from './money';

/** The till basket (held in the Zustand basket store and mirrored to the draft row). */
export interface BasketState {
  /** Unique by productId; basket order (D-008). Read-only: every transition returns new arrays. */
  lines: readonly BasketLine[];
  memberId?: string;
  bookingId?: string;
  /** Set when a tab is loaded ("tab mode", D-063). */
  tabId?: string;
}

export const EMPTY_BASKET: BasketState = Object.freeze({ lines: Object.freeze([]) });

/**
 * Tapping a product (D-008): an existing line gets qty + 1 in place; a new product is appended
 * with qty 1. If the line is already at MAX_LINE_QTY the same basket object is returned.
 */
export function addProduct(basket: BasketState, productId: string): BasketState {
  const index = basket.lines.findIndex((line) => line.productId === productId);
  if (index === -1) return { ...basket, lines: [...basket.lines, { productId, qty: 1 }] };
  const line = basket.lines[index];
  if (line === undefined || line.qty >= MAX_LINE_QTY) return basket;
  return { ...basket, lines: basket.lines.map((l, i) => (i === index ? { productId: l.productId, qty: l.qty + 1 } : l)) };
}

/**
 * A void (D-085): removes `qty` units (1..line qty) from the product's line; the line is removed
 * when it reaches 0. Throws RangeError for an unknown line or an out-of-range qty.
 */
export function reduceLine(basket: BasketState, productId: string, qty: number): BasketState {
  const line = basket.lines.find((l) => l.productId === productId);
  if (line === undefined) throw new RangeError(`No basket line for product ${productId}`);
  if (!Number.isInteger(qty) || qty < 1 || qty > line.qty) {
    throw new RangeError(`Void quantity must be an integer 1..${line.qty}`);
  }
  const remaining = line.qty - qty;
  const lines =
    remaining === 0
      ? basket.lines.filter((l) => l.productId !== productId)
      : basket.lines.map((l) => (l.productId === productId ? { productId, qty: remaining } : l));
  return { ...basket, lines };
}

/** True when there are no lines, member, booking or loaded tab (D-095, D-047). */
export function isBasketEmpty(basket: BasketState): boolean {
  return basket.lines.length === 0 && basket.memberId === undefined && basket.bookingId === undefined && basket.tabId === undefined;
}

/** True when the basket has no lines (Pay is disabled, D-031). */
export function hasNoLines(basket: BasketState): boolean {
  return basket.lines.length === 0;
}

/**
 * Add-to-tab merge (D-063 b): existing productIds have their qty summed in place; new productIds
 * are appended in basket order. A merged qty above MAX_LINE_QTY throws RangeError (never a silent
 * cap); the service reports it as a VALIDATION error.
 */
export function mergeLines(tabLines: readonly TabLine[], basketLines: readonly BasketLine[]): TabLine[] {
  const merged: TabLine[] = tabLines.map((line) => ({ productId: line.productId, qty: line.qty }));
  for (const line of basketLines) {
    const existing = merged.find((m) => m.productId === line.productId);
    if (existing === undefined) {
      merged.push({ productId: line.productId, qty: line.qty });
      continue;
    }
    const qty = existing.qty + line.qty;
    if (qty > MAX_LINE_QTY) throw new RangeError(`Maximum quantity is ${MAX_LINE_QTY}`);
    existing.qty = qty;
  }
  return merged;
}
