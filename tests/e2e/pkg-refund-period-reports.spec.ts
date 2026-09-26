/**
 * Refunds, the trading period (open, X read, Z close) and the product sales and VAT reports
 * (spec §6.8, §6.11, §10.3 journeys 6 and 7; architecture §5.5, §5.7, §5.8; D-035..D-047, D-070,
 * D-098, D-103, D-125). Runs at both viewports. Every figure is the sample data's (D-097, D-098)
 * and comes from the services; the tests assert the exact pence the decisions give.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AuditEvent, Period, Product, Sale, Settings, Staff, StockMovement, Tab } from '../../src/data/types';
import {
  MANAGER,
  STAFF,
  SUPERVISOR,
  approveOverride,
  enterMoney,
  expectMoney,
  expectNoHorizontalScroll,
  firstRun,
  freshStart,
  lock,
  login,
  money,
  navigate,
  openPeriod,
  readAuditEvents,
  readStore,
  waitForDocument,
} from './helpers';

// ---------------------------------------------------------------------------
// Helpers for this spec
// ---------------------------------------------------------------------------

function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/** First run with the sample data, then the manager opens a period with a £100 float. */
async function setUpTrading(page: Page): Promise<void> {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page, 10_000);
}

/** Taps a product `times` times from its category tab on the till. */
async function addProduct(page: Page, category: string, name: string, times = 1): Promise<void> {
  await page.getByRole('tab', { name: category, exact: true }).click();
  const product = button(page, name);
  for (let i = 0; i < times; i += 1) await product.click();
}

async function attachMember(page: Page, query: string, label: string): Promise<void> {
  await button(page, 'Member').click();
  const dialog = page.getByRole('dialog', { name: 'Attach member' });
  await dialog.getByLabel('Search members').fill(query);
  await button(dialog, label).click();
  await expect(dialog).toBeHidden();
}

/** Till -> Pay -> Exact (no change): the receipt tab opens and the till comes back. */
async function payExact(page: Page): Promise<void> {
  await button(page, 'Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  const receipt = await waitForDocument(page.context(), () => button(page, 'Exact').click());
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);
}

async function devicePrefix(page: Page): Promise<string> {
  const [settings] = await readStore<Settings>(page, 'settings');
  if (settings === undefined) throw new Error('no settings row');
  return settings.devicePrefix;
}

