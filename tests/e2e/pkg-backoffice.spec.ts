/**
 * Back office (spec §5, §6.9, §8; D-013, D-051, D-058, D-075, D-077, D-080..D-082, D-087..D-091,
 * D-105): the section menu, products (price change audit), categories, deals, staff, stock,
 * settings and backup. Every journey starts from first run with the sample data (D-097..D-100)
 * and runs at both viewports.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AuditEvent, Category, Deal, Product, Settings, Staff, StockMovement } from '../../src/data/types';
import {
  CLUB_NAME,
  MANAGER,
  STAFF,
  SUPERVISOR,
  approveOverride,
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

/** Menu -> Back office -> the section card named `section`. */
async function openSection(page: Page, section: string, url: RegExp, heading = section): Promise<void> {
  await navigate(page, 'Back office');
  await expect(page.getByRole('heading', { level: 1, name: 'Back office' })).toBeVisible();
  await page.getByRole('link', { name: section, exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
}

function dialog(page: Page, name: string): Locator {
  return page.getByRole('dialog', { name, exact: true });
}

function toast(page: Page, text: string): Locator {
  return page.getByTestId('toast').filter({ hasText: text });
}

async function staffId(page: Page, name: string): Promise<string> {
  const staff = await readStore<Staff>(page, 'staff');
  const id = staff.find((s) => s.name === name)?.id;
  if (id === undefined) throw new Error(`No staff member called ${name}`);
  return id;
}

/** Rows in creation order (IndexedDB getAll returns them by random UUID). */
function byCreation<T extends { createdAt: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function productByName(page: Page, name: string): Promise<Product> {
  const product = (await readStore<Product>(page, 'products')).find((p) => p.name === name);
  if (product === undefined) throw new Error(`No product called ${name}`);
  return product;
}

test.beforeEach(async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
});

test('the back office menu reaches every section, including members and bookings', async ({ page }) => {
  await navigate(page, 'Back office');
  await expect(page).toHaveURL(/#\/backoffice$/);
  // Sample stock: Single Malt Whisky (10 on hand, low at 14) is the one low item (D-097).
  await expect(page.getByRole('link', { name: 'Stock', exact: true })).toContainText('1 item low on stock');
  await expect(page.getByRole('link', { name: 'Backup', exact: true })).toContainText('Never backed up');
  await expectNoHorizontalScroll(page);

  const sections: [link: string, url: RegExp, heading: string][] = [
    ['Products', /#\/backoffice\/products$/, 'Products'],
    ['Categories', /#\/backoffice\/categories$/, 'Categories'],
    ['Deals', /#\/backoffice\/deals$/, 'Deals'],
    ['Stock', /#\/backoffice\/stock$/, 'Stock'],
    ['Members', /#\/members$/, 'Members'],
    ['Bookings', /#\/bookings$/, 'Bookings'],
    ['Staff', /#\/backoffice\/staff$/, 'Staff'],
    ['Settings', /#\/backoffice\/settings$/, 'Settings'],
    ['Backup', /#\/backoffice\/backup$/, 'Backup'],
  ];
  for (const [link, url, heading] of sections) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    if (url.source.includes('backoffice')) await page.getByRole('link', { name: 'Back office', exact: true }).click();
    else await page.goBack();
    await expect(page).toHaveURL(/#\/backoffice$/);
  }
});

test('products: a price change is audited, a new product takes its category defaults, and a product can be deactivated', async ({ page }) => {
  await openSection(page, 'Products', /#\/backoffice\/products$/);
  await expect(page.getByTestId('product-row')).toHaveCount(40);
  await expect(page.getByRole('button', { name: 'Edit Club Bitter' })).toContainText('£4.20');
  await expectNoHorizontalScroll(page);

  // Price change 420 -> 440 (D-087).
  await page.getByRole('button', { name: 'Edit Club Bitter' }).click();
  const edit = dialog(page, 'Edit product');
  await expect(edit.getByLabel('Price', { exact: true })).toHaveValue('4.20');
  await edit.getByLabel('Price', { exact: true }).fill('4.40');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(toast(page, 'Club Bitter: price changed from £4.20 to £4.40')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Club Bitter' })).toContainText('£4.40');
  expect((await productByName(page, 'Club Bitter')).pricePence).toBe(440);
  const manager = await staffId(page, MANAGER.name);
  const bitter = await productByName(page, 'Club Bitter');
  let events = await readAuditEvents(page);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'priceChange',
    staffId: manager,
    detail: { productId: bitter.id, productName: 'Club Bitter', oldPricePence: 420, newPricePence: 440 },
  });
  expect(events[0]?.approvedById).toBeUndefined();

  // The form checks itself before saving.
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  const add = dialog(page, 'Add product');
  await add.getByLabel('Price', { exact: true }).fill('4.505');
  await add.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(add.getByText('Enter a name')).toBeVisible();
  await expect(add.getByText('Enter a price like 4.50')).toBeVisible();

  // New product: colour and position come from its category (D-105).
  await add.getByLabel('Name').fill('Ginger Beer');
  await add.getByLabel('Category', { exact: true }).selectOption({ label: 'Soft Drinks' });
  await expect(add.getByLabel('Position in category')).toHaveValue('8');
  await expect(add.getByLabel('Button colour', { exact: true })).toHaveValue('#0369a1');
  await add.getByLabel('Price', { exact: true }).fill('2.75');
  await add.getByLabel('VAT rate').selectOption({ label: '20%' });
  await add.getByLabel('Stock unit').fill('bottle');
  await add.getByLabel('Low-stock level').fill('6');
  await add.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(toast(page, 'Ginger Beer added')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Ginger Beer' })).toContainText('£2.75');
  const categories = await readStore<Category>(page, 'categories');
  const soft = categories.find((c) => c.name === 'Soft Drinks');
  expect(await productByName(page, 'Ginger Beer')).toMatchObject({
    categoryId: soft?.id,
    pricePence: 275,
    vatRate: 20,
    buttonColour: '#0369a1',
    sortOrder: 8,
    stockTracked: true,
    stockUnit: 'bottle',
    lowStockLevel: 6,
    memberDiscountEligible: true,
    active: true,
  });
  // Creating a product writes no priceChange (D-087).
  events = await readAuditEvents(page);
  expect(events.filter((e) => e.type === 'priceChange')).toHaveLength(1);

  // Deactivate Shandy (D-051): kept, marked inactive.
  await page.getByRole('button', { name: 'Edit Shandy' }).click();
  await dialog(page, 'Edit product').getByLabel('Active').uncheck();
  await dialog(page, 'Edit product').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page, 'Edit product')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Shandy' })).toContainText('Inactive');
  expect((await productByName(page, 'Shandy')).active).toBe(false);

  // Search and filter.
  await page.getByLabel('Search products').fill('cider');
  await expect(page.getByTestId('product-row')).toHaveCount(2);
  await page.getByLabel('Search products').fill('');
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Events' });
  await expect(page.getByTestId('product-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Edit Raffle Ticket' })).toContainText('VAT 0%');
  await expectNoHorizontalScroll(page);
});

test('staff saving a product change needs a manager PIN for that one save', async ({ page }) => {
  await lock(page);
  await login(page, STAFF.pin);
  await openSection(page, 'Products', /#\/backoffice\/products$/);
  await expect(page.getByText('Saving a change needs a manager PIN.')).toBeVisible();

  // Cancelling the override leaves the form open and saves nothing.
  await page.getByRole('button', { name: 'Edit Club Bitter' }).click();
  const edit = dialog(page, 'Edit product');
  await edit.getByLabel('Price', { exact: true }).fill('4.60');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  const override = page.getByTestId('override-dialog');
  await expect(override).toBeVisible();
  await expect(dialog(page, 'Manager PIN')).toBeVisible();
  await override.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(override).toBeHidden();
  await expect(edit).toBeVisible();
  expect(await readAuditEvents(page)).toEqual([]);

  // A supervisor PIN is not enough; the manager's approves this one save.
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await enterPin(override, SUPERVISOR.pin);
  await expect(override.getByText('PIN not accepted')).toBeVisible();
  await approveOverride(page, MANAGER.pin);
  await expect(edit).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Club Bitter' })).toContainText('£4.60');

  const sam = await staffId(page, STAFF.name);
  const morgan = await staffId(page, MANAGER.name);
  // Both are written in the save's one transaction (D-072).
  const events = await readAuditEvents(page);
  expect(events.map((e) => e.type).sort()).toEqual(['override', 'priceChange']);
  expect(events.find((e) => e.type === 'override')).toMatchObject({ staffId: sam, approvedById: morgan, detail: { action: 'editCatalogue' } });
  expect(events.find((e) => e.type === 'priceChange')).toMatchObject({
    type: 'priceChange',
    staffId: sam,
    approvedById: morgan,
    detail: { productName: 'Club Bitter', oldPricePence: 420, newPricePence: 460 },
  });
});

test('categories: add, rename and delete; a category in use cannot be deleted', async ({ page }) => {
  await openSection(page, 'Categories', /#\/backoffice\/categories$/);
  await expect(page.getByTestId('category-row')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Edit Soft Drinks' })).toContainText('7 products · position 5');

  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  const add = dialog(page, 'Add category');
  await expect(add.getByLabel('Position')).toHaveValue('8');
  await add.getByLabel('Name').fill('draught');
  await add.getByRole('button', { name: 'Add category', exact: true }).click();
  await expect(add.getByText('Another category already has that name')).toBeVisible();
  await add.getByLabel('Name').fill('Cocktails');
  await add.getByLabel('Colour', { exact: true }).fill('#be185d');
  await add.getByRole('button', { name: 'Add category', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Cocktails' })).toContainText('0 products · position 8');

  // Rename.
  await page.getByRole('button', { name: 'Edit Cocktails' }).click();
  await dialog(page, 'Edit category').getByLabel('Name').fill('Mocktails');
  await dialog(page, 'Edit category').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Mocktails' })).toBeVisible();

  // Draught has products: delete is not offered.
  await page.getByRole('button', { name: 'Edit Draught' }).click();
  const draught = dialog(page, 'Edit category');
  await expect(draught.getByRole('button', { name: 'Delete category' })).toBeDisabled();
  await expect(draught.getByText('This category has 6 products.')).toBeVisible();
  await draught.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Delete the empty one (soft delete, D-051).
  await page.getByRole('button', { name: 'Edit Mocktails' }).click();
  await dialog(page, 'Edit category').getByRole('button', { name: 'Delete category' }).click();
  const confirm = dialog(page, 'Delete category?');
  await expect(confirm).toBeVisible();
  await expectNoHorizontalScroll(page);
  await confirm.getByRole('button', { name: 'Delete category' }).click();
  await expect(dialog(page, 'Edit category')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Mocktails' })).toHaveCount(0);
  await expect(page.getByTestId('category-row')).toHaveCount(7);
  const stored = (await readStore<Category>(page, 'categories')).find((c) => c.name === 'Mocktails');
  expect(stored).toMatchObject({ colour: '#be185d', sortOrder: 8 });
  expect(stored?.deletedAt).toBeDefined();
  await expectNoHorizontalScroll(page);
});

test('deals: sample deals are listed, a new deal is validated and saved, and a deal can be deactivated', async ({ page }) => {
  await openSection(page, 'Deals', /#\/backoffice\/deals$/);
  const rows = page.getByTestId('deal-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Any 2 bottles for £8' })).toContainText('2 for £8.00');
  await expect(rows.filter({ hasText: 'Any 2 bottles for £8' })).toContainText('5 products');
  await expect(rows.filter({ hasText: 'Snacks 3 for 2' })).toContainText('3 for 2');
  await expect(rows.filter({ hasText: 'Snacks 3 for 2' })).toContainText('Applies now');

  // Validation messages come from rules/validation.validateDeal (D-013).
  await page.getByRole('button', { name: 'Add deal', exact: true }).click();
  const add = dialog(page, 'Add deal');
  await add.getByLabel('Some free').check();
  await add.getByLabel('Group size').fill('3');
  await add.getByLabel('Customer pays for').fill('3');
  await add.getByRole('button', { name: 'Add deal', exact: true }).click();
  await expect(add.getByText('Enter a name')).toBeVisible();
  await expect(add.getByText('Units paid for must be at least 1 and less than the group size')).toBeVisible();
  await expect(add.getByText('Choose at least one product')).toBeVisible();

  await add.getByLabel('Name', { exact: true }).fill('Spirits 3 for 2');
  await add.getByLabel('Customer pays for').fill('2');
  await expect(add.getByText('Buy any 3, pay for 2: the cheapest one is free')).toBeVisible();
  await add.getByRole('checkbox', { name: /^House Gin/ }).check();
  await add.getByRole('checkbox', { name: /^House Vodka/ }).check();
  await add.getByRole('checkbox', { name: /^House Whisky/ }).check();
  await expect(add.getByText('3 chosen')).toBeVisible();
  await add.getByLabel('Start date').fill('2099-01-31');
  await add.getByLabel('End date').fill('2099-01-01');
  await add.getByRole('button', { name: 'Add deal', exact: true }).click();
  await expect(add.getByText('End date must be on or after the start date')).toBeVisible();
  await add.getByLabel('Start date').fill('2099-01-01');
  await add.getByLabel('End date').fill('2099-01-31');
  await add.getByRole('button', { name: 'Add deal', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(toast(page, 'Spirits 3 for 2 added')).toBeVisible();
  const spirits = rows.filter({ hasText: 'Spirits 3 for 2' });
  await expect(spirits).toContainText('01/01/2099 to 31/01/2099');
  await expect(spirits).toContainText('Not started');
  await expect(spirits).toContainText('3 products: House Gin, House Vodka, House Whisky');

  const products = await readStore<Product>(page, 'products');
  const idOf = (name: string): string | undefined => products.find((p) => p.name === name)?.id;
  const deal = (await readStore<Deal>(page, 'deals')).find((d) => d.name === 'Spirits 3 for 2');
  expect(deal).toMatchObject({
    type: 'nForM',
    n: 3,
    m: 2,
    active: true,
    // London midnight at the start of 01/01/2099 and of the day after 31/01/2099 (D-012).
    startsAt: '2099-01-01T00:00:00.000Z',
    endsAt: '2099-02-01T00:00:00.000Z',
  });
  expect(deal?.pricePence).toBeUndefined();
  expect([...(deal?.productIds ?? [])].sort()).toEqual([idOf('House Gin'), idOf('House Vodka'), idOf('House Whisky')].sort());

  // Editing keeps the dates; clearing the end date removes it (D-050).
  await page.getByRole('button', { name: 'Edit Spirits 3 for 2' }).click();
  const edit = dialog(page, 'Edit deal');
  await expect(edit.getByLabel('Start date')).toHaveValue('2099-01-01');
  await expect(edit.getByLabel('End date')).toHaveValue('2099-01-31');
  await edit.getByLabel('End date').fill('');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(spirits).toContainText('From 01/01/2099');
  const saved = (await readStore<Deal>(page, 'deals')).find((d) => d.name === 'Spirits 3 for 2');
  expect(saved?.endsAt).toBeUndefined();

  // Deactivate / reactivate.
  await page.getByRole('button', { name: 'Deactivate Snacks 3 for 2' }).click();
  await expect(page.getByRole('button', { name: 'Reactivate Snacks 3 for 2' })).toBeVisible();
  await expect(rows.filter({ hasText: 'Snacks 3 for 2' })).toContainText('Inactive');
  expect((await readStore<Deal>(page, 'deals')).find((d) => d.name === 'Snacks 3 for 2')?.active).toBe(false);
  await expectNoHorizontalScroll(page);
});

test('staff: add with a PIN typed twice, unique PINs, deactivate, and the last-manager rule', async ({ page }) => {
  await openSection(page, 'Staff', /#\/backoffice\/staff$/);
  await expect(page.getByTestId('staff-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Edit Morgan Manager' })).toContainText('You');

  await page.getByRole('button', { name: 'Add staff', exact: true }).click();
  const add = dialog(page, 'Add staff');
  await add.getByLabel('Name').fill('Tom Tapster');
  await add.getByLabel('PIN', { exact: true }).fill('3333');
  await add.getByLabel('Confirm PIN').fill('3334');
  await add.getByRole('button', { name: 'Add staff', exact: true }).click();
  await expect(add.getByText("PINs don't match")).toBeVisible();
  // Sam Staff already uses 1111 (D-075): the owner is never named.
  await add.getByLabel('PIN', { exact: true }).fill(STAFF.pin);
  await add.getByLabel('Confirm PIN').fill(STAFF.pin);
  await add.getByRole('button', { name: 'Add staff', exact: true }).click();
  await expect(add.getByText("That PIN can't be used — choose another").first()).toBeVisible();
  await add.getByLabel('PIN', { exact: true }).fill('3333');
  await add.getByLabel('Confirm PIN').fill('3333');
  await add.getByRole('button', { name: 'Add staff', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Tom Tapster' })).toContainText('Staff');
  expect((await readStore<Staff>(page, 'staff')).find((s) => s.name === 'Tom Tapster')).toMatchObject({ role: 'staff', active: true });

  // You can't change your own role or deactivate yourself (D-077).
  await page.getByRole('button', { name: 'Edit Morgan Manager' }).click();
  const self = dialog(page, 'Edit staff');
  await expect(self.getByRole('radio', { name: /^Supervisor/ })).toBeDisabled();
  await expect(self.getByLabel('Active')).toBeDisabled();
  await self.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Deactivate Sam: his PIN stops working.
  await page.getByRole('button', { name: 'Edit Sam Staff' }).click();
  await dialog(page, 'Edit staff').getByLabel('Active').uncheck();
  await dialog(page, 'Edit staff').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page, 'Edit staff')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Sam Staff' })).toContainText('Inactive');
  await lock(page);
  await enterPin(loginKeypad(page), STAFF.pin);
  await expect(loginKeypad(page).getByText('PIN not recognised')).toBeVisible();
  await login(page, '3333');
  await expect(page.getByTestId('current-staff')).toHaveText('Tom Tapster');

  // A supervisor demoting the only manager (approved by that manager's PIN) is refused.
  await lock(page);
  await login(page, SUPERVISOR.pin);
  await openSection(page, 'Staff', /#\/backoffice\/staff$/);
  await page.getByRole('button', { name: 'Edit Morgan Manager' }).click();
  const edit = dialog(page, 'Edit staff');
  await edit.getByRole('radio', { name: /^Supervisor/ }).check();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await approveOverride(page, MANAGER.pin);
  await expect(edit.getByRole('alert').filter({ hasText: 'There must always be at least one active manager' })).toBeVisible();
  expect((await readStore<Staff>(page, 'staff')).find((s) => s.name === MANAGER.name)?.role).toBe('manager');
  await expectNoHorizontalScroll(page);
});

test('stock: goods in, adjustment and waste change the levels and the low-stock list', async ({ page }) => {
  await openSection(page, 'Stock', /#\/backoffice\/stock$/);
  const low = page.getByTestId('low-stock-list');
  await expect(low.getByTestId('low-stock-item')).toHaveCount(1);
  await expect(low.getByTestId('low-stock-item').first()).toContainText('Single Malt Whisky');
  await expect(low.getByTestId('low-stock-on-hand').first()).toHaveText('10');
  await expectNoHorizontalScroll(page);

  // Goods in 20 Single Malt: 30 on hand, off the low-stock list.
  await page.getByRole('button', { name: 'Goods in', exact: true }).click();
  const goodsIn = dialog(page, 'Goods in');
  await goodsIn.getByLabel('Product').selectOption({ label: 'Single Malt Whisky' });
  await goodsIn.getByLabel('Quantity').fill('20');
  await goodsIn.getByLabel('Note').fill('Delivery 4471');
  await goodsIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(goodsIn).toBeHidden();
  await expect(toast(page, 'Goods in: 20 × Single Malt Whisky')).toBeVisible();
  await expect(low).toContainText('Nothing is low on stock.');
  const levels = page.getByTestId('stock-levels');
  await expect(levels.locator('tr', { hasText: 'Single Malt Whisky' }).locator('td').first()).toHaveText('30');

  // Adjustment -100 Club Bitter needs a reason, then goes negative and tops the list (D-082).
  await page.getByRole('button', { name: 'Adjust stock', exact: true }).click();
  const adjust = dialog(page, 'Adjust stock');
  await adjust.getByLabel('Product').selectOption({ label: 'Club Bitter' });
  await adjust.getByLabel('Take off stock').check();
  await adjust.getByLabel('Quantity').fill('100');
  await adjust.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(adjust.getByText('Enter a reason')).toBeVisible();
  await adjust.getByLabel('Reason').fill('Stock count');
  await adjust.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(adjust).toBeHidden();
  await expect(low.getByTestId('low-stock-item')).toHaveCount(1);
  await expect(low.getByTestId('low-stock-item').first()).toContainText('Club Bitter');
  await expect(low.getByTestId('low-stock-on-hand').first()).toHaveText('-12');
  await expect(levels.locator('tr', { hasText: 'Club Bitter' }).locator('td').first()).toContainText('-12');

  // Waste 2 Orange Juice: 24 -> 22 (still above its level of 6).
  await page.getByRole('button', { name: 'Adjust stock', exact: true }).click();
  await adjust.getByLabel('Product').selectOption({ label: 'Orange Juice' });
  await adjust.getByLabel('Waste').check();
  await adjust.getByLabel('Quantity').fill('2');
  await adjust.getByLabel('Reason').fill('Dropped');
  await adjust.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(adjust).toBeHidden();
  await expect(levels.locator('tr', { hasText: 'Orange Juice' }).locator('td').first()).toHaveText('22');

  // History shows every movement of the product.
  await page.getByRole('button', { name: 'Club Bitter history' }).click();
  const history = dialog(page, 'Stock history');
  await expect(history).toContainText('-100');
  await expect(history).toContainText('+88');
  await expect(history).toContainText('Stock count');
  // Goods in from the history starts with the product chosen.
  await history.getByRole('button', { name: 'Goods in', exact: true }).click();
  await expect(goodsIn.getByLabel('Product')).toHaveValue((await productByName(page, 'Club Bitter')).id);
  await goodsIn.getByLabel('Quantity').fill('112');
  await goodsIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(goodsIn).toBeHidden();
  await expect(low).toContainText('Nothing is low on stock.');
  await expect(levels.locator('tr', { hasText: 'Club Bitter' }).locator('td').first()).toHaveText('100');

  const bitter = await productByName(page, 'Club Bitter');
  const juice = await productByName(page, 'Orange Juice');
  const malt = await productByName(page, 'Single Malt Whisky');
  const movements = await readStore<StockMovement>(page, 'stockMovements');
  expect(byCreation(movements.filter((m) => m.productId === malt.id && m.reason === 'goodsIn')).map((m) => [m.qty, m.note])).toEqual([
    [10, 'Opening stock'],
    [20, 'Delivery 4471'],
  ]);
  expect(movements.find((m) => m.productId === juice.id && m.reason === 'waste')).toMatchObject({ qty: -2, note: 'Dropped' });
  const adjusts = byCreation((await readAuditEvents(page)).filter((e): e is Extract<AuditEvent, { type: 'stockAdjust' }> => e.type === 'stockAdjust'));
  expect(adjusts.map((e) => e.detail)).toEqual([
    expect.objectContaining({ productId: bitter.id, productName: 'Club Bitter', qty: -100, reason: 'adjustment', note: 'Stock count' }),
    expect.objectContaining({ productId: juice.id, productName: 'Orange Juice', qty: -2, reason: 'waste', note: 'Dropped' }),
  ]);
  await expectNoHorizontalScroll(page);
});

test('settings: fields are checked, then saved; the header and receipt prefix follow', async ({ page }) => {
  await openSection(page, 'Settings', /#\/backoffice\/settings$/);
  const [settings] = await readStore<Settings>(page, 'settings');
  await expect(page.getByLabel('Club name')).toHaveValue(CLUB_NAME);
  await expect(page.getByLabel('Receipt footer')).toHaveValue('Thank you for your custom');
  await expect(page.getByLabel('Auto-lock after')).toHaveValue('5');
  await expect(page.getByLabel('Member discount')).toHaveValue('15');
  await expect(page.getByLabel('Receipt prefix')).toHaveValue(settings?.devicePrefix ?? '');
  await expect(page.getByTestId('next-receipt-number')).toHaveText(`${settings?.devicePrefix ?? ''}-000001`);

  await page.getByLabel('Receipt prefix').fill('BAR-1');
  await page.getByLabel('Auto-lock after').fill('0');
  await page.getByLabel('Member discount').fill('101');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Device prefix must be 1 to 6 letters or digits')).toBeVisible();
  await expect(page.getByText('Auto-lock must be 1 to 60 minutes')).toBeVisible();
  await expect(page.getByText('Member discount must be a whole number 0 to 100')).toBeVisible();

  await page.getByLabel('Club name').fill('Oakfield GC Bar');
  await page.getByLabel('Receipt footer').fill('Cheers!\nSee you at the 19th');
  await page.getByLabel('Auto-lock after').fill('10');
  await page.getByLabel('Member discount').fill('10');
  await page.getByLabel('Receipt prefix').fill('bar1');
  await expect(page.getByLabel('Receipt prefix')).toHaveValue('BAR1');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(toast(page, 'Settings saved')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Oakfield GC Bar' })).toBeVisible();
  await expect(page.getByTestId('next-receipt-number')).toHaveText('BAR1-000001');
  const [saved] = await readStore<Settings>(page, 'settings');
  expect(saved).toMatchObject({
    clubName: 'Oakfield GC Bar',
    receiptFooter: 'Cheers!\nSee you at the 19th',
    autoLockMinutes: 10,
    memberDiscountPercent: 10,
    devicePrefix: 'BAR1',
    receiptCounter: 0,
  });

  // The new discount reaches the product form hint.
  await openSection(page, 'Products', /#\/backoffice\/products$/);
  await page.getByRole('button', { name: 'Edit Club Bitter' }).click();
  await expect(dialog(page, 'Edit product').getByText('Members get 10% off this product')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('backup: export downloads a file, and import checks it, needs REPLACE and replaces everything', async ({ page }) => {
  await openSection(page, 'Backup', /#\/backoffice\/backup$/);
  await expect(page.getByTestId('last-backup')).toHaveText('Never');
  await expectNoHorizontalScroll(page);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^club-epos-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  await expect(page.getByTestId('last-backup')).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  const path = await download.path();
  const file = JSON.parse(await readFile(path, 'utf8')) as { format: string; exportedAt: string; tables: Record<string, unknown[]> };
  expect(file.format).toBe('club-epos-backup');
  expect(file.tables.products).toHaveLength(40);
  const [settings] = await readStore<Settings>(page, 'settings');
  expect(settings?.lastBackupAt).toBe(file.exportedAt);
  const exportEvents = (await readAuditEvents(page)).filter((e) => e.type === 'backupExport');
  expect(exportEvents).toHaveLength(1);
  expect(exportEvents[0]?.detail).toEqual({ exportedAt: file.exportedAt });

  // A change made after the export, which the import will undo.
  await openSection(page, 'Settings', /#\/backoffice\/settings$/);
  await page.getByLabel('Club name').fill('Changed Club');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('link', { name: 'Changed Club' })).toBeVisible();

  await openSection(page, 'Backup', /#\/backoffice\/backup$/);
  // A file that is not a backup is rejected with its problems listed (D-089).
  await page.getByLabel('Choose backup file').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') });
  await expect(page.getByTestId('backup-problems')).toContainText('The file is not a Club EPOS backup');
  await expect(page.getByRole('button', { name: 'Import backup' })).toHaveCount(0);

  await page.getByLabel('Choose another file').setInputFiles(path);
  const summary = page.getByTestId('backup-summary');
  await expect(summary).toContainText('It is a valid Club EPOS backup.');
  await expect(summary.getByRole('term').filter({ hasText: 'Products' }).locator('xpath=following-sibling::dd')).toHaveText('40');
  await expect(summary.getByRole('term').filter({ hasText: 'Staff' }).locator('xpath=following-sibling::dd')).toHaveText('3');
  const importButton = page.getByRole('button', { name: 'Import backup' });
  await expect(importButton).toBeDisabled();
  await page.getByLabel('Type REPLACE to confirm').fill('replace');
  await expect(importButton).toBeDisabled();
  await page.getByLabel('Type REPLACE to confirm').fill('REPLACE');
  await expect(importButton).toBeEnabled();
  await importButton.click();

  // Everyone is logged out and the data (club name included) comes from the file (D-090).
  await expect(loginKeypad(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: CLUB_NAME })).toBeVisible();
  await login(page, MANAGER.pin);
  const [restored] = await readStore<Settings>(page, 'settings');
  expect(restored?.clubName).toBe(CLUB_NAME);
  const imports = (await readAuditEvents(page)).filter((e) => e.type === 'backupImport');
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({
    staffId: await staffId(page, MANAGER.name),
    detail: { fileExportedAt: file.exportedAt, fileDeviceId: settings?.deviceId, importedByName: MANAGER.name },
  });
});

// ---------------------------------------------------------------------------
// Regressions: no backup import over a payment in progress; focus comes back to Add product (D-134)
// ---------------------------------------------------------------------------

test('a backup import is refused while a payment has money taken, which would otherwise vanish with no record (D-033, D-134)', async ({ page }) => {
  await openPeriod(page, 10_000);
  await openSection(page, 'Backup', /#\/backoffice\/backup$/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  const path = await download.path();

  // £20 of a £26.00 bottle is in the drawer.
  await navigate(page, 'Till');
  await page.getByRole('tab', { name: 'Wine', exact: true }).click();
  await page.getByRole('button', { name: 'Prosecco (bottle)', exact: true }).click();
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(page).toHaveURL(/#\/pay$/);
  await page.getByRole('button', { name: '£20', exact: true }).click();
  await expect(page.getByTestId('tender-row')).toHaveCount(1);

  await openSection(page, 'Backup', /#\/backoffice\/backup$/);
  const warning = page.getByTestId('backup-payment-in-progress');
  await expect(warning).toHaveText(/A payment is in progress\. Finish or cancel it before importing a backup\./);
  await page.getByLabel('Choose backup file').setInputFiles(path);
  await expect(page.getByTestId('backup-summary')).toContainText('It is a valid Club EPOS backup.');
  await page.getByLabel('Type REPLACE to confirm').fill('REPLACE');
  await expect(page.getByRole('button', { name: 'Import backup' })).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // Back to Pay: the payment is still there with its £20.
  await warning.getByRole('link', { name: 'Back to Pay' }).click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByTestId('tender-row')).toContainText(/Cash\s*£20\.00/);
  // Once it is handed back and cancelled, the import is allowed again.
  await page.getByRole('button', { name: 'Cancel payment', exact: true }).click();
  await dialog(page, 'Cancel this payment?').getByRole('button', { name: 'Yes, cancel' }).click();
  await openSection(page, 'Backup', /#\/backoffice\/backup$/);
  await expect(page.getByTestId('backup-payment-in-progress')).toHaveCount(0);
  await page.getByLabel('Choose backup file').setInputFiles(path);
  await page.getByLabel('Type REPLACE to confirm').fill('REPLACE');
  await expect(page.getByRole('button', { name: 'Import backup' })).toBeEnabled();
});

test('keyboard focus: Add product goes busy without losing focus, and focus returns to it when its dialog closes (D-134)', async ({ page }) => {
  await openSection(page, 'Products', /#\/backoffice\/products$/);
  const add = page.getByRole('button', { name: 'Add product', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  const addDialog = dialog(page, 'Add product');
  await expect(addDialog).toBeVisible();
  await expect(addDialog.getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(addDialog).toBeHidden();
  await expect(add).toBeFocused();
});

/** 'body' when focus is lost, else the focused element's tag, id and text (e.g. 'main#main'). */
function focusedElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'body';
    return `${active.tagName.toLowerCase()}${active.id === '' ? '' : `#${active.id}`}`;
  });
}

test('keyboard focus: a deal’s Deactivate / Reactivate keeps focus while it saves and after (D-134, D-137)', async ({ page }) => {
  await openSection(page, 'Deals', /#\/backoffice\/deals$/);
  const deactivate = page.getByRole('button', { name: 'Deactivate Any 2 bottles for £8', exact: true });
  await deactivate.focus();
  await page.keyboard.press('Enter');
  const reactivate = page.getByRole('button', { name: 'Reactivate Any 2 bottles for £8', exact: true });
  await expect(reactivate).toBeVisible();
  await expect(toast(page, 'Any 2 bottles for £8 deactivated')).toBeVisible();
  await expect(reactivate).toBeFocused();
  // And back, from the keyboard again.
  await page.keyboard.press('Enter');
  await expect(deactivate).toBeVisible();
  await expect(deactivate).toBeFocused();
  const deals = await readStore<Deal>(page, 'deals');
  expect(deals.find((d) => d.name === 'Any 2 bottles for £8')?.active).toBe(true);
});

test('keyboard focus: Cancel on a checked backup file removes itself and focus stays on the page (D-135, D-137)', async ({ page }) => {
  await openSection(page, 'Backup', /#\/backoffice\/backup$/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  await page.getByLabel('Choose backup file').setInputFiles(await download.path());
  const summary = page.getByTestId('backup-summary');
  await expect(summary).toContainText('It is a valid Club EPOS backup.');
  await summary.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(summary).toHaveCount(0);
  await expect.poll(() => focusedElement(page)).toBe('main#main');
});

// ---------------------------------------------------------------------------
// Regressions: saving Settings and choosing a backup file keep keyboard focus (D-135, D-138)
// ---------------------------------------------------------------------------

test('keyboard focus: saving Settings keeps focus on Save settings, or on the field where Enter was pressed, which shows the value saved (D-135, D-138)', async ({ page }) => {
  await openSection(page, 'Settings', /#\/backoffice\/settings$/);
  await page.getByLabel('Receipt footer').fill('Thanks for visiting');
  const save = page.getByRole('button', { name: 'Save settings' });
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(toast(page, 'Settings saved')).toBeVisible();
  await expect.poll(async () => (await readStore<Settings>(page, 'settings'))[0]?.receiptFooter).toBe('Thanks for visiting');
  await expect(save).toBeFocused();

  // Enter in a field saves the form; the field keeps focus and shows the name as saved (spaces collapsed).
  const clubName = page.getByLabel('Club name');
  await clubName.fill('  Oakfield   GC Bar ');
  await clubName.press('Enter');
  await expect(page.getByRole('link', { name: 'Oakfield GC Bar' })).toBeVisible();
  await expect(clubName).toHaveValue('Oakfield GC Bar');
  await expect(clubName).toBeFocused();

  // Staff need a manager PIN for the save: focus comes back to Save settings and stays there.
  await lock(page);
  await login(page, STAFF.pin);
  await openSection(page, 'Settings', /#\/backoffice\/settings$/);
  await page.getByLabel('Receipt footer').fill('See you at the 19th');
  await save.focus();
  await page.keyboard.press('Enter');
  await approveOverride(page, MANAGER.pin);
  await expect.poll(async () => (await readStore<Settings>(page, 'settings'))[0]?.receiptFooter).toBe('See you at the 19th');
  await expect(save).toBeFocused();
});

test('keyboard focus: choosing a backup file keeps focus on the file input while it is checked and after (D-134, D-138)', async ({ page }) => {
  await openSection(page, 'Backup', /#\/backoffice\/backup$/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);

  const input = page.getByLabel('Choose backup file');
  await input.focus();
  await input.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') });
  await expect(page.getByTestId('backup-problems')).toContainText('The file is not a Club EPOS backup');
  const another = page.getByLabel('Choose another file');
  await expect(another).toBeFocused();

  await another.setInputFiles(await download.path());
  await expect(page.getByTestId('backup-summary')).toContainText('It is a valid Club EPOS backup.');
  await expect(another).toBeFocused();
});
