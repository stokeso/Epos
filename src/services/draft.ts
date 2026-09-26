/**
 * Draft basket persistence (spec §6.2, §8; D-094..D-096).
 */
import type { BasketLine } from '../data/types';
import { EMPTY_BASKET, isBasketEmpty, type BasketState } from '../rules/basket';
import type { ServiceContext } from './context';

/**
 * Called after every basket change (no debounce). Saves the draft row, or clears it when the
 * basket is completely empty (isBasketEmpty).
 */
export async function saveDraft(ctx: ServiceContext, basket: BasketState): Promise<void> {
  if (isBasketEmpty(basket)) {
    await ctx.repos.draft.clear();
    return;
  }
  await ctx.repos.draft.save({
    lines: basket.lines.map((line) => ({ productId: line.productId, qty: line.qty })),
    ...(basket.memberId === undefined ? {} : { memberId: basket.memberId }),
    ...(basket.bookingId === undefined ? {} : { bookingId: basket.bookingId }),
    ...(basket.tabId === undefined ? {} : { tabId: basket.tabId }),
  });
}

/** Clears the draft row (no-op if absent). */
export async function clearDraft(ctx: ServiceContext): Promise<void> {
  await ctx.repos.draft.clear();
}

export interface RestoredDraft {
  basket: BasketState;
  /** Lines / member / booking dropped as stale; > 0 -> toast 'N item(s) removed from the saved basket'. */
  removedCount: number;
}

/**
 * At login when the in-memory basket is empty (D-096). null when there is no draft (or it was
 * discarded because its tab is missing, deleted or not open). Drops lines whose product record is
 * missing (inactive/deleted products are kept), a missing member, and a booking that is missing,
 * not open or has a zero balance. When anything was dropped, re-saves the cleaned draft.
 * removedCount counts each dropped line, member and booking as one item.
 */
export async function restoreDraft(ctx: ServiceContext): Promise<RestoredDraft | null> {
  const { repos } = ctx;
  const draft = await repos.draft.get();
  if (draft === undefined) return null;

  if (draft.tabId !== undefined) {
    const tab = await repos.tabs.get(draft.tabId);
    if (tab === undefined || tab.deletedAt !== undefined || tab.status !== 'open') {
      await repos.draft.clear();
      return null;
    }
  }

  let removedCount = 0;
  const lines: BasketLine[] = [];
  for (const line of draft.lines) {
    if ((await repos.products.get(line.productId)) === undefined) removedCount += 1;
    else lines.push({ productId: line.productId, qty: line.qty });
  }

  let memberId = draft.memberId;
  if (memberId !== undefined && (await repos.members.get(memberId)) === undefined) {
    memberId = undefined;
    removedCount += 1;
  }

  let bookingId = draft.bookingId;
  if (bookingId !== undefined) {
    const booking = await repos.bookings.get(bookingId);
    const usable =
      booking !== undefined &&
      booking.deletedAt === undefined &&
      booking.status === 'open' &&
      (await repos.sales.bookingBalance(bookingId)) > 0;
    if (!usable) {
      bookingId = undefined;
      removedCount += 1;
    }
  }

  const restored: BasketState = {
    lines,
    ...(memberId === undefined ? {} : { memberId }),
    ...(bookingId === undefined ? {} : { bookingId }),
    ...(draft.tabId === undefined ? {} : { tabId: draft.tabId }),
  };
  if (removedCount > 0) await saveDraft(ctx, restored);
  return { basket: isBasketEmpty(restored) ? EMPTY_BASKET : restored, removedCount };
}