/** A receipt number as the till prints it: '3F9C-000042'. */
function receiptNumber(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

/** A row ('TOTAL', 'Cash', 'Net takings', …) of a receipt or X/Z document. */
function docRow(doc: Page, label: string): Locator {
  return doc.locator('.row').filter({ has: doc.locator('.label').getByText(label, { exact: true }) });
}

async function expectDocRow(doc: Page, label: string, pence: number): Promise<void> {
  await expect(docRow(doc, label).locator('.amount')).toHaveText(money(pence));
}

async function productId(page: Page, name: string): Promise<string> {
  const product = (await readStore<Product>(page, 'products')).find((p) => p.name === name);
  if (product === undefined) throw new Error(`no product ${name}`);
  return product.id;
}

/** Stock on hand = the sum of the product's movements (spec §3.2). */
async function onHand(page: Page, name: string): Promise<number> {
  const id = await productId(page, name);
  const movements = await readStore<StockMovement>(page, 'stockMovements');
  return movements.filter((m) => m.productId === id).reduce((sum, m) => sum + m.qty, 0);
}

async function staffId(page: Page, name: string): Promise<string> {
  const staff = (await readStore<Staff>(page, 'staff')).find((s) => s.name === name);
  if (staff === undefined) throw new Error(`no staff ${name}`);
  return staff.id;
}

/** The London date today, plus `days` (D-102, D-103): 'YYYY-MM-DD'. */
function londonDate(days = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY'. */
function ukDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

// Refund screen parts
function refundLine(page: Page, name: string): Locator {
  return page.getByTestId('refund-line').filter({ has: page.getByText(name, { exact: true }) });
}

async function findReceipt(page: Page, text: string): Promise<void> {
  await page.getByLabel('Receipt number').fill(text);
  await button(page, 'Find sale').click();
}

// ---------------------------------------------------------------------------
// Refunds (spec §6.8; D-035..D-039, D-125; journey 6)
// ---------------------------------------------------------------------------

test('refund in two parts: to stock by cash, then waste and a second line by card; quantities are capped and stock is restored', async ({ page, context }) => {
  await setUpTrading(page);
  // D-098: 2 × Birdie Pale Ale + 1 × Fairway Lager with member 1001 = £10.88 (finals 680 and 408).
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  await addProduct(page, 'Draught', 'Fairway Lager');
  await attachMember(page, '1001', '1001 — Alice Archer');
  await payExact(page);
  const prefix = await devicePrefix(page);
  expect(await onHand(page, 'Birdie Pale Ale')).toBe(46);
  expect(await onHand(page, 'Fairway Lager')).toBe(87);

  await navigate(page, 'Refunds');
  await expect(page.getByRole('heading', { level: 1, name: 'Refunds' })).toBeVisible();

  // D-035 / D-122: lower case and without the leading zeros still finds the receipt.
  await findReceipt(page, `${prefix.toLowerCase()}-1`);
  const sale = page.getByTestId('refund-sale');
  await expect(sale.getByRole('heading', { name: receiptNumber(prefix, 1) })).toBeVisible();
  await expectMoney(page.getByTestId('refund-sale-total'), 1088);
  await expect(sale).toContainText('Member 1001 — Alice Archer');
  await expect(refundLine(page, 'Birdie Pale Ale')).toContainText('2 × £4.50');
  await expect(refundLine(page, 'Birdie Pale Ale')).toContainText('paid £6.80');
  await expect(refundLine(page, 'Fairway Lager')).toContainText('paid £4.08');
  await expectNoHorizontalScroll(page);

  // Nothing chosen yet: Refund is disabled; cash and return-to-stock are the defaults (D-038, D-039).
  await expect(button(page, 'Refund')).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Refund by' }).getByRole('radio', { name: 'Cash' })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Stock for Birdie Pale Ale' }).getByRole('radio', { name: 'Return to stock' })).toBeChecked();

  // The stepper stops at what was sold (D-036).
  const birdie = refundLine(page, 'Birdie Pale Ale');
  await button(page, 'Increase Birdie Pale Ale').click();
  await button(page, 'Increase Birdie Pale Ale').click();
  await expect(birdie.getByTestId('refund-qty')).toHaveText('2');
  await expect(button(page, 'Increase Birdie Pale Ale')).toBeDisabled();
  await expectMoney(page.getByTestId('refund-total'), 680);
  await button(page, 'Decrease Birdie Pale Ale').click();
  await expect(birdie.getByTestId('refund-qty')).toHaveText('1');
  // D-037: one unit's share of the deal (50) and member discount (60): 450 - 50 - 60 = 340.
  await expectMoney(page.getByTestId('refund-total'), 340);
  await expectMoney(birdie.getByTestId('refund-line-amount'), 340);

  const first = await waitForDocument(context, () => button(page, 'Refund £3.40').click());
  await expect(first).toHaveTitle(`Receipt ${receiptNumber(prefix, 2)}`);
  await expect(first.locator('body')).toContainText('REFUND');
  await expect(first.locator('body')).toContainText(`Refund of ${receiptNumber(prefix, 1)}`);
  await expectDocRow(first, 'TOTAL', -340);
  await expectDocRow(first, 'Cash', -340);
  await first.close();

  const done = page.getByTestId('refund-complete');
  await expect(done).toContainText(`Receipt ${receiptNumber(prefix, 2)} for ${receiptNumber(prefix, 1)}`);
  await expect(done).toContainText('Give the customer £3.40 in cash.');
  // Returned to stock: 46 + 1 (D-039).
  expect(await onHand(page, 'Birdie Pale Ale')).toBe(47);

  // The sale reloads: one Birdie left to refund, the choices reset.
  await expect(birdie).toContainText('1 already refunded');
  await expect(birdie).toContainText('of 1');
  await expect(birdie.getByTestId('refund-qty')).toHaveText('0');
  await expect(button(page, 'Refund')).toBeDisabled();

  // Second refund: the last Birdie as waste and the Lager to stock, by card.
  await button(page, 'Increase Birdie Pale Ale').click();
  await expect(button(page, 'Increase Birdie Pale Ale')).toBeDisabled();
  await page.getByRole('group', { name: 'Stock for Birdie Pale Ale' }).getByRole('radio', { name: 'Waste' }).check();
  await button(page, 'Increase Fairway Lager').click();
  await page.getByRole('group', { name: 'Refund by' }).getByRole('radio', { name: 'Card' }).check();
  // 340 (the second unit's shares) + 408 (the whole Lager line) = 748.
  await expectMoney(page.getByTestId('refund-total'), 748);
  const second = await waitForDocument(context, () => button(page, 'Refund £7.48').click());
  await expect(second).toHaveTitle(`Receipt ${receiptNumber(prefix, 3)}`);
  await expectDocRow(second, 'TOTAL', -748);
  await expectDocRow(second, 'Card', -748);
  await second.close();
  await expect(page.getByTestId('refund-complete')).toContainText('Refund £7.48 on the card machine.');

  // Everything is refunded now.
  await expect(page.getByTestId('refund-all-done')).toHaveText('Everything on this receipt has already been refunded.');
  await expect(page.getByText('Fully refunded', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Refund/ })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Waste nets to zero (+1 refund, -1 waste); the Lager went back to stock (D-039).
  expect(await onHand(page, 'Birdie Pale Ale')).toBe(47);
  expect(await onHand(page, 'Fairway Lager')).toBe(88);
  const birdieId = await productId(page, 'Birdie Pale Ale');
  const wasted = (await readStore<StockMovement>(page, 'stockMovements')).filter((m) => m.productId === birdieId && m.reason === 'waste');
  expect(wasted).toEqual([expect.objectContaining({ qty: -1, note: 'Refund - wasted' })]);

  // The refund sales (D-038): negative, referencing the original, one tender each.
  const sales = await readStore<Sale>(page, 'sales');
  const original = sales.find((s) => s.receiptNumber === receiptNumber(prefix, 1));
  const refunds = sales.filter((s) => s.kind === 'refund').sort((a, b) => a.receiptNumber.localeCompare(b.receiptNumber));
  expect(refunds).toHaveLength(2);
  expect(refunds[0]).toMatchObject({ refundOfSaleId: original?.id, totalPence: -340, tenders: [{ type: 'cash', amountPence: -340 }] });
  expect(refunds[1]).toMatchObject({ refundOfSaleId: original?.id, totalPence: -748, tenders: [{ type: 'card', amountPence: -748 }] });
  // D-037: the VAT shares of the Birdie line (113) are 57 then 56.
  expect(refunds[0]?.lines.map((l) => l.vatPence)).toEqual([-57]);
  expect(refunds[1]?.lines.map((l) => [l.nameAtSale, l.vatPence, l.returnToStock])).toEqual([
    ['Birdie Pale Ale', -56, false],
    ['Fairway Lager', -68, true],
  ]);

  // A refund receipt can't itself be refunded; an unknown number is reported (D-035).
  await findReceipt(page, receiptNumber(prefix, 3));
  await expect(page.getByTestId('refund-not-refundable')).toContainText("This receipt can't be refunded");
  await expect(page.getByTestId('refund-sale')).toHaveCount(0);
  await findReceipt(page, 'zzzz-7');
  await expect(page.getByTestId('refund-not-found')).toContainText('There is no receipt ZZZZ-000007 on this till.');
});

