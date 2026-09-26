/**
 * Pay screen happy paths and failure handling (spec §6.4, §6.7, §6.10, §8; architecture §5.1–5.3;
 * D-023, D-029..D-034, D-109). Runs at both viewports: tablet landscape and phone portrait.
 * Figures are the sample data's (D-097, D-098) and come from the services; the tests assert the
 * exact pence the decisions give.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Sale, Staff } from '../../src/data/types';
import {
  STAFF,
  enterMoney,
  expectMoney,
  expectNoHorizontalScroll,
  firstRun,
  freshStart,
  isNarrow,
  lock,
  login,
  money,
  navigate,
  openPeriod,
  readStore,
  waitForDocument,
} from './helpers';

// ---------------------------------------------------------------------------
// Helpers for this spec
// ---------------------------------------------------------------------------

/** First run with the sample data, then the manager opens a period with a £100 float. */
async function setUpTrading(page: Page): Promise<void> {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page, 10_000);
}

/** Taps a product `times` times from its category tab on the till. */
async function addProduct(page: Page, category: string, name: string, times = 1): Promise<void> {
  await page.getByRole('tab', { name: category, exact: true }).click();
  const button = page.getByRole('button', { name, exact: true });
  for (let i = 0; i < times; i += 1) await button.click();
}

/** The till's always-visible running total: basket-total (tablet) or basket-bar-total (phone). */
async function expectTillTotal(page: Page, pence: number): Promise<void> {
  await expectMoney(page.getByTestId(isNarrow(page) ? 'basket-bar-total' : 'basket-total'), pence);
}

async function attachMember(page: Page, query: string, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Member', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Attach member' });
  await dialog.getByLabel('Search members').fill(query);
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Till → Pay. */
async function openPay(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pay' })).toBeAttached();
}

function button(page: Page | Locator, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

/** The Pay screen's custom-amount keypad. */
function keypad(page: Page): Locator {
  return page.getByRole('group', { name: 'Amount tendered' });
}

async function expectPayFigures(page: Page, figures: { due: number; remaining: number; change: number }): Promise<void> {
  await expectMoney(page.getByTestId('amount-due'), figures.due);
  await expectMoney(page.getByTestId('remaining'), figures.remaining);
  await expectMoney(page.getByTestId('change-due'), figures.change);
}

/** A receipt row ('TOTAL', 'Card', 'Change', …) in a receipt document. */
function receiptRow(doc: Page, label: string): Locator {
  return doc.locator('.row').filter({ has: doc.locator('.label').getByText(label, { exact: true }) });
}

async function expectReceiptRow(doc: Page, label: string, pence: number): Promise<void> {
  await expect(receiptRow(doc, label).locator('.amount')).toHaveText(money(pence));
}

async function sales(page: Page): Promise<Sale[]> {
  return readStore<Sale>(page, 'sales');
}

/**
 * Test set-up only: closes (or reopens) the open period behind the app's back, so the next
 * commitSale fails inside its transaction (spec §8: a failed save).
 */
async function setPeriodClosedBehindTheApp(page: Page, closed: boolean): Promise<void> {
  await page.evaluate(async (closed) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('club-epos');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('open failed'));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('periods', 'readwrite');
      const store = tx.objectStore('periods');
      const request = store.getAll();
      request.onsuccess = () => {
        const rows = request.result as { closedAt?: string }[];
        const period = rows[rows.length - 1];
        if (period === undefined) throw new Error('no period');
        if (closed) period.closedAt = new Date().toISOString();
        else delete period.closedAt;
        store.put(period);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('put failed'));
    });
    db.close();
  }, closed);
}

/** Makes window.open return null (a popup blocker) or restores it. */
async function blockPopups(page: Page, blocked: boolean): Promise<void> {
  await page.evaluate((blocked) => {
    const saved = Reflect.get(window, '__realOpen') as typeof window.open | undefined;
    if (blocked) {
      if (saved === undefined) Reflect.set(window, '__realOpen', window.open);
      window.open = () => null;
    } else if (saved !== undefined) {
      window.open = saved;
    }
  }, blocked);
}

const RECEIPT_TITLE = (n: number) => new RegExp(`^Receipt [0-9A-F]{4}-${String(n).padStart(6, '0')}$`);

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

