/**
 * Till screen happy paths (spec §6.3, §6.5, §6.6, §6.7; architecture §5.1, §5.3, §5.4, §5.6).
 * Runs at both viewports: tablet landscape (side basket panel) and phone portrait (bottom sheet).
 * Figures are the sample data's (D-097, D-098, D-100) and come from the services.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AuditEvent, Draft, Product, Staff, Tab } from '../../src/data/types';
import {
  MANAGER,
  STAFF,
  SUPERVISOR,
  approveOverride,
  enterMoney,
  enterPin,
  expectMoney,
  expectNoHorizontalScroll,
  firstRun,
  freshStart,
  isNarrow,
  lock,
  login,
  loginKeypad,
  navigate,
  openPeriod,
  readAuditEvents,
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

/** Taps a product `times` times from its category tab. */
async function addProduct(page: Page, category: string, name: string, times = 1): Promise<void> {
  await page.getByRole('tab', { name: category, exact: true }).click();
  const button = page.getByRole('button', { name, exact: true });
  for (let i = 0; i < times; i += 1) await button.click();
}

/** The basket region: the side panel on the tablet, the expanded bottom sheet on the phone. */
async function openBasket(page: Page): Promise<Locator> {
  if (!isNarrow(page)) return page.getByRole('complementary', { name: 'Basket' });
  const sheet = page.getByRole('dialog', { name: 'Basket' });
  if (!(await sheet.isVisible())) await page.getByRole('button', { name: 'View basket' }).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeBasket(page: Page): Promise<void> {
  if (!isNarrow(page)) return;
  const sheet = page.getByRole('dialog', { name: 'Basket' });
  if (await sheet.isVisible()) {
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
  }
}

/** The always-visible running total: basket-total (tablet) or basket-bar-total (phone bar). */
async function expectTotal(page: Page, pence: number): Promise<void> {
  await expectMoney(page.getByTestId(isNarrow(page) ? 'basket-bar-total' : 'basket-total'), pence);
}

function action(page: Page, name: 'Member' | 'Tab' | 'Booking' | 'Void' | 'No sale' | 'Pay'): Locator {
  return page.getByRole('button', { name, exact: true });
}

async function attachMember(page: Page, query: string, label: string): Promise<void> {
  await action(page, 'Member').click();
  const dialog = page.getByRole('dialog', { name: 'Attach member' });
  await dialog.getByLabel('Search members').fill(query);
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function idsByName<T extends { id: string; name: string }>(page: Page, store: 'staff' | 'products'): Promise<Record<string, string>> {
  const rows = await readStore<T>(page, store);
  return Object.fromEntries(rows.map((row) => [row.name, row.id]));
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

test('without an open period selling is disabled until a manager opens one', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Till', exact: true })).toBeAttached();
  await expect(page.getByTestId('no-period')).toContainText('No trading period open');
  await expect(page.getByRole('tab', { name: 'Draught' })).toHaveCount(0);
  for (const name of ['Member', 'Tab', 'Booking', 'Void', 'No sale', 'Pay'] as const) await expect(action(page, name)).toBeDisabled();
  await expectNoHorizontalScroll(page);

  await openPeriod(page, 10_000);
  await expect(page.getByTestId('no-period')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Draught' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Club Bitter', exact: true })).toBeEnabled();
  for (const name of ['Member', 'Tab', 'Booking', 'No sale'] as const) await expect(action(page, name)).toBeEnabled();
  // Nothing to void or pay for yet.
  await expect(action(page, 'Void')).toBeDisabled();
  await expect(action(page, 'Pay')).toBeDisabled();
  await expectNoHorizontalScroll(page);
});