test('a supervisor needs a manager PIN to refund; the override is audited', async ({ page, context }) => {
  await setUpTrading(page);
  // D-098: 3 × Ready Salted Crisps + 1 × Chocolate Bar = £3.80 (Snacks 3 for 2).
  await addProduct(page, 'Snacks', 'Ready Salted Crisps', 3);
  await addProduct(page, 'Snacks', 'Chocolate Bar');
  await payExact(page);
  const prefix = await devicePrefix(page);

  await lock(page);
  await login(page, SUPERVISOR.pin);
  await navigate(page, 'Refunds');
  await findReceipt(page, receiptNumber(prefix, 1));
  await button(page, 'Increase Chocolate Bar').click();
  await expectMoney(page.getByTestId('refund-total'), 140);
  await button(page, 'Refund £1.40').click();

  const override = page.getByRole('dialog', { name: 'Manager PIN' });
  await expect(override).toBeVisible();
  const refund = await waitForDocument(context, () => approveOverride(page, MANAGER.pin));
  await expect(refund).toHaveTitle(`Receipt ${receiptNumber(prefix, 2)}`);
  await expectDocRow(refund, 'TOTAL', -140);
  await refund.close();
  await expect(page.getByTestId('refund-complete')).toContainText('Give the customer £1.40 in cash.');

  const sue = await staffId(page, SUPERVISOR.name);
  const morgan = await staffId(page, MANAGER.name);
  const events = await readAuditEvents(page);
  expect(events.filter((e) => e.type === 'override')).toEqual([
    expect.objectContaining({ staffId: sue, approvedById: morgan, detail: { action: 'refund' } }),
  ]);
  expect(events.filter((e) => e.type === 'refund')).toEqual([expect.objectContaining({ staffId: sue, approvedById: morgan })]);
});