test('split card and cash with a deal and a member: card above the balance is refused, change is shown and the receipt opens', async ({ page, context }) => {
  await setUpTrading(page);
  // D-098: 2 × Birdie Pale Ale + 1 × Fairway Lager with a member = £10.88.
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  await addProduct(page, 'Draught', 'Fairway Lager');
  await attachMember(page, '1001', '1001 — Alice Archer');
  await expectTillTotal(page, 1088);
  await openPay(page);

  await expectPayFigures(page, { due: 1088, remaining: 1088, change: 0 });
  await expect(page.getByTestId('tender-row')).toHaveCount(0);
  await expect(button(page, 'Back to basket')).toBeVisible();
  await expect(button(page, 'Cash')).toBeDisabled();
  for (const name of ['£5', '£10', '£20', '£50', 'Exact', 'Card']) await expect(button(page, name)).toBeEnabled();
  // The order summary shows the frozen pricing (on the phone it is collapsed under 'Order details').
  if (isNarrow(page)) await page.getByText('Order details').click();
  const order = page.getByRole('list', { name: 'Discounts and deposits' });
  await expect(order).toContainText('Any 2 bottles for £8');
  await expect(order).toContainText('-£1.00');
  await expect(order).toContainText('-£1.92');
  await expectNoHorizontalScroll(page);

  // D-029: a card tender above the balance is refused with the service's message; nothing recorded.
  await enterMoney(keypad(page), 2000);
  await expectMoney(page.getByTestId('tender-amount'), 2000);
  await button(page, 'Card').click();
  await expect(page.getByTestId('pay-error')).toHaveText("Card can't be more than the balance (£10.88)");
  await expectPayFigures(page, { due: 1088, remaining: 1088, change: 0 });
  await expect(page.getByTestId('tender-row')).toHaveCount(0);

  // Card £5 leaves £5.88; the keypad clears (D-030) and the exit becomes 'Cancel payment' (D-033).
  await enterMoney(keypad(page), 500);
  await expect(page.getByTestId('pay-error')).toHaveCount(0);
  await button(page, 'Card').click();
  await expectPayFigures(page, { due: 1088, remaining: 588, change: 0 });
  await expect(page.getByTestId('tender-row')).toHaveCount(1);
  await expect(page.getByTestId('tender-row')).toContainText(/Card\s*£5\.00/);
  await expectMoney(page.getByTestId('tender-amount'), 0);
  await expect(button(page, 'Back to basket')).toHaveCount(0);
  await expect(button(page, 'Cancel payment')).toBeVisible();

  // £10 cash completes it: change £4.12 (D-098). The receipt opens in a new tab (D-109).
  const receipt = await waitForDocument(context, () => button(page, '£10').click());
  await expect(receipt).toHaveTitle(RECEIPT_TITLE(1));
  await expectReceiptRow(receipt, 'TOTAL', 1088);
  await expectReceiptRow(receipt, 'Card', 500);
  await expectReceiptRow(receipt, 'Cash', 1000);
  await expectReceiptRow(receipt, 'Change', 412);
  await expectReceiptRow(receipt, 'Member discount (#1001)', -192);
  await receipt.close();

  const done = page.getByTestId('payment-complete');
  await expect(done.getByRole('heading', { name: 'Sale complete' })).toBeVisible();
  await expectMoney(page.getByTestId('change-due'), 412);
  await expect(button(page, 'New sale')).toBeFocused();
  await expectNoHorizontalScroll(page);

  const [sale] = await sales(page);
  expect(sale).toMatchObject({
    kind: 'sale',
    totalPence: 1088,
    memberDiscountPence: 192,
    tenders: [
      { type: 'card', amountPence: 500 },
      { type: 'cash', amountPence: 1000 },
    ],
    changePence: 412,
  });
  expect(sale?.dealLines).toEqual([expect.objectContaining({ name: 'Any 2 bottles for £8', savingPence: 100 })]);

  // The basket and Pay state were cleared by the commit; New sale returns to an empty till.
  await button(page, 'New sale').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 0);
});

