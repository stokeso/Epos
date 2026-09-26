/**
 * Tabs (spec §6.6, §8; D-062..D-066). Every operation: auth.action 'tabs' and an open period.
 * Operations that empty the basket clear the draft in the same transaction and return EMPTY_BASKET.
 */
import { AppError } from '../data/errors';
import type { IsoInstant, Tab, TabLabelType } from '../data/types';
import { EMPTY_BASKET, hasNoLines, isBasketEmpty, mergeLines, type BasketState } from '../rules/basket';
import { MAX_LINE_QTY } from '../rules/money';
import { priceBasket } from '../rules/pricing';
import { formatDuration } from '../rules/time';
import { tabDisplayLabel, validateTabLabel } from '../rules/validation';
import { nowIso, type ServiceContext } from './context';
import { assertAuthorised, overrideEvents, type Authorisation } from './override';
import { requireOpenPeriod } from './periods';
import { getSettings } from './settings';
import { productsById, validOrThrow } from './shared';
import { pricingLinesFrom } from './till';

export interface TabSummary {
  tab: Tab;
  /** 'Smith' or 'Table 5'. */
  displayLabel: string;
  /** priceBasket(tab lines, deals, now, member % if tab.memberId, no booking).totalPence (D-062). */
  totalPence: number;
  openedAt: IsoInstant;
  /** formatDuration(now - openedAt). */
  timeOpen: string;
  /** True when this tab is the one loaded in the basket ('On till'). */
  onTill: boolean;
}

/** Open, non-deleted tabs sorted by openedAt ascending (D-064). Viewing needs no open period. */
export async function listOpenTabs(ctx: ServiceContext, basket: BasketState): Promise<TabSummary[]> {
  const { repos } = ctx;
  const tabs = await repos.tabs.listOpen();
  if (tabs.length === 0) return [];
  const now = nowIso(ctx);
  const settings = await getSettings(ctx);
  const products = await productsById(ctx);
  const deals = await repos.deals.list();
  const summaries: TabSummary[] = [];
  for (const tab of tabs) {
    const member = tab.memberId === undefined ? undefined : await repos.members.get(tab.memberId);
    const priced = priceBasket({
      lines: pricingLinesFrom(tab.lines, products),
      deals,
      at: now,
      memberDiscountPercent: member === undefined ? null : settings.memberDiscountPercent,
      depositBalancePence: null,
    });
    summaries.push({
      tab,
      displayLabel: tabDisplayLabel(tab),
      totalPence: priced.totalPence,
      openedAt: tab.openedAt,
      timeOpen: formatDuration(Date.parse(now) - Date.parse(tab.openedAt)),
      onTill: basket.tabId === tab.id,
    });
  }
  return summaries;
}

/** New tab / add to tab preconditions (D-063 a, b; D-065). */
function assertCanMoveBasketToTab(basket: BasketState): void {
  if (hasNoLines(basket)) throw new AppError('VALIDATION', 'Add items to the basket first');
  if (basket.tabId !== undefined) throw new AppError('VALIDATION', 'A tab is already on the till: save it to the tab or pay it first');
  if (basket.bookingId !== undefined) throw new AppError('VALIDATION', 'Detach the booking first: bookings are never stored on tabs');
}

/** The tab if it exists, is not deleted and is open, else TAB_NOT_OPEN. */
async function requireOpenTab(ctx: ServiceContext, tabId: string): Promise<Tab> {
  const tab = await ctx.repos.tabs.get(tabId);
  if (tab === undefined || tab.deletedAt !== undefined || tab.status !== 'open') {
    throw new AppError('TAB_NOT_OPEN', 'That tab is no longer open');
  }
  return tab;
}

/**
 * New tab (D-063 a): basket has lines, is not in tab mode and has no booking. Validates the label
 * (validateTabLabel) against the open tabs inside the transaction. transact: tabs.create({
 * labelType, label, openedAt: now, openedBy: auth.staffId, status 'open', lines, memberId? }) +
 * draft.clear() + overrideEvents.
 */
