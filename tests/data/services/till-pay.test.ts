/**
 * Till and Pay: catalogue, basket pricing, void, no sale, the Pay freeze, tenders and the sale
 * commit (spec §6.3, §6.4, §7, §8; D-008..D-011, D-029..D-034, D-043, D-056, D-079, D-085, D-086).
 */
import { describe, expect, it } from 'vitest';
import { saveDeal, saveProduct, setProductActive, deleteCategory, saveCategory } from '../../../src/services/catalogue';
import { saveDraft } from '../../../src/services/draft';
import { approveOverride } from '../../../src/services/override';
import { completePayment, openSalePayment, takeTender } from '../../../src/services/pay';
import { openPeriod } from '../../../src/services/periods';
import { fallbackDocument } from '../../../src/services/shared';
import { escapeHtml, RECEIPT_CSP } from '../../../src/receipt';
import { loadTillCatalogue, recordNoSale, resolvePricingLines, viewBasket, voidLine } from '../../../src/services/till';
import {
  auth,
  basket,
  card,
  cash,
  expectAppError,
  failingContext,
  outboxSince,
  PINS,
  registerCleanup,
  sell,
  setupTill,
  tenderAll,
} from './harness';

registerCleanup();

describe('till catalogue and pricing view (D-008, D-009, D-011)', () => {
  it('lists non-deleted categories and active products in sort order', async () => {
    const t = await setupTill();
    const manager = auth(t.manager, 'editCatalogue');
    await setProductActive(t.h.ctx, manager, t.c.bitter.id, false);
    const spare = await saveCategory(t.h.ctx, manager, null, { name: 'Spare', sortOrder: 0, colour: '#000000' });
    await deleteCategory(t.h.ctx, auth(t.manager, 'editCatalogue'), spare.id);

    const catalogue = await loadTillCatalogue(t.h.ctx);
    expect(catalogue.categories.map((c) => c.name)).toEqual(['Draught', 'Snacks', 'Wine', 'Events']);
    expect(catalogue.products.map((p) => p.name)).toEqual(['Crisps', 'Lager', 'Raffle Ticket', 'Wine']);
  });

  it('resolves lines from the current product records, keeping inactive products and dropping missing ones', async () => {
    const t = await setupTill();
    await setProductActive(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.bitter.id, false);
    const lines = await resolvePricingLines(t.h.ctx, [
      { productId: t.c.bitter.id, qty: 2 },
      { productId: 'missing-product', qty: 1 },
      { productId: t.c.crisps.id, qty: 1 },
    ]);
    expect(lines).toEqual([
      { productId: t.c.bitter.id, name: 'Bitter', qty: 2, unitPricePence: 420, vatRate: 20, memberDiscountEligible: true },
      { productId: t.c.crisps.id, name: 'Crisps', qty: 1, unitPricePence: 125, vatRate: 0, memberDiscountEligible: true },
    ]);
  });

  it('prices the D-020 member basket with the deal, member discount and VAT per line', async () => {
    const t = await setupTill();
    const view = await viewBasket(t.h.ctx, basket([[t.c.lager, 3], [t.c.crisps, 2]], { memberId: t.c.member.id }));
    expect(view.member?.memberNumber).toBe('1042');
    expect(view.priced.lines.map(({ grossPence, dealDiscountPence, memberDiscountPence, finalPence, vatPence, netPence }) => ({
      grossPence,
      dealDiscountPence,
      memberDiscountPence,
      finalPence,
      vatPence,
      netPence,
    }))).toEqual([
      { grossPence: 1350, dealDiscountPence: 450, memberDiscountPence: 135, finalPence: 765, vatPence: 128, netPence: 637 },
      { grossPence: 250, dealDiscountPence: 0, memberDiscountPence: 38, finalPence: 212, vatPence: 0, netPence: 212 },
    ]);
    expect(view.priced.dealLines).toEqual([{ dealId: t.c.lagerDeal.id, name: 'Lager 3 for 2', groupCount: 1, savingPence: 450 }]);
    expect(view.priced.memberDiscountPence).toBe(173);
    expect(view.priced.totalPence).toBe(977);

    const noMember = await viewBasket(t.h.ctx, basket([[t.c.lager, 3], [t.c.crisps, 2]]));
    expect(noMember.member).toBeUndefined();
    expect(noMember.priced.totalPence).toBe(1150);
  });

  it('reprices an open basket after a price edit (D-009) and uses the current member percent (D-019)', async () => {
    const t = await setupTill();
    const b = basket([[t.c.bitter, 2]], { memberId: t.c.member.id });
    expect((await viewBasket(t.h.ctx, b)).priced.totalPence).toBe(714); // 840 - 126 (15%)
    await saveProduct(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.bitter.id, { ...t.c.bitter, pricePence: 440 });
    await t.h.repos.settings.update({ memberDiscountPercent: 10 });
    expect((await viewBasket(t.h.ctx, b)).priced.totalPence).toBe(792); // 880 - 88
  });
});

