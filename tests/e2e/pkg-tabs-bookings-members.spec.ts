/**
 * Tabs, Bookings and Members screens (spec §6.5, §6.6, §6.7; D-026, D-027, D-062..D-065, D-070,
 * D-071, D-100, D-104, D-105). Runs at both viewports: tablet landscape and phone portrait.
 * Figures are the sample data's (D-097, D-098, D-100) and come from the services; the tests
 * assert the exact pence the decisions give.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AuditEvent, Booking, Member, Sale, Staff, Tab } from '../../src/data/types';
import {
  MANAGER,
  STAFF,
  approveOverride,
  enterMoney,
  expectMoney,
  expectNoHorizontalScroll,
  firstRun,
  freshStart,
  isNarrow,
  lock,
  login,
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

function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

async function expectHeading(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

/** Taps a product `times` times from its category tab on the till. */
async function addProduct(page: Page, category: string, name: string, times = 1): Promise<void> {
  await page.getByRole('tab', { name: category, exact: true }).click();
  const product = button(page, name);
  for (let i = 0; i < times; i += 1) await product.click();
}

/** The till's always-visible running total: basket-total (tablet) or basket-bar-total (phone). */
async function expectTillTotal(page: Page, pence: number): Promise<void> {
  await expectMoney(page.getByTestId(isNarrow(page) ? 'basket-bar-total' : 'basket-total'), pence);
}

/** Till: Tab → New tab by name or table. */
async function openNewTab(page: Page, labelType: 'name' | 'table', label: string): Promise<void> {
  await button(page, 'Tab').click();
  const dialog = page.getByRole('dialog', { name: 'Tab' });
  if (labelType === 'table') await dialog.getByRole('radio', { name: 'Table' }).check();
  await dialog.getByLabel(labelType === 'table' ? 'Table number' : 'Tab name').fill(label);
  await button(dialog, 'Open tab').click();
  await expect(dialog).toBeHidden();
}

async function attachMember(page: Page, query: string, label: string): Promise<void> {
  await button(page, 'Member').click();
  const dialog = page.getByRole('dialog', { name: 'Attach member' });
  await dialog.getByLabel('Search members').fill(query);
  await button(dialog, label).click();
  await expect(dialog).toBeHidden();
}

/** The Tabs screen card for a tab, by its display label ('Smith', 'Table 5'). */
function tabCard(page: Page, label: string): Locator {
  return page.getByTestId('tab-row').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
}

/** A booking row on the Bookings list, by booking name. */
function bookingRow(page: Page, name: string): Locator {
  return page.getByRole('link', { name, exact: true });
}

/** Today's date in the club's time zone (D-102) as 'YYYY-MM-DD'. */
function londonToday(): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 'YYYY-MM-DD' + n days, shown as 'DD/MM/YYYY' (D-102). */
function displayDatePlus(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const iso = d.toISOString().slice(0, 10);
  const [y, m, day] = iso.split('-');
  return `${day}/${m}/${y}`;
}

async function memberSearch(page: Page, query: string): Promise<Locator> {
  await page.getByLabel('Search members').fill(query);
  return page.getByRole('list', { name: query.trim() === '' ? 'Active members' : 'Matching members' });
}

// ---------------------------------------------------------------------------
// Tabs (spec §6.6)
// ---------------------------------------------------------------------------

