/**
 * A full bar shift end to end (spec §1.1, §10.3 journeys 1-7): log in, open the period, sell
 * with a deal, a member and split tenders, run tabs by table and by name, take a deposit and use
 * it on a final bill, void with a PIN override, no sale, refund, X read, Z close with a
 * declared-cash variance, and a tab carried over into the next period.
 *
 * The money follows the D-042 worked period exactly, so every X/Z figure is asserted to the
 * penny, together with the D-042 reconciliation identities and the rule that the product sales
 * and VAT reports equal the sum of the receipts.
 */
import { describe, expect, it } from 'vitest';
import type { Sale } from '../../../src/data/types';
import { EMPTY_BASKET, addProduct, type BasketState } from '../../../src/rules/basket';
import { login, type Session } from '../../../src/services/auth';
import { listAttachableBookings, saveBooking, settleBooking } from '../../../src/services/bookings';
import { saveDraft } from '../../../src/services/draft';
import { approveOverride, authoriseDirect } from '../../../src/services/override';
import { completePayment, openSalePayment } from '../../../src/services/pay';
import { confirmZClose, openPeriod, prepareZClose, previewZClose, runXRead } from '../../../src/services/periods';
import { commitRefund, findSaleForRefund } from '../../../src/services/refunds';
import { runProductSalesReport, runVatReport, todayLocal } from '../../../src/services/reports';
import { completeFirstRun } from '../../../src/services/setup';
import { createStaff } from '../../../src/services/staff';
import { addBasketToTab, listOpenTabs, loadTab, openNewTab } from '../../../src/services/tabs';
import { recordNoSale, viewBasket, voidLine } from '../../../src/services/till';
import { auth, buildCatalogue, card, cash, makeHarness, registerCleanup, takeDeposit, tenderAll } from './harness';

registerCleanup();

const MINUTE = 60_000;

function add(b: BasketState, productId: string, times = 1): BasketState {
  let next = b;
  for (let i = 0; i < times; i += 1) next = addProduct(next, productId);
  return next;
}

async function loggedIn(ctx: Parameters<typeof login>[0], pin: string): Promise<Session> {
  const session = await login(ctx, pin);
  if (session === null) throw new Error(`PIN ${pin} not recognised`);
  return session;
}