test('a deal and a member price the basket, the member comes off again, and Pay opens', async ({ page }) => {
  await setUpTrading(page);

  // D-098: 2 x Birdie Pale Ale (any 2 bottles for £8) + 1 x Fairway Lager.
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  await addProduct(page, 'Draught', 'Fairway Lager');
  await expectTotal(page, 1280);

  let basket = await openBasket(page);
  await expect(basket.getByTestId('deal-line')).toHaveText(/Any 2 bottles for £8\s*-£1\.00/);
  await expect(basket.getByTestId('member-badge')).toHaveCount(0);
  await expectMoney(basket.getByTestId('basket-total'), 1280);
  await closeBasket(page);

  await attachMember(page, '1001', '1001 — Alice Archer');
  await expectTotal(page, 1088);
  basket = await openBasket(page);
  await expect(basket.getByTestId('member-badge')).toContainText('1001 — Alice Archer');
  await expect(basket.getByTestId('member-discount-line')).toHaveText(/Member discount \(15%\)\s*-£1\.92/);
  await expectMoney(basket.getByTestId('basket-total'), 1088);

  // Remove the member from the basket panel: the discount goes with them.
  await basket.getByRole('button', { name: 'Remove member' }).click();
  await expect(basket.getByTestId('member-badge')).toHaveCount(0);
  await expectMoney(basket.getByTestId('basket-total'), 1280);
  await closeBasket(page);

  // Search by name this time; the dialog shows who is attached and can detach them.
  await attachMember(page, 'arch', '1001 — Alice Archer');
  await expectTotal(page, 1088);
  await action(page, 'Member').click();
  const dialog = page.getByRole('dialog', { name: 'Attach member' });
  await expect(dialog.getByTestId('member-dialog-current')).toHaveText('1001 — Alice Archer');
  await dialog.getByRole('button', { name: 'Detach member' }).click();
  await expect(dialog).toBeHidden();
  await expectTotal(page, 1280);
  await attachMember(page, 'Archer', '1001 — Alice Archer');
  await expectTotal(page, 1088);

  // The draft follows every change (D-095).
  const products = await idsByName<Product>(page, 'products');
  const [draft] = await readStore<Draft>(page, 'draft');
  expect(draft?.lines).toEqual([
    { productId: products['Birdie Pale Ale'], qty: 2 },
    { productId: products['Fairway Lager'], qty: 1 },
  ]);
  expect(draft?.memberId).toBeDefined();

  await expectNoHorizontalScroll(page);
  await action(page, 'Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
});

test('line plus adds one and line minus voids one, with a void audit event', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  const basket = await openBasket(page);
  await basket.getByRole('button', { name: 'Add one Club Bitter' }).click();
  await basket.getByRole('button', { name: 'Add one Club Bitter' }).click();
  await expectMoney(basket.getByTestId('basket-total'), 1260);
  await expect(basket.getByRole('list', { name: 'Basket lines' })).toContainText('3 ×');

  // A manager voids directly: no override dialog, no override event (D-070).
  await basket.getByRole('button', { name: 'Remove one Club Bitter' }).click();
  await expectMoney(basket.getByTestId('basket-total'), 840);
  await closeBasket(page);
  await expectTotal(page, 840);

  const products = await idsByName<Product>(page, 'products');
  await expect.poll(async () => (await readAuditEvents(page)).length).toBe(1);
  const [event] = await readAuditEvents(page);
  expect(event).toMatchObject({
    type: 'void',
    detail: { productId: products['Club Bitter'], productName: 'Club Bitter', qty: 1, unitPricePence: 420 },
  });
  expect(event?.approvedById).toBeUndefined();
});

test('staff need a supervisor PIN to void or open the drawer; both are audited', async ({ page }) => {
  await setUpTrading(page);
  await lock(page);
  await login(page, STAFF.pin);
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);

  await addProduct(page, 'Draught', 'Fairway Lager', 3);
  await expectTotal(page, 1440);

  // Void and No sale are visible and enabled for staff (D-070).
  await action(page, 'Void').click();
  const voidDialog = page.getByRole('dialog', { name: 'Void item' });
  await expect(voidDialog.getByRole('radio', { name: /3 × Fairway Lager/ })).toBeChecked();
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('3');
  await voidDialog.getByRole('button', { name: 'Void fewer' }).click();
  await voidDialog.getByRole('button', { name: 'Void fewer' }).click();
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('1');
  await voidDialog.getByRole('button', { name: 'Confirm void' }).click();

  // Staff get the override; a staff PIN is not enough.
  const override = page.getByRole('dialog', { name: 'Supervisor or manager PIN' });
  await expect(override).toBeVisible();
  await enterPin(override, STAFF.pin);
  await expect(override.getByText('PIN not accepted')).toBeVisible();
  await approveOverride(page, SUPERVISOR.pin);
  await expect(voidDialog).toBeHidden();
  await expectTotal(page, 960);

  await action(page, 'No sale').click();
  await approveOverride(page, SUPERVISOR.pin);
  await expect(page.getByTestId('toast').filter({ hasText: 'Drawer opened' })).toBeVisible();

  const staff = await idsByName<Staff>(page, 'staff');
  const products = await idsByName<Product>(page, 'products');
  await expect.poll(async () => (await readAuditEvents(page)).length).toBe(4);
  const events = await readAuditEvents(page);
  const sam = staff[STAFF.name];
  const sue = staff[SUPERVISOR.name];
  expect(events.filter((e: AuditEvent) => e.type === 'override').map((e) => e.detail)).toEqual(
    expect.arrayContaining([{ action: 'voidLine' }, { action: 'noSale' }]),
  );
  for (const event of events) expect(event).toMatchObject({ staffId: sam, approvedById: sue });
  expect(events.find((e) => e.type === 'void')).toMatchObject({
    detail: { productId: products['Fairway Lager'], productName: 'Fairway Lager', qty: 1, unitPricePence: 480 },
  });
  expect(events.filter((e) => e.type === 'noSale')).toHaveLength(1);
  await expectNoHorizontalScroll(page);
});