describe('void and no sale (D-043, D-085, D-086)', () => {
  it('writes one void event per void and returns the reduced basket', async () => {
    const t = await setupTill();
    const period = await t.h.repos.periods.getOpen();
    const b = basket([[t.c.lager, 3], [t.c.crisps, 1]]);
    const after = await voidLine(t.h.ctx, auth(t.supervisor, 'voidLine'), b, t.c.lager.id, 2);
    expect(after.lines).toEqual([
      { productId: t.c.lager.id, qty: 1 },
      { productId: t.c.crisps.id, qty: 1 },
    ]);
    expect(b.lines[0]?.qty).toBe(3);
    const removed = await voidLine(t.h.ctx, auth(t.supervisor, 'voidLine'), after, t.c.crisps.id, 1);
    expect(removed.lines).toEqual([{ productId: t.c.lager.id, qty: 1 }]);

    const voids = await t.h.repos.auditEvents.listByType('void');
    expect(voids.map((e) => ({ staffId: e.staffId, approvedById: e.approvedById, periodId: e.periodId, detail: e.detail }))).toEqual([
      { staffId: t.supervisor.staffId, approvedById: undefined, periodId: period?.id, detail: { productId: t.c.lager.id, productName: 'Lager', qty: 2, unitPricePence: 450 } },
      { staffId: t.supervisor.staffId, approvedById: undefined, periodId: period?.id, detail: { productId: t.c.crisps.id, productName: 'Crisps', qty: 1, unitPricePence: 125 } },
    ]);
    expect(voids[0]).not.toHaveProperty('approvedById');
    expect(await t.h.repos.auditEvents.listByType('override')).toEqual([]);
  });

  it('records the tab on voids of a loaded tab line', async () => {
    const t = await setupTill();
    await voidLine(t.h.ctx, auth(t.manager, 'voidLine'), basket([[t.c.lager, 2]], { tabId: 'tab-1' }), t.c.lager.id, 1);
    const [event] = await t.h.repos.auditEvents.listByType('void');
    expect(event?.detail).toEqual({ productId: t.c.lager.id, productName: 'Lager', qty: 1, unitPricePence: 450, tabId: 'tab-1' });
  });

  it('rejects a bad quantity, an unknown line, a wrong authorisation or no open period, writing nothing', async () => {
    const t = await setupTill({ floatPence: null });
    const b = basket([[t.c.lager, 2]]);
    const supervisor = auth(t.supervisor, 'voidLine');
    await expectAppError(voidLine(t.h.ctx, supervisor, b, t.c.lager.id, 1), 'NO_OPEN_PERIOD', 'No trading period open');
    await expectAppError(recordNoSale(t.h.ctx, auth(t.supervisor, 'noSale')), 'NO_OPEN_PERIOD');
    await openPeriod(t.h.ctx, auth(t.manager, 'openClosePeriod'), 0);
    await expectAppError(voidLine(t.h.ctx, supervisor, b, t.c.lager.id, 3), 'VALIDATION', 'Choose 1 to 2 to void');
    await expectAppError(voidLine(t.h.ctx, supervisor, b, t.c.lager.id, 0), 'VALIDATION');
    await expectAppError(voidLine(t.h.ctx, supervisor, b, t.c.crisps.id, 1), 'NOT_FOUND');
    await expectAppError(voidLine(t.h.ctx, auth(t.supervisor, 'noSale'), b, t.c.lager.id, 1), 'PERMISSION_DENIED');
    expect(await t.h.repos.auditEvents.list()).toEqual([]);
  });

  it('records a no sale, with the override when a staff member is approved by a supervisor', async () => {
    const t = await setupTill();
    const period = await t.h.repos.periods.getOpen();
    await recordNoSale(t.h.ctx, auth(t.manager, 'noSale'));
    const approval = await approveOverride(t.h.ctx, t.staff, 'noSale', PINS.supervisor);
    if (approval === null) throw new Error('expected approval');
    await recordNoSale(t.h.ctx, approval);
    const events = (await t.h.repos.auditEvents.list()).map(({ type, staffId, approvedById, periodId, detail }) => ({ type, staffId, approvedById, periodId, detail }));
    expect(events).toEqual([
      { type: 'noSale', staffId: t.manager.staffId, approvedById: undefined, periodId: period?.id, detail: {} },
      { type: 'override', staffId: t.staff.staffId, approvedById: t.supervisor.staffId, periodId: period?.id, detail: { action: 'noSale' } },
      { type: 'noSale', staffId: t.staff.staffId, approvedById: t.supervisor.staffId, periodId: period?.id, detail: {} },
    ]);
    // No receipt number is consumed (D-060).
    expect((await t.h.repos.settings.get())?.receiptCounter).toBe(0);
  });
});

