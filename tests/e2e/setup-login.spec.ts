/**
 * First run, login, lock and the shell (spec §6.1, §6.2; D-067, D-071, D-076, D-078, D-111).
 * Runs at both viewports (tablet landscape 1280x800, phone portrait 390x844).
 */
import { expect, test } from '@playwright/test';
import type { Period, Staff } from '../../src/data/types';
import {
  CLUB_NAME,
  MANAGER,
  STAFF,
  SUPERVISOR,
  approveOverride,
  enterMoney,
  enterPin,
  expectNoHorizontalScroll,
  firstRun,
  freshStart,
  lock,
  login,
  loginKeypad,
  navigate,
  openPeriod,
  readAuditEvents,
  readStore,
} from './helpers';

test('first run with sample data logs the manager in on the till', async ({ page }) => {
  await freshStart(page);
  await firstRun(page, { loadSample: true });
  await expect(page.getByTestId('current-staff')).toHaveText(MANAGER.name);
  await expect(page.getByRole('link', { name: CLUB_NAME })).toBeVisible();
  await expect(page.getByTestId('period-status')).toHaveText('No period open');
  await expect(page.getByTestId('no-period')).toContainText('No trading period open');
  await expectNoHorizontalScroll(page);

  const staff = await readStore<Staff>(page, 'staff');
  expect(staff.map((s) => `${s.name}:${s.role}`).sort()).toEqual(['Morgan Manager:manager', 'Sam Staff:staff', 'Sue Supervisor:supervisor']);

  // Setup is offered only once.
  await page.goto('/#/setup');
  await expect(page).toHaveURL(/#\/till$/);
});

test('setup checks the form before creating anything', async ({ page }) => {
  await freshStart(page);
  await page.getByRole('button', { name: 'Set up till' }).click();
  await expect(page.getByText('Enter the club name')).toBeVisible();
  await expect(page.getByText('Enter your name')).toBeVisible();
  await expect(page.getByText('PIN must be 4 to 6 digits')).toBeVisible();

  await page.getByLabel('Club name').fill(CLUB_NAME);
  await page.getByLabel('Manager name').fill(MANAGER.name);
  await page.getByLabel('PIN', { exact: true }).fill('1234');
  await page.getByLabel('Confirm PIN').fill('4321');
  await page.getByRole('button', { name: 'Set up till' }).click();
  await expect(page.getByText("PINs don't match")).toBeVisible();

  await page.getByLabel('PIN', { exact: true }).fill(STAFF.pin);
  await page.getByLabel('Confirm PIN').fill(STAFF.pin);
  await page.getByLabel('Load sample data').check();
  await page.getByRole('button', { name: 'Set up till' }).click();
  await expect(page.getByText('That PIN is used by the sample staff')).toBeVisible();
  await expect(page).toHaveURL(/#\/setup$/);
  expect(await readStore(page, 'staff')).toEqual([]);
});

test('each sample role logs in, locks and logs in again', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  for (const person of [STAFF, SUPERVISOR, MANAGER]) {
    await lock(page);
    await expect(page.getByRole('heading', { name: CLUB_NAME })).toBeVisible();
    await login(page, person.pin);
    await expect(page).toHaveURL(/#\/till$/);
    await expect(page.getByTestId('current-staff')).toHaveText(person.name);
    await expectNoHorizontalScroll(page);
  }
  await lock(page);
  await login(page, MANAGER.pin);
  await expect(page.getByTestId('current-staff')).toHaveText(MANAGER.name);
});

test('a wrong PIN is rejected and five in a row lock the keypad for 30 seconds', async ({ page }) => {
  await page.clock.install();
  await freshStart(page);
  await firstRun(page);
  await lock(page);
  const keypad = loginKeypad(page);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await enterPin(keypad, '9999');
    await expect(keypad.getByText('PIN not recognised')).toBeVisible();
  }
  await enterPin(keypad, '9999');
  await expect(keypad.getByText(/Too many attempts\. Try again in \d+ s/)).toBeVisible();
  await expect(keypad.getByRole('button', { name: '1', exact: true })).toBeDisabled();

  await page.clock.fastForward(31_000);
  await expect(keypad.getByRole('button', { name: '1', exact: true })).toBeEnabled();
  await login(page, MANAGER.pin);
  await expect(page.getByTestId('current-staff')).toHaveText(MANAGER.name);
});

test('the lockout countdown is not read out every second: it is announced once when it starts and once when it ends (D-135)', async ({ page }) => {
  await page.clock.install();
  await freshStart(page);
  await firstRun(page);
  await lock(page);
  const keypad = loginKeypad(page);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await enterPin(keypad, '9999');
    await expect(keypad.getByText('PIN not recognised')).toBeVisible();
  }
  await enterPin(keypad, '9999');
  // Everything the login screen's live regions hold, in order.
  const live = () =>
    page.getByTestId('login-screen').evaluate((screen) => [...screen.querySelectorAll('[aria-live]')].map((el) => el.textContent ?? '').join(' | '));
  await expect(keypad.getByRole('timer')).toHaveText(/^Too many attempts\. Try again in \d+ s$/);
  const started = await live();
  expect(started).toContain('Too many attempts. The keypad is locked for 30 seconds.');
  expect(started).not.toMatch(/Try again in/);

  // The visible countdown ticks; nothing a screen reader is told changes.
  await page.clock.fastForward(3_000);
  await expect(keypad.getByRole('timer')).toHaveText(/Try again in 2\d s$/);
  expect(await live()).toBe(started);

  await page.clock.fastForward(30_000);
  await expect(keypad.getByRole('button', { name: '1', exact: true })).toBeEnabled();
  await expect.poll(live).toContain('The keypad is unlocked. You can enter a PIN again.');
});