test('tabs screen: every open tab with label, total and time open; Load puts it on the till; Settle goes to Pay and keeps the member', async ({
  page,
  context,
}) => {
  await setUpTrading(page);

  // Nothing open yet.
  await navigate(page, 'Tabs');
  await expectHeading(page, 'Tabs');
  await expect(page.getByTestId('tabs-empty')).toContainText('No open tabs');
  await navigate(page, 'Till');

  // Smith: 2 × Fairway Lager = 960. Table 5: 1 × Ready Salted Crisps with Alice (15% off 120) = 102.
  await addProduct(page, 'Draught', 'Fairway Lager', 2);
  await openNewTab(page, 'name', 'Smith');
  await addProduct(page, 'Snacks', 'Ready Salted Crisps');
  await attachMember(page, 'arch', '1001 — Alice Archer');
  await openNewTab(page, 'table', '5');
  await expectTillTotal(page, 0);

  await navigate(page, 'Tabs');
  await expectHeading(page, 'Tabs');
  const rows = page.getByTestId('tab-row');
  await expect(rows).toHaveCount(2);
  // Oldest first (D-064).
  await expect(rows.nth(0).getByRole('heading', { level: 2 })).toHaveText('Smith');
  await expect(rows.nth(1).getByRole('heading', { level: 2 })).toHaveText('Table 5');

  const smith = tabCard(page, 'Smith');
  await expectMoney(smith.getByTestId('tab-total'), 960);
  await expect(smith.getByTestId('tab-time-open')).toHaveText('Open 0m');
  await expect(smith).toContainText('2 items');
  await expect(smith.getByTestId('tab-member')).toHaveCount(0);

  const table5 = tabCard(page, 'Table 5');
  await expectMoney(table5.getByTestId('tab-total'), 102);
  await expect(table5.getByTestId('tab-time-open')).toHaveText('Open 0m');
  await expect(table5).toContainText('1 item');
  await expect(table5.getByTestId('tab-member')).toHaveText('1001 — Alice Archer');

  await expect(page.getByTestId('tabs-summary')).toContainText('2 open tabs');
  await expectMoney(page.getByTestId('tabs-summary-total'), 1062);
  await expectNoHorizontalScroll(page);

  // Load Smith: its lines go into the basket (tab mode) and the till shows it.
  await button(page, 'Load Smith').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expect(page.getByTestId('toast').filter({ hasText: 'Tab Smith is on the till' })).toBeVisible();
  await expectTillTotal(page, 960);

  // Back on Tabs: Smith is 'On till'; other tabs can't be loaded until the basket is clear.
  await navigate(page, 'Tabs');
  await expect(smith.getByTestId('tab-on-till')).toHaveText('On till');
  await expect(smith.getByRole('link', { name: 'Go to till with Smith', exact: true })).toBeVisible();
  await expect(page.getByTestId('tabs-basket-busy')).toContainText('A tab is on the till');
  await expect(button(table5, 'Load Table 5')).toBeDisabled();
  await expect(button(table5, 'Settle Table 5')).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // Settle the tab that is on the till: straight to Pay for £9.60.
  await button(smith, 'Settle Smith').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), 960);
  let receipt = await waitForDocument(context, () => button(page, 'Exact').click());
  await expect(receipt).toHaveTitle(/^Receipt [0-9A-F]{4}-000001$/);
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);

  // Settle Table 5 from the Tabs screen: it loads (member attached) and opens Pay at £1.02.
  await navigate(page, 'Tabs');
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId('tabs-basket-busy')).toHaveCount(0);
  await button(table5, 'Settle Table 5').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), 102);
  receipt = await waitForDocument(context, () => button(page, 'Card').click());
  await expect(receipt).toHaveTitle(/^Receipt [0-9A-F]{4}-000002$/);
  await expect(receipt.locator('body')).toContainText('1001');
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);

  await navigate(page, 'Tabs');
  await expect(page.getByTestId('tabs-empty')).toBeVisible();

  // The data: both tabs settled; the Table 5 sale carries its tab and Alice (spec §6.6, D-065).
  const tabs = await readStore<Tab>(page, 'tabs');
  const members = await readStore<Member>(page, 'members');
  const alice = members.find((m) => m.memberNumber === '1001');
  expect(tabs.map((t) => t.status)).toEqual(['settled', 'settled']);
  const sales = await readStore<Sale>(page, 'sales');
  const tableTab = tabs.find((t) => t.labelType === 'table');
  const smithTab = tabs.find((t) => t.labelType === 'name');
  expect(sales.find((s) => s.tabId === smithTab?.id)).toMatchObject({ kind: 'sale', totalPence: 960 });
  expect(sales.find((s) => s.tabId === tableTab?.id)).toMatchObject({ kind: 'sale', totalPence: 102, memberId: alice?.id, memberDiscountPence: 18 });
});

// ---------------------------------------------------------------------------
// Bookings (spec §6.7)
// ---------------------------------------------------------------------------

