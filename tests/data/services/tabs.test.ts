/**
 * Tabs: open by name or table, add, load, park, settle, the Tabs list (spec §6.6, §8;
 * D-062..D-066).
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_BASKET } from '../../../src/rules/basket';
import { saveProduct } from '../../../src/services/catalogue';
import { saveDraft } from '../../../src/services/draft';
import { openSalePayment } from '../../../src/services/pay';
import { addBasketToTab, listOpenTabs, loadTab, openNewTab, parkTab } from '../../../src/services/tabs';
import { auth, basket, cash, expectAppError, outboxSince, registerCleanup, sell, setupTill, type Till } from './harness';

registerCleanup();

const tabsAuth = (t: Till) => auth(t.staff, 'tabs');

describe('opening a tab (D-063 a, D-064)', () => {
  it('moves the basket onto a new name tab and clears the basket and draft in one transaction', async () => {
    const t = await setupTill();
    const b = basket([[t.c.lager, 2]], { memberId: t.c.member.id });
    await saveDraft(t.h.ctx, b);
    const before = await t.h.repos.outbox.count();
    const { tab, basket: after } = await openNewTab(t.h.ctx, tabsAuth(t), b, 'name', '  Smith  ');
    expect(after).toEqual(EMPTY_BASKET);
    expect(tab).toMatchObject({
      labelType: 'name',
      label: 'Smith',
      status: 'open',
      openedBy: t.staff.staffId,
      openedAt: t.h.clock.iso(),
      lines: [{ productId: t.c.lager.id, qty: 2 }],
      memberId: t.c.member.id,
    });
    expect(await t.h.repos.draft.get()).toBeUndefined();
    expect(await outboxSince(t.h.repos, before)).toEqual([{ entity: 'tabs', operation: 'create' }]);
  });

  it('opens table tabs and keeps name and table labels separate', async () => {
    const t = await setupTill();
    await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'table', '5');
    await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.bitter, 1]]), 'name', '5');
    await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.crisps, 1]]), 'name', 'Smith');
    const list = await listOpenTabs(t.h.ctx, EMPTY_BASKET);
    expect(list.map((s) => s.displayLabel)).toEqual(['Table 5', '5', 'Smith']);
    await expectAppError(openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'name', ' smith '), 'VALIDATION', /is already open/);
    await expectAppError(openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'table', '5'), 'VALIDATION', 'Table 5 is already open');
    await expectAppError(openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'name', '   '), 'VALIDATION');
    await expectAppError(openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'table', 'T/5'), 'VALIDATION');
    expect(await t.h.repos.tabs.listOpen()).toHaveLength(3);
  });

  it('needs lines, no loaded tab, no booking, an open period and the tabs authorisation', async () => {
    const t = await setupTill();
    await expectAppError(openNewTab(t.h.ctx, tabsAuth(t), basket([], { memberId: t.c.member.id }), 'name', 'A'), 'VALIDATION', 'Add items to the basket first');
    await expectAppError(openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]], { tabId: 'x' }), 'name', 'A'), 'VALIDATION');
    await expectAppError(openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]], { bookingId: 'b' }), 'name', 'A'), 'VALIDATION');
    await expectAppError(openNewTab(t.h.ctx, auth(t.staff, 'sell'), basket([[t.c.lager, 1]]), 'name', 'A'), 'PERMISSION_DENIED');
    const closed = await setupTill({ floatPence: null });
    await expectAppError(openNewTab(closed.h.ctx, tabsAuth(closed), basket([[closed.c.lager, 1]]), 'name', 'A'), 'NO_OPEN_PERIOD');
    expect(await t.h.repos.tabs.list()).toEqual([]);
  });
});

describe('adding to, loading and parking a tab (D-063 b..d, D-065)', () => {
  it('merges the basket into the tab: existing products summed in place, new ones appended (D-063 example)', async () => {
    const t = await setupTill();
    const { tab } = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 2]]), 'name', 'Smith');
    const added = await addBasketToTab(t.h.ctx, tabsAuth(t), basket([[t.c.crisps, 1]]), tab.id);
    expect(added.basket).toEqual(EMPTY_BASKET);
    expect(added.tab.lines).toEqual([
      { productId: t.c.lager.id, qty: 2 },
      { productId: t.c.crisps.id, qty: 1 },
    ]);
    const again = await addBasketToTab(t.h.ctx, tabsAuth(t), basket([[t.c.bitter, 1], [t.c.lager, 1]]), tab.id);
    expect(again.tab.lines).toEqual([
      { productId: t.c.lager.id, qty: 3 },
      { productId: t.c.crisps.id, qty: 1 },
      { productId: t.c.bitter.id, qty: 1 },
    ]);
  });

  it('takes the basket member only when the tab has none', async () => {
    const t = await setupTill();
    const { tab } = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'table', '7');
    const withMember = await addBasketToTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]], { memberId: t.c.member.id }), tab.id);
    expect(withMember.tab.memberId).toBe(t.c.member.id);
    const other = await t.h.repos.members.create({ memberNumber: '2000', firstName: 'Ben', lastName: 'Birch', active: true });
    const kept = await addBasketToTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]], { memberId: other.id }), tab.id);
    expect(kept.tab.memberId).toBe(t.c.member.id);
  });

  it('rejects a merged quantity above 999 and a closed tab, leaving the tab and draft unchanged', async () => {
    const t = await setupTill();
    const { tab } = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 998]]), 'name', 'Big');
    const b = basket([[t.c.lager, 2]]);
    await saveDraft(t.h.ctx, b);
    await expectAppError(addBasketToTab(t.h.ctx, tabsAuth(t), b, tab.id), 'VALIDATION', 'Maximum quantity is 999');
    expect((await t.h.repos.tabs.get(tab.id))?.lines).toEqual([{ productId: t.c.lager.id, qty: 998 }]);
    expect(await t.h.repos.draft.get()).toBeDefined();
    await expectAppError(addBasketToTab(t.h.ctx, tabsAuth(t), b, 'missing'), 'TAB_NOT_OPEN');
  });

  it('loads a tab only into an empty basket, carrying its member, and writes nothing', async () => {
    const t = await setupTill();
    const { tab } = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 2]], { memberId: t.c.member.id }), 'name', 'Smith');
    await expectAppError(loadTab(t.h.ctx, tabsAuth(t), basket([], { memberId: t.c.member.id }), tab.id), 'BASKET_NOT_EMPTY');
    const before = await t.h.repos.exportAll();
    const loaded = await loadTab(t.h.ctx, tabsAuth(t), EMPTY_BASKET, tab.id);
    expect(loaded).toEqual({ lines: [{ productId: t.c.lager.id, qty: 2 }], memberId: t.c.member.id, tabId: tab.id });
    expect(await t.h.repos.exportAll()).toEqual(before);
    expect((await listOpenTabs(t.h.ctx, loaded)).map((s) => s.onTill)).toEqual([true]);
    await expectAppError(loadTab(t.h.ctx, tabsAuth(t), EMPTY_BASKET, 'missing'), 'TAB_NOT_OPEN');
  });

  it('parks the basket back onto the tab, removing a detached member, and deletes a tab parked empty', async () => {
    const t = await setupTill();
    const { tab } = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 2]], { memberId: t.c.member.id }), 'name', 'Smith');
    const loaded = await loadTab(t.h.ctx, tabsAuth(t), EMPTY_BASKET, tab.id);
    await saveDraft(t.h.ctx, loaded);
    const edited = { lines: [...loaded.lines, { productId: t.c.crisps.id, qty: 1 }], tabId: tab.id };
    expect(await parkTab(t.h.ctx, tabsAuth(t), edited)).toEqual(EMPTY_BASKET);
    const parked = await t.h.repos.tabs.get(tab.id);
    expect(parked?.lines).toEqual(edited.lines);
    expect(parked).not.toHaveProperty('memberId');
    expect(await t.h.repos.draft.get()).toBeUndefined();

    await parkTab(t.h.ctx, tabsAuth(t), { lines: [], tabId: tab.id });
    expect((await t.h.repos.tabs.get(tab.id))?.deletedAt).toBe(t.h.clock.iso());
    expect(await t.h.repos.tabs.listOpen()).toEqual([]);
  });

  it('parks only in tab mode and never with a booking attached', async () => {
    const t = await setupTill();
    await expectAppError(parkTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]])), 'VALIDATION', 'No tab is on the till');
    const { tab } = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'name', 'Smith');
    await expectAppError(parkTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]], { tabId: tab.id, bookingId: 'b' })), 'VALIDATION');
  });
});

describe('settling tabs and the Tabs list (D-062, D-063 e, D-064, D-065)', () => {
  it('settles through Pay: the deal applies across rounds, the member stays attached and the tab closes', async () => {
    const t = await setupTill();
    const { tab } = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 2]], { memberId: t.c.member.id }), 'table', '5');
    await addBasketToTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), tab.id);
    const loaded = await loadTab(t.h.ctx, tabsAuth(t), EMPTY_BASKET, tab.id);
    await saveDraft(t.h.ctx, loaded);
    const before = await t.h.repos.outbox.count();

    // Lager x3 with 3 for 2: 1350 - 450 = 900; member 15% of 900 = 135 -> 765.
    const { sale } = await sell(t.h.ctx, t.staff, loaded, [cash(1000)]);
    expect(sale).toMatchObject({ tabId: tab.id, memberId: t.c.member.id, totalPence: 765, changePence: 235 });
    const settled = await t.h.repos.tabs.get(tab.id);
    expect(settled).toMatchObject({ status: 'settled', lines: [{ productId: t.c.lager.id, qty: 3 }] });
    expect(await t.h.repos.draft.get()).toBeUndefined();
    expect(await listOpenTabs(t.h.ctx, EMPTY_BASKET)).toEqual([]);
    // The sale, one stock movement, the receipt counter and the tab (D-053 example).
    expect(await outboxSince(t.h.repos, before)).toEqual([
      { entity: 'sales', operation: 'create' },
      { entity: 'stockMovements', operation: 'create' },
      { entity: 'settings', operation: 'update' },
      { entity: 'tabs', operation: 'update' },
    ]);
    // A settled tab cannot be paid again, and its label can be reused.
    await expectAppError(openSalePayment(t.h.ctx, loaded), 'TAB_NOT_OPEN');
    await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 1]]), 'table', '5');
  });

  it('lists open tabs oldest first with repriced totals, time open and the tab on the till', async () => {
    const t = await setupTill();
    const smith = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.bitter, 2]]), 'name', 'Smith');
    t.h.clock.advance(20 * 60_000);
    const table = await openNewTab(t.h.ctx, tabsAuth(t), basket([[t.c.lager, 3]], { memberId: t.c.member.id }), 'table', '12');
    t.h.clock.advance(65 * 60_000);

    const list = await listOpenTabs(t.h.ctx, { lines: [], tabId: table.tab.id });
    expect(list.map(({ displayLabel, totalPence, timeOpen, onTill }) => ({ displayLabel, totalPence, timeOpen, onTill }))).toEqual([
      { displayLabel: 'Smith', totalPence: 840, timeOpen: '1h 25m', onTill: false },
      { displayLabel: 'Table 12', totalPence: 765, timeOpen: '1h 5m', onTill: true },
    ]);
    expect(list[0]?.openedAt).toBe(smith.tab.openedAt);

    // D-009 / D-062: a price edit reprices the open tab.
    await saveProduct(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.bitter.id, { ...t.c.bitter, pricePence: 440 });
    expect((await listOpenTabs(t.h.ctx, EMPTY_BASKET))[0]?.totalPence).toBe(880);
  });

  it('lists tabs without an open period', async () => {
    const t = await setupTill({ floatPence: null });
    expect(await listOpenTabs(t.h.ctx, EMPTY_BASKET)).toEqual([]);
  });
});