test('each screen opens at the top, not at the last screen\'s scroll position (D-135)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await navigate(page, 'Members');
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
  const main = page.locator('#main');
  // The phone's member list is taller than the screen; scroll to its end.
  const scrolled = await main.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  if ((page.viewportSize()?.width ?? 0) < 900) expect(scrolled).toBeGreaterThan(0);

  await navigate(page, 'Back office');
  const heading = page.getByRole('heading', { level: 1, name: 'Back office' });
  await expect(heading).toBeInViewport();
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
});

test('the till locks itself after five idle minutes and a refresh also returns to login', async ({ page }) => {
  await page.clock.install();
  await freshStart(page);
  await firstRun(page);

  await page.clock.fastForward('04:30');
  await expect(page.getByTestId('current-staff')).toHaveText(MANAGER.name);
  await page.clock.fastForward('00:31');
  await expect(loginKeypad(page)).toBeVisible();

  await login(page, STAFF.pin);
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);

  await page.reload();
  await expect(loginKeypad(page)).toBeVisible();
  await login(page, SUPERVISOR.pin);
  await expect(page.getByTestId('current-staff')).toHaveText(SUPERVISOR.name);
});

test('the manager opens a trading period from the till', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page, 12_345);
  await expect(page.getByTestId('no-period')).toBeHidden();
  const periods = await readStore<Period>(page, 'periods');
  expect(periods).toHaveLength(1);
  expect(periods[0]?.floatPence).toBe(12_345);
  expect(periods[0]?.closedAt).toBeUndefined();
  // Opening a period directly writes no override event (D-067, D-070).
  expect(await readAuditEvents(page)).toEqual([]);
});

test('staff opening a period needs a manager PIN override for that one action', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await lock(page);
  await login(page, STAFF.pin);

  await page.getByTestId('no-period').getByRole('button', { name: 'Open period' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open period' });
  await enterMoney(dialog, 5000);
  await dialog.getByRole('button', { name: 'Open period' }).click();

  const override = page.getByRole('dialog', { name: 'Manager PIN' });
  await expect(override).toBeVisible();
  await enterPin(override, SUPERVISOR.pin);
  await expect(override.getByText('PIN not accepted')).toBeVisible();
  await approveOverride(page, MANAGER.pin);

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('period-status')).toHaveText('Period open');

  const staff = await readStore<Staff>(page, 'staff');
  const idOf = (name: string): string | undefined => staff.find((s) => s.name === name)?.id;
  const events = await readAuditEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'override',
    staffId: idOf(STAFF.name),
    approvedById: idOf(MANAGER.name),
    detail: { action: 'openClosePeriod' },
  });
  const periods = await readStore<Period>(page, 'periods');
  expect(periods[0]).toMatchObject({ floatPence: 5000, openedBy: idOf(STAFF.name) });
});

