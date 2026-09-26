/**
 * Helpers for the spec §10.3 journeys 5–8 (tests/e2e/journeys-5-8.spec.ts) and the offline check
 * (tests/e2e/offline.spec.ts). They build on tests/e2e/helpers.ts and only drive the UI through
 * the stable selectors of architecture §7.4 and docs/ui-plan.md §9; IndexedDB is only read.
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { Product, Sale, Settings, Staff, StockMovement } from '../../src/data/types';
import { enterMoney, expectMoney, firstRun, freshStart, isNarrow, money, navigate, openPeriod, readStore, waitForDocument } from './helpers';

// ---------------------------------------------------------------------------
// Set-up and basic selectors
// ---------------------------------------------------------------------------

/** A button by its exact accessible name (keypad keys, action buttons, dialog buttons). */
export function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/** A dialog by its exact title (its accessible name). */
export function dialog(page: Page, name: string): Locator {
  return page.getByRole('dialog', { name, exact: true });
}

/** Journey 1 in short: first run with the sample data, then the manager opens a period. */
export async function setUpTrading(page: Page, floatPence = 10_000): Promise<void> {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page, floatPence);
}

export async function expectHeading(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Till
// ---------------------------------------------------------------------------

/** Taps a product `times` times from its category tab on the till. */
export async function addProduct(page: Page, category: string, name: string, times = 1): Promise<void> {
  await page.getByRole('tab', { name: category, exact: true }).click();
  const product = button(page, name);
  for (let i = 0; i < times; i += 1) await product.click();
}

/** The till's always-visible running total: basket-total (tablet) or basket-bar-total (phone bar). */
export function tillTotal(page: Page): Locator {
  return page.getByTestId(isNarrow(page) ? 'basket-bar-total' : 'basket-total');
}

export async function expectTillTotal(page: Page, pence: number): Promise<void> {
  await expectMoney(tillTotal(page), pence);
}

/** The basket region: the side panel on the tablet, the expanded bottom sheet on the phone. */
export async function openBasket(page: Page): Promise<Locator> {
  if (!isNarrow(page)) return page.getByRole('complementary', { name: 'Basket' });
  const sheet = dialog(page, 'Basket');
  if (!(await sheet.isVisible())) await page.getByRole('button', { name: /^View basket / }).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Closes the phone's basket sheet (nothing to do on the tablet). */
export async function closeBasket(page: Page): Promise<void> {
  if (!isNarrow(page)) return;
  const sheet = dialog(page, 'Basket');
  if (await sheet.isVisible()) {
    await button(sheet, 'Close').click();
    await expect(sheet).toBeHidden();
  }
}

/** Basket lines as the panel shows them: '{qty} ×', name, '@ £unit', gross. */
export function basketLines(basket: Locator): Locator {
  return basket.getByRole('list', { name: 'Basket lines' }).getByRole('listitem');
}

/** A regex for one basket line row: e.g. basketLineText(2, 'Birdie Pale Ale', 450). */
export function basketLineText(qty: number, name: string, unitPence: number): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unit = money(unitPence).replace(/[.$]/g, '\\$&');
  const gross = money(qty * unitPence).replace(/[.$]/g, '\\$&');
  return new RegExp(`^\\s*${qty} ×\\s*${escaped}\\s*@ ${unit}\\s*${gross}\\s*$`);
}

export async function attachMember(page: Page, query: string, label: string): Promise<void> {
  await button(page, 'Member').click();
  const memberDialog = dialog(page, 'Attach member');
  await memberDialog.getByLabel('Search members').fill(query);
  await button(memberDialog, label).click();
  await expect(memberDialog).toBeHidden();
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

/** Till -> Pay; checks the amount due. */
export async function openPay(page: Page, duePence: number): Promise<void> {
  await button(page, 'Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expectMoney(page.getByTestId('amount-due'), duePence);
}

/**
 * Takes the final tender (which commits the sale) and returns the receipt tab it opens.
 * `tender` is the button to press: 'Exact', 'Card', '£5', '£10', '£20', '£50' or 'Cash'.
 */
export async function finalTender(page: Page, context: BrowserContext, tender: string): Promise<Page> {
  return waitForDocument(context, () => button(page, tender).click());
}

/** Enters an amount on the Pay keypad ('Amount tendered'). */
export async function enterTenderAmount(page: Page, pence: number): Promise<void> {
  await enterMoney(page.getByRole('group', { name: 'Amount tendered' }), pence);
}

/** After a payment that gave change: checks the change and goes back with 'New sale'. */
export async function newSaleAfterChange(page: Page, changePence: number): Promise<void> {
  await expectMoney(page.getByTestId('change-due'), changePence);
  await button(page, 'New sale').click();
  await expect(page).toHaveURL(/#\/till$/);
}

// ---------------------------------------------------------------------------
// Documents (receipts, X read, Z report): '<div class="row"><span class="label">…</span> <span class="amount">…</span></div>'
// ---------------------------------------------------------------------------

/** A figure row of a receipt or X/Z document by its exact label ('TOTAL', 'Net takings', …). */
export function docRow(doc: Page, label: string): Locator {
  return doc.locator('.row').filter({ has: doc.locator('.label').getByText(label, { exact: true }) });
}

/** Asserts a money row shows exactly `pence`. */
export async function expectDocMoney(doc: Page, label: string, pence: number): Promise<void> {
  await expect(docRow(doc, label)).toHaveCount(1);
  await expect(docRow(doc, label).locator('.amount')).toHaveText(money(pence));
}

/** Asserts a count row ('No sales', 'Voids') shows exactly `count`. */
export async function expectDocCount(doc: Page, label: string, count: number): Promise<void> {
  await expect(docRow(doc, label)).toHaveCount(1);
  await expect(docRow(doc, label).locator('.amount')).toHaveText(String(count));
}

export interface VatRow {
  rate: number;
  netPence: number;
  vatPence: number;
  grossPence: number;
}

/** Asserts the document's VAT table (Rate, Net, VAT, Gross) has exactly these rows, in order. */
export async function expectVatTable(doc: Page, rows: readonly VatRow[]): Promise<void> {
  const body = doc.locator('table.vat tbody tr');
  await expect(body).toHaveCount(rows.length);
  for (const [index, row] of rows.entries()) {
    await expect(body.nth(index).locator('td')).toHaveText([`${row.rate}%`, money(row.netPence), money(row.vatPence), money(row.grossPence)]);
  }
}

// ---------------------------------------------------------------------------
// Records (read-only IndexedDB access through helpers.readStore)
// ---------------------------------------------------------------------------

export async function devicePrefix(page: Page): Promise<string> {
  const [settings] = await readStore<Settings>(page, 'settings');
  if (settings === undefined) throw new Error('no settings row');
  return settings.devicePrefix;
}

/** A receipt number as the till prints it (D-059): receiptNumber('3F9C', 42) = '3F9C-000042'. */
export function receiptNumber(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

export async function staffIdByName(page: Page, name: string): Promise<string> {
  const person = (await readStore<Staff>(page, 'staff')).find((s) => s.name === name);
  if (person === undefined) throw new Error(`no staff member ${name}`);
  return person.id;
}

export async function productByName(page: Page, name: string): Promise<Product> {
  const product = (await readStore<Product>(page, 'products')).find((p) => p.name === name);
  if (product === undefined) throw new Error(`no product ${name}`);
  return product;
}

export async function saleByReceipt(page: Page, number: string): Promise<Sale> {
  const sale = (await readStore<Sale>(page, 'sales')).find((s) => s.receiptNumber === number);
  if (sale === undefined) throw new Error(`no sale ${number}`);
  return sale;
}

/** Every stock movement of a product, oldest first. */
export async function movementsOf(page: Page, productId: string): Promise<StockMovement[]> {
  const rows = await readStore<StockMovement>(page, 'stockMovements');
  return rows.filter((m) => m.productId === productId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Back office: Stock
// ---------------------------------------------------------------------------

/** Menu -> Back office -> Stock. */
export async function openStockScreen(page: Page): Promise<void> {
  await navigate(page, 'Back office');
  await expectHeading(page, 'Back office');
  await page.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(page).toHaveURL(/#\/backoffice\/stock$/);
  await expectHeading(page, 'Stock');
}

/** The 'On hand' cell of a product's row in the Stock screen's levels table. */
export function stockOnHandCell(page: Page, productName: string): Locator {
  const row = page
    .getByTestId('stock-levels')
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: `${productName} history`, exact: true }) });
  return row.getByRole('cell').first();
}

/**
 * Asserts the Stock screen shows `onHand` for the product. The cell may also carry a 'Low' or
 * 'Negative' badge before the number, so the number is matched at the end of the cell.
 */
export async function expectStockOnHand(page: Page, productName: string, onHand: number): Promise<void> {
  await page.getByLabel('Search stock').fill(productName);
  await expect(stockOnHandCell(page, productName)).toHaveText(new RegExp(`(^|[^\\d-])${onHand < 0 ? '-' : ''}${Math.abs(onHand)}$`));
}