describe('a full bar shift (spec §1.1, D-042)', () => {
  it('runs the shift and every figure reconciles to the penny', async () => {
    // ---- First run and staff (journey 1) -------------------------------------------------
    const h = await makeHarness();
    const { ctx, repos, clock } = h;
    const setupSession = await completeFirstRun(ctx, { clubName: 'Oakfield Golf Club', managerName: 'Morgan Manager', pin: '1234', confirmPin: '1234', loadSampleData: false });
    await createStaff(ctx, auth(setupSession, 'manageMembersStaffSettings'), { name: 'Sue Supervisor', role: 'supervisor', pin: '2222', confirmPin: '2222' });
    await createStaff(ctx, auth(setupSession, 'manageMembersStaffSettings'), { name: 'Sam Staff', role: 'staff', pin: '1111', confirmPin: '1111' });
    const c = await buildCatalogue(h, setupSession);

    // ---- Log in and open the period with a £100 float ----------------------------------------
    const morgan = await loggedIn(ctx, '1234');
    expect(morgan).toEqual(setupSession);
    const period = await openPeriod(ctx, auth(morgan, 'openClosePeriod'), 10000);

    const sam = await loggedIn(ctx, '1111');
    const sue = await loggedIn(ctx, '2222');
    expect([sam.role, sue.role]).toEqual(['staff', 'supervisor']);
    const booking = await saveBooking(ctx, auth(sam, 'bookings'), null, { type: 'wedding', name: 'Smith wedding', date: '2026-10-24', notes: '' });

    // ---- S1 on a table tab: member #1042, Lager x3 with 3 for 2, Crisps x2 (journeys 2, 3) --
    clock.advance(10 * MINUTE);
    let b = add({ ...EMPTY_BASKET, memberId: c.member.id }, c.lager.id, 2);
    await saveDraft(ctx, b);
    const table5 = (await openNewTab(ctx, auth(sam, 'tabs'), b, 'table', '5')).tab;
    clock.advance(20 * MINUTE);
    b = add(add(EMPTY_BASKET, c.lager.id), c.crisps.id, 2);
    await addBasketToTab(ctx, auth(sam, 'tabs'), b, table5.id);
    clock.advance(20 * MINUTE);
    b = await loadTab(ctx, auth(sam, 'tabs'), EMPTY_BASKET, table5.id);
    expect(b).toEqual({ lines: [{ productId: c.lager.id, qty: 3 }, { productId: c.crisps.id, qty: 2 }], memberId: c.member.id, tabId: table5.id });
    await saveDraft(ctx, b);
    expect((await viewBasket(ctx, b)).priced.totalPence).toBe(977);
    const s1Pay = tenderAll(await openSalePayment(ctx, b), [cash(2000)]);
    const s1 = await completePayment(ctx, auth(sam, 'sell'), s1Pay);
    expect(s1.sale).toMatchObject({
      receiptNumber: '3F9C-000001',
      memberId: c.member.id,
      tabId: table5.id,
      memberDiscountPence: 173,
      totalPence: 977,
      tenders: [{ type: 'cash', amountPence: 2000 }],
      changePence: 1023,
    });
    expect(s1.sale.lines.map((l) => [l.qty, l.dealDiscountPence, l.memberDiscountPence, l.finalPence, l.vatPence])).toEqual([
      [3, 450, 135, 765, 128],
      [2, 0, 38, 212, 0],
    ]);
    expect(s1.document).toContain('£9.77');
    expect(s1.document).toContain('£10.23');
    // The stored tabId and memberId resolve to their display labels (D-064, D-107, D-108).
    expect(s1.document).toContain('Tab: Table 5');
    expect(s1.document).toContain('Member discount (#1042)');
    expect((await repos.tabs.get(table5.id))?.status).toBe('settled');
    expect(await repos.draft.get()).toBeUndefined();

    // ---- S2: a £50 cash deposit for the Smith wedding (journey 4) ----------------------------
    clock.advance(5 * MINUTE);
    const s2 = await takeDeposit(ctx, sam, booking.id, 5000, [cash(5000)]);
    expect(s2.sale).toMatchObject({ receiptNumber: '3F9C-000002', kind: 'deposit', totalPence: 5000, changePence: 0 });
    expect(s2.document).toContain('Deposit balance now £50.00');
    expect((await listAttachableBookings(ctx)).map((s) => [s.booking.id, s.balancePence])).toEqual([[booking.id, 5000]]);

    // ---- S3 on a name tab: Wine x4 with the deposit applied, card + cash --------------------
    clock.advance(5 * MINUTE);
    const smith = (await openNewTab(ctx, auth(sam, 'tabs'), add(EMPTY_BASKET, c.wineBottle.id, 2), 'name', 'Smith')).tab;
    clock.advance(30 * MINUTE);
    await addBasketToTab(ctx, auth(sam, 'tabs'), add(EMPTY_BASKET, c.wineBottle.id, 2), smith.id);
    // A tab that stays open over the Z close.
    const jones = (await openNewTab(ctx, auth(sam, 'tabs'), add(EMPTY_BASKET, c.bitter.id, 2), 'name', 'Jones')).tab;
    expect((await listOpenTabs(ctx, EMPTY_BASKET)).map((s) => [s.displayLabel, s.totalPence, s.timeOpen])).toEqual([
      ['Smith', 9180, '30m'],
      ['Jones', 840, '0m'],
    ]);
    clock.advance(10 * MINUTE);
    b = { ...(await loadTab(ctx, auth(sam, 'tabs'), EMPTY_BASKET, smith.id)), bookingId: booking.id };
    const view = await viewBasket(ctx, b);
    expect(view.priced).toMatchObject({ subtotalPence: 9180, depositAppliedPence: 5000, totalPence: 4180 });
    const s3Pay = await openSalePayment(ctx, b);
    const s3 = await completePayment(ctx, auth(sam, 'sell'), tenderAll(s3Pay, [card(3000), cash(1500)]));
    expect(s3.sale).toMatchObject({
      receiptNumber: '3F9C-000003',
      bookingId: booking.id,
      tabId: smith.id,
      depositAppliedPence: 5000,
      totalPence: 4180,
      tenders: [{ type: 'card', amountPence: 3000 }, { type: 'cash', amountPence: 1500 }],
      changePence: 320,
    });
    expect(s3.document).toContain('-£50.00');
    expect(s3.document).toContain('Tab: Smith');
    expect(s3.document).toContain('Booking: Smith wedding');
    expect(s3.document).toContain('£41.80');
    expect(await repos.sales.bookingBalance(booking.id)).toBe(0);
    expect((await settleBooking(ctx, auth(sam, 'bookings'), booking.id)).status).toBe('settled');

    // ---- Two voids (one by staff with a supervisor PIN) and a no sale (journey 5) -----------
    clock.advance(5 * MINUTE);
    b = add(EMPTY_BASKET, c.bitter.id);
    expect(authoriseDirect(sam, 'voidLine')).toBeNull();
    const approval = await approveOverride(ctx, sam, 'voidLine', '2222');
    if (approval === null) throw new Error('expected approval');
    b = await voidLine(ctx, approval, b, c.bitter.id, 1);
    expect(b.lines).toEqual([]);
    b = add(EMPTY_BASKET, c.crisps.id, 2);
    b = await voidLine(ctx, auth(sue, 'voidLine'), b, c.crisps.id, 2);
    expect(b.lines).toEqual([]);
    await recordNoSale(ctx, auth(sue, 'noSale'));

    // ---- S4: refund 1 Lager from S1 by cash, returned to stock (journey 6) ------------------
    clock.advance(5 * MINUTE);
    const lookup = await findSaleForRefund(ctx, '3f9c-1');
    if (lookup.status !== 'found') throw new Error('expected to find S1');
    const s4 = await commitRefund(ctx, auth(morgan, 'refund'), { originalSaleId: lookup.sale.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' });
    expect(s4.sale).toMatchObject({ receiptNumber: '3F9C-000004', totalPence: -255, tenders: [{ type: 'cash', amountPence: -255 }] });
    expect(s4.sale.lines[0]?.vatPence).toBe(-43);
    expect(s4.document).toContain('-£2.55');
    expect(s4.document).toContain('Refund of 3F9C-000001');
    expect(s4.document).toContain('Member discount (#1042)');

    // ---- X read (journey 7) ----------------------------------------------------------------
    clock.advance(60 * MINUTE);
    const expectedFigures = {
      grossSalesPence: 10780,
      dealDiscountsPence: 450,
      memberDiscountsPence: 173,
      refundsPence: 255,
      netTakingsPence: 9902,
      depositsTakenPence: 5000,
      depositsAppliedPence: 5000,
      cashTenderedPence: 8500,
      changeGivenPence: 1343,
      cashRefundedPence: 255,
      cashTotalPence: 6902,
      cardTenderedPence: 3000,
      cardRefundedPence: 0,
      cardTotalPence: 3000,
      vatByRate: [
        { vatRate: 20, grossPence: 9690, vatPence: 1615, netPence: 8075 },
        { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
      ],
      floatPence: 10000,
      expectedCashPence: 16902,
      noSaleCount: 1,
      voidCount: 2,
    };
    const x = await runXRead(ctx, auth(sue, 'xRead'));
    expect(x.period.id).toBe(period.id);
    expect(x.figures).toEqual(expectedFigures);
    expect(x.document).toContain('£99.02');
    expect(x.document).toContain('£169.02');

    // D-042 reconciliation identities.
    const periodSales: Sale[] = await repos.sales.listByPeriod(period.id);
    expect(periodSales.map((s) => s.receiptNumber)).toEqual(['3F9C-000001', '3F9C-000002', '3F9C-000003', '3F9C-000004']);
    const saleLines = periodSales.filter((s) => s.kind === 'sale').flatMap((s) => s.lines);
    const refundLines = periodSales.filter((s) => s.kind === 'refund').flatMap((s) => s.lines);
    const sumFinals = (lines: typeof saleLines) => lines.reduce((a, l) => a + l.finalPence, 0);
    const f = x.figures;
    expect(f.netTakingsPence).toBe(sumFinals([...saleLines, ...refundLines]));
    expect(f.cashTotalPence + f.cardTotalPence).toBe(f.netTakingsPence - f.depositsAppliedPence + f.depositsTakenPence);
    expect(f.expectedCashPence).toBe(f.floatPence + f.cashTotalPence);
    expect(f.vatByRate.reduce((a, r) => a + r.grossPence, 0)).toBe(f.netTakingsPence);
    for (const row of f.vatByRate) expect(row.netPence + row.vatPence).toBe(row.grossPence);
    expect(f.grossSalesPence - f.dealDiscountsPence - f.memberDiscountsPence).toBe(sumFinals(saleLines));
    for (const sale of periodSales) {
      expect(sale.tenders.reduce((a, t) => a + t.amountPence, 0) - sale.changePence).toBe(sale.totalPence);
    }

    // ---- Z close with a declared-cash variance ---------------------------------------------
    clock.advance(30 * MINUTE);
    const precheck = await prepareZClose(ctx, EMPTY_BASKET);
    expect(precheck.openTabCount).toBe(1);
    expect(await previewZClose(ctx, 16900)).toEqual({ expectedCashPence: 16902, declaredCashPence: 16900, variancePence: -2 });
    const z = await confirmZClose(ctx, auth(morgan, 'openClosePeriod'), EMPTY_BASKET, 16900);
    expect(z.figures).toEqual({ ...expectedFigures, declaredCashPence: 16900, variancePence: -2 });
    expect(z.period).toMatchObject({ id: period.id, zNumber: 1, declaredCashPence: 16900, closedBy: morgan.staffId, closedAt: clock.iso() });
    expect(z.document).toContain('<title>Z report 1</title>');
    expect(z.document).toContain('-£0.02');

    // The period's audit trail (D-043, D-072, D-084).
    const trail = await repos.auditEvents.listByPeriod(period.id);
    expect(trail.map((e) => [e.type, e.staffId, e.approvedById])).toEqual([
      ['override', sam.staffId, sue.staffId],
      ['void', sam.staffId, sue.staffId],
      ['void', sue.staffId, undefined],
      ['noSale', sue.staffId, undefined],
      ['refund', morgan.staffId, undefined],
      ['zClose', morgan.staffId, undefined],
    ]);
    expect(trail.at(-1)?.detail).toEqual({ zNumber: 1, floatPence: 10000, expectedCashPence: 16902, declaredCashPence: 16900, variancePence: -2 });

    // ---- Reports equal the sum of receipts ---------------------------------------------------
    const today = todayLocal(ctx);
    const products = await runProductSalesReport(ctx, auth(morgan, 'salesReports'), today, today);
    const vat = await runVatReport(ctx, auth(morgan, 'salesReports'), today, today);
    expect(products.categories.flatMap((cat) => cat.products.map((p) => [p.name, p.qty, p.takingsPence]))).toEqual([
      ['Lager', 2, 510],
      ['Crisps', 2, 212],
      ['Wine', 4, 9180],
    ]);
    expect(products.totalTakingsPence).toBe(9902);
    expect(vat.rows).toEqual(expectedFigures.vatByRate);
    expect(vat.totals).toEqual({ grossPence: 9902, vatPence: 1615, netPence: 8287 });
    const receipts = periodSales.filter((s) => s.kind !== 'deposit');
    expect(receipts.reduce((a, s) => a + s.totalPence + s.depositAppliedPence, 0)).toBe(products.totalTakingsPence);
    expect(vat.totals.grossPence).toBe(x.figures.netTakingsPence);

    // ---- Stock after the shift ---------------------------------------------------------------
    expect(await repos.stockMovements.onHand(c.lager.id)).toBe(48 - 3 + 1);
    expect(await repos.stockMovements.onHand(c.crisps.id)).toBe(36 - 2);
    expect(await repos.stockMovements.onHand(c.wineBottle.id)).toBe(12 - 4);
    expect(await repos.stockMovements.onHand(c.bitter.id)).toBe(48);

    // ---- The next period: the carried-over tab counts only where it is settled (D-066) -------
    clock.advance(12 * 60 * MINUTE);
    await expectNoOpenPeriodForSales(b);
    const period2 = await openPeriod(ctx, auth(morgan, 'openClosePeriod'), 10000);
    b = await loadTab(ctx, auth(sam, 'tabs'), EMPTY_BASKET, jones.id);
    const s5 = await completePayment(ctx, auth(sam, 'sell'), tenderAll(await openSalePayment(ctx, b), [card(null)]));
    expect(s5.sale).toMatchObject({ receiptNumber: '3F9C-000005', periodId: period2.id, totalPence: 840 });
    const x2 = await runXRead(ctx, auth(morgan, 'xRead'));
    expect(x2.figures).toMatchObject({ grossSalesPence: 840, netTakingsPence: 840, cardTotalPence: 840, cashTotalPence: 0, expectedCashPence: 10000, voidCount: 0, noSaleCount: 0 });
    expect((await repos.sales.listByPeriod(period.id)).map((s) => s.receiptNumber)).toHaveLength(4);

    async function expectNoOpenPeriodForSales(basketNow: BasketState): Promise<void> {
      await expect(openSalePayment(ctx, add(basketNow, c.lager.id))).rejects.toMatchObject({ code: 'NO_OPEN_PERIOD' });
    }
  });
});
