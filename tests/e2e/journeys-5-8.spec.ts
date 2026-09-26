/**
 * Spec §10.3 end-to-end journeys 5–8, run in both Playwright projects (tablet landscape 1280×800
 * and phone portrait 390×844):
 *
 *   5. Staff user tries to void -> supervisor PIN override -> audit event exists
 *   6. Manager refund with return-to-stock -> stock level restored
 *   7. X read -> Z close with a declared-cash variance -> Z report figures match the sales made
 *   8. Refresh mid-basket -> basket restored after login
 *
 * Every expected figure is worked out by hand in the comments from the sample data (D-097,
 * D-098, D-100) and the pricing rules (spec §7; D-014..D-023, D-029, D-037, D-041). The tests only
 * drive the UI and read IndexedDB; they never write to it.
 */
import { expect, test, type Page } from '@playwright/test';
import type { AuditEvent, Draft, Period, Sale } from '../../src/data/types';
import {
  MANAGER,
  STAFF,
  SUPERVISOR,
  approveOverride,
  enterMoney,
  enterPin,
  expectMoney,
  expectNoHorizontalScroll,
  lock,
  login,
  loginKeypad,
  navigate,
  readAuditEvents,
  readStore,
  waitForDocument,
} from './helpers';
import {
  addProduct,
  attachMember,
  basketLineText,
  basketLines,
  button,
  closeBasket,
  devicePrefix,
  dialog,
  docRow,
  enterTenderAmount,
  expectDocCount,
  expectDocMoney,
  expectHeading,
  expectStockOnHand,
  expectTillTotal,
  expectVatTable,
  finalTender,
  movementsOf,
  newSaleAfterChange,
  openBasket,
  openPay,
  openStockScreen,
  productByName,
  receiptNumber,
  saleByReceipt,
  setUpTrading,
  staffIdByName,
  type VatRow,
} from './helpers-journeys-b';

async function openPeriodId(page: Page): Promise<string> {
  const open = (await readStore<Period>(page, 'periods')).find((p) => p.closedAt === undefined);
  if (open === undefined) throw new Error('no open period');
  return open.id;
}

// ---------------------------------------------------------------------------
// Journey 5: staff void -> supervisor PIN override -> audit events (spec §5, §6.3; D-071, D-072,
// D-085, D-116)
// ---------------------------------------------------------------------------