test('bookings: list with type, date, status and balance; create and edit; take a deposit through Pay; settle once it is used; cancel', async ({
  page,
  context,
}) => {
  await setUpTrading(page);
  const today = londonToday();

  // The two sample bookings, by date (D-100).
  await navigate(page, 'Bookings');
  await expectHeading(page, 'Bookings');
  const openList = page.getByRole('list', { name: 'Open bookings' });
  await expect(openList.getByRole('link')).toHaveCount(2);
  await expect(openList.getByRole('link').nth(0)).toHaveAccessibleName('Seniors Society Day');
  await expect(openList.getByRole('link').nth(1)).toHaveAccessibleName('Smith & Jones Wedding');
  const seniors = bookingRow(page, 'Seniors Society Day');
  await expect(seniors).toContainText('Society day');
  await expect(seniors.getByTestId('booking-row-date')).toHaveText(displayDatePlus(today, 14));
  await expect(seniors).toContainText('In 14 days');
  await expect(seniors.getByTestId('booking-row-status')).toHaveText('Open');
  await expectMoney(seniors.getByTestId('booking-row-balance'), 0);
  const wedding = bookingRow(page, 'Smith & Jones Wedding');
  await expect(wedding).toContainText('Wedding');
  await expect(wedding.getByTestId('booking-row-date')).toHaveText(displayDatePlus(today, 30));
  await expect(wedding).toContainText('In 30 days');
  await expectNoHorizontalScroll(page);

  // Create: the fields are checked before saving.
  await button(page, 'New booking').click();
  let form = page.getByRole('dialog', { name: 'New booking' });
  await expect(form.getByRole('radio', { name: 'Wedding' })).toBeChecked();
  await button(form, 'Save booking').click();
  await expect(form.getByText('Enter a name')).toBeVisible();
  await expect(form.getByText('Enter a valid date')).toBeVisible();
  await form.getByRole('radio', { name: 'Event tickets' }).check();
  await form.getByLabel('Name', { exact: true }).fill('Autumn Quiz Night');
  await form.getByLabel('Date', { exact: true }).fill('2027-03-12');
  await form.getByLabel('Notes', { exact: true }).fill('Teams of four');
  await button(form, 'Save booking').click();
  await expect(form).toBeHidden();
  await expect(page).toHaveURL(/#\/bookings\/[0-9a-f-]+$/);
  await expectHeading(page, 'Autumn Quiz Night');
  await expect(page.getByTestId('booking-type')).toHaveText('Event tickets');
  await expect(page.getByTestId('booking-date')).toHaveText('12/03/2027');
  await expect(page.getByTestId('booking-notes')).toHaveText('Teams of four');
  await expect(page.getByTestId('booking-status')).toHaveText('Open');
  await expectMoney(page.getByTestId('booking-balance'), 0);
  await expectNoHorizontalScroll(page);

  // Edit.
  await button(page, 'Edit details').click();
  form = page.getByRole('dialog', { name: 'Edit booking' });
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Autumn Quiz Night');
  await form.getByRole('radio', { name: 'Other' }).check();
  await form.getByLabel('Notes', { exact: true }).fill('Teams of four, 20 tables');
  await button(form, 'Save booking').click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('booking-type')).toHaveText('Other');
  await expect(page.getByTestId('booking-notes')).toHaveText('Teams of four, 20 tables');

  // Take a £25.00 deposit: keypad → Pay → Exact → receipt → back to the booking.
  await button(page, 'Take deposit').click();
  const deposit = page.getByRole('dialog', { name: 'Take deposit' });
  await expect(button(deposit, 'Continue to Pay')).toBeDisabled();
  await enterMoney(deposit, 2500);
  await expectMoney(deposit.getByTestId('deposit-amount'), 2500);
  await button(deposit, 'Continue to Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), 2500);
  let receipt = await waitForDocument(context, () => button(page, 'Exact').click());
  await expect(receipt).toHaveTitle(/^Receipt [0-9A-F]{4}-000001$/);
  await receipt.close();
  await expect(page).toHaveURL(/#\/bookings\/[0-9a-f-]+$/);
  await expectHeading(page, 'Autumn Quiz Night');
  await expectMoney(page.getByTestId('booking-balance'), 2500);
  // A balance is left, so it can be neither settled nor cancelled (D-026).
  await expect(button(page, 'Mark settled')).toBeDisabled();
  await expect(button(page, 'Cancel booking')).toBeDisabled();
  await expect(page.getByText('it is £25.00 now')).toBeVisible();

  // Use the deposit on a bill: 2 × Buffet Ticket = £30.00, deposit £25.00, £5.00 to pay.
  await navigate(page, 'Till');
  await addProduct(page, 'Events', 'Buffet Ticket', 2);
  await button(page, 'Booking').click();
  const attach = page.getByRole('dialog', { name: 'Attach booking' });
  await button(attach, 'Autumn Quiz Night').click();
  await expect(attach).toBeHidden();
  await expectTillTotal(page, 500);
  await button(page, 'Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), 500);
  receipt = await waitForDocument(context, () => button(page, '£5').click());
  await receipt.close();
  await expect(page).toHaveURL(/#\/till$/);

  // Balance used: Mark settled (confirmed).
  await navigate(page, 'Bookings');
  const quiz = bookingRow(page, 'Autumn Quiz Night');
  await expectMoney(quiz.getByTestId('booking-row-balance'), 0);
  await quiz.click();
  await expectHeading(page, 'Autumn Quiz Night');
  await expectMoney(page.getByTestId('booking-balance'), 0);
  await button(page, 'Mark settled').click();
  const confirmSettle = page.getByRole('dialog', { name: 'Mark this booking settled?' });
  await button(confirmSettle, 'Mark settled').click();
  await expect(confirmSettle).toBeHidden();
  await expect(page.getByTestId('booking-status')).toHaveText('Settled');
  await expect(page.getByTestId('booking-closed')).toContainText('read-only');
  await expect(button(page, 'Take deposit')).toHaveCount(0);
  await expect(button(page, 'Edit details')).toHaveCount(0);

  // Cancel a booking with no deposit (allowed at a zero balance, D-026).
  await page.getByRole('link', { name: 'All bookings' }).click();
  await expectHeading(page, 'Bookings');
  await bookingRow(page, 'Seniors Society Day').click();
  await expectHeading(page, 'Seniors Society Day');
  await button(page, 'Cancel booking').click();
  const confirmCancel = page.getByRole('dialog', { name: 'Cancel this booking?' });
  await button(confirmCancel, 'Cancel booking').click();
  await expect(confirmCancel).toBeHidden();
  await expect(page.getByTestId('booking-status')).toHaveText('Cancelled');

  // The list: one open booking; the closed ones are folded away with their status.
  await page.getByRole('link', { name: 'All bookings' }).click();
  await expect(openList.getByRole('link')).toHaveCount(1);
  await expect(openList.getByRole('link')).toHaveAccessibleName('Smith & Jones Wedding');
  await page.getByText('Settled and cancelled', { exact: false }).click();
  const closedList = page.getByRole('list', { name: 'Settled and cancelled bookings' });
  await expect(closedList.getByRole('link')).toHaveCount(2);
  await expect(bookingRow(page, 'Seniors Society Day').getByTestId('booking-row-status')).toHaveText('Cancelled');
  await expect(bookingRow(page, 'Autumn Quiz Night').getByTestId('booking-row-status')).toHaveText('Settled');
  await expectNoHorizontalScroll(page);

  const bookings = await readStore<Booking>(page, 'bookings');
  expect(bookings.find((b) => b.name === 'Autumn Quiz Night')).toMatchObject({
    type: 'other',
    date: '2027-03-12',
    notes: 'Teams of four, 20 tables',
    status: 'settled',
  });
  expect(bookings.find((b) => b.name === 'Seniors Society Day')?.status).toBe('cancelled');
  const sales = await readStore<Sale>(page, 'sales');
  expect(sales.find((s) => s.kind === 'deposit')).toMatchObject({ totalPence: 2500, lines: [], tenders: [{ type: 'cash', amountPence: 2500 }] });
  expect(sales.find((s) => s.kind === 'sale')).toMatchObject({ depositAppliedPence: 2500, totalPence: 500 });
});

test('a booking with a deposit part-paid on Pay stays open; once closed, its untaken deposit payment is dropped (D-134)', async ({ page }) => {
  await setUpTrading(page);
  const openSeniors = async (): Promise<void> => {
    await navigate(page, 'Bookings');
    await bookingRow(page, 'Seniors Society Day').click();
    await expectHeading(page, 'Seniors Society Day');
  };
  const takeDeposit = async (pence: number): Promise<void> => {
    await button(page, 'Take deposit').click();
    const dialog = page.getByRole('dialog', { name: 'Take deposit' });
    await enterMoney(dialog, pence);
    await button(dialog, 'Continue to Pay').click();
    await expect(page).toHaveURL(/#\/pay$/);
  };

  // £10 of a £20 deposit is in the drawer: the booking can't be closed until it is saved or handed back.
  await openSeniors();
  await takeDeposit(2000);
  await button(page, '£10').click();
  await expectMoney(page.getByTestId('remaining'), 1000);
  await openSeniors();
  const busy = page.getByTestId('booking-deposit-in-progress');
  await expect(busy).toContainText('A deposit payment for this booking is in progress');
  await expect(button(page, 'Cancel booking')).toBeDisabled();
  await expect(button(page, 'Mark settled')).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // Handed back: the booking can close again.
  await busy.getByRole('link', { name: 'Back to Pay' }).click();
  await button(page, 'Cancel payment').click();
  await button(page.getByRole('dialog', { name: 'Cancel this payment?' }), 'Yes, cancel').click();
  await expect(page).toHaveURL(/#\/bookings\//);
  await expect(page.getByTestId('booking-deposit-in-progress')).toHaveCount(0);

  // A deposit started and left with nothing taken: cancelling the booking drops it, so the next
  // login is on the till, not a Pay screen for a cancelled booking.
  await takeDeposit(20_000);
  await openSeniors();
  await expect(button(page, 'Cancel booking')).toBeEnabled();
  await button(page, 'Cancel booking').click();
  await button(page.getByRole('dialog', { name: 'Cancel this booking?' }), 'Cancel booking').click();
  await expect(page.getByTestId('booking-status')).toHaveText('Cancelled');
  await lock(page);
  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/till$/);
  expect((await readStore<Sale>(page, 'sales')).filter((s) => s.kind === 'deposit')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Members (spec §6.5)
// ---------------------------------------------------------------------------

test('members: search by name or number; a manager adds, edits, deactivates and reactivates a member', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await navigate(page, 'Members');
  await expectHeading(page, 'Members');

  // Everyone active is listed until you type (D-100: 20 members).
  let list = await memberSearch(page, '');
  await expect(list.getByRole('button')).toHaveCount(20);
  await expect(list.getByRole('button').first()).toHaveAccessibleName('1001 — Alice Archer');

  // Search by name and by number (D-104).
  list = await memberSearch(page, 'arch');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(button(list, '1001 — Alice Archer')).toBeVisible();
  list = await memberSearch(page, '1012');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(button(list, '1012 — Liam Lockhart')).toBeVisible();
  await memberSearch(page, 'zzz');
  await expect(page.getByText('No active members match')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Add: the next number is suggested; a duplicate number is refused.
  await button(page, 'Add member').click();
  let dialog = page.getByRole('dialog', { name: 'Add member' });
  await expect(dialog.getByLabel('Member number')).toHaveValue('1021');
  await dialog.getByLabel('Member number').fill('1001');
  await dialog.getByLabel('First name').fill('Una');
  await dialog.getByLabel('Last name').fill('Underwood');
  await button(dialog, 'Save member').click();
  await expect(dialog.getByText('Another member already has that number')).toBeVisible();
  await dialog.getByLabel('Member number').fill('1021');
  await button(dialog, 'Save member').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: '1021 — Una Underwood added' })).toBeVisible();
  list = await memberSearch(page, 'underwood');
  await expect(button(list, '1021 — Una Underwood')).toBeVisible();

  // Edit.
  await button(list, '1021 — Una Underwood').click();
  dialog = page.getByRole('dialog', { name: 'Edit member' });
  await expect(dialog.getByLabel('First name')).toHaveValue('Una');
  await dialog.getByLabel('Last name').fill('Underhill');
  await button(dialog, 'Save member').click();
  await expect(dialog).toBeHidden();
  list = await memberSearch(page, '1021');
  await expect(button(list, '1021 — Una Underhill')).toBeVisible();

  // Deactivate (confirmed): gone from search, listed as inactive.
  await button(list, '1021 — Una Underhill').click();
  dialog = page.getByRole('dialog', { name: 'Edit member' });
  await button(dialog, 'Deactivate member').click();
  const confirm = page.getByRole('dialog', { name: 'Deactivate this member?' });
  await button(confirm, 'Deactivate').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: '1021 — Una Underhill deactivated' })).toBeVisible();
  await memberSearch(page, 'una');
  await expect(page.getByText('No active members match')).toBeVisible();
  const inactive = page.getByRole('list', { name: 'Inactive members' });
  await expect(inactive.getByRole('button')).toHaveCount(1);

  // Reactivate.
  await button(inactive, '1021 — Una Underhill').click();
  dialog = page.getByRole('dialog', { name: 'Edit member' });
  await expect(dialog.getByTestId('member-status')).toContainText('Inactive');
  await button(dialog, 'Reactivate member').click();
  await expect(dialog).toBeHidden();
  await expect(inactive).toHaveCount(0);
  list = await memberSearch(page, 'una');
  await expect(button(list, '1021 — Una Underhill')).toBeVisible();
  await expectNoHorizontalScroll(page);

  const members = await readStore<Member>(page, 'members');
  expect(members).toHaveLength(21);
  expect(members.find((m) => m.memberNumber === '1021')).toMatchObject({ firstName: 'Una', lastName: 'Underhill', active: true });
});

test('members: staff can search, but saving a member needs a manager PIN (override audit, D-071)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await lock(page);
  await login(page, STAFF.pin);
  await navigate(page, 'Members');
  await expectHeading(page, 'Members');
  await expect(page.getByText('Adding or changing a member needs a manager PIN.')).toBeVisible();

  const list = await memberSearch(page, 'moss');
  await expect(button(list, '1013 — Megan Moss')).toBeVisible();

  await button(page, 'Add member').click();
  const dialog = page.getByRole('dialog', { name: 'Add member' });
  await dialog.getByLabel('First name').fill('Victor');
  await dialog.getByLabel('Last name').fill('Vance');
  await button(dialog, 'Save member').click();
  await expect(page.getByTestId('override-dialog')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Manager PIN' })).toBeVisible();
  await approveOverride(page, MANAGER.pin);
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: '1021 — Victor Vance added' })).toBeVisible();

  const staff = await readStore<Staff>(page, 'staff');
  const sam = staff.find((s) => s.name === STAFF.name);
  const morgan = staff.find((s) => s.name === MANAGER.name);
  const overrides = (await readAuditEvents(page)).filter((e: AuditEvent) => e.type === 'override');
  expect(overrides).toHaveLength(1);
  expect(overrides[0]).toMatchObject({ staffId: sam?.id, approvedById: morgan?.id, detail: { action: 'manageMembersStaffSettings' } });
  expect((await readStore<Member>(page, 'members')).find((m) => m.memberNumber === '1021')).toMatchObject({ firstName: 'Victor', lastName: 'Vance', active: true });
});

test('keyboard focus: Mark settled and Cancel booking go with the closed booking’s card, and focus stays on the page (D-135, D-137)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  /** 'body' when focus is lost, else the focused element's tag and id. */
  const focused = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) return 'body';
      return `${active.tagName.toLowerCase()}${active.id === '' ? '' : `#${active.id}`}`;
    });

  for (const [booking, action, confirmTitle] of [
    ['Seniors Society Day', 'Mark settled', 'Mark this booking settled?'],
    ['Smith & Jones Wedding', 'Cancel booking', 'Cancel this booking?'],
  ] as const) {
    await navigate(page, 'Bookings');
    await bookingRow(page, booking).click();
    await expectHeading(page, booking);
    await button(page, action).focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: confirmTitle });
    await button(confirm, action).focus();
    await page.keyboard.press('Enter');
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId('booking-closed')).toBeVisible();
    await expect(button(page, action)).toHaveCount(0);
    await expect.poll(focused, { message: `${action}: focus fell to <body>` }).toBe('main#main');
  }
});
