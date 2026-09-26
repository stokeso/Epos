/**
 * Refunds (spec §6.8; D-035..D-039) and stock control (spec §6.9; D-079..D-082).
 */
import { describe, expect, it } from 'vitest';
import { saveProduct, setProductActive } from '../../../src/services/catalogue';
import { saveBooking } from '../../../src/services/bookings';
import { approveOverride } from '../../../src/services/override';
import { commitRefund, findSaleForRefund } from '../../../src/services/refunds';
import { listLowStock, listStockLevels, recordGoodsIn, recordStockAdjustment, stockHistory } from '../../../src/services/stock';
import { auth, basket, card, cash, expectAppError, PINS, registerCleanup, sell, setupTill, takeDeposit, type Till } from './harness';

registerCleanup();

/** S1 of the D-042 worked period: member #1042, Lager x3 with 3 for 2, Crisps x2 at 0%; cash 2000. */
async function saleS1(t: Till) {
  return (await sell(t.h.ctx, t.staff, basket([[t.c.lager, 3], [t.c.crisps, 2]], { memberId: t.c.member.id }), [cash(2000)])).sale;
}

const refundAuth = (t: Till) => auth(t.manager, 'refund');

describe('refund lookup (D-035, D-036, D-122)', () => {
  it('finds a sale by a loosely typed receipt number and lists what can be refunded', async () => {
    const t = await setupTill();
    const s1 = await saleS1(t);
    for (const query of ['3f9c-1', ' 3F9C-000001 ', '3f9c-0000001']) {
      const found = await findSaleForRefund(t.h.ctx, query);
      expect(found.status).toBe('found');
    }
    const found = await findSaleForRefund(t.h.ctx, '3f9c-1');
    if (found.status !== 'found') throw new Error('expected found');
    expect(found.sale.id).toBe(s1.id);
    expect(found.lines.map(({ lineIndex, soldQty, refundedQty, refundableQty, stockTracked }) => ({ lineIndex, soldQty, refundedQty, refundableQty, stockTracked }))).toEqual([
      { lineIndex: 0, soldQty: 3, refundedQty: 0, refundableQty: 3, stockTracked: true },
      { lineIndex: 1, soldQty: 2, refundedQty: 0, refundableQty: 2, stockTracked: true },
    ]);
    expect(await findSaleForRefund(t.h.ctx, '3F9C-999')).toEqual({ status: 'notFound' });
    expect(await findSaleForRefund(t.h.ctx, '   ')).toEqual({ status: 'notFound' });
  });

  it('refuses deposit and refund receipts', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, { type: 'wedding', name: 'Smith', date: '2026-10-26', notes: '' });
    const deposit = await takeDeposit(t.h.ctx, t.staff, booking.id, 5000, [cash(5000)]);
    expect(await findSaleForRefund(t.h.ctx, deposit.sale.receiptNumber)).toMatchObject({ status: 'notRefundable', sale: { id: deposit.sale.id } });
    await expectAppError(commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: deposit.sale.id, lines: [], tenderType: 'cash' }), 'NOT_REFUNDABLE');

    const s1 = await saleS1(t);
    const refund = await commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: s1.id, lines: [{ lineIndex: 1, qty: 1, returnToStock: true }], tenderType: 'cash' });
    expect((await findSaleForRefund(t.h.ctx, refund.sale.receiptNumber)).status).toBe('notRefundable');
  });
});

