/**
 * No sideways scroll inside dialogs, at 390 px and 1280 px (spec §10.4 "screens checked at both
 * sizes"; docs/ui-plan.md §6). Much of the phone UI is dialogs: expectNoHorizontalScroll checks
 * the topmost open dialog as well as the page, so each main dialog is opened and checked here.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, firstRun, freshStart, isNarrow, navigate, openPeriod } from './helpers';

function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

function dialog(page: Page, name: string): Locator {
  return page.getByRole('dialog', { name, exact: true });
}

/** Opens a dialog with `open`, checks the layout, then closes it with its Cancel/Close button. */
async function check(page: Page, name: string, open: () => Promise<unknown>, closeWith = 'Cancel'): Promise<void> {
  await open();
  const opened = dialog(page, name);
  await expect(opened).toBeVisible();
  await expectNoHorizontalScroll(page);
  await button(opened, closeWith).click();
  await expect(opened).toBeHidden();
}

test('the check sees a dialog: content wider than a dialog fails it', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await page.getByTestId('no-period').getByRole('button', { name: 'Open period' }).click();
  const open = dialog(page, 'Open period');
  await expect(open).toBeVisible();
  await expectNoHorizontalScroll(page);
  await open.evaluate((el) => {
    const wide = document.createElement('div');
    wide.style.width = '2000px';
    wide.style.height = '10px';
    // Into the dialog's scrolling body (the element that scrolls vertically).
    const body = [...el.querySelectorAll<HTMLElement>('*')].find((node) => getComputedStyle(node).overflowY === 'auto');
    (body ?? el).append(wide);
  });
  await expect(expectNoHorizontalScroll(page)).rejects.toThrow(/the open dialog scrolls horizontally/);
});

test('till, bookings, members and back-office dialogs never scroll sideways', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page);

  // Till: the menu, the basket sheet (phone), Member, Booking, Tab and Void.
  await check(page, 'Menu', () => button(page, 'Menu').click(), 'Close');
  await page.getByRole('tab', { name: 'Wine', exact: true }).click();
  await button(page, 'Prosecco (bottle)').click();
  await page.getByRole('tab', { name: 'Draught', exact: true }).click();
  await button(page, 'Club Bitter').click();
  if (isNarrow(page)) await check(page, 'Basket', () => page.getByRole('button', { name: /^View basket / }).click(), 'Close');
  await check(page, 'Attach member', () => button(page, 'Member').click());
  await check(page, 'Attach booking', () => button(page, 'Booking').click());
  await check(page, 'Tab', () => button(page, 'Tab').click());
  await check(page, 'Void item', () => button(page, 'Void').click());

  // Bookings: new booking and take deposit.
  await navigate(page, 'Bookings');
  await check(page, 'New booking', () => button(page, 'New booking').click());
  await page.getByRole('link', { name: 'Smith & Jones Wedding' }).click();
  await check(page, 'Take deposit', () => button(page, 'Take deposit').click());

  // Members: add member.
  await navigate(page, 'Members');
  await check(page, 'Add member', () => button(page, 'Add member').click());

  // Back office: products, deals, staff and stock.
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await check(page, 'Edit product', () => page.getByRole('button', { name: 'Edit Club Bitter' }).click());
  await check(page, 'Add product', () => button(page, 'Add product').click());
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Deals', exact: true }).click();
  await check(page, 'Add deal', () => button(page, 'Add deal').click());
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Staff', exact: true }).click();
  await check(page, 'Add staff', () => button(page, 'Add staff').click());
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Stock', exact: true }).click();
  await check(page, 'Goods in', () => button(page, 'Goods in').click());
  await check(page, 'Adjust stock', () => button(page, 'Adjust stock').click());
  // The history table may scroll sideways inside its own table region (docs/ui-plan.md §6).
  await check(page, 'Stock history', () => page.getByRole('button', { name: 'Club Bitter history' }).click(), 'Done');
});

test('edit dialogs and confirmations never scroll sideways either', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page);

  // Back office edits: category (add and edit), staff, deal.
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Categories', exact: true }).click();
  await check(page, 'Add category', () => button(page, 'Add category').click());
  await check(page, 'Edit category', () => page.getByRole('button', { name: 'Edit Draught' }).click());
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Staff', exact: true }).click();
  await check(page, 'Edit staff', () => page.getByRole('button', { name: 'Edit Sam Staff' }).click());
  await navigate(page, 'Back office');
  await page.getByRole('link', { name: 'Deals', exact: true }).click();
  await check(page, 'Edit deal', () => page.getByRole('button', { name: 'Edit Snacks 3 for 2' }).click());

  // Members: edit, and the Deactivate confirmation on top of it.
  await navigate(page, 'Members');
  await page.getByRole('button', { name: '1001 — Alice Archer', exact: true }).click();
  const edit = dialog(page, 'Edit member');
  await expect(edit).toBeVisible();
  await expectNoHorizontalScroll(page);
  await check(page, 'Deactivate this member?', () => button(edit, 'Deactivate member').click(), 'Keep active');
  await button(edit, 'Cancel').click();
  await expect(edit).toBeHidden();

  // Bookings: edit details, and the Mark settled / Cancel booking confirmations.
  await navigate(page, 'Bookings');
  await page.getByRole('link', { name: 'Smith & Jones Wedding' }).click();
  await check(page, 'Edit booking', () => button(page, 'Edit details').click());
  await check(page, 'Mark this booking settled?', () => button(page, 'Mark settled').click(), 'Keep open');
  await check(page, 'Cancel this booking?', () => button(page, 'Cancel booking').click(), 'Keep booking');
});