test('Back to basket and Cancel payment keep the basket; the Pay session survives a lock; Exact with no change returns straight to the till', async ({ page, context }) => {
  await setUpTrading(page);
  // D-098: 3 × Ready Salted Crisps + 1 × Chocolate Bar = £3.80 (Snacks 3 for 2).
  await addProduct(page, 'Snacks', 'Ready Salted Crisps', 3);
  await addProduct(page, 'Snacks', 'Chocolate Bar');
  await openPay(page);
  await expectPayFigures(page, { due: 380, remaining: 380, change: 0 });

  // No tenders: Back to basket leaves freely and the basket is untouched (D-033).
  await button(page, 'Back to basket').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 380);

  // A £1.00 cash tender, then a lock: the Pay session survives and staff return to it (D-033).
  await openPay(page);
  await enterMoney(keypad(page), 100);
  await expect(button(page, 'Cash')).toBeEnabled();
  await button(page, 'Cash').click();
  await expectPayFigures(page, { due: 380, remaining: 280, change: 0 });
  await lock(page);
  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/pay$/);
  await expectPayFigures(page, { due: 380, remaining: 280, change: 0 });
  await expect(page.getByTestId('tender-row')).toHaveCount(1);

  // Cancel payment asks first; 'Keep paying' stays on Pay.
  await button(page, 'Cancel payment').click();
  let confirm = page.getByRole('dialog', { name: 'Cancel this payment?' });
  await expect(confirm).toContainText('cash £1.00');
  // The instruction is the dialog's description, so a screen reader announces it with the title.
  await expect(confirm).toHaveAccessibleDescription(/Already taken: cash £1\.00\. Hand back the cash/);
  await button(confirm, 'Keep paying').click();
  await expect(confirm).toBeHidden();
  await expectMoney(page.getByTestId('remaining'), 280);

  await button(page, 'Cancel payment').click();
  confirm = page.getByRole('dialog', { name: 'Cancel this payment?' });
  await button(confirm, 'Yes, cancel').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expect(page.getByTestId('toast').filter({ hasText: 'Payment cancelled. Nothing was saved.' })).toBeVisible();
  await expectTillTotal(page, 380);
  expect(await sales(page)).toHaveLength(0);

  // Exact tenders the remaining balance; with no change the till comes straight back (staff can sell: no override).
  await openPay(page);
  const receipt = await waitForDocument(context, () => button(page, 'Exact').click());
  await expect(receipt).toHaveTitle(RECEIPT_TITLE(1));
  await expectReceiptRow(receipt, 'TOTAL', 380);
  await expectReceiptRow(receipt, 'Cash', 380);
  await expect(receiptRow(receipt, 'Change')).toHaveCount(0);
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);
  await expect(page.getByTestId('toast').filter({ hasText: /^Sale complete · Receipt [0-9A-F]{4}-000001$/ })).toBeVisible();
  await expectTillTotal(page, 0);
  await expect(page.getByTestId('override-dialog')).toHaveCount(0);

  const staff = await readStore<Staff>(page, 'staff');
  const sam = staff.find((s) => s.name === STAFF.name);
  const [sale] = await sales(page);
  expect(sale).toMatchObject({ kind: 'sale', staffId: sam?.id, totalPence: 380, tenders: [{ type: 'cash', amountPence: 380 }], changePence: 0 });
});