test('the menu reaches every screen, whatever the role', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await lock(page);
  await login(page, STAFF.pin);
  const screens: [link: string, heading: string, url: RegExp][] = [
    ['Tabs', 'Tabs', /#\/tabs$/],
    ['Bookings', 'Bookings', /#\/bookings$/],
    ['Members', 'Members', /#\/members$/],
    ['Refunds', 'Refunds', /#\/refunds$/],
    ['Period', 'Period', /#\/period$/],
    ['Product sales report', 'Product sales report', /#\/reports\/product-sales$/],
    ['VAT report', 'VAT report', /#\/reports\/vat$/],
    ['Back office', 'Back office', /#\/backoffice$/],
    ['Till', 'Till', /#\/till$/],
  ];
  for (const [link, heading, url] of screens) {
    await navigate(page, link);
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeAttached();
    await expectNoHorizontalScroll(page);
  }
});

test('keyboard use of the PIN keypads: Enter presses a focused key, focus never leaves the keypad, physical digits and Enter still work (D-073, D-132)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page);
  await lock(page);

  // Login keypad: Enter on a focused key presses that key, as on any button.
  const keypad = loginKeypad(page);
  await keypad.getByRole('button', { name: '1', exact: true }).focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Enter');
  await expect(keypad.getByText('4 digits entered')).toBeAttached();
  // Enter on Clear clears: it doesn't submit the 1111 typed so far.
  await keypad.getByRole('button', { name: 'Clear', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(keypad.getByText('No digits entered')).toBeAttached();
  await expect(page).toHaveURL(/#\/login$/);
  // Clear is now disabled; focus moved to the keypad group rather than falling to <body>.
  await expect(keypad).toBeFocused();
  // Physical digits and Enter log in (D-073).
  await page.keyboard.type(STAFF.pin);
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/till$/);
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);

  // Override dialog: focus starts on its keypad and stays in the dialog after a wrong PIN.
  await page.getByRole('button', { name: 'No sale', exact: true }).click();
  const override = page.getByTestId('override-dialog');
  const approverKeypad = override.getByRole('group', { name: "Approver's PIN" });
  await expect(approverKeypad).toBeFocused();
  const focusInOverride = (): Promise<boolean> =>
    page.evaluate(() => document.querySelector('[data-testid="override-dialog"]')?.contains(document.activeElement) ?? false);
  await page.keyboard.type('9999');
  await page.keyboard.press('Enter');
  await expect(override.getByText('PIN not accepted')).toBeVisible();
  expect(await focusInOverride()).toBe(true);
  await enterPin(override, '9998');
  await expect(override.getByText('PIN not accepted')).toBeVisible();
  expect(await focusInOverride()).toBe(true);
  await page.keyboard.type(SUPERVISOR.pin);
  await page.keyboard.press('Enter');
  await expect(override).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Drawer opened' })).toBeVisible();
});

test('Lock from the keyboard puts focus on the PIN keypad, so the login screen is announced and Enter logs in (D-132, D-136, D-137)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  const lockButton = page.getByRole('button', { name: 'Lock', exact: true });
  await lockButton.focus();
  await page.keyboard.press('Enter');
  const keypad = loginKeypad(page);
  await expect(keypad).toBeVisible();
  await expect(keypad).toBeFocused();
  await expect(keypad).toHaveAccessibleName('Enter your PIN');
  await page.keyboard.type(STAFF.pin);
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/till$/);
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);

  // A reload lands on the keypad too; Tab from it reaches its first key.
  await page.reload();
  await expect(keypad).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keypad.getByRole('button', { name: '1', exact: true })).toBeFocused();
});