export async function openNewTab(
  ctx: ServiceContext,
  auth: Authorisation,
  basket: BasketState,
  labelType: TabLabelType,
  label: string,
): Promise<{ tab: Tab; basket: BasketState }> {
  assertAuthorised(auth, 'tabs');
  const period = await requireOpenPeriod(ctx);
  assertCanMoveBasketToTab(basket);
  const openedAt = nowIso(ctx);
  const tab = await ctx.repos.transact(async () => {
    const value = validOrThrow(validateTabLabel(labelType, label, { openTabs: await ctx.repos.tabs.listOpen() }));
    const created = await ctx.repos.tabs.create({
      labelType,
      label: value,
      openedAt,
      openedBy: auth.staffId,
      status: 'open',
      lines: basket.lines.map((line) => ({ productId: line.productId, qty: line.qty })),
      ...(basket.memberId === undefined ? {} : { memberId: basket.memberId }),
    });
    await ctx.repos.draft.clear();
    await ctx.repos.auditEvents.append(overrideEvents(auth, period.id));
    return created;
  });
  return { tab, basket: EMPTY_BASKET };
}

/**
 * Add the basket to an open tab (D-063 b): same preconditions as openNewTab. mergeLines (a merged
 * qty above 999 is a VALIDATION error); sets tab.memberId from the basket only if the tab has none.
 * transact: tabs.update + draft.clear() + overrideEvents.
 */
export async function addBasketToTab(
  ctx: ServiceContext,
  auth: Authorisation,
  basket: BasketState,
  tabId: string,
): Promise<{ tab: Tab; basket: BasketState }> {
  assertAuthorised(auth, 'tabs');
  const period = await requireOpenPeriod(ctx);
  assertCanMoveBasketToTab(basket);
  const tab = await ctx.repos.transact(async () => {
    const existing = await requireOpenTab(ctx, tabId);
    let lines: Tab['lines'];
    try {
      lines = mergeLines(existing.lines, basket.lines);
    } catch {
      throw new AppError('VALIDATION', `Maximum quantity is ${MAX_LINE_QTY}`, { lines: `Maximum quantity is ${MAX_LINE_QTY}` });
    }
    const takesMember = existing.memberId === undefined && basket.memberId !== undefined;
    const updated = await ctx.repos.tabs.update(tabId, { lines, ...(takesMember ? { memberId: basket.memberId } : {}) });
    await ctx.repos.draft.clear();
    await ctx.repos.auditEvents.append(overrideEvents(auth, period.id));
    return updated;
  });
  return { tab, basket: EMPTY_BASKET };
}

/**
 * Load (reopen) a tab into a completely empty basket (D-063 c): returns { lines: tab.lines,
 * memberId: tab.memberId, tabId }. Writes nothing to the tab (the UI then saves the draft).
 */
export async function loadTab(ctx: ServiceContext, auth: Authorisation, basket: BasketState, tabId: string): Promise<BasketState> {
  assertAuthorised(auth, 'tabs');
  const period = await requireOpenPeriod(ctx);
  if (!isBasketEmpty(basket)) throw new AppError('BASKET_NOT_EMPTY', 'Finish, park or void the current basket before loading a tab');
  const tab = await requireOpenTab(ctx, tabId);
  await ctx.repos.auditEvents.append(overrideEvents(auth, period.id));
  return {
    lines: tab.lines.map((line) => ({ productId: line.productId, qty: line.qty })),
    ...(tab.memberId === undefined ? {} : { memberId: tab.memberId }),
    tabId: tab.id,
  };
}

/**
 * Park ('Save to tab', D-063 d): tab mode, no booking. transact: tabs.update(tab.lines = basket
 * lines, memberId = basket.memberId or removed) — or tabs.softDelete when the basket has no
 * lines — + draft.clear() + overrideEvents.
 */
export async function parkTab(ctx: ServiceContext, auth: Authorisation, basket: BasketState): Promise<BasketState> {
  assertAuthorised(auth, 'tabs');
  const period = await requireOpenPeriod(ctx);
  const tabId = basket.tabId;
  if (tabId === undefined) throw new AppError('VALIDATION', 'No tab is on the till');
  if (basket.bookingId !== undefined) throw new AppError('VALIDATION', 'Detach the booking first: bookings are never stored on tabs');
  await ctx.repos.transact(async () => {
    await requireOpenTab(ctx, tabId);
    if (hasNoLines(basket)) {
      await ctx.repos.tabs.softDelete(tabId);
    } else {
      // A patch key set to undefined removes the field (D-050): a detached member leaves the tab.
      await ctx.repos.tabs.update(tabId, {
        lines: basket.lines.map((line) => ({ productId: line.productId, qty: line.qty })),
        memberId: basket.memberId,
      });
    }
    await ctx.repos.draft.clear();
    await ctx.repos.auditEvents.append(overrideEvents(auth, period.id));
  });
  return EMPTY_BASKET;
}