test('a deposit that covers the bill makes it £0.00 and the sale completes with no tender (D-023, D-031)', async ({ page, context }) => {
  await setUpTrading(page);
  // A £100.00 deposit taken through Bookings → Take deposit → Pay (D-024, D-027).
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Smith & Jones Wedding' }).click();
  await button(page, 'Take deposit').click();
  const depositDialog = page.getByRole('dialog', { name: 'Take deposit' });
  await enterMoney(depositDialog, 10_000);
  await button(depositDialog, 'Continue to Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  const depositReceipt = await waitForDocument(context, () => button(page, 'Exact').click());
  await depositReceipt.close();
  await expect(page).toHaveURL(/#\/bookings\//);
  await expectMoney(page.getByTestId('booking-balance'), 10_000);
  await navigate(page, 'Till');

  await addProduct(page, 'Wine', 'House Red (bottle)', 2);
  await page.getByRole('button', { name: 'Booking', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Attach booking' });
  await dialog.getByRole('button', { name: 'Smith & Jones Wedding' }).click();
  await expect(dialog).toBeHidden();
  await expectTillTotal(page, 0);

  await openPay(page);
  await expectPayFigures(page, { due: 0, remaining: 0, change: 0 });
  await expect(page.getByRole('heading', { name: 'Nothing to pay' })).toBeVisible();
  await expect(page.getByTestId('zero-total-reason')).toHaveText(/^The deposit covers the whole bill\./);
  for (const name of ['Card', 'Cash', 'Exact', '£5']) await expect(button(page, name)).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // A double tap commits once (the committing guard): exactly one receipt and one sale.
  const receipt = await waitForDocument(context, () => button(page, 'Complete sale').dblclick());
  await expect(receipt).toHaveTitle(RECEIPT_TITLE(2));
  await expectReceiptRow(receipt, 'Deposit applied', -3800);
  await expectReceiptRow(receipt, 'TOTAL', 0);
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 0);

  const bills = (await sales(page)).filter((s) => s.kind === 'sale');
  expect(bills).toHaveLength(1);
  const sale = bills[0];
  // D-023: applied = min(balance 10000, bill 3800); £62.00 stays on the booking.
  expect(sale).toMatchObject({ depositAppliedPence: 3800, totalPence: 0, tenders: [], changePence: 0 });
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Smith & Jones Wedding' }).click();
  await expectMoney(page.getByTestId('booking-balance'), 6200);
  await expect(button(page, 'Mark settled')).toBeDisabled();
});

test('take a deposit on a booking: split card and cash with change, then back to the booking (D-024, D-027)', async ({ page, context }) => {
  await setUpTrading(page);
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Seniors Society Day' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Seniors Society Day' })).toBeVisible();
  await page.getByRole('button', { name: 'Take deposit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Take deposit' });
  await enterMoney(dialog, 5000);
  await dialog.getByRole('button', { name: 'Continue to Pay' }).click();
  await expect(page).toHaveURL(/#\/pay$/);

  await expect(page.getByText('Deposit for Seniors Society Day', { exact: true })).toBeVisible();
  await expect(page.getByTestId('deposit-booking')).toContainText('Society day');
  await expectPayFigures(page, { due: 5000, remaining: 5000, change: 0 });
  await expect(button(page, 'Back to booking')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await enterMoney(keypad(page), 2000);
  await button(page, 'Card').click();
  await expectPayFigures(page, { due: 5000, remaining: 3000, change: 0 });

  const receipt = await waitForDocument(context, () => button(page, '£50').click());
  await expect(receipt).toHaveTitle(RECEIPT_TITLE(1));
  await expect(receipt.locator('body')).toContainText('DEPOSIT');
  await expect(receipt.locator('body')).toContainText('Deposit balance now £50.00');
  await expectReceiptRow(receipt, 'Change', 2000);
  await receipt.close();

  await expect(page.getByTestId('payment-complete').getByRole('heading', { name: 'Deposit taken' })).toBeVisible();
  await expectMoney(page.getByTestId('change-due'), 2000);
  await button(page, 'Back to booking').click();
  await expect(page).toHaveURL(/#\/bookings\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Seniors Society Day' })).toBeVisible();

  const [deposit] = await sales(page);
  expect(deposit).toMatchObject({
    kind: 'deposit',
    lines: [],
    totalPence: 5000,
    tenders: [
      { type: 'card', amountPence: 2000 },
      { type: 'cash', amountPence: 5000 },
    ],
    changePence: 2000,
  });
});

test('a failed save keeps the payment open with Try again (spec §8, D-034); a blocked receipt tab shows the receipt on screen with Reprint (D-109)', async ({ page, context }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  await openPay(page);
  await expectPayFigures(page, { due: 420, remaining: 420, change: 0 });

  // The period is closed behind the app's back, so the commit fails inside its transaction.
  await setPeriodClosedBehindTheApp(page, true);
  await button(page, '£5').click();
  const failure = page.getByTestId('pay-error');
  await expect(failure).toContainText(/^Sale not saved: /);
  await expect(page).toHaveURL(/#\/pay$/);
  await expectPayFigures(page, { due: 420, remaining: 0, change: 80 });
  await expect(button(page, 'Cancel payment')).toBeVisible();
  await button(page, 'Try again').click();
  await expect(failure).toContainText(/^Sale not saved: /);
  expect(await sales(page)).toHaveLength(0);

  // Fixed; the browser now blocks the receipt tab: Try again saves and shows the on-screen receipt.
  await setPeriodClosedBehindTheApp(page, false);
  await blockPopups(page, true);
  await button(page, 'Try again').click();
  const panel = page.getByTestId('receipt-fallback');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog', { name: RECEIPT_TITLE(1) })).toBeVisible();
  await expect(panel.frameLocator('iframe').locator('.payment')).toContainText('£4.20');
  expect(await sales(page)).toHaveLength(1);

  // Reprint while still blocked keeps the panel; once allowed, Reprint opens the tab and closes it.
  await button(panel, 'Reprint').click();
  await expect(panel).toBeVisible();
  await blockPopups(page, false);
  const receipt = await waitForDocument(context, () => button(panel, 'Reprint').click());
  await expect(receipt).toHaveTitle(RECEIPT_TITLE(1));
  await receipt.close();
  await expect(panel).toBeHidden();

  // The change to hand back is still on screen behind the panel.
  await expectMoney(page.getByTestId('change-due'), 80);
  await button(page, 'New sale').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 0);
  const [sale] = await sales(page);
  expect(sale).toMatchObject({ kind: 'sale', totalPence: 420, tenders: [{ type: 'cash', amountPence: 500 }], changePence: 80 });
});

// ---------------------------------------------------------------------------
// Regressions: £0.00 without a deposit (D-031), the remaining figure at both sizes
// ---------------------------------------------------------------------------

test('a £0.00 bill with no deposit (100% member discount) says the total is £0.00, not that a deposit covers it (D-031)', async ({ page, context }) => {
  await setUpTrading(page);
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Member discount').fill('100');
  await button(page, 'Save settings').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Settings saved' })).toBeVisible();
  await navigate(page, 'Till');

  await addProduct(page, 'Draught', 'Club Bitter', 2);
  await attachMember(page, '1003', '1003 — Clara Chalmers');
  await expectTillTotal(page, 0);
  await openPay(page);
  await expectPayFigures(page, { due: 0, remaining: 0, change: 0 });
  await expect(page.getByRole('heading', { name: 'Nothing to pay' })).toBeVisible();
  await expect(page.getByTestId('zero-total-reason')).toHaveText('The total is £0.00. Complete the sale to save it and print the receipt.');

  const receipt = await waitForDocument(context, () => button(page, 'Complete sale').click());
  await expect(receipt).toHaveTitle(RECEIPT_TITLE(1));
  await receipt.close();
  const [sale] = await sales(page);
  expect(sale).toMatchObject({ kind: 'sale', totalPence: 0, memberDiscountPence: 840, depositAppliedPence: 0, tenders: [] });
});

test('the remaining figure always fits its card: four- and five-figure amounts keep their pence', async ({ page }) => {
  await setUpTrading(page);
  for (const pence of [104_000, 9_999_999]) {
    await navigate(page, 'Bookings');
    await page.getByRole('link', { name: 'Smith & Jones Wedding' }).click();
    await button(page, 'Take deposit').click();
    const dialog = page.getByRole('dialog', { name: 'Take deposit' });
    await enterMoney(dialog, pence);
    await dialog.getByRole('button', { name: 'Continue to Pay' }).click();
    await expect(page).toHaveURL(/#\/pay$/);
    const remaining = page.getByTestId('remaining');
    await expectMoney(remaining, pence);

    // The text itself (not its box) must end inside the hero's padding box and the card.
    const fit = await remaining.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const card = el.closest('section')?.getBoundingClientRect();
      return { left: text.left, right: text.right, cardLeft: card?.left ?? 0, cardRight: card?.right ?? 0 };
    });
    expect(fit.left, `${money(pence)} starts inside the card`).toBeGreaterThanOrEqual(fit.cardLeft);
    expect(fit.right, `${money(pence)} ends inside the card`).toBeLessThanOrEqual(fit.cardRight - 8);
    await expectNoHorizontalScroll(page);
    await button(page, 'Back to booking').click();
    await expect(page).toHaveURL(/#\/bookings\//);
  }
});

// ---------------------------------------------------------------------------
// Regressions: double taps and keys that move under the finger; Pay with no period (D-134)
// ---------------------------------------------------------------------------

const MONEY_KEYS = ['£5', '£10', '£20', '£50', 'Exact', 'Cash', 'Card'];

/** Where each money key sits in the page (its box plus the scroll of <main>). */
async function moneyKeyPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const name of MONEY_KEYS) {
    positions[name] = await button(page, name).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y + (document.getElementById('main')?.scrollTop ?? 0)) };
    });
  }
  return positions;
}