test('journey 5: a staff void needs a supervisor PIN; one override and one void event record both people', async ({ page, context }) => {
  await setUpTrading(page);
  const periodId = await openPeriodId(page);
  await lock(page);
  await login(page, STAFF.pin);
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);

  // 3 × Club Bitter @ £4.20 = 1260, then 1 × Cola @ £2.50 = 250 -> 1510.
  await addProduct(page, 'Draught', 'Club Bitter', 3);
  await addProduct(page, 'Soft Drinks', 'Cola');
  await expectTillTotal(page, 1510);

  // Void is visible and enabled for staff (D-070). Choose 2 of the 3 Club Bitters.
  await expect(button(page, 'Void')).toBeEnabled();
  await button(page, 'Void').click();
  const voidDialog = dialog(page, 'Void item');
  await expect(voidDialog).toBeVisible();
  await voidDialog.getByRole('radio', { name: /3 × Club Bitter/ }).check();
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('3');
  await button(voidDialog, 'Void fewer').click();
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('2');
  await expectNoHorizontalScroll(page);

  // First try: the override dialog asks for a supervisor or manager PIN; Cancel aborts the action.
  await button(voidDialog, 'Confirm void').click();
  const override = page.getByTestId('override-dialog');
  await expect(dialog(page, 'Supervisor or manager PIN')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await button(override, 'Cancel').click();
  await expect(override).toBeHidden();
  await expect(voidDialog).toBeVisible();
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('2');
  // Nothing changed and nothing was written.
  expect(await readAuditEvents(page)).toEqual([]);

  // Second try: a staff PIN is not enough (D-071); the supervisor's PIN approves this one void.
  await button(voidDialog, 'Confirm void').click();
  await expect(override).toBeVisible();
  await enterPin(override, STAFF.pin);
  await expect(override.getByText('PIN not accepted')).toBeVisible();
  await approveOverride(page, SUPERVISOR.pin);
  await expect(voidDialog).toBeHidden();

  // 1 × Club Bitter (420) + 1 × Cola (250) = 670.
  await expectTillTotal(page, 670);
  const basket = await openBasket(page);
  await expect(basketLines(basket)).toHaveText([basketLineText(1, 'Club Bitter', 420), basketLineText(1, 'Cola', 250)]);
  await closeBasket(page);
  // The session is still Sam's: the approval covered that one action only (D-071).
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);

  // The audit trail (D-072, D-084, D-116): exactly one override and one void, both naming Sam as
  // the requester and Sue as the approver, in the open period.
  const sam = await staffIdByName(page, STAFF.name);
  const sue = await staffIdByName(page, SUPERVISOR.name);
  const bitter = await productByName(page, 'Club Bitter');
  await expect.poll(async () => (await readAuditEvents(page)).length).toBe(2);
  let events = await readAuditEvents(page);
  expect(events.filter((e) => e.type === 'override')).toEqual([
    expect.objectContaining({ type: 'override', staffId: sam, approvedById: sue, periodId, detail: { action: 'voidLine' } }),
  ]);
  expect(events.filter((e) => e.type === 'void')).toEqual([
    expect.objectContaining({
      type: 'void',
      staffId: sam,
      approvedById: sue,
      periodId,
      detail: { productId: bitter.id, productName: 'Club Bitter', qty: 2, unitPricePence: 420 },
    }),
  ]);

  // D-116: the X read counts the one void. Sue can X read directly (no override, nothing written).
  await lock(page);
  await login(page, SUPERVISOR.pin);
  await navigate(page, 'Period');
  await expectHeading(page, 'Period');
  const xRead = await waitForDocument(context, () => button(page, 'X read').click());
  await expect(xRead).toHaveTitle('X read');
  await expectDocCount(xRead, 'Voids', 1);
  await expectDocCount(xRead, 'No sales', 0);
  // Nothing has been sold yet: a void is not a sale and moves no money (D-043).
  await expectDocMoney(xRead, 'Gross sales', 0);
  await expectDocMoney(xRead, 'Net takings', 0);
  await xRead.close();

  events = await readAuditEvents(page);
  expect(events.map((e: AuditEvent) => e.type).sort()).toEqual(['override', 'void']);
});

// ---------------------------------------------------------------------------
// Journey 6: manager refund with return to stock -> stock level restored (spec §6.8, §6.9;
// D-035..D-039, D-079, D-082)
// ---------------------------------------------------------------------------