test('tabs by name and by table: open, add to, load and save back', async ({ page }) => {
  await setUpTrading(page);
  const products = await idsByName<Product>(page, 'products');

  // New tab by name: the basket moves onto it.
  await addProduct(page, 'Draught', 'Fairway Lager', 2);
  await action(page, 'Tab').click();
  let dialog = page.getByRole('dialog', { name: 'Tab' });
  await expect(dialog.getByRole('radio', { name: 'Name' })).toBeChecked();
  await dialog.getByLabel('Tab name').fill('Smith');
  await dialog.getByRole('button', { name: 'Open tab' }).click();
  await expect(dialog).toBeHidden();
  await expectTotal(page, 0);
  await expect(page.getByTestId('toast').filter({ hasText: 'Basket moved to new tab Smith' })).toBeVisible();

  // Add a second round to the same tab.
  await addProduct(page, 'Snacks', 'Ready Salted Crisps');
  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByRole('button', { name: 'Add to Smith' }).click();
  await expect(dialog).toBeHidden();
  await expectTotal(page, 0);

  // A table tab.
  await addProduct(page, 'Soft Drinks', 'Cola');
  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByRole('radio', { name: 'Table' }).check();
  await dialog.getByLabel('Table number').fill('5');
  await dialog.getByRole('button', { name: 'Open tab' }).click();
  await expect(dialog).toBeHidden();

  // A clashing name is refused inline and the basket is kept (D-064).
  await addProduct(page, 'Soft Drinks', 'Lemonade');
  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByLabel('Tab name').fill('smith ');
  await dialog.getByRole('button', { name: 'Open tab' }).click();
  await expect(dialog.getByText(/smith is already open/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to Table 5' }).click();
  await expect(dialog).toBeHidden();

  let tabs = await readStore<Tab>(page, 'tabs');
  const smith = tabs.find((t) => t.label === 'Smith');
  const table5 = tabs.find((t) => t.label === '5');
  expect(smith).toMatchObject({
    labelType: 'name',
    status: 'open',
    lines: [
      { productId: products['Fairway Lager'], qty: 2 },
      { productId: products['Ready Salted Crisps'], qty: 1 },
    ],
  });
  expect(table5).toMatchObject({
    labelType: 'table',
    status: 'open',
    lines: [
      { productId: products['Cola'], qty: 1 },
      { productId: products['Lemonade'], qty: 1 },
    ],
  });

  // Empty basket: load Smith onto the till (tab mode), add a round, save it back.
  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByRole('button', { name: 'Load Smith' }).click();
  await expect(dialog).toBeHidden();
  await expectTotal(page, 1080);
  let basket = await openBasket(page);
  await expect(basket.getByTestId('tab-badge')).toContainText('Smith');
  await closeBasket(page);

  await addProduct(page, 'Draught', 'Links IPA');
  await expectTotal(page, 1600);
  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await expect(dialog.getByRole('button', { name: 'Open tab' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save to tab' }).click();
  await expect(dialog).toBeHidden();
  await expectTotal(page, 0);
  basket = await openBasket(page);
  await expect(basket.getByTestId('tab-badge')).toHaveCount(0);
  await closeBasket(page);

  tabs = await readStore<Tab>(page, 'tabs');
  expect(tabs.find((t) => t.id === smith?.id)?.lines).toEqual([
    { productId: products['Fairway Lager'], qty: 2 },
    { productId: products['Ready Salted Crisps'], qty: 1 },
    { productId: products['Links IPA'], qty: 1 },
  ]);
  expect(await readStore(page, 'draft')).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test('a booking with a deposit balance takes the deposit off the bill', async ({ page, context }) => {
  await setUpTrading(page);
  await addProduct(page, 'Wine', 'Prosecco (bottle)');
  await expectTotal(page, 2600);

  // The sample bookings have no deposits yet (D-100).
  await action(page, 'Booking').click();
  let dialog = page.getByRole('dialog', { name: 'Attach booking' });
  await expect(dialog.getByText('No open bookings have a deposit balance.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // A £20.00 deposit through Bookings → Take deposit → Pay (D-027: the till basket is untouched).
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Smith & Jones Wedding' }).click();
  await page.getByRole('button', { name: 'Take deposit', exact: true }).click();
  const deposit = page.getByRole('dialog', { name: 'Take deposit' });
  await enterMoney(deposit, 2000);
  await deposit.getByRole('button', { name: 'Continue to Pay' }).click();
  await expect(page).toHaveURL(/#\/pay$/);
  const receipt = await waitForDocument(context, () => page.getByRole('button', { name: 'Exact', exact: true }).click());
  await receipt.close();
  await expect(page).toHaveURL(/#\/bookings\//);
  await navigate(page, 'Till');
  await expectTotal(page, 2600);
  await action(page, 'Booking').click();
  dialog = page.getByRole('dialog', { name: 'Attach booking' });
  await expect(dialog.getByRole('button', { name: 'Seniors Society Day' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Smith & Jones Wedding' }).click();
  await expect(dialog).toBeHidden();

  // D-023: applied = min(balance, bill) = 2000; due 600.
  await expectTotal(page, 600);
  let basket = await openBasket(page);
  await expect(basket.getByTestId('booking-badge')).toContainText('Smith & Jones Wedding');
  await expect(basket.getByTestId('deposit-line')).toHaveText(/Deposit taken\s*-£20\.00/);
  await closeBasket(page);

  // Bookings are never stored on tabs (D-065).
  await action(page, 'Tab').click();
  const tabDialog = page.getByRole('dialog', { name: 'Tab' });
  await expect(tabDialog.getByText('Detach the booking first')).toBeVisible();
  await expect(tabDialog.getByRole('button', { name: 'Open tab' })).toHaveCount(0);
  await tabDialog.getByRole('button', { name: 'Cancel' }).click();

  basket = await openBasket(page);
  await basket.getByRole('button', { name: 'Remove booking' }).click();
  await expect(basket.getByTestId('deposit-line')).toHaveCount(0);
  await expectMoney(basket.getByTestId('basket-total'), 2600);
  await closeBasket(page);
  await expectNoHorizontalScroll(page);
});

test('a refresh mid-basket restores it after login', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Snacks', 'Ready Salted Crisps', 3);
  await addProduct(page, 'Snacks', 'Chocolate Bar');
  // D-098: 3 x crisps (3 for 2) + chocolate bar = 240 + 140.
  await expectTotal(page, 380);

  await page.reload();
  await login(page, MANAGER.pin);
  await expect(page).toHaveURL(/#\/till$/);
  await expectTotal(page, 380);
  const basket = await openBasket(page);
  await expect(basket.getByTestId('deal-line')).toHaveText(/Snacks 3 for 2\s*-£1\.20/);
  await closeBasket(page);
});

// ---------------------------------------------------------------------------
// Regressions: basket races, tab labels, dialog focus and names (D-064, D-085, D-130, D-132)
// ---------------------------------------------------------------------------

/** The centre of an element, for page.mouse clicks with no wait between them. */
async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a product tapped while Pay opens is never left out of the bill (D-011, D-130)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  await expectTotal(page, 420);
  const pay = await centre(action(page, 'Pay'));
  const lager = await centre(page.getByRole('button', { name: 'Fairway Lager', exact: true }));
  // Pay, then a product straight away, before Pay has finished opening.
  await page.mouse.click(pay.x, pay.y);
  await page.mouse.click(lager.x, lager.y);
  await page.waitForTimeout(500);

  const products = await idsByName<Product>(page, 'products');
  const [draft] = await readStore<Draft>(page, 'draft');
  if (/#\/pay$/.test(page.url())) {
    // Pay opened: the tap was refused while it opened ('Finish or cancel the payment first'), or
    // landed on the Pay screen. Either way the bill is exactly the basket. (The store test in
    // tests/unit/stores.test.ts pins the refusal down deterministically.)
    expect(draft?.lines).toEqual([{ productId: products['Club Bitter'], qty: 1 }]);
    await expectMoney(page.getByTestId('amount-due'), 420);
  } else {
    // The tap landed after Pay had opened: the stale payment was dropped and the till has both (D-011).
    expect(draft?.lines).toEqual([
      { productId: products['Club Bitter'], qty: 1 },
      { productId: products['Fairway Lager'], qty: 1 },
    ]);
    await expectTotal(page, 900);
  }
});

test('two quick taps on line minus void two units, each with its own void event (D-085, D-130)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter', 5);
  await expectTotal(page, 2100);
  const basket = await openBasket(page);
  const minus = await centre(basket.getByRole('button', { name: 'Remove one Club Bitter' }));
  await page.mouse.click(minus.x, minus.y);
  await page.mouse.click(minus.x, minus.y);
  await expectMoney(basket.getByTestId('basket-total'), 1260);
  await expect.poll(async () => (await readAuditEvents(page)).filter((e) => e.type === 'void').length).toBe(2);
  const [draft] = await readStore<Draft>(page, 'draft');
  expect(draft?.lines.map((l) => l.qty)).toEqual([3]);
  await closeBasket(page);

  if (!isNarrow(page)) {
    // A product tapped while a void is being written is kept (the side panel and grid are both on screen).
    const lager = await centre(page.getByRole('button', { name: 'Fairway Lager', exact: true }));
    await page.mouse.click(minus.x, minus.y);
    await page.mouse.click(lager.x, lager.y);
    await expectTotal(page, 2 * 420 + 480);
    const products = await idsByName<Product>(page, 'products');
    await expect
      .poll(async () => (await readStore<Draft>(page, 'draft'))[0]?.lines)
      .toEqual([
        { productId: products['Club Bitter'], qty: 2 },
        { productId: products['Fairway Lager'], qty: 1 },
      ]);
  }
});

test('table labels take letters and hyphens: the field asks for the full keyboard (D-064)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Soft Drinks', 'Cola');
  await action(page, 'Tab').click();
  const dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByRole('radio', { name: 'Table' }).check();
  const field = dialog.getByLabel('Table number');
  await expect(field).not.toHaveAttribute('inputmode', 'numeric');
  await field.fill('Terrace-1');
  await dialog.getByRole('button', { name: 'Open tab' }).click();
  await expect(dialog).toBeHidden();
  const tabs = await readStore<Tab>(page, 'tabs');
  expect(tabs.map((t) => [t.labelType, t.label])).toEqual([['table', 'Terrace-1']]);
});

test('the member dialog returns focus to Member; the phone basket bar is named by what it shows', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  const member = action(page, 'Member');
  await member.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Attach member' });
  await expect(dialog.getByLabel('Search members')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(member).toBeFocused();

  // After attaching a member (the main path) focus is back on Member too.
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Search members').fill('1001');
  await dialog.getByRole('button', { name: '1001 — Alice Archer', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(member).toBeFocused();

  if (isNarrow(page)) {
    // WCAG 2.5.3: the bar's name contains its visible count and total.
    await expect(page.getByRole('button', { name: /^View basket 1 item\s*(Alice Archer\s*)?£3\.57$/ })).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// Regressions: the phone bar at four figures; keyboard focus that stays put (D-134)
// ---------------------------------------------------------------------------

test('phone basket bar: the item count is never drawn over a four-figure total', async ({ page }) => {
  test.skip(!isNarrow(page), 'The basket bar is the phone layout');
  await setUpTrading(page);
  const measure = (): Promise<{ countRight: number; totalLeft: number; countCut: boolean }> =>
    page.evaluate(() => {
      const textBox = (el: Element): DOMRect => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect();
      };
      const count = document.querySelector('[data-testid="basket-bar-count"]');
      const total = document.querySelector('[data-testid="basket-bar-total"]');
      if (count === null || total === null) throw new Error('no basket bar');
      return { countRight: textBox(count).right, totalLeft: textBox(total).left, countCut: count.scrollWidth > count.clientWidth };
    });

  // 39 × Prosecco (bottle) = £1,014.00; 100 × = £2,600.00.
  await addProduct(page, 'Wine', 'Prosecco (bottle)', 39);
  await expectTotal(page, 101_400);
  let bar = await measure();
  expect(bar.countRight, '39 items ends before £1,014.00 starts').toBeLessThanOrEqual(bar.totalLeft);
  expect(bar.countCut).toBe(false);

  await addProduct(page, 'Wine', 'Prosecco (bottle)', 61);
  await expectTotal(page, 260_000);
  bar = await measure();
  expect(bar.countRight, '100 items ends before £2,600.00 starts').toBeLessThanOrEqual(bar.totalLeft);
  expect(bar.countCut).toBe(false);
  await expect(page.getByTestId('basket-bar-count')).toHaveText('100 items');
  await expectNoHorizontalScroll(page);
});

test('keyboard focus stays put: No sale while it saves, the Void steppers at their limits, a refused tab name (D-134)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter', 2);

  // No sale (the manager needs no PIN): the button keeps focus while it saves.
  const noSale = action(page, 'No sale');
  await noSale.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast').filter({ hasText: 'Drawer opened' })).toBeVisible();
  await expect(noSale).toBeFocused();

  // Void: a stepper that reaches its limit hands focus to the other one, inside the dialog.
  await action(page, 'Void').click();
  const voidDialog = page.getByRole('dialog', { name: 'Void item' });
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('2');
  await voidDialog.getByRole('button', { name: 'Void fewer' }).focus();
  await page.keyboard.press('Enter');
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('1');
  await expect(voidDialog.getByRole('button', { name: 'Void more' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('2');
  await expect(voidDialog.getByRole('button', { name: 'Void fewer' })).toBeFocused();
  await voidDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(voidDialog).toBeHidden();

  // Tab: Enter with no name keeps focus on the field, which says why at once (an alert).
  await action(page, 'Tab').click();
  const tabDialog = page.getByRole('dialog', { name: 'Tab' });
  const name = tabDialog.getByLabel('Tab name');
  await expect(name).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tabDialog.getByRole('alert').filter({ hasText: 'Enter a name' })).toBeVisible();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(await readStore<Tab>(page, 'tabs')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Regressions: an emptied tab, focus that never falls to <body>, forced colours, lock (D-135)
// ---------------------------------------------------------------------------

test('a tab with every line voided offers Remove tab and says it was removed, not saved (D-063 d, D-135)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter', 2);
  await action(page, 'Tab').click();
  let dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByLabel('Tab name').fill('Smith');
  await dialog.getByRole('button', { name: 'Open tab' }).click();
  await expect(dialog).toBeHidden();

  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByRole('button', { name: 'Load Smith' }).click();
  await expect(dialog).toBeHidden();
  await expectTotal(page, 840);
  await action(page, 'Void').click();
  const voidDialog = page.getByRole('dialog', { name: 'Void item' });
  await expect(voidDialog.getByTestId('void-qty')).toHaveText('2');
  await voidDialog.getByRole('button', { name: 'Confirm void' }).click();
  await expect(voidDialog).toBeHidden();
  await expectTotal(page, 0);

  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await expect(dialog.getByRole('button', { name: 'Save to tab' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Remove tab' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Tab Smith removed (no items left)' })).toBeVisible();
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved to Smith' })).toHaveCount(0);
  const [smith] = await readStore<Tab>(page, 'tabs');
  expect(smith?.deletedAt).toBeDefined();
  await navigate(page, 'Tabs');
  await expect(page.getByText('Smith', { exact: true })).toHaveCount(0);
});

test('focus never falls to <body> when the focused control goes away (D-135)', async ({ page }) => {
  await setUpTrading(page);
  /** Where focus is: lost (<body>) or not, and whether it is inside an open dialog. */
  const focusState = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return {
        lost: active === null || active === document.body,
        inDialog: active?.closest('[role="dialog"]')?.getAttribute('aria-modal') === 'true',
      };
    });

  // Void the only line from the Void dialog: Void is disabled afterwards, so focus can't go back to it.
  await addProduct(page, 'Draught', 'Club Bitter');
  const voidButton = action(page, 'Void');
  await voidButton.focus();
  await page.keyboard.press('Enter');
  const voidDialog = page.getByRole('dialog', { name: 'Void item' });
  await voidDialog.getByRole('button', { name: 'Confirm void' }).focus();
  await page.keyboard.press('Enter');
  await expect(voidDialog).toBeHidden();
  await expect(voidButton).toBeDisabled();
  expect(await focusState()).toMatchObject({ lost: false });

  // '−' on a line's last unit removes the line (and the button): focus stays in the basket,
  // which on the phone is the open basket sheet.
  await addProduct(page, 'Draught', 'Club Bitter');
  await addProduct(page, 'Draught', 'Fairway Lager');
  let basket = await openBasket(page);
  await basket.getByRole('button', { name: 'Remove one Club Bitter' }).focus();
  await page.keyboard.press('Enter');
  await expect(basket.getByRole('button', { name: 'Remove one Club Bitter' })).toHaveCount(0);
  await expect.poll(focusState).toEqual({ lost: false, inDialog: isNarrow(page) });
  await closeBasket(page);

  // Remove member: the badge goes, focus stays in the basket.
  await attachMember(page, '1001', '1001 — Alice Archer');
  basket = await openBasket(page);
  await basket.getByRole('button', { name: 'Remove member' }).focus();
  await page.keyboard.press('Enter');
  await expect(basket.getByTestId('member-badge')).toHaveCount(0);
  await expect.poll(focusState).toEqual({ lost: false, inDialog: isNarrow(page) });
  await closeBasket(page);
});

test('a button that changes screen hands focus to the new screen’s heading, never <body> (D-136)', async ({ page }) => {
  await setUpTrading(page);
  /** 'body' when focus is lost, else the focused element's tag and text (e.g. 'h1 Pay'). */
  const focused = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) return 'body';
      return `${active.tagName.toLowerCase()} ${active.textContent?.trim() ?? ''}`;
    });
  const pressEnterOn = async (control: Locator): Promise<void> => {
    await control.focus();
    await page.keyboard.press('Enter');
  };

  // Pay (beside the basket on the tablet, in the basket bar on the phone) and back.
  await addProduct(page, 'Draught', 'Club Bitter');
  await pressEnterOn(page.getByRole('button', { name: 'Pay', exact: true }));
  await expect(page).toHaveURL(/#\/pay$/);
  await expect.poll(focused).toBe('h1 Pay');
  await pressEnterOn(page.getByRole('button', { name: 'Back to basket' }));
  await expect(page).toHaveURL(/#\/till$/);
  await expect.poll(focused).toBe('h1 Till');

  if (isNarrow(page)) {
    // The open basket sheet's own Pay: the sheet closes as the till goes.
    const sheet = await openBasket(page);
    await pressEnterOn(sheet.getByRole('button', { name: /^Pay £/ }));
    await expect(page).toHaveURL(/#\/pay$/);
    await expect.poll(focused).toBe('h1 Pay');
    await pressEnterOn(page.getByRole('button', { name: 'Back to basket' }));
    await expect(page).toHaveURL(/#\/till$/);
  }

  // A link inside a lazily loaded screen, and a dialog whose button changes screen.
  await navigate(page, 'Bookings');
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeFocused();
  await pressEnterOn(page.getByRole('link', { name: 'Seniors Society Day' }));
  await expect(page).toHaveURL(/#\/bookings\/.+/);
  await expect.poll(focused).toBe('h1 Seniors Society Day');
  await page.getByRole('button', { name: 'Take deposit' }).click();
  const deposit = page.getByRole('dialog', { name: 'Take deposit' });
  await enterMoney(deposit, 1000);
  await pressEnterOn(deposit.getByRole('button', { name: 'Continue to Pay' }));
  await expect(page).toHaveURL(/#\/pay$/);
  await expect.poll(focused).toBe('h1 Pay');
});

test('forced colours (Windows High Contrast) keep product edges, the selected category and the selected line visible (D-135)', async ({ page }) => {
  test.skip(isNarrow(page), 'Basket lines are selectable in the tablet layout');
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  const basket = await openBasket(page);
  await basket.getByRole('button', { name: /^1 × Club Bitter, / }).click();
  await page.emulateMedia({ forcedColors: 'active' });
  const styles = await page.evaluate(() => {
    const css = (el: Element | null): CSSStyleDeclaration => {
      if (el === null) throw new Error('element not found');
      return getComputedStyle(el);
    };
    const product = css(document.querySelector('[role="tabpanel"] button'));
    const selectedTab = css(document.querySelector('[role="tab"][aria-selected="true"]'));
    const otherTab = css(document.querySelector('[role="tab"][aria-selected="false"]'));
    const line = css(document.querySelector('[aria-pressed="true"]')?.closest('li') ?? null);
    return {
      productBorder: `${product.borderTopStyle} ${product.borderTopWidth}`,
      tabsDiffer: selectedTab.backgroundColor !== otherTab.backgroundColor,
      lineOutline: line.outlineStyle,
    };
  });
  expect(styles).toEqual({ productBorder: 'solid 2px', tabsDiffer: true, lineOutline: 'solid' });
});

test('a basket with a deal and a member, and a loaded tab, survive Lock and auto-lock (D-078)', async ({ page }) => {
  await page.clock.install();
  await setUpTrading(page);
  // D-098: 2 × Birdie Pale Ale + 1 × Fairway Lager with member 1001 = £10.88.
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  await addProduct(page, 'Draught', 'Fairway Lager');
  await attachMember(page, '1001', '1001 — Alice Archer');
  await expectTotal(page, 1088);

  const expectKept = async (): Promise<void> => {
    await expectTotal(page, 1088);
    const basket = await openBasket(page);
    await expect(basket.getByTestId('member-badge')).toContainText('1001 — Alice Archer');
    await expect(basket.getByTestId('deal-line')).toContainText('Any 2 bottles for £8');
    await expect(basket.getByTestId('member-discount-line')).toContainText('-£1.92');
    await closeBasket(page);
  };

  await lock(page);
  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/till$/);
  await expectKept();

  await page.clock.fastForward('05:02');
  await expect(loginKeypad(page)).toBeVisible();
  await login(page, SUPERVISOR.pin);
  await expectKept();

  // On a tab: move the basket to tab Hendry and load it back, then lock.
  await action(page, 'Tab').click();
  let dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByLabel('Tab name').fill('Hendry');
  await dialog.getByRole('button', { name: 'Open tab' }).click();
  await expect(dialog).toBeHidden();
  await action(page, 'Tab').click();
  dialog = page.getByRole('dialog', { name: 'Tab' });
  await dialog.getByRole('button', { name: 'Load Hendry' }).click();
  await expect(dialog).toBeHidden();
  await lock(page);
  await login(page, STAFF.pin);
  await expectKept();
  const basket = await openBasket(page);
  await expect(basket.getByTestId('tab-badge')).toContainText('Hendry');
  await closeBasket(page);
});

// ---------------------------------------------------------------------------
// Regressions: a failed draft save, adds announced (D-137)
// ---------------------------------------------------------------------------

test('a failed draft save stays on screen with Try again, which brings the saved basket up to date (spec §8, D-095, D-137)', async ({ page }) => {
  await setUpTrading(page);
  await addProduct(page, 'Draught', 'Club Bitter');
  await expectTotal(page, 420);
  const draftLines = async () => (await readStore<Draft>(page, 'draft'))[0]?.lines.map((line) => line.qty) ?? [];
  await expect.poll(draftLines).toEqual([1]);

  // Storage refuses every draft write from now on (e.g. the device is full).
  await page.evaluate(() => {
    const originals = { put: IDBObjectStore.prototype.put, add: IDBObjectStore.prototype.add };
    (window as unknown as { __restoreDraftWrites: () => void }).__restoreDraftWrites = () => {
      IDBObjectStore.prototype.put = originals.put;
      IDBObjectStore.prototype.add = originals.add;
    };
    for (const method of ['put', 'add'] as const) {
      const original = originals[method];
      IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if (this.name === 'draft') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return original.apply(this, args);
      };
    }
  });
  await addProduct(page, 'Draught', 'Fairway Lager');
  await expectTotal(page, 900);
  const banner = page.getByTestId('draft-error');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('The basket could not be saved.');
  await expect(banner).toContainText('If this page is reloaded now, the latest changes to the basket will be lost.');
  await expect(page.getByTestId('toast').filter({ hasText: 'The basket could not be saved as a draft' })).toBeVisible();
  // Re-pricing finishing afterwards does not hide it.
  await page.waitForTimeout(1000);
  await expect(banner).toBeVisible();
  expect(await draftLines()).toEqual([1]);

  // Try again while storage still fails keeps it; once storage works it saves the whole basket.
  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(banner).toBeVisible();
  await page.evaluate(() => (window as unknown as { __restoreDraftWrites: () => void }).__restoreDraftWrites());
  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(banner).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Basket saved' })).toBeVisible();
  await expect.poll(draftLines).toEqual([1, 1]);

  await page.reload();
  await login(page, MANAGER.pin);
  await expectTotal(page, 900);
});

test('each product added is announced with the basket’s new count and total (WCAG 4.1.3, D-137)', async ({ page }) => {
  await setUpTrading(page);
  const announcement = page.getByTestId('till-announcement');
  await expect(announcement).toHaveAttribute('role', 'status');
  await expect(announcement).toHaveText('');
  await addProduct(page, 'Draught', 'Club Bitter');
  await expect(announcement).toHaveText('Club Bitter added. 1 item, £4.20.');
  await addProduct(page, 'Draught', 'Club Bitter');
  await expect(announcement).toHaveText('Club Bitter added. 2 items, £8.40.');

  // A line's + is announced too; on a phone the region is inside the open basket sheet, since the
  // rest of the app is inert behind it.
  const basket = await openBasket(page);
  const region = isNarrow(page) ? basket.getByTestId('till-announcement') : announcement;
  await expect(page.getByTestId('till-announcement')).toHaveCount(1);
  await basket.getByRole('button', { name: 'Add one Club Bitter' }).click();
  await expect(region).toHaveText('Club Bitter added. 3 items, £12.60.');
  await closeBasket(page);
  await expect(announcement).toHaveCount(1);

  // A product from another category, by its own button.
  await addProduct(page, 'Snacks', 'Chocolate Bar');
  await expect(announcement).toHaveText('Chocolate Bar added. 4 items, £14.00.');
});