/** Two taps on the same spot 150 ms apart, with no waiting in between (a double tap). */
async function doubleTap(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
}

test('a double tap takes one tender, and neither a refusal nor a tender moves a money key under the finger (D-134)', async ({ page }) => {
  await setUpTrading(page);
  // 2 × Club Bitter = £8.40.
  await addProduct(page, 'Draught', 'Club Bitter', 2);

  // A double tap on the till's Pay: the second tap never types into Pay's keypad.
  await doubleTap(page, button(page, 'Pay'));
  await expect(page).toHaveURL(/#\/pay$/);
  await page.waitForTimeout(500);
  await expectMoney(page.getByTestId('tender-amount'), 0);
  await expect(page.getByTestId('tender-row')).toHaveCount(0);
  const before = await moneyKeyPositions(page);

  // A refused card shows its message under the keys: nothing moves.
  await enterMoney(keypad(page), 1000);
  await button(page, 'Card').click();
  await expect(page.getByTestId('pay-error')).toHaveText("Card can't be more than the balance (£8.40)");
  expect(await moneyKeyPositions(page)).toEqual(before);

  // A double tap on Card after typing £3.00 takes £3.00 by card once; the second tap does not
  // take the remaining £5.40 by card and save the sale.
  await enterMoney(keypad(page), 300);
  await doubleTap(page, button(page, 'Card'));
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByTestId('tender-row')).toHaveCount(1);
  await expect(page.getByTestId('tender-row')).toContainText(/Card\s*£3\.00/);
  await expectMoney(page.getByTestId('remaining'), 540);
  expect(await sales(page)).toHaveLength(0);
  // The tender taken moved no key either (on a phone it joins the one 'Taken' row).
  expect(await moneyKeyPositions(page)).toEqual(before);

  // A double tap on £5 takes £5 once.
  await doubleTap(page, button(page, '£5'));
  await page.waitForTimeout(500);
  await expect(page.getByTestId('tender-row')).toHaveCount(2);
  await expectMoney(page.getByTestId('remaining'), 40);
  expect(await moneyKeyPositions(page)).toEqual(before);
  await expectNoHorizontalScroll(page);
  expect(await sales(page)).toHaveLength(0);

  // A double tap on £10 finishes it: the second tap can't skip the change to hand back.
  const popup = page.context().waitForEvent('page');
  await doubleTap(page, button(page, '£10'));
  await (await popup).close();
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByTestId('payment-complete')).toBeVisible();
  await expectMoney(page.getByTestId('change-due'), 960);
  const [sale] = await sales(page);
  expect(sale).toMatchObject({
    totalPence: 840,
    tenders: [
      { type: 'card', amountPence: 300 },
      { type: 'cash', amountPence: 500 },
      { type: 'cash', amountPence: 1000 },
    ],
    changePence: 960,
  });
  await button(page, 'New sale').click();
  await expect(page).toHaveURL(/#\/till$/);
});