describe('committing refunds (D-036..D-039)', () => {
  it('refunds the Lager line one unit at a time with cumulative shares that sum to the original (D-037 table)', async () => {
    const t = await setupTill();
    const s1 = await saleS1(t);
    const stockBefore = await t.h.repos.stockMovements.onHand(t.c.lager.id);
    const period = await t.h.repos.periods.getOpen();

    const first = await commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: s1.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' });
    expect(first.sale).toMatchObject({
      kind: 'refund',
      receiptNumber: '3F9C-000002',
      refundOfSaleId: s1.id,
      memberId: t.c.member.id,
      staffId: t.manager.staffId,
      periodId: period?.id,
      dealLines: [],
      memberDiscountPence: -45,
      depositAppliedPence: 0,
      totalPence: -255,
      tenders: [{ type: 'cash', amountPence: -255 }],
      changePence: 0,
    });
    expect(first.sale.lines).toEqual([
      {
        productId: t.c.lager.id,
        nameAtSale: 'Lager',
        qty: -1,
        unitPricePence: 450,
        vatRate: 20,
        dealDiscountPence: -150,
        memberDiscountPence: -45,
        finalPence: -255,
        vatPence: -43,
        refundOfLineIndex: 0,
        returnToStock: true,
      },
    ]);
    expect(first.document).toContain('<title>Receipt 3F9C-000002</title>');
    expect(first.document).toContain('3F9C-000001');
    expect(await t.h.repos.stockMovements.onHand(t.c.lager.id)).toBe(stockBefore + 1);

    const [audit] = await t.h.repos.auditEvents.listByType('refund');
    expect(audit).toMatchObject({
      staffId: t.manager.staffId,
      periodId: period?.id,
      detail: {
        refundSaleId: first.sale.id,
        refundReceiptNumber: '3F9C-000002',
        originalSaleId: s1.id,
        originalReceiptNumber: '3F9C-000001',
        totalPence: -255,
        tender: 'cash',
        lines: [{ productId: t.c.lager.id, qty: 1, returnToStock: true }],
      },
    });
    expect(audit).not.toHaveProperty('approvedById');

    // Second unit as waste: +1 refund and -1 waste, net 0 (D-039); VAT 85 - 43 = 42.
    const second = await commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: s1.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: false }], tenderType: 'cash' });
    expect(second.sale.lines[0]).toMatchObject({ dealDiscountPence: -150, memberDiscountPence: -45, finalPence: -255, vatPence: -42, returnToStock: false });
    expect((await t.h.repos.stockMovements.listBySale(second.sale.id)).map(({ qty, reason, note }) => ({ qty, reason, note }))).toEqual([
      { qty: 1, reason: 'refund', note: '' },
      { qty: -1, reason: 'waste', note: 'Refund - wasted' },
    ]);
    expect(await t.h.repos.stockMovements.onHand(t.c.lager.id)).toBe(stockBefore + 1);

    // Third unit by card: VAT 128 - 85 = 43.
    const third = await commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: s1.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'card' });
    expect(third.sale.lines[0]?.vatPence).toBe(-43);
    expect(third.sale.tenders).toEqual([{ type: 'card', amountPence: -255 }]);

    const refunds = await t.h.repos.sales.listRefundsOf(s1.id);
    const sum = (key: 'dealDiscountPence' | 'memberDiscountPence' | 'finalPence' | 'vatPence') => refunds.flatMap((r) => r.lines).reduce((a, l) => a + l[key], 0);
    expect([sum('dealDiscountPence'), sum('memberDiscountPence'), sum('finalPence'), sum('vatPence')]).toEqual([-450, -135, -765, -128]);

    const lookup = await findSaleForRefund(t.h.ctx, '3f9c-1');
    if (lookup.status !== 'found') throw new Error('expected found');
    expect(lookup.lines.map((l) => [l.refundedQty, l.refundableQty])).toEqual([[3, 0], [0, 2]]);
    await expectAppError(
      commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: s1.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' }),
      'VALIDATION',
      'Lager: choose 0 to 0 to refund',
    );
  });

  it('prices each of two overlapping refunds from the refunds committed before it (D-037, D-127)', async () => {
    const t = await setupTill();
    const s1 = await saleS1(t);
    const oneLager = { originalSaleId: s1.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' } as const;
    const results = await Promise.allSettled([commitRefund(t.h.ctx, refundAuth(t), oneLager), commitRefund(t.h.ctx, refundAuth(t), oneLager)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    await commitRefund(t.h.ctx, refundAuth(t), oneLager);

    const refunds = (await t.h.repos.sales.listRefundsOf(s1.id)).sort((a, b) => a.receiptNumber.localeCompare(b.receiptNumber));
    // The D-037 table, in commit order: the second refund is units 1..2, not a repeat of 0..1.
    expect(refunds.map((r) => r.lines[0]?.vatPence)).toEqual([-43, -42, -43]);
    const sum = (key: 'dealDiscountPence' | 'memberDiscountPence' | 'finalPence' | 'vatPence') => refunds.flatMap((r) => r.lines).reduce((a, l) => a + l[key], 0);
    expect([sum('dealDiscountPence'), sum('memberDiscountPence'), sum('finalPence'), sum('vatPence')]).toEqual([-450, -135, -765, -128]);
  });

  it('refunds two units at once after one (D-037) and several lines together', async () => {
    const t = await setupTill();
    const s1 = await saleS1(t);
    await commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: s1.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' });
    const { sale } = await commitRefund(t.h.ctx, refundAuth(t), {
      originalSaleId: s1.id,
      lines: [
        { lineIndex: 1, qty: 2, returnToStock: true },
        { lineIndex: 0, qty: 2, returnToStock: true },
      ],
      tenderType: 'card',
    });
    expect(sale.lines.map(({ refundOfLineIndex, qty, dealDiscountPence, memberDiscountPence, finalPence, vatPence }) => ({ refundOfLineIndex, qty, dealDiscountPence, memberDiscountPence, finalPence, vatPence }))).toEqual([
      { refundOfLineIndex: 0, qty: -2, dealDiscountPence: -300, memberDiscountPence: -90, finalPence: -510, vatPence: -85 },
      { refundOfLineIndex: 1, qty: -2, dealDiscountPence: 0, memberDiscountPence: -38, finalPence: -212, vatPence: 0 },
    ]);
    expect(sale).toMatchObject({ totalPence: -722, memberDiscountPence: -128, tenders: [{ type: 'card', amountPence: -722 }] });
  });

  it('pays the line value out without restoring a deposit applied on the original (D-038 example)', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, { type: 'wedding', name: 'Smith', date: '2026-10-26', notes: '' });
    await takeDeposit(t.h.ctx, t.staff, booking.id, 5000, [cash(5000)]);
    const bill = await sell(t.h.ctx, t.staff, basket([[t.c.wineBottle, 4]], { bookingId: booking.id }), [card(3000), cash(1500)]);
    const { sale } = await commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: bill.sale.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' });
    expect(sale.lines[0]).toMatchObject({ qty: -1, finalPence: -2295, vatPence: -383 });
    expect(sale).toMatchObject({ totalPence: -2295, tenders: [{ type: 'cash', amountPence: -2295 }], depositAppliedPence: 0 });
    expect(sale).not.toHaveProperty('bookingId');
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(0);
  });

  it('never wastes an untracked product and writes no movement for it (D-039)', async () => {
    const t = await setupTill();
    const { sale: original } = await sell(t.h.ctx, t.staff, basket([[t.c.raffle, 2]]), [cash(200)]);
    const lookup = await findSaleForRefund(t.h.ctx, original.receiptNumber);
    if (lookup.status !== 'found') throw new Error('expected found');
    expect(lookup.lines[0]?.stockTracked).toBe(false);
    const { sale } = await commitRefund(t.h.ctx, refundAuth(t), { originalSaleId: original.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: false }], tenderType: 'cash' });
    expect(sale.lines[0]?.returnToStock).toBe(true);
    expect(await t.h.repos.stockMovements.listBySale(sale.id)).toEqual([]);
  });

  it('needs the refund authorisation, records the manager override, and needs an open period', async () => {
    const t = await setupTill();
    const s1 = await saleS1(t);
    const request = { originalSaleId: s1.id, lines: [{ lineIndex: 1, qty: 1, returnToStock: true }], tenderType: 'cash' as const };
    await expectAppError(commitRefund(t.h.ctx, auth(t.supervisor, 'voidLine'), request), 'PERMISSION_DENIED');
    await expectAppError(commitRefund(t.h.ctx, refundAuth(t), { ...request, lines: [] }), 'VALIDATION', 'Choose at least one item to refund');
    await expectAppError(commitRefund(t.h.ctx, refundAuth(t), { ...request, originalSaleId: 'missing' }), 'NOT_FOUND');

    const approval = await approveOverride(t.h.ctx, t.supervisor, 'refund', PINS.manager);
    if (approval === null) throw new Error('expected approval');
    const { sale } = await commitRefund(t.h.ctx, approval, request);
    expect(sale.staffId).toBe(t.supervisor.staffId);
    const events = (await t.h.repos.auditEvents.list()).map((e) => [e.type, e.staffId, e.approvedById]);
    expect(events).toEqual([
      ['override', t.supervisor.staffId, t.manager.staffId],
      ['refund', t.supervisor.staffId, t.manager.staffId],
    ]);

    const closed = await setupTill({ floatPence: null });
    await expectAppError(commitRefund(closed.h.ctx, auth(closed.manager, 'refund'), request), 'NO_OPEN_PERIOD');
  });
});