// ---------------------------------------------------------------------------
// Period: open, X read, Z close (spec §6.11; D-046, D-047; journey 7)
// ---------------------------------------------------------------------------

test('open a period, X read by override, Z close with open tabs and a short drawer prints Z report 1', async ({ page, context }) => {
  await freshStart(page);
  await firstRun(page);

  // No period yet: the Period screen offers to open one (D-067).
  await navigate(page, 'Period');
  await expect(page.getByRole('heading', { level: 1, name: 'Period' })).toBeVisible();
  await page.getByTestId('no-period').getByRole('button', { name: 'Open period' }).click();
  const openDialog = page.getByRole('dialog', { name: 'Open period' });
  await enterMoney(openDialog, 10_000);
  await button(openDialog, 'Open period').click();
  await expect(openDialog).toBeHidden();
  await expect(page.getByTestId('period-status')).toHaveText('Period open');
  await expectMoney(page.getByTestId('period-float'), 10_000);
  await expect(page.getByTestId('period-summary')).toContainText(MANAGER.name);
  await expectNoHorizontalScroll(page);

  // A £3.80 sale paid with £5 (change £1.20).
  await navigate(page, 'Till');
  await addProduct(page, 'Snacks', 'Ready Salted Crisps', 3);
  await addProduct(page, 'Snacks', 'Chocolate Bar');
  await button(page, 'Pay').click();
  const receipt = await waitForDocument(context, () => button(page, '£5').click());
  await receipt.close();
  await expectMoney(page.getByTestId('change-due'), 120);
  await button(page, 'New sale').click();
  await expect(page).toHaveURL(/#\/till$/);

  // A basket on the till blocks the Z close (D-047).
  await addProduct(page, 'Soft Drinks', 'Cola');
  await navigate(page, 'Period');
  await button(page, 'Z close').click();
  await expect(page.getByTestId('period-error')).toContainText('Finish, park or void the current basket first');
  await expect(page.getByRole('dialog', { name: 'Z close' })).toHaveCount(0);
  await page.getByTestId('period-error').getByRole('link', { name: 'Go to till' }).click();
  await expect(page).toHaveURL(/#\/till$/);

  // Move the Cola onto a tab: it stays open over the Z close (D-066).
  await button(page, 'Tab').click();
  const tabDialog = page.getByRole('dialog', { name: 'Tab' });
  await tabDialog.getByLabel('Tab name').fill('Smith');
  await button(tabDialog, 'Open tab').click();
  await expect(tabDialog).toBeHidden();

  // Staff can't X read: a supervisor PIN approves it. The period stays open (D-046).
  await lock(page);
  await login(page, STAFF.pin);
  await navigate(page, 'Period');
  await button(page, 'X read').click();
  await expect(page.getByRole('dialog', { name: 'Supervisor or manager PIN' })).toBeVisible();
  const xRead = await waitForDocument(context, () => approveOverride(page, SUPERVISOR.pin));
  await expect(xRead).toHaveTitle('X read');
  await expectDocRow(xRead, 'Gross sales', 500);
  await expectDocRow(xRead, 'Deal discounts', -120);
  await expectDocRow(xRead, 'Net takings', 380);
  await expectDocRow(xRead, 'Cash tendered', 500);
  await expectDocRow(xRead, 'Change given', 120);
  await expectDocRow(xRead, 'Cash total', 380);
  await expectDocRow(xRead, 'Float', 10_000);
  await expectDocRow(xRead, 'Expected cash', 10_380);
  await xRead.close();
  await expect(page.getByTestId('period-status')).toHaveText('Period open');

  // Z close as staff: a manager PIN starts the wizard; the approval is used by the confirm.
  await button(page, 'Z close').click();
  await approveOverride(page, MANAGER.pin);
  const wizard = page.getByRole('dialog', { name: 'Z close' });
  await expect(wizard).toBeVisible();
  await expect(wizard.getByTestId('z-open-tabs')).toContainText('1 tab is open and will carry over to the next period');
  await expectNoHorizontalScroll(page);
  await button(wizard, 'Continue').click();

  // The expected cash is not shown before the count (D-047).
  await expect(wizard.getByTestId('z-step-count')).toBeVisible();
  await expect(wizard).not.toContainText('Expected cash');
  await enterMoney(wizard, 10_370);
  await expectMoney(wizard.getByTestId('counted-cash'), 10_370);
  await expectNoHorizontalScroll(page);
  await button(wizard, 'Continue').click();
  await expectMoney(wizard.getByTestId('z-expected'), 10_380);
  await expectMoney(wizard.getByTestId('z-declared'), 10_370);
  await expectMoney(wizard.getByTestId('z-variance'), -10);
  await expect(wizard.getByTestId('z-variance-kind')).toHaveText('Short');
  await expectNoHorizontalScroll(page);

  // Back keeps the count.
  await button(wizard, 'Back').click();
  await expectMoney(wizard.getByTestId('counted-cash'), 10_370);
  await button(wizard, 'Continue').click();
  await expectMoney(wizard.getByTestId('z-variance'), -10);

  const zReport = await waitForDocument(context, () => button(wizard, 'Confirm Z close').click());
  await expect(zReport).toHaveTitle('Z report 1');
  await expect(zReport.locator('body')).toContainText('Z REPORT 1');
  await expectDocRow(zReport, 'Net takings', 380);
  await expectDocRow(zReport, 'Expected cash', 10_380);
  await expectDocRow(zReport, 'Declared cash', 10_370);
  await expectDocRow(zReport, 'Variance (short)', -10);
  await zReport.close();

  await expect(wizard).toBeHidden();
  await expect(page.getByTestId('period-status')).toHaveText('No period open');
  await expect(page.getByTestId('z-closed')).toContainText('Z report 1 printed.');
  await expect(page.getByTestId('z-closed')).toContainText('Expected £103.80, declared £103.70: £0.10 short.');
  await expect(page.getByTestId('no-period')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The records: the period closed with Z 1; the tab still open; the zClose event and one override.
  const [period] = await readStore<Period>(page, 'periods');
  expect(period).toMatchObject({ zNumber: 1, floatPence: 10_000, declaredCashPence: 10_370 });
  expect(period?.closedAt).toBeDefined();
  const tabs = await readStore<Tab>(page, 'tabs');
  expect(tabs).toEqual([expect.objectContaining({ label: 'Smith', status: 'open' })]);
  const sam = await staffId(page, STAFF.name);
  const morgan = await staffId(page, MANAGER.name);
  const events = await readAuditEvents(page);
  const zClose = events.find((e): e is Extract<AuditEvent, { type: 'zClose' }> => e.type === 'zClose');
  expect(zClose).toMatchObject({
    staffId: sam,
    approvedById: morgan,
    detail: { zNumber: 1, floatPence: 10_000, expectedCashPence: 10_380, declaredCashPence: 10_370, variancePence: -10 },
  });
  const overrides = events.filter((e) => e.type === 'override').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  expect(overrides.map((e) => [e.detail, e.staffId, e.approvedById])).toEqual([
    [{ action: 'xRead' }, sam, await staffId(page, SUPERVISOR.name)],
    [{ action: 'openClosePeriod' }, sam, morgan],
  ]);

  // Next period: the carried-over tab is settled and counts there, not in Z 1 (D-066).
  await page.getByTestId('no-period').getByRole('button', { name: 'Open period' }).click();
  const reopen = page.getByRole('dialog', { name: 'Open period' });
  await enterMoney(reopen, 10_000);
  await button(reopen, 'Open period').click();
  await approveOverride(page, MANAGER.pin);
  await expect(page.getByTestId('period-status')).toHaveText('Period open');
  await navigate(page, 'Tabs');
  await button(page, 'Settle Smith').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), 250);
  const tabReceipt = await waitForDocument(context, () => button(page, 'Exact').click());
  await tabReceipt.close();
  await expect(page).toHaveURL(/#\/till$/);
  await navigate(page, 'Period');
  await button(page, 'X read').click();
  const nextX = await waitForDocument(context, () => approveOverride(page, SUPERVISOR.pin));
  await expectDocRow(nextX, 'Gross sales', 250);
  await expectDocRow(nextX, 'Cash tendered', 250);
  await expectDocRow(nextX, 'Float', 10_000);
  await expectDocRow(nextX, 'Expected cash', 10_250);
  await nextX.close();
  const settled = (await readStore<Sale>(page, 'sales')).find((s) => s.totalPence === 250);
  const periods = await readStore<Period>(page, 'periods');
  expect(settled?.periodId).toBe(periods.find((p) => p.closedAt === undefined)?.id);
  expect(settled?.periodId).not.toBe(period?.id);
});

// ---------------------------------------------------------------------------
// Reports (spec §6.11; D-044, D-045, D-070, D-103)
// ---------------------------------------------------------------------------

test('product sales and VAT reports: figures only after Run, per product, category and rate, with refunds netted off', async ({ page, context }) => {
  await setUpTrading(page);
  // Sale 1: 2 × Birdie Pale Ale (deal: 800, VAT 133) + Raffle Ticket (100 at 0%).
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  await addProduct(page, 'Events', 'Raffle Ticket');
  await payExact(page);
  // Sale 2: Sweepstake Entry (200 at 0%) + Cola (250, VAT 42).
  await addProduct(page, 'Events', 'Sweepstake Entry');
  await addProduct(page, 'Soft Drinks', 'Cola');
  await payExact(page);
  // Refund one Birdie: -400, VAT -67 (D-037: 133 × 1/2 = 66.5 -> 67).
  const prefix = await devicePrefix(page);
  await navigate(page, 'Refunds');
  await findReceipt(page, receiptNumber(prefix, 1));
  await button(page, 'Increase Birdie Pale Ale').click();
  const refund = await waitForDocument(context, () => button(page, 'Refund £4.00').click());
  await refund.close();
  await expect(page.getByTestId('refund-complete')).toBeVisible();

  // Product sales: both dates default to today in London; nothing shows before Run (D-070).
  await navigate(page, 'Product sales report');
  await expect(page.getByRole('heading', { level: 1, name: 'Product sales report' })).toBeVisible();
  const today = londonDate();
  await expect(page.getByLabel('From', { exact: true })).toHaveValue(today);
  await expect(page.getByLabel('To', { exact: true })).toHaveValue(today);
  await expect(page.getByTestId('report-placeholder')).toBeVisible();
  await expect(page.getByTestId('report-results')).toHaveCount(0);

  await button(page, 'Run report').click();
  const results = page.getByTestId('report-results');
  await expect(results.getByRole('heading', { name: `Sales for ${ukDate(today)}` })).toBeVisible();
  await expectMoney(page.getByTestId('report-total-takings'), 950);
  await expect(page.getByTestId('report-total-qty')).toHaveText('4');

  const byCategory = page.getByTestId('category-sales-table');
  await expect(byCategory.getByRole('row')).toHaveText([
    /Category\s*Qty\s*Takings/,
    /Bottles & Cans\s*1\s*£4\.00/,
    /Soft Drinks\s*1\s*£2\.50/,
    /Events\s*2\s*£3\.00/,
    /Total\s*4\s*£9\.50/,
  ]);
  const byProduct = page.getByTestId('product-sales-table');
  await expect(byProduct.getByTestId('product-sales-row')).toHaveText([
    /Birdie Pale Ale\s*1\s*£4\.00/,
    /Cola\s*1\s*£2\.50/,
    /Raffle Ticket\s*1\s*£1\.00/,
    /Sweepstake Entry\s*1\s*£2\.00/,
  ]);
  await expectMoney(page.getByTestId('product-sales-total'), 950);
  await expectNoHorizontalScroll(page);

  // An end date before the start date is refused by the service; the old figures are marked stale.
  const tomorrow = londonDate(1);
  await page.getByLabel('From', { exact: true }).fill(tomorrow);
  await button(page, 'Run report').click();
  await expect(page.getByText('Choose a valid date range: the end date must be on or after the start date')).toBeVisible();
  await expect(page.getByTestId('report-stale')).toBeVisible();

  // A day with no sales.
  await page.getByLabel('To', { exact: true }).fill(tomorrow);
  await button(page, 'Run report').click();
  await expect(results.getByRole('heading', { name: `Sales for ${ukDate(tomorrow)}` })).toBeVisible();
  await expect(page.getByTestId('report-empty')).toHaveText('No sales in this date range.');
  await expectMoney(page.getByTestId('report-total-takings'), 0);

  // VAT report as the supervisor: Run needs a manager PIN (D-070); totals match the product report (D-042).
  await lock(page);
  await login(page, SUPERVISOR.pin);
  await navigate(page, 'VAT report');
  await expect(page.getByRole('heading', { level: 1, name: 'VAT report' })).toBeVisible();
  await expect(page.getByTestId('report-placeholder')).toBeVisible();
  await button(page, 'Run report').click();
  await expect(page.getByRole('dialog', { name: 'Manager PIN' })).toBeVisible();
  await approveOverride(page, MANAGER.pin);

  await expect(page.getByTestId('report-results').getByRole('heading', { name: `VAT for ${ukDate(today)}` })).toBeVisible();
  const vatTable = page.getByTestId('vat-table');
  // 20%: 800 + 250 - 400 = 650 gross, 133 + 42 - 67 = 108 VAT. 0%: 100 + 200.
  await expect(vatTable.getByRole('row')).toHaveText([
    /VAT rate\s*Net\s*VAT\s*Gross/,
    /20%\s*£5\.42\s*£1\.08\s*£6\.50/,
    /0%\s*£3\.00\s*£0\.00\s*£3\.00/,
    /Total\s*£8\.42\s*£1\.08\s*£9\.50/,
  ]);
  await expectMoney(page.getByTestId('report-total-vat'), 108);
  await expectMoney(page.getByTestId('report-total-net'), 842);
  await expectMoney(page.getByTestId('report-total-gross'), 950);
  await expectNoHorizontalScroll(page);

  const sue = await staffId(page, SUPERVISOR.name);
  const overrides = (await readAuditEvents(page)).filter((e) => e.type === 'override');
  expect(overrides).toEqual([expect.objectContaining({ staffId: sue, detail: { action: 'salesReports' } })]);
});

// ---------------------------------------------------------------------------
// Regression: no Z close while a payment has tenders taken (D-033, D-047, D-130)
// ---------------------------------------------------------------------------

test('Z close waits while a deposit payment has tenders taken; the deposit then saves and the Z counts it', async ({ page, context }) => {
  await setUpTrading(page);
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Seniors Society Day' }).click();
  await button(page, 'Take deposit').click();
  const dialog = page.getByRole('dialog', { name: 'Take deposit' });
  await enterMoney(dialog, 2500);
  await button(dialog, 'Continue to Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await button(page, '£20').click();
  await expectMoney(page.getByTestId('remaining'), 500);

  // The basket is empty, but £20 of this deposit is already in the drawer: Z close is refused.
  await navigate(page, 'Period');
  const warning = page.getByTestId('z-payment-in-progress');
  await expect(warning).toContainText('A payment is in progress. Finish or cancel it before closing the period.');
  await expect(button(page, 'Z close')).toBeDisabled();
  await expect(page.getByRole('dialog', { name: 'Z close' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Back to Pay: the deposit completes, and only then can the period close.
  await warning.getByRole('link', { name: 'Back to Pay' }).click();
  await expect(page).toHaveURL(/#\/pay$/);
  const receipt = await waitForDocument(context, () => button(page, 'Exact').click());
  await receipt.close();
  await expect(page).toHaveURL(/#\/bookings\//);
  const deposits = (await readStore<Sale>(page, 'sales')).filter((s) => s.kind === 'deposit');
  expect(deposits).toHaveLength(1);
  expect(deposits[0]).toMatchObject({ totalPence: 2500, tenders: [{ type: 'cash', amountPence: 2000 }, { type: 'cash', amountPence: 500 }] });

  await navigate(page, 'Period');
  await expect(page.getByTestId('z-payment-in-progress')).toHaveCount(0);
  await button(page, 'Z close').click();
  const wizard = page.getByRole('dialog', { name: 'Z close' });
  await enterMoney(wizard, 12_500);
  await button(wizard, 'Continue').click();
  // Expected cash = float £100 + the £25 deposit: the drawer balances.
  await expectMoney(wizard.getByTestId('z-expected'), 12_500);
  await expectMoney(wizard.getByTestId('z-variance'), 0);
});

// ---------------------------------------------------------------------------
// Regressions: a stale deposit Pay session after a Z close; the VAT table on a phone (D-134)
// ---------------------------------------------------------------------------

test('a deposit left on Pay with nothing taken is dropped by the Z close: the next login is on the till, not a Pay screen with no period (D-134)', async ({ page, context }) => {
  await setUpTrading(page);
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Seniors Society Day' }).click();
  await button(page, 'Take deposit').click();
  const dialog = page.getByRole('dialog', { name: 'Take deposit' });
  await enterMoney(dialog, 5000);
  await button(dialog, 'Continue to Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);

  // Left by the menu with nothing taken: the Z close may go ahead (D-130).
  await navigate(page, 'Period');
  await expect(page.getByTestId('z-payment-in-progress')).toHaveCount(0);
  await button(page, 'Z close').click();
  const wizard = page.getByRole('dialog', { name: 'Z close' });
  await enterMoney(wizard, 10_000);
  await button(wizard, 'Continue').click();
  const z = await waitForDocument(context, () => button(wizard, 'Confirm Z close').click());
  await z.close();
  await expect(page.getByTestId('z-closed')).toBeVisible();

  // The deposit could never be saved now, so the next login is on the till with no period.
  await lock(page);
  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/till$/);
  await expect(page.getByTestId('period-status')).toHaveText('No period open');
  await expect(page.getByTestId('no-period')).toBeVisible();
  expect((await readStore<Sale>(page, 'sales')).filter((s) => s.kind === 'deposit')).toHaveLength(0);
});

test('the VAT table shows every figure of a four-figure day in full on a phone, with no sideways scroll (D-134)', async ({ page }) => {
  await setUpTrading(page);
  // 40 × Prosecco (bottle) at £26.00 = £1,040.00 at 20%, and 3 × Raffle Ticket = £3.00 at 0%.
  await addProduct(page, 'Wine', 'Prosecco (bottle)', 40);
  await addProduct(page, 'Events', 'Raffle Ticket', 3);
  await payExact(page);
  await navigate(page, 'VAT report');
  await button(page, 'Run report').click();
  const table = page.getByTestId('vat-table');
  await expect(table.getByRole('row')).toHaveText([
    /VAT rate\s*Net\s*VAT\s*Gross/,
    /^20%\s*£866\.67\s*£173\.33\s*£1,040\.00$/,
    /^0%\s*£3\.00\s*£0\.00\s*£3\.00$/,
    /^Total\s*£869\.67\s*£173\.33\s*£1,043\.00$/,
  ]);
  // The table fits its region: nothing is cut off mid-figure.
  expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const inView = await table.evaluate((el) => {
    const region = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll('th, td')).every((cell) => cell.getBoundingClientRect().right <= region.right + 0.5);
  });
  expect(inView).toBe(true);
  await expectNoHorizontalScroll(page);
});

test('money keypad dialogs open on the keypad, not on Delete last digit: type the amount and press Enter (D-134)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);

  // Open period: 1,0,0,0,0 then Enter opens it with £100.00 (Enter used to delete a digit: £10.00).
  await page.getByTestId('no-period').getByRole('button', { name: 'Open period' }).click();
  const open = page.getByRole('dialog', { name: 'Open period' });
  await expect(open.getByRole('group', { name: 'Float' })).toBeFocused();
  await page.keyboard.type('10000');
  await expect(open.getByTestId('float-amount')).toHaveText('£100.00');
  await page.keyboard.press('Enter');
  await expect(open).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Period opened with a float of £100.00' })).toBeVisible();
  expect((await readStore<Period>(page, 'periods'))[0]?.floatPence).toBe(10_000);

  // Take deposit: the same.
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Seniors Society Day' }).click();
  await button(page, 'Take deposit').click();
  const deposit = page.getByRole('dialog', { name: 'Take deposit' });
  await expect(deposit.getByRole('group', { name: 'Deposit amount' })).toBeFocused();
  await page.keyboard.type('2500');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), 2500);
  await button(page, 'Back to booking').click();
  await expect(page).toHaveURL(/#\/bookings\//);

  // Z close: the counted cash, then Enter shows the check step.
  await navigate(page, 'Period');
  await button(page, 'Z close').click();
  const wizard = page.getByRole('dialog', { name: 'Z close' });
  await expect(wizard.getByRole('group', { name: 'Counted cash' })).toBeFocused();
  await page.keyboard.type('10000');
  await page.keyboard.press('Enter');
  await expectMoney(wizard.getByTestId('z-declared'), 10_000);
  await expectMoney(wizard.getByTestId('z-variance'), 0);
  await button(wizard, 'Back').click();
  await button(wizard, 'Cancel').click();
  await expect(wizard).toBeHidden();
});