test('Pay with no open period takes no money: the tender keys are off and staff are told why (D-068, D-134)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  await openPay(page);
  // The period is closed behind the app's back; a lock and login reads it again.
  await setPeriodClosedBehindTheApp(page, true);
  await lock(page);
  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByTestId('period-status')).toHaveText('No period open');
  await expect(page.getByTestId('pay-no-period')).toContainText("Don't take any money");
  for (const name of MONEY_KEYS) await expect(button(page, name)).toBeDisabled();
  await expect(page.getByTestId('tender-row')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await button(page, 'Back to basket').click();
  await expect(page).toHaveURL(/#\/till$/);
  expect(await sales(page)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Regressions: leaving Pay, the frozen member %, the receipt panel through a lock (D-135)
// ---------------------------------------------------------------------------

test('leaving Pay through the Menu drops a payment with no tenders, so a later price edit is charged (D-009, D-011, D-135)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter', 2);
  await openPay(page);
  await expectMoney(page.getByTestId('amount-due'), 840);

  // Menu → Back office → Products: Club Bitter £4.20 → £4.60.
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Club Bitter' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit product' });
  await edit.getByLabel('Price', { exact: true }).fill('4.60');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Club Bitter: price changed from £4.20 to £4.60' })).toBeVisible();

  // The next login goes to the till (no Pay session left), where the basket is repriced.
  await lock(page);
  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 920);
  await openPay(page);
  await expectPayFigures(page, { due: 920, remaining: 920, change: 0 });
  await button(page, 'Exact').click();
  await expect(page).toHaveURL(/#\/till$/);
  const [sale] = await sales(page);
  expect(sale).toMatchObject({ kind: 'sale', totalPence: 920 });
  expect(sale?.lines.map((line) => line.unitPricePence)).toEqual([460]);
});