describe('stock control (D-080..D-082)', () => {
  it('records goods in without an audit event and without needing an open period', async () => {
    const t = await setupTill({ floatPence: null });
    const auditBefore = await t.h.repos.auditEvents.list();
    const movement = await recordGoodsIn(t.h.ctx, auth(t.manager, 'stockControl'), { productId: t.c.bitter.id, qty: 24, note: ' Delivery ' });
    expect(movement).toMatchObject({ productId: t.c.bitter.id, qty: 24, reason: 'goodsIn', staffId: t.manager.staffId, note: 'Delivery' });
    expect(await t.h.repos.stockMovements.onHand(t.c.bitter.id)).toBe(72);
    expect(await t.h.repos.auditEvents.list()).toEqual(auditBefore);
  });

  it('validates goods in: quantity, product and authorisation', async () => {
    const t = await setupTill();
    const stock = auth(t.manager, 'stockControl');
    await expectAppError(recordGoodsIn(t.h.ctx, stock, { productId: t.c.bitter.id, qty: 0, note: '' }), 'VALIDATION', 'Quantity must be 1 to 9999');
    await expectAppError(recordGoodsIn(t.h.ctx, stock, { productId: t.c.bitter.id, qty: 10_000, note: '' }), 'VALIDATION');
    await expectAppError(recordGoodsIn(t.h.ctx, stock, { productId: t.c.raffle.id, qty: 1, note: '' }), 'VALIDATION', 'Choose a stock-tracked product');
    await expectAppError(recordGoodsIn(t.h.ctx, stock, { productId: 'missing', qty: 1, note: '' }), 'VALIDATION');
    await expectAppError(recordGoodsIn(t.h.ctx, auth(t.manager, 'editCatalogue'), { productId: t.c.bitter.id, qty: 1, note: '' }), 'PERMISSION_DENIED');
  });

  it('records a signed adjustment and a manual waste with a stockAdjust audit event (D-081 example)', async () => {
    const t = await setupTill();
    const period = await t.h.repos.periods.getOpen();
    const stock = auth(t.manager, 'stockControl');
    const adjustment = await recordStockAdjustment(t.h.ctx, stock, { productId: t.c.lager.id, kind: 'adjustment', qty: -3, note: 'Recount' });
    const waste = await recordStockAdjustment(t.h.ctx, stock, { productId: t.c.bitter.id, kind: 'waste', qty: 2, note: 'Spilt' });
    expect(adjustment).toMatchObject({ qty: -3, reason: 'adjustment', note: 'Recount' });
    expect(waste).toMatchObject({ qty: -2, reason: 'waste', note: 'Spilt' });
    expect(await t.h.repos.stockMovements.onHand(t.c.bitter.id)).toBe(46);
    const events = await t.h.repos.auditEvents.listByType('stockAdjust');
    expect(events.map((e) => ({ staffId: e.staffId, periodId: e.periodId, detail: e.detail }))).toEqual([
      { staffId: t.manager.staffId, periodId: period?.id, detail: { stockMovementId: adjustment.id, productId: t.c.lager.id, productName: 'Lager', qty: -3, reason: 'adjustment', note: 'Recount' } },
      { staffId: t.manager.staffId, periodId: period?.id, detail: { stockMovementId: waste.id, productId: t.c.bitter.id, productName: 'Bitter', qty: -2, reason: 'waste', note: 'Spilt' } },
    ]);
    await expectAppError(recordStockAdjustment(t.h.ctx, stock, { productId: t.c.lager.id, kind: 'adjustment', qty: 0, note: 'x' }), 'VALIDATION');
    await expectAppError(recordStockAdjustment(t.h.ctx, stock, { productId: t.c.lager.id, kind: 'waste', qty: -1, note: 'x' }), 'VALIDATION');
    await expectAppError(recordStockAdjustment(t.h.ctx, stock, { productId: t.c.lager.id, kind: 'adjustment', qty: 1, note: '  ' }), 'VALIDATION', 'Enter a reason');
  });

  it('omits periodId on a stock adjustment made with no open period', async () => {
    const t = await setupTill({ floatPence: null });
    await recordStockAdjustment(t.h.ctx, auth(t.manager, 'stockControl'), { productId: t.c.lager.id, kind: 'adjustment', qty: 5, note: 'Found' });
    const [event] = await t.h.repos.auditEvents.listByType('stockAdjust');
    expect(event).not.toHaveProperty('periodId');
  });

  it('lists stock levels and the low-stock list, which includes negative stock first (D-082)', async () => {
    const t = await setupTill();
    expect((await listStockLevels(t.h.ctx)).map((l) => [l.product.name, l.onHand])).toEqual([
      ['Lager', 48],
      ['Bitter', 48],
      ['Crisps', 36],
      ['Wine', 12],
    ]);
    expect(await listLowStock(t.h.ctx)).toEqual([]);

    // Selling is never blocked by stock: Bitter goes negative.
    await sell(t.h.ctx, t.staff, basket([[t.c.bitter, 50]]), [card(null)]);
    await sell(t.h.ctx, t.staff, basket([[t.c.wineBottle, 10]]), [card(null)]);
    await setProductActive(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.crisps.id, false);
    await sell(t.h.ctx, t.staff, basket([[t.c.crisps, 30]]), [card(null)]);

    expect((await listLowStock(t.h.ctx)).map((l) => [l.product.name, l.onHand])).toEqual([
      ['Bitter', -2],
      ['Wine', 2],
    ]);
    // Inactive tracked products still show on the stock list.
    expect((await listStockLevels(t.h.ctx)).map((l) => [l.product.name, l.onHand])).toEqual([
      ['Lager', 48],
      ['Bitter', -2],
      ['Crisps', 6],
      ['Wine', 2],
    ]);
    await saveProduct(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.lager.id, { ...t.c.lager, stockTracked: false });
    expect((await listStockLevels(t.h.ctx)).map((l) => l.product.name)).toEqual(['Bitter', 'Crisps', 'Wine']);
  });

  it('shows a product’s stock history newest first', async () => {
    const t = await setupTill();
    t.h.clock.advance(1000);
    await sell(t.h.ctx, t.staff, basket([[t.c.lager, 2]]), [card(null)]);
    t.h.clock.advance(1000);
    await recordGoodsIn(t.h.ctx, auth(t.manager, 'stockControl'), { productId: t.c.lager.id, qty: 6, note: '' });
    expect((await stockHistory(t.h.ctx, t.c.lager.id)).map((m) => [m.reason, m.qty])).toEqual([
      ['goodsIn', 6],
      ['sale', -2],
      ['goodsIn', 48],
    ]);
  });
});