describe('Pay (D-011, D-029..D-034)', () => {
  it('needs an open period and at least one line', async () => {
    const t = await setupTill({ floatPence: null });
    await expectAppError(openSalePayment(t.h.ctx, basket([[t.c.lager, 1]])), 'NO_OPEN_PERIOD');
    await openPeriod(t.h.ctx, auth(t.manager, 'openClosePeriod'), 0);
    await expectAppError(openSalePayment(t.h.ctx, basket([], { memberId: t.c.member.id })), 'VALIDATION', 'The basket is empty');
  });

  it('applies the tender rules: card capped at the balance, split tenders, change only from cash', async () => {
    const t = await setupTill();
    const session = await openSalePayment(t.h.ctx, basket([[t.c.lager, 3], [t.c.crisps, 2]], { memberId: t.c.member.id }));
    expect(session.tender).toEqual({ totalPence: 977, tenders: [], remainingPence: 977, complete: false, changePence: 0 });

    const rejected = takeTender(session, card(1000));
    expect(rejected).toEqual({ ok: false, reason: 'cardExceedsBalance', message: "Card can't be more than the balance (£9.77)" });
    expect(takeTender(session, cash(0))).toMatchObject({ ok: false, reason: 'amountTooSmall' });

    const partial = tenderAll(session, [card(500)]);
    expect(partial.tender.remainingPence).toBe(477);
    expect(session.tender.tenders).toEqual([]);
    const done = tenderAll(partial, [cash(1000)]);
    expect(done.tender).toEqual({ totalPence: 977, tenders: [{ type: 'card', amountPence: 500 }, { type: 'cash', amountPence: 1000 }], remainingPence: 0, complete: true, changePence: 523 });
    expect(takeTender(done, cash(100))).toMatchObject({ ok: false, reason: 'nothingDue' });
  });

  it('commits the sale: receipt number, snapshot lines, deal lines, member, stock movements, draft cleared', async () => {
    const t = await setupTill();
    const b = basket([[t.c.lager, 3], [t.c.crisps, 2], [t.c.raffle, 1]], { memberId: t.c.member.id });
    await saveDraft(t.h.ctx, b);
    const outboxBefore = await t.h.repos.outbox.count();
    const lagerStock = await t.h.repos.stockMovements.onHand(t.c.lager.id);

    const { sale, document } = await sell(t.h.ctx, t.staff, b, [cash(2000)]);

    expect(sale).toMatchObject({
      receiptNumber: '3F9C-000001',
      kind: 'sale',
      staffId: t.staff.staffId,
      memberId: t.c.member.id,
      memberDiscountPence: 173,
      depositAppliedPence: 0,
      totalPence: 1077,
      tenders: [{ type: 'cash', amountPence: 2000 }],
      changePence: 923,
      dealLines: [{ dealId: t.c.lagerDeal.id, name: 'Lager 3 for 2', groupCount: 1, savingPence: 450 }],
    });
    expect(sale).not.toHaveProperty('bookingId');
    expect(sale).not.toHaveProperty('tabId');
    expect(sale.lines).toEqual([
      { productId: t.c.lager.id, nameAtSale: 'Lager', qty: 3, unitPricePence: 450, vatRate: 20, dealDiscountPence: 450, memberDiscountPence: 135, finalPence: 765, vatPence: 128 },
      { productId: t.c.crisps.id, nameAtSale: 'Crisps', qty: 2, unitPricePence: 125, vatRate: 0, dealDiscountPence: 0, memberDiscountPence: 38, finalPence: 212, vatPence: 0 },
      { productId: t.c.raffle.id, nameAtSale: 'Raffle Ticket', qty: 1, unitPricePence: 100, vatRate: 0, dealDiscountPence: 0, memberDiscountPence: 0, finalPence: 100, vatPence: 0 },
    ]);
    expect(await t.h.repos.sales.get(sale.id)).toEqual(sale);
    expect(sale.periodId).toBe((await t.h.repos.periods.getOpen())?.id);

    // Tracked lines only (D-079); the raffle ticket is untracked.
    const movements = await t.h.repos.stockMovements.listBySale(sale.id);
    expect(movements.map(({ productId, qty, reason, staffId, note }) => ({ productId, qty, reason, staffId, note }))).toEqual([
      { productId: t.c.lager.id, qty: -3, reason: 'sale', staffId: t.staff.staffId, note: '' },
      { productId: t.c.crisps.id, qty: -2, reason: 'sale', staffId: t.staff.staffId, note: '' },
    ]);
    expect(await t.h.repos.stockMovements.onHand(t.c.lager.id)).toBe(lagerStock - 3);
    expect(await t.h.repos.draft.get()).toBeUndefined();
    expect((await t.h.repos.settings.get())?.receiptCounter).toBe(1);
    expect(await outboxSince(t.h.repos, outboxBefore)).toEqual([
      { entity: 'sales', operation: 'create' },
      { entity: 'stockMovements', operation: 'create' },
      { entity: 'stockMovements', operation: 'create' },
      { entity: 'settings', operation: 'update' },
    ]);

    expect(document).toContain('<title>Receipt 3F9C-000001</title>');
    expect(document).toContain('Member discount (#1042)');
    expect(document).toContain('£10.77');
  });

  it('numbers receipts sequentially per device', async () => {
    const t = await setupTill();
    const first = await sell(t.h.ctx, t.staff, basket([[t.c.bitter, 1]]), [card(null)]);
    const second = await sell(t.h.ctx, t.staff, basket([[t.c.bitter, 1]]), [cash(420)]);
    expect([first.sale.receiptNumber, second.sale.receiptNumber]).toEqual(['3F9C-000001', '3F9C-000002']);
    expect(first.sale.tenders).toEqual([{ type: 'card', amountPence: 420 }]);
  });

  it('keeps the prices frozen at Pay open: a later price edit does not change the sale (D-011)', async () => {
    const t = await setupTill();
    const session = tenderAll(await openSalePayment(t.h.ctx, basket([[t.c.bitter, 2]])), [cash(1000)]);
    await saveProduct(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.bitter.id, { ...t.c.bitter, pricePence: 440 });
    const { sale } = await completePayment(t.h.ctx, auth(t.staff, 'sell'), session);
    expect(sale.lines[0]).toMatchObject({ unitPricePence: 420, finalPence: 840 });
    expect(sale.changePence).toBe(160);
  });

  it('keeps a deal that ends while Pay is open (D-011 example)', async () => {
    const t = await setupTill();
    await saveDeal(t.h.ctx, auth(t.manager, 'editCatalogue'), null, {
      name: 'Bitter 2 for £8',
      type: 'nForPrice',
      n: 2,
      pricePence: 800,
      productIds: [t.c.bitter.id],
      active: true,
      endDate: '2026-09-26',
    });
    const b = basket([[t.c.bitter, 2]]);
    t.h.clock.set('2026-09-26T22:59:30.000Z');
    const session = await openSalePayment(t.h.ctx, b);
    expect(session.priced.totalPence).toBe(800);
    t.h.clock.set('2026-09-26T23:00:10.000Z');
    expect((await viewBasket(t.h.ctx, b)).priced.totalPence).toBe(840);
    const { sale } = await completePayment(t.h.ctx, auth(t.staff, 'sell'), tenderAll(session, [card(null)]));
    expect(sale.totalPence).toBe(800);
    expect(sale.dealLines).toEqual([expect.objectContaining({ name: 'Bitter 2 for £8', savingPence: 40 })]);
    expect(sale.createdAt).toBe('2026-09-26T23:00:10.000Z');
  });

  it('writes stock movements from the CURRENT stockTracked flag at commit (D-079)', async () => {
    const t = await setupTill();
    const session = tenderAll(await openSalePayment(t.h.ctx, basket([[t.c.lager, 1], [t.c.bitter, 1]])), [cash(870)]);
    await saveProduct(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.lager.id, { ...t.c.lager, stockTracked: false });
    const { sale } = await completePayment(t.h.ctx, auth(t.staff, 'sell'), session);
    expect((await t.h.repos.stockMovements.listBySale(sale.id)).map((m) => m.productId)).toEqual([t.c.bitter.id]);
  });

  it('refuses an incomplete payment or the wrong authorisation, writing nothing', async () => {
    const t = await setupTill();
    const session = await openSalePayment(t.h.ctx, basket([[t.c.lager, 1]]));
    await expectAppError(completePayment(t.h.ctx, auth(t.staff, 'sell'), tenderAll(session, [cash(100)])), 'VALIDATION');
    await expectAppError(completePayment(t.h.ctx, auth(t.staff, 'tabs'), tenderAll(session, [cash(450)])), 'PERMISSION_DENIED');
    expect(await t.h.repos.sales.list()).toEqual([]);
  });

  it('leaves nothing behind when the commit fails, so the basket and draft survive (spec §8, D-034)', async () => {
    const t = await setupTill();
    const b = basket([[t.c.lager, 2]]);
    await saveDraft(t.h.ctx, b);
    const before = await t.h.repos.exportAll();
    const draftBefore = await t.h.repos.draft.get();

    const failing = await failingContext(t.h);
    const session = tenderAll(await openSalePayment(failing, b), [cash(900)]);
    await expectAppError(completePayment(failing, auth(t.staff, 'sell'), session), 'FORCED_FAILURE');

    expect(await t.h.repos.exportAll()).toEqual(before);
    expect(await t.h.repos.draft.get()).toEqual(draftBefore);
    // "Try again" with a healthy store commits the same frozen session exactly once.
    const { sale } = await completePayment(t.h.ctx, auth(t.staff, 'sell'), session);
    expect(sale.receiptNumber).toBe('3F9C-000001');
    expect(await t.h.repos.sales.list()).toHaveLength(1);
  });

  it('returns a fallback receipt instead of throwing when printing fails after the commit (D-123)', async () => {
    const t = await setupTill();
    const broken = { ...t.h.ctx, repos: { ...t.h.repos, staff: { ...t.h.repos.staff, get: () => Promise.reject(new Error('staff table unreadable')) } } };
    const session = tenderAll(await openSalePayment(broken, basket([[t.c.lager, 1]])), [cash(500)]);
    const { sale, document } = await completePayment(broken, auth(t.staff, 'sell'), session);
    expect(sale.receiptNumber).toBe('3F9C-000001');
    expect(document).toContain('<title>Receipt 3F9C-000001</title>');
    expect(document).toContain('Receipt 3F9C-000001 was saved, but the receipt could not be printed.');
    expect(document).toContain('staff table unreadable');
    expect(await t.h.repos.sales.list()).toHaveLength(1);
  });

  it('the fallback document uses the receipt CSP and escaping (D-110, D-123)', () => {
    const html = fallbackDocument('Receipt <1>', 'a & b', `it's "broken"`);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${RECEIPT_CSP}">`);
    expect(html).toContain(`<title>${escapeHtml('Receipt <1>')}</title>`);
    expect(html).toContain('<p>a &amp; b</p>');
    expect(html).toContain('<p>it&#39;s &quot;broken&quot;</p>');
    expect(html).not.toContain('<1>');
  });

  it('rejects a stale tab or booking at Pay open', async () => {
    const t = await setupTill();
    await expectAppError(openSalePayment(t.h.ctx, basket([[t.c.lager, 1]], { tabId: 'no-such-tab' })), 'TAB_NOT_OPEN');
    await expectAppError(openSalePayment(t.h.ctx, basket([[t.c.lager, 1]], { bookingId: 'no-such-booking' })), 'BOOKING_NOT_OPEN');
    await expectAppError(openSalePayment(t.h.ctx, basket([[t.c.lager, 1]], { memberId: 'no-such-member' })), 'NOT_FOUND');
    await expectAppError(openSalePayment(t.h.ctx, { lines: [{ productId: 'gone', qty: 1 }] }), 'NOT_FOUND');
  });
});