test('Pay labels the member discount with the % it was priced at, even after the setting changes (D-011, D-135)', async ({ page }) => {
  await setUpTrading(page);
  // 2 × Club Bitter £8.40 with member 1001 at 15%: -£1.26, £7.14.
  await addProduct(page, 'Draught', 'Club Bitter', 2);
  await attachMember(page, '1001', '1001 — Alice Archer');
  await expectTillTotal(page, 714);
  await openPay(page);
  await button(page, '£5').click();
  await expectPayFigures(page, { due: 714, remaining: 214, change: 0 });

  // With money taken the payment is kept while the manager changes the discount to 10%.
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Member discount').fill('10');
  await button(page, 'Save settings').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Settings saved' })).toBeVisible();
  await navigate(page, 'Till');
  await page.getByRole('link', { name: 'Return to payment' }).click();
  await expect(page).toHaveURL(/#\/pay$/);

  await expectPayFigures(page, { due: 714, remaining: 214, change: 0 });
  if (isNarrow(page)) await page.getByText('Order details').click();
  const adjustments = page.getByRole('list', { name: 'Discounts and deposits' });
  await expect(adjustments).toContainText('Member discount (15%)');
  await expect(adjustments).not.toContainText('10%');
  await expect(adjustments).toContainText('-£1.26');
});

test('a blocked receipt survives a stray tap, Escape and an auto-lock: only Close or Reprint closes it (D-109, D-135)', async ({ page, context }) => {
  await page.clock.install();
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  await openPay(page);
  await blockPopups(page, true);
  await button(page, 'Exact').click();
  const panel = page.getByTestId('receipt-fallback');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog', { name: RECEIPT_TITLE(1) })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // A tap on the backdrop (top-left corner, over the header) and Escape leave it open.
  await page.mouse.click(4, 4);
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();

  // Auto-lock: hidden behind the login screen, back after the next login (whoever logs in).
  await page.clock.runFor(5 * 60_000 + 2_000);
  await expect(page.getByTestId('login-screen')).toBeVisible();
  await expect(panel).toBeHidden();
  await login(page, STAFF.pin);
  await expect(panel).toBeVisible();
  await expect(panel.frameLocator('iframe').locator('.payment')).toContainText('£4.20');

  // Reprint once the browser allows it opens the tab and closes the panel.
  await blockPopups(page, false);
  const receipt = await waitForDocument(context, () => button(panel, 'Reprint').click());
  await expect(receipt).toHaveTitle(RECEIPT_TITLE(1));
  await receipt.close();
  await expect(panel).toBeHidden();
});

// ---------------------------------------------------------------------------
// Regressions: the locked basket on the till, Cash keeps focus (D-137)
// ---------------------------------------------------------------------------

test('with money taken the till shows the locked basket at the price being charged, whatever changes in the back office (D-011, D-033, D-137)', async ({ page }) => {
  await setUpTrading(page);
  // 2 × Club Bitter £8.40 with member 1001 at 15%: -£1.26, £7.14.
  await addProduct(page, 'Draught', 'Club Bitter', 2);
  await attachMember(page, '1001', '1001 — Alice Archer');
  await expectTillTotal(page, 714);
  await openPay(page);
  await button(page, '£5').click();
  await expectPayFigures(page, { due: 714, remaining: 214, change: 0 });

  // Mid-payment the manager changes Club Bitter to £4.60 and the member discount to 10%.
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Club Bitter' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit product' });
  await edit.getByLabel('Price', { exact: true }).fill('4.60');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Club Bitter: price changed from £4.20 to £4.60' })).toBeVisible();
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Member discount').fill('10');
  await button(page, 'Save settings').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Settings saved' })).toBeVisible();

  // The till, under 'Payment in progress', shows what Pay is charging: £7.14 at £4.20 and 15%.
  await navigate(page, 'Till');
  await expect(page.getByText('The basket is locked until the payment is finished or cancelled.')).toBeVisible();
  await expectTillTotal(page, 714);
  const basket = isNarrow(page) ? page.getByRole('dialog', { name: 'Basket' }) : page.getByRole('complementary', { name: 'Basket' });
  if (isNarrow(page)) await page.getByRole('button', { name: 'View basket' }).click();
  await expectMoney(basket.getByTestId('basket-total'), 714);
  await expect(basket).toContainText('@ £4.20');
  await expect(basket).not.toContainText('£4.60');
  await expect(basket.getByTestId('member-discount-line')).toContainText('Member discount (15%)');
  await expect(basket.getByTestId('member-discount-line')).toContainText('-£1.26');
  if (isNarrow(page)) {
    await expect(basket.getByRole('button', { name: 'Pay £7.14' })).toBeAttached();
    await basket.getByRole('button', { name: 'Close' }).click();
  }
  await page.getByRole('link', { name: 'Return to payment' }).click();
  await expectPayFigures(page, { due: 714, remaining: 214, change: 0 });

  // Cancelling the payment unlocks the basket, which is priced at now again (D-009):
  // 2 × £4.60 = £9.20, member 10% -£0.92 = £8.28.
  await button(page, 'Cancel payment').click();
  await button(page.getByRole('dialog', { name: 'Cancel this payment?' }), 'Yes, cancel').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 828);
});

