/**
 * Trading periods: open with float, X read, Z close (spec §6.11, §7; D-040..D-047, D-061,
 * D-066..D-068).
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_BASKET } from '../../../src/rules/basket';
import { approveOverride } from '../../../src/services/override';
import { openSalePayment } from '../../../src/services/pay';
import {
  confirmZClose,
  currentPeriodFigures,
  getOpenPeriod,
  openPeriod,
  prepareZClose,
  previewZClose,
  requireOpenPeriod,
  runXRead,
} from '../../../src/services/periods';
import { addBasketToTab, loadTab, openNewTab } from '../../../src/services/tabs';
import { auth, basket, card, cash, expectAppError, PINS, registerCleanup, sell, setupTill } from './harness';

registerCleanup();

describe('opening a period (D-067)', () => {
  it('opens one period with a float; only one may be open', async () => {
    const t = await setupTill({ floatPence: null });
    expect(await getOpenPeriod(t.h.ctx)).toBeUndefined();
    await expectAppError(requireOpenPeriod(t.h.ctx), 'NO_OPEN_PERIOD', 'No trading period open');
    const period = await openPeriod(t.h.ctx, auth(t.manager, 'openClosePeriod'), 15000);
    expect(period).toMatchObject({ openedBy: t.manager.staffId, floatPence: 15000, openedAt: t.h.clock.iso() });
    expect(period).not.toHaveProperty('closedAt');
    expect(await requireOpenPeriod(t.h.ctx)).toEqual(period);
    await expectAppError(openPeriod(t.h.ctx, auth(t.manager, 'openClosePeriod'), 0), 'PERIOD_ALREADY_OPEN');
    // There is no audit type for opening a period (D-084).
    expect(await t.h.repos.auditEvents.list()).toEqual([]);
  });

  it('validates the float: 0..9,999,999 whole pence', async () => {
    const t = await setupTill({ floatPence: null });
    const manager = auth(t.manager, 'openClosePeriod');
    for (const bad of [-1, 10_000_000, 12.5, -0]) {
      await expectAppError(openPeriod(t.h.ctx, manager, bad), 'VALIDATION', 'The float must be £0.00 to £99,999.99');
    }
    await expectAppError(openPeriod(t.h.ctx, auth(t.manager, 'xRead'), 100), 'PERMISSION_DENIED');
    expect((await openPeriod(t.h.ctx, manager, 9_999_999)).floatPence).toBe(9_999_999);
  });

  it('lets staff open a period with a manager PIN, recording the override against the new period (D-083)', async () => {
    const t = await setupTill({ floatPence: null });
    const approval = await approveOverride(t.h.ctx, t.staff, 'openClosePeriod', PINS.manager);
    if (approval === null) throw new Error('expected approval');
    const period = await openPeriod(t.h.ctx, approval, 10000);
    expect(period.openedBy).toBe(t.staff.staffId);
    const [event] = await t.h.repos.auditEvents.list();
    expect(event).toMatchObject({ type: 'override', staffId: t.staff.staffId, approvedById: t.manager.staffId, periodId: period.id, detail: { action: 'openClosePeriod' } });
  });
});

describe('X read (D-046)', () => {
  it('reports the period so far without closing it or writing anything', async () => {
    const t = await setupTill();
    await sell(t.h.ctx, t.staff, basket([[t.c.lager, 2]]), [cash(1000)]);
    const before = await t.h.repos.exportAll();
    const x = await runXRead(t.h.ctx, auth(t.supervisor, 'xRead'));
    expect(x.figures).toMatchObject({ grossSalesPence: 900, netTakingsPence: 900, cashTenderedPence: 1000, changeGivenPence: 100, cashTotalPence: 900, floatPence: 10000, expectedCashPence: 10900 });
    expect(x.document).toContain('<title>X read</title>');
    expect(x.document).toContain('Sue Supervisor');
    expect(await t.h.repos.exportAll()).toEqual(before);
    expect((await getOpenPeriod(t.h.ctx))?.id).toBe(x.period.id);
  });

  it('records only the override event when a staff member is approved (D-072)', async () => {
    const t = await setupTill();
    const approval = await approveOverride(t.h.ctx, t.staff, 'xRead', PINS.supervisor);
    if (approval === null) throw new Error('expected approval');
    const x = await runXRead(t.h.ctx, approval);
    expect((await t.h.repos.auditEvents.list()).map((e) => [e.type, e.periodId])).toEqual([['override', x.period.id]]);
  });

  it('needs an open period and the xRead authorisation', async () => {
    const t = await setupTill({ floatPence: null });
    await expectAppError(runXRead(t.h.ctx, auth(t.supervisor, 'xRead')), 'NO_OPEN_PERIOD');
    await expectAppError(currentPeriodFigures(t.h.ctx), 'NO_OPEN_PERIOD');
    await expectAppError(runXRead(t.h.ctx, auth(t.supervisor, 'noSale')), 'PERMISSION_DENIED');
  });
});

describe('Z close (D-047, D-061, D-066)', () => {
  it('needs an empty basket and warns about open tabs, which carry over', async () => {
    const t = await setupTill();
    await expectAppError(prepareZClose(t.h.ctx, basket([], { memberId: t.c.member.id })), 'BASKET_NOT_EMPTY', 'Finish, park or void the current basket first');
    await openNewTab(t.h.ctx, auth(t.staff, 'tabs'), basket([[t.c.lager, 1]]), 'name', 'Smith');
    const check = await prepareZClose(t.h.ctx, EMPTY_BASKET);
    expect(check.openTabCount).toBe(1);
    expect(check.period.id).toBe((await getOpenPeriod(t.h.ctx))?.id);
    await expectAppError(confirmZClose(t.h.ctx, auth(t.manager, 'openClosePeriod'), basket([[t.c.lager, 1]]), 0), 'BASKET_NOT_EMPTY');
    expect(await getOpenPeriod(t.h.ctx)).toBeDefined();
  });

  it('previews expected cash, declared cash and the variance without writing', async () => {
    const t = await setupTill();
    await sell(t.h.ctx, t.staff, basket([[t.c.lager, 3]]), [cash(5000)]);
    await sell(t.h.ctx, t.staff, basket([[t.c.bitter, 1]]), [card(null)]);
    const before = await t.h.repos.exportAll();
    // float 10000 + cash 5000 - change 4100 = 10900.
    expect(await previewZClose(t.h.ctx, 10850)).toEqual({ expectedCashPence: 10900, declaredCashPence: 10850, variancePence: -50 });
    expect(await previewZClose(t.h.ctx, 11000)).toEqual({ expectedCashPence: 10900, declaredCashPence: 11000, variancePence: 100 });
    await expectAppError(previewZClose(t.h.ctx, -1), 'VALIDATION', 'The counted cash must be £0.00 to £99,999.99');
    expect(await t.h.repos.exportAll()).toEqual(before);
  });

  it('closes the period with the next Z number and a zClose audit event, then selling stops', async () => {
    const t = await setupTill();
    await sell(t.h.ctx, t.staff, basket([[t.c.lager, 3]]), [cash(5000)]);
    const open = await requireOpenPeriod(t.h.ctx);
    t.h.clock.advance(8 * 3_600_000);
    const z = await confirmZClose(t.h.ctx, auth(t.manager, 'openClosePeriod'), EMPTY_BASKET, 10800);
    expect(z.period).toMatchObject({ id: open.id, zNumber: 1, closedBy: t.manager.staffId, declaredCashPence: 10800, closedAt: t.h.clock.iso() });
    expect(z.figures).toMatchObject({ expectedCashPence: 10900, declaredCashPence: 10800, variancePence: -100, netTakingsPence: 900 });
    expect(z.document).toContain('<title>Z report 1</title>');
    const [event] = await t.h.repos.auditEvents.listByType('zClose');
    expect(event).toMatchObject({
      staffId: t.manager.staffId,
      periodId: open.id,
      detail: { zNumber: 1, floatPence: 10000, expectedCashPence: 10900, declaredCashPence: 10800, variancePence: -100 },
    });
    expect(event).not.toHaveProperty('approvedById');
    expect(await getOpenPeriod(t.h.ctx)).toBeUndefined();
    await expectAppError(openSalePayment(t.h.ctx, basket([[t.c.lager, 1]])), 'NO_OPEN_PERIOD');
    await expectAppError(confirmZClose(t.h.ctx, auth(t.manager, 'openClosePeriod'), EMPTY_BASKET, 0), 'NO_OPEN_PERIOD');

    // The next period gets Z 2 (D-061).
    await openPeriod(t.h.ctx, auth(t.manager, 'openClosePeriod'), 10000);
    const z2 = await confirmZClose(t.h.ctx, auth(t.manager, 'openClosePeriod'), EMPTY_BASKET, 10000);
    expect(z2.period.zNumber).toBe(2);
    expect(z2.figures).toMatchObject({ netTakingsPence: 0, expectedCashPence: 10000, variancePence: 0 });
  });

  it('records the override and the zClose event together when a supervisor is approved by a manager', async () => {
    const t = await setupTill();
    const approval = await approveOverride(t.h.ctx, t.supervisor, 'openClosePeriod', PINS.manager);
    if (approval === null) throw new Error('expected approval');
    const z = await confirmZClose(t.h.ctx, approval, EMPTY_BASKET, 10000);
    expect(z.period.closedBy).toBe(t.supervisor.staffId);
    expect((await t.h.repos.auditEvents.list()).map((e) => [e.type, e.staffId, e.approvedById, e.periodId])).toEqual([
      ['override', t.supervisor.staffId, t.manager.staffId, z.period.id],
      ['zClose', t.supervisor.staffId, t.manager.staffId, z.period.id],
    ]);
  });

  it('closes the period even when the Z report cannot be printed, but an X read that fails throws (D-123)', async () => {
    const t = await setupTill();
    const broken = { ...t.h.ctx, repos: { ...t.h.repos, staff: { ...t.h.repos.staff, get: () => Promise.reject(new Error('staff table unreadable')) } } };
    await expect(runXRead(broken, auth(t.supervisor, 'xRead'))).rejects.toThrow('staff table unreadable');
    const z = await confirmZClose(broken, auth(t.manager, 'openClosePeriod'), EMPTY_BASKET, 10000);
    expect(z.period.zNumber).toBe(1);
    expect(z.document).toContain('<title>Z report 1</title>');
    expect(z.document).toContain('Z 1 was closed, but the report could not be printed.');
    expect(await getOpenPeriod(t.h.ctx)).toBeUndefined();
  });

  it('carries open tabs over: a tab settles in the period open at settlement (D-066)', async () => {
    const t = await setupTill();
    const tabs = auth(t.staff, 'tabs');
    const { tab } = await openNewTab(t.h.ctx, tabs, basket([[t.c.lager, 2]]), 'table', '4');
    const z1 = await confirmZClose(t.h.ctx, auth(t.manager, 'openClosePeriod'), EMPTY_BASKET, 10000);
    expect(z1.figures.netTakingsPence).toBe(0);
    expect((await t.h.repos.tabs.get(tab.id))?.status).toBe('open');

    const p2 = await openPeriod(t.h.ctx, auth(t.manager, 'openClosePeriod'), 5000);
    await addBasketToTab(t.h.ctx, tabs, basket([[t.c.lager, 1]]), tab.id);
    const loaded = await loadTab(t.h.ctx, tabs, EMPTY_BASKET, tab.id);
    const { sale } = await sell(t.h.ctx, t.staff, loaded, [cash(900)]);
    expect(sale.periodId).toBe(p2.id);
    const { figures } = await currentPeriodFigures(t.h.ctx);
    expect(figures).toMatchObject({ grossSalesPence: 1350, dealDiscountsPence: 450, netTakingsPence: 900, expectedCashPence: 5900 });
  });
});