test('journey 6: a manager refunds to stock and the Stock screen shows the level restored', async ({ page, context }) => {
  await setUpTrading(page);

  // Before the sale: Fairway Lager's opening stock is 88 (D-097).
  await openStockScreen(page);
  await expectStockOnHand(page, 'Fairway Lager', 88);
  await expectNoHorizontalScroll(page);

  // The sale: 3 × Fairway Lager @ £4.80 = 1440 (tracked) + 1 × Cola @ £2.50 = 250 (not tracked).
  // No deals or member: total 1690, all on the card (the keypad is empty, so Card takes the balance).
  await navigate(page, 'Till');
  await addProduct(page, 'Draught', 'Fairway Lager', 3);
  await addProduct(page, 'Soft Drinks', 'Cola');
  await expectTillTotal(page, 1690);
  await openPay(page, 1690);
  const receipt = await finalTender(page, context, 'Card');
  const prefix = await devicePrefix(page);
  const saleNumber = receiptNumber(prefix, 1);
  await expect(receipt).toHaveTitle(`Receipt ${saleNumber}`);
  await expectDocMoney(receipt, 'TOTAL', 1690);
  await expectDocMoney(receipt, 'Card', 1690);
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);

  // After the sale: 88 - 3 = 85 (D-079).
  await openStockScreen(page);
  await expectStockOnHand(page, 'Fairway Lager', 85);

  // The refund, as the manager (no override): all 3 Lagers, to stock (the default), by cash (the default).
  await navigate(page, 'Refunds');
  await expectHeading(page, 'Refunds');
  await page.getByLabel('Receipt number').fill(saleNumber);
  await button(page, 'Find sale').click();
  const found = page.getByTestId('refund-sale');
  await expect(found.getByRole('heading', { name: saleNumber })).toBeVisible();
  await expectMoney(page.getByTestId('refund-sale-total'), 1690);
  // Cola is not stock-tracked, so it has no stock choice (D-039).
  await expect(page.getByRole('group', { name: 'Stock for Cola' })).toHaveCount(0);
  const lagerStock = page.getByRole('group', { name: 'Stock for Fairway Lager' });
  await expect(lagerStock.getByRole('radio', { name: 'Return to stock' })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Refund by' }).getByRole('radio', { name: 'Cash' })).toBeChecked();
  for (let i = 0; i < 3; i += 1) await button(page, 'Increase Fairway Lager').click();
  await expect(button(page, 'Increase Fairway Lager')).toBeDisabled();
  // 3 × 480 with no discounts: refund 1440.
  await expectMoney(page.getByTestId('refund-total'), 1440);
  await expectNoHorizontalScroll(page);

  const refundDoc = await waitForDocument(context, () => button(page, 'Refund £14.40').click());
  const refundNumber = receiptNumber(prefix, 2);
  await expect(refundDoc).toHaveTitle(`Receipt ${refundNumber}`);
  await expect(refundDoc.locator('body')).toContainText('REFUND');
  await expect(refundDoc.locator('body')).toContainText(`Refund of ${saleNumber}`);
  await expectDocMoney(refundDoc, 'TOTAL', -1440);
  await expectDocMoney(refundDoc, 'Cash', -1440);
  // The line's VAT was 1440 × 20/120 = 240; all 3 of 3 units refunded -> -240, net -1200 (D-037).
  await expectVatTable(refundDoc, [{ rate: 20, netPence: -1200, vatPence: -240, grossPence: -1440 }]);
  await refundDoc.close();
  await expect(page.getByTestId('refund-complete')).toContainText('Give the customer £14.40 in cash.');

  // After the refund: 85 + 3 = 88, the level before the sale.
  await openStockScreen(page);
  await expectStockOnHand(page, 'Fairway Lager', 88);
  await expectNoHorizontalScroll(page);

  // The records behind the screen: +88 opening stock, -3 sale, +3 refund (D-039, D-079).
  const lager = await productByName(page, 'Fairway Lager');
  const sale = await saleByReceipt(page, saleNumber);
  const refund = await saleByReceipt(page, refundNumber);
  expect((await movementsOf(page, lager.id)).map((m) => ({ qty: m.qty, reason: m.reason, saleId: m.saleId }))).toEqual([
    { qty: 88, reason: 'goodsIn', saleId: undefined },
    { qty: -3, reason: 'sale', saleId: sale.id },
    { qty: 3, reason: 'refund', saleId: refund.id },
  ]);
  expect(refund).toMatchObject({ kind: 'refund', refundOfSaleId: sale.id, totalPence: -1440, tenders: [{ type: 'cash', amountPence: -1440 }], changePence: 0 });
  expect(refund.lines).toEqual([expect.objectContaining({ productId: lager.id, qty: -3, finalPence: -1440, vatPence: -240, returnToStock: true })]);

  // The manager refunded directly: a refund audit event and no override (D-070, D-072).
  const morgan = await staffIdByName(page, MANAGER.name);
  const events = await readAuditEvents(page);
  expect(events.filter((e) => e.type === 'override')).toEqual([]);
  const refundEvents = events.filter((e) => e.type === 'refund');
  expect(refundEvents).toEqual([
    expect.objectContaining({
      staffId: morgan,
      detail: expect.objectContaining({
        refundSaleId: refund.id,
        originalSaleId: sale.id,
        totalPence: -1440,
        tender: 'cash',
        lines: [{ productId: lager.id, qty: 3, returnToStock: true }],
      }),
    }),
  ]);
  expect(refundEvents[0]?.approvedById).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Journey 7: X read -> Z close with a declared-cash variance -> Z report matches the sales
// (spec §6.11, §7 cash-up formula; D-041, D-042, D-043, D-046, D-047, D-108)
// ---------------------------------------------------------------------------

/**
 * The period, worked out by hand. Float £100.00 (10000).
 *
 * S1 (Receipt 1) sale, member 1001 (15%): 2 × Birdie Pale Ale @ 450 + 1 × Fairway Lager @ 480.
 *    Birdie gross 900; "Any 2 bottles for £8" saves 900 - 800 = 100 -> post-deal 800.
 *    Lager gross 480, no deal -> post-deal 480.
 *    Member base 800 + 480 = 1280; 1280 × 15% = 192, spread 1280:  800 -> 120, 480 -> 72.
 *    Finals: Birdie 900 - 100 - 120 = 680 (VAT 680 × 20/120 = 113.33 -> 113);
 *            Lager 480 - 72 = 408 (VAT 68).  Total 1088.
 *    Paid £20 cash (2000): change 2000 - 1088 = 912.
 * S2 (Receipt 2) sale: 3 × Ready Salted Crisps @ 120 + 1 × Chocolate Bar @ 140 + 1 × Raffle Ticket
 *    @ 100 (0% VAT); a Cola was added and voided first (1 void).
 *    Crisps gross 360; "Snacks 3 for 2" frees 1 unit: saving 120 (40 each) -> final 240 (VAT 40).
 *    Chocolate 140 (VAT 140 × 20/120 = 23.33 -> 23). Raffle 100 at 0% (VAT 0).  Total 480.
 *    Paid by card: 480.
 * One no sale.
 * S3 (Receipt 3) deposit: £20.00 (2000) on "Seniors Society Day", cash (Exact), no change.
 * S4 (Receipt 4) sale with that booking: House Red (bottle) 1900 + House White (bottle) 1900.
 *    Each VAT 1900 × 20/120 = 316.67 -> 317. Finals 3800; deposit applied min(2000, 3800) = 2000;
 *    total 1800. Paid card £10.00 (1000) then £10 cash (1000): change 1000 + 1000 - 1800 = 200.
 * S5 (Receipt 5) refund of 1 Birdie Pale Ale from S1, by cash (D-037, 1 of 2 units):
 *    deal share 100 × 1/2 = 50, member share 120 × 1/2 = 60, final 450 - 50 - 60 = 340;
 *    VAT share 113 × 1/2 = 56.5 -> 57.  Refund -340, cash -340.
 */
const FLOAT = 10_000;
const DECLARED = 13_500;

const EXPECTED = (() => {
  // Gross sales = Σ qty × unit over sale lines (refunds excluded; deposits have no lines).
  const grossSales = 900 + 480 + (360 + 140 + 100) + (1900 + 1900); // 5780
  const dealDiscounts = 100 + 120; // 220
  const memberDiscounts = 192;
  const refunds = 340;
  const netTakings = grossSales - dealDiscounts - memberDiscounts - refunds; // 5028
  const depositsTaken = 2000;
  const depositsApplied = 2000;
  const cashTendered = 2000 + 2000 + 1000; // S1 £20, S3 deposit, S4 £10 = 5000
  const changeGiven = 912 + 200; // 1112
  const cashRefunded = 340;
  const cashTotal = cashTendered - changeGiven - cashRefunded; // 3548
  const cardTendered = 480 + 1000; // S2, S4 = 1480
  const cardRefunded = 0;
  const cardTotal = cardTendered - cardRefunded; // 1480
  // VAT by rate: sum of line figures (D-021); the refund line nets off.
  const vat20Gross = 680 + 408 + 240 + 140 + 1900 + 1900 - 340; // 4928
  const vat20Vat = 113 + 68 + 40 + 23 + 317 + 317 - 57; // 821
  const vatByRate: VatRow[] = [
    { rate: 20, grossPence: vat20Gross, vatPence: vat20Vat, netPence: vat20Gross - vat20Vat }, // net 4107
    { rate: 0, grossPence: 100, vatPence: 0, netPence: 100 },
  ];
  const expectedCash = FLOAT + cashTendered - changeGiven - cashRefunded; // 13548
  const variance = DECLARED - expectedCash; // -48: £0.48 short
  return {
    grossSales,
    dealDiscounts,
    memberDiscounts,
    refunds,
    netTakings,
    depositsTaken,
    depositsApplied,
    cashTendered,
    changeGiven,
    cashRefunded,
    cashTotal,
    cardTendered,
    cardRefunded,
    cardTotal,
    noSaleCount: 1,
    voidCount: 1,
    vatByRate,
    float: FLOAT,
    expectedCash,
    declared: DECLARED,
    variance,
  };
})();

/** Every X/Z figure of spec §6.11 in the D-108 order (deductions print as negatives, D-041). */
async function expectPeriodFigures(doc: Page): Promise<void> {
  const f = EXPECTED;
  await expectDocMoney(doc, 'Gross sales', f.grossSales);
  await expectDocMoney(doc, 'Deal discounts', -f.dealDiscounts);
  await expectDocMoney(doc, 'Member discounts', -f.memberDiscounts);
  await expectDocMoney(doc, 'Refunds', -f.refunds);
  await expectDocMoney(doc, 'Net takings', f.netTakings);
  await expectDocMoney(doc, 'Cash tendered', f.cashTendered);
  await expectDocMoney(doc, 'Change given', f.changeGiven);
  await expectDocMoney(doc, 'Cash refunded', f.cashRefunded);
  await expectDocMoney(doc, 'Cash total', f.cashTotal);
  await expectDocMoney(doc, 'Card tendered', f.cardTendered);
  await expectDocMoney(doc, 'Card refunded', f.cardRefunded);
  await expectDocMoney(doc, 'Card total', f.cardTotal);
  await expectDocMoney(doc, 'Deposits taken', f.depositsTaken);
  await expectDocMoney(doc, 'Deposits applied', f.depositsApplied);
  await expectDocCount(doc, 'No sales', f.noSaleCount);
  await expectDocCount(doc, 'Voids', f.voidCount);
  await expectVatTable(doc, f.vatByRate);
  await expectDocMoney(doc, 'Float', f.float);
  await expectDocMoney(doc, 'Expected cash', f.expectedCash);
}

test('journey 7: X read, then a Z close with a short drawer; the Z report matches the sales made', async ({ page, context }) => {
  test.setTimeout(180_000);

  // The hand figures satisfy the D-042 reconciliation identities.
  const f = EXPECTED;
  expect(f).toMatchObject({ grossSales: 5780, netTakings: 5028, cashTotal: 3548, cardTotal: 1480, expectedCash: 13_548, variance: -48 });
  expect(f.cashTotal + f.cardTotal).toBe(f.netTakings - f.depositsApplied + f.depositsTaken);
  expect(f.expectedCash).toBe(f.float + f.cashTotal);
  expect(f.vatByRate.reduce((sum, r) => sum + r.grossPence, 0)).toBe(f.netTakings);
  expect(f.grossSales - f.dealDiscounts - f.memberDiscounts).toBe(1088 + 480 + 3800);

  await setUpTrading(page, FLOAT);
  const prefix = await devicePrefix(page);

  // S1: deal + member, £20 cash with change.
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  await addProduct(page, 'Draught', 'Fairway Lager');
  await attachMember(page, '1001', '1001 — Alice Archer');
  await expectTillTotal(page, 1088);
  await openPay(page, 1088);
  let doc = await finalTender(page, context, '£20');
  await expect(doc).toHaveTitle(`Receipt ${receiptNumber(prefix, 1)}`);
  await expectDocMoney(doc, 'TOTAL', 1088);
  await expectDocMoney(doc, 'Cash', 2000);
  await expectDocMoney(doc, 'Change', 912);
  await doc.close();
  await newSaleAfterChange(page, 912);

  // S2: a Cola is added and voided (the manager voids directly), then card for the rest.
  await addProduct(page, 'Snacks', 'Ready Salted Crisps', 3);
  await addProduct(page, 'Snacks', 'Chocolate Bar');
  await addProduct(page, 'Events', 'Raffle Ticket');
  await addProduct(page, 'Soft Drinks', 'Cola');
  await expectTillTotal(page, 480 + 250);
  await button(page, 'Void').click();
  const voidDialog = dialog(page, 'Void item');
  await expect(voidDialog.getByRole('radio', { name: /1 × Cola/ })).toBeChecked();
  await button(voidDialog, 'Confirm void').click();
  await expect(voidDialog).toBeHidden();
  await expectTillTotal(page, 480);
  await openPay(page, 480);
  doc = await finalTender(page, context, 'Card');
  await expect(doc).toHaveTitle(`Receipt ${receiptNumber(prefix, 2)}`);
  await expectDocMoney(doc, 'TOTAL', 480);
  await expectDocMoney(doc, 'Card', 480);
  await doc.close();
  await expect(page).toHaveURL(/#\/till$/);

  // One no sale (the manager opens the drawer directly).
  await button(page, 'No sale').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Drawer opened' })).toBeVisible();

  // S3: a £20.00 deposit on Seniors Society Day, paid Exact in cash.
  await navigate(page, 'Bookings');
  await expectHeading(page, 'Bookings');
  await page.getByRole('list', { name: 'Open bookings' }).getByRole('link', { name: 'Seniors Society Day' }).click();
  await expectHeading(page, 'Seniors Society Day');
  await button(page, 'Take deposit').click();
  const depositDialog = dialog(page, 'Take deposit');
  await enterMoney(depositDialog, 2000);
  await button(depositDialog, 'Continue to Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), 2000);
  doc = await finalTender(page, context, 'Exact');
  await expect(doc).toHaveTitle(`Receipt ${receiptNumber(prefix, 3)}`);
  await expect(doc.locator('body')).toContainText('DEPOSIT');
  await expect(doc.locator('body')).toContainText('Deposit balance now £20.00');
  await doc.close();
  await expectHeading(page, 'Seniors Society Day');
  await expectMoney(page.getByTestId('booking-balance'), 2000);

  // S4: two bottles of wine against the booking: 3800 - 2000 deposit = 1800; card £10, then £10 cash.
  await navigate(page, 'Till');
  await addProduct(page, 'Wine', 'House Red (bottle)');
  await addProduct(page, 'Wine', 'House White (bottle)');
  await button(page, 'Booking').click();
  const attach = dialog(page, 'Attach booking');
  await button(attach, 'Seniors Society Day').click();
  await expect(attach).toBeHidden();
  await expectTillTotal(page, 1800);
  await openPay(page, 1800);
  await enterTenderAmount(page, 1000);
  await button(page, 'Card').click();
  await expectMoney(page.getByTestId('remaining'), 800);
  doc = await finalTender(page, context, '£10');
  await expect(doc).toHaveTitle(`Receipt ${receiptNumber(prefix, 4)}`);
  await expectDocMoney(doc, 'Deposit applied', -2000);
  await expectDocMoney(doc, 'TOTAL', 1800);
  await expectDocMoney(doc, 'Card', 1000);
  await expectDocMoney(doc, 'Cash', 1000);
  await expectDocMoney(doc, 'Change', 200);
  await doc.close();
  await newSaleAfterChange(page, 200);

  // S5: refund 1 Birdie Pale Ale from S1 by cash: -340.
  await navigate(page, 'Refunds');
  await page.getByLabel('Receipt number').fill(receiptNumber(prefix, 1));
  await button(page, 'Find sale').click();
  await button(page, 'Increase Birdie Pale Ale').click();
  await expectMoney(page.getByTestId('refund-total'), 340);
  doc = await waitForDocument(context, () => button(page, 'Refund £3.40').click());
  await expect(doc).toHaveTitle(`Receipt ${receiptNumber(prefix, 5)}`);
  await expectDocMoney(doc, 'TOTAL', -340);
  await expectDocMoney(doc, 'Cash', -340);
  await doc.close();
  await expect(page.getByTestId('refund-complete')).toContainText('Give the customer £3.40 in cash.');

  // X read: the figures so far; the period stays open (D-046).
  await navigate(page, 'Period');
  await expectHeading(page, 'Period');
  const xRead = await waitForDocument(context, () => button(page, 'X read').click());
  await expect(xRead).toHaveTitle('X read');
  await expect(xRead.locator('body')).toContainText('X READ');
  await expectPeriodFigures(xRead);
  // An X read has no cash-up section (D-108).
  await expect(docRow(xRead, 'Declared cash')).toHaveCount(0);
  await xRead.close();
  await expect(page.getByTestId('period-status')).toHaveText('Period open');

  // Z close: no open tabs, so straight to the count; expected cash is shown only after it (D-047).
  await button(page, 'Z close').click();
  const wizard = dialog(page, 'Z close');
  await expect(wizard.getByTestId('z-step-count')).toBeVisible();
  await expect(wizard).not.toContainText('Expected cash');
  await enterMoney(wizard, DECLARED);
  await expectMoney(wizard.getByTestId('counted-cash'), DECLARED);
  await button(wizard, 'Continue').click();
  await expectMoney(wizard.getByTestId('z-expected'), f.expectedCash);
  await expectMoney(wizard.getByTestId('z-declared'), DECLARED);
  await expectMoney(wizard.getByTestId('z-variance'), f.variance);
  await expect(wizard.getByTestId('z-variance-kind')).toHaveText('Short');
  await expectNoHorizontalScroll(page);

  const zReport = await waitForDocument(context, () => button(wizard, 'Confirm Z close').click());
  await expect(zReport).toHaveTitle('Z report 1');
  await expect(zReport.locator('body')).toContainText('Z REPORT 1');
  await expectPeriodFigures(zReport);
  await expectDocMoney(zReport, 'Declared cash', DECLARED);
  await expectDocMoney(zReport, 'Variance (short)', f.variance);
  await zReport.close();

  await expect(wizard).toBeHidden();
  await expect(page.getByTestId('period-status')).toHaveText('No period open');
  await expect(page.getByTestId('z-closed')).toContainText('Expected £135.48, declared £135.00: £0.48 short.');
  await expectNoHorizontalScroll(page);

  // The records agree with the report (D-047, D-084).
  const [period] = await readStore<Period>(page, 'periods');
  expect(period).toMatchObject({ zNumber: 1, floatPence: FLOAT, declaredCashPence: DECLARED });
  expect(period?.closedAt).toBeDefined();
  const events = await readAuditEvents(page);
  expect(events.filter((e) => e.type === 'zClose').map((e) => e.detail)).toEqual([
    { zNumber: 1, floatPence: FLOAT, expectedCashPence: f.expectedCash, declaredCashPence: DECLARED, variancePence: f.variance },
  ]);
  expect(events.filter((e) => e.type === 'void')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'noSale')).toHaveLength(1);
  const sales = await readStore<Sale>(page, 'sales');
  expect(sales.map((s) => [s.receiptNumber, s.kind, s.totalPence, s.changePence]).sort()).toEqual(
    [
      [receiptNumber(prefix, 1), 'sale', 1088, 912],
      [receiptNumber(prefix, 2), 'sale', 480, 0],
      [receiptNumber(prefix, 3), 'deposit', 2000, 0],
      [receiptNumber(prefix, 4), 'sale', 1800, 200],
      [receiptNumber(prefix, 5), 'refund', -340, 0],
    ].sort(),
  );
});

// ---------------------------------------------------------------------------
// Journey 8: refresh mid-basket -> basket restored after login (spec §6.2, §8; D-033, D-074,
// D-094..D-096)
// ---------------------------------------------------------------------------

/**
 * The basket: 2 × Birdie Pale Ale @ 450, 1 × Fairway Lager @ 480, 3 × Ready Salted Crisps @ 120,
 * member 1001 (15%).
 *   Birdie gross 900, "Any 2 bottles for £8" -100 -> post-deal 800.
 *   Lager gross 480 -> 480.   Crisps gross 360, "Snacks 3 for 2" -120 -> 240.
 *   Member base 800 + 480 + 240 = 1520; 15% = 228, spread 1520: 120, 72, 36.
 *   Finals 680 + 408 + 204 = 1292.
 */
async function buildJourney8Basket(page: Page): Promise<void> {
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  await addProduct(page, 'Draught', 'Fairway Lager');
  await addProduct(page, 'Snacks', 'Ready Salted Crisps', 3);
  await attachMember(page, '1001', '1001 — Alice Archer');
  await expectTillTotal(page, 1292);
}

async function expectJourney8Basket(page: Page): Promise<void> {
  await expectTillTotal(page, 1292);
  const basket = await openBasket(page);
  // The same lines in the same order (D-008: line order is the receipt order).
  await expect(basketLines(basket)).toHaveText([
    basketLineText(2, 'Birdie Pale Ale', 450),
    basketLineText(1, 'Fairway Lager', 480),
    basketLineText(3, 'Ready Salted Crisps', 120),
  ]);
  await expect(basket.getByTestId('member-badge')).toContainText('1001 — Alice Archer');
  const deals = basket.getByTestId('deal-line');
  await expect(deals).toHaveCount(2);
  await expect(deals.filter({ hasText: 'Any 2 bottles for £8' })).toHaveText(/Any 2 bottles for £8\s*-£1\.00/);
  await expect(deals.filter({ hasText: 'Snacks 3 for 2' })).toHaveText(/Snacks 3 for 2\s*-£1\.20/);
  await expect(basket.getByTestId('member-discount-line')).toHaveText(/Member discount \(15%\)\s*-£2\.28/);
  await expectMoney(basket.getByTestId('basket-total'), 1292);
  await closeBasket(page);
}

function draftContents(draft: Draft | undefined): unknown {
  if (draft === undefined) return undefined;
  return { lines: draft.lines, memberId: draft.memberId, bookingId: draft.bookingId, tabId: draft.tabId };
}

test('journey 8: a refresh mid-basket loses the session, and the basket comes back exactly after login', async ({ page, context }) => {
  await setUpTrading(page);
  await lock(page);
  await login(page, STAFF.pin);
  await buildJourney8Basket(page);
  const [before] = await readStore<Draft>(page, 'draft');
  expect(before?.lines).toHaveLength(3);
  expect(before?.memberId).toBeDefined();

  // Refresh: the session lived only in memory (D-074), so the login keypad shows.
  await page.reload();
  await expect(loginKeypad(page)).toBeVisible();
  await expect(page.getByTestId('current-staff')).toHaveCount(0);

  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/till$/);
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);
  await expectJourney8Basket(page);
  // Nothing was dropped, so there is no 'removed from the saved basket' toast (D-096).
  await expect(page.getByTestId('toast').filter({ hasText: 'removed from the saved basket' })).toHaveCount(0);
  const [after] = await readStore<Draft>(page, 'draft');
  expect(draftContents(after)).toEqual(draftContents(before));
  await expectNoHorizontalScroll(page);

  // The restored basket sells normally, and the sale clears the draft (D-095).
  await openPay(page, 1292);
  const receipt = await finalTender(page, context, 'Exact');
  const prefix = await devicePrefix(page);
  await expect(receipt).toHaveTitle(`Receipt ${receiptNumber(prefix, 1)}`);
  await expectDocMoney(receipt, 'Member discount (#1001)', -228);
  await expectDocMoney(receipt, 'TOTAL', 1292);
  await expectDocMoney(receipt, 'Cash', 1292);
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 0);
  await expect.poll(async () => readStore(page, 'draft')).toEqual([]);

  // Another refresh brings nothing back: the paid basket can't be sold twice (D-094).
  await page.reload();
  await login(page, STAFF.pin);
  await expectTillTotal(page, 0);
  expect(await readStore<Sale>(page, 'sales')).toHaveLength(1);
});

test('journey 8: a refresh during payment drops the tenders but restores the basket; nothing is saved', async ({ page, context }) => {
  await setUpTrading(page);
  await buildJourney8Basket(page);

  // A £5 note is taken, then the page is refreshed before the rest is paid.
  await openPay(page, 1292);
  await button(page, '£5').click();
  await expectMoney(page.getByTestId('remaining'), 792);
  await page.reload();

  // The Pay session was only in memory (D-033): after login it is the till, not Pay.
  await login(page, MANAGER.pin);
  await expect(page).toHaveURL(/#\/till$/);
  await expectJourney8Basket(page);
  expect(await readStore<Sale>(page, 'sales')).toEqual([]);

  // Paying again starts from the full amount due.
  await openPay(page, 1292);
  await expectMoney(page.getByTestId('remaining'), 1292);
  const receipt = await finalTender(page, context, 'Card');
  await expectDocMoney(receipt, 'TOTAL', 1292);
  await expectDocMoney(receipt, 'Card', 1292);
  await receipt.close();
  const sales = await readStore<Sale>(page, 'sales');
  expect(sales).toEqual([expect.objectContaining({ kind: 'sale', totalPence: 1292, tenders: [{ type: 'card', amountPence: 1292 }], changePence: 0 })]);
});