test('Cash keeps keyboard focus after a part cash tender clears the keypad, and ignores Enter until an amount is typed (D-134, D-137)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter', 3);
  await openPay(page);
  await expectPayFigures(page, { due: 1260, remaining: 1260, change: 0 });
  await page.waitForTimeout(500); // Pay's 400 ms rest after opening (D-134)
  for (const digit of '500') await page.keyboard.press(digit);
  await expectMoney(page.getByTestId('tender-amount'), 500);
  const cash = button(page, 'Cash');
  await cash.focus();
  await page.keyboard.press('Enter');
  await expectPayFigures(page, { due: 1260, remaining: 760, change: 0 });
  await expect(page.getByTestId('tender-row')).toHaveCount(1);
  await expect(cash).toBeFocused();
  await expect(cash).toBeDisabled();

  // Enter again on the unavailable Cash key takes nothing.
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await expectPayFigures(page, { due: 1260, remaining: 760, change: 0 });
  await expect(page.getByTestId('tender-row')).toHaveCount(1);
  await expect(cash).toBeFocused();

  // An amount makes it available again, still focused.
  for (const digit of '200') await page.keyboard.press(digit);
  await expect(cash).toBeEnabled();
  await expect(cash).toBeFocused();
});

test('when the tender that covers the bill can’t be saved, focus goes to Try again, not <body> (spec §8, D-034, D-135, D-138)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  await openPay(page);
  await page.waitForTimeout(500); // Pay's 400 ms rest after opening (D-134)

  // The £5 key covers the bill, so it goes with the tender keys while the sale is saved.
  await setPeriodClosedBehindTheApp(page, true);
  await button(page, '£5').focus();
  await page.keyboard.press('Enter');
  const failure = page.getByTestId('pay-error');
  await expect(failure).toContainText(/^Sale not saved: /);
  const tryAgain = button(page, 'Try again');
  await expect(tryAgain).toBeFocused();

  // Enter there tries again; once the period is back, it saves the sale.
  await setPeriodClosedBehindTheApp(page, false);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await expect(button(page, 'New sale')).toBeVisible();
  await expect.poll(async () => (await sales(page)).length).toBe(1);
});
