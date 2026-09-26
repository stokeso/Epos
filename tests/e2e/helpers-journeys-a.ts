/**
 * Helpers for the spec §10.3 journeys 1–4 (tests/e2e/journeys-1-4.spec.ts), built on the shared
 * helpers in ./helpers.ts. Selectors follow architecture §7.4 and docs/ui-plan.md §9: buttons by
 * exact accessible name, dialogs by title, money by test id, documents by `<title>`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { Settings } from '../../src/data/types';
import { MANAGER, expectMoney, firstRun, freshStart, isNarrow, lock, login, money, openPeriod, readStore, type Person } from './helpers';

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/** A button by its exact accessible name ('5' would otherwise also match '£5'). */
export function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/** A toast containing `text`. */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByTestId('toast').filter({ hasText: text });
}

export async function expectHeading(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

/**
 * First run with the sample data (Morgan Manager, PIN 1234, D-099), the manager opens a period
 * with `floatPence` from the till, then `who` (if not the manager) logs in instead.
 */
export async function startTrading(page: Page, who: Person = MANAGER, floatPence = 10_000): Promise<void> {
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page, floatPence);
  if (who.pin !== MANAGER.pin) {
    await lock(page);
    await login(page, who.pin);
  }
  await expect(page.getByTestId('current-staff')).toHaveText(who.name);
}

/** The device's receipt number `n` (D-059): `{devicePrefix}-00000n`, read from Settings. */
export async function receiptNumber(page: Page, n: number): Promise<string> {
  const [settings] = await readStore<Settings>(page, 'settings');
  if (settings === undefined) throw new Error('No Settings row');
  return `${settings.devicePrefix}-${String(n).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Till
// ---------------------------------------------------------------------------

/** Selects the category tab, then taps the product button `times` times. */
export async function addProduct(page: Page, category: string, name: string, times = 1): Promise<void> {
  await page.getByRole('tab', { name: category, exact: true }).click();
  const product = button(page.getByRole('tabpanel'), name);
  for (let i = 0; i < times; i += 1) await product.click();
}

/** The till's always-visible running total: basket-total (tablet) or basket-bar-total (phone). */
export async function expectTillTotal(page: Page, pence: number): Promise<void> {
  await expectMoney(page.getByTestId(isNarrow(page) ? 'basket-bar-total' : 'basket-total'), pence);
}

/**
 * The full basket panel: the side panel on the tablet; on the phone the bottom sheet is opened
 * first. Close it again with closeBasket.
 */
export async function openBasket(page: Page): Promise<Locator> {
  if (!isNarrow(page)) return page.getByRole('complementary', { name: 'Basket' });
  await page.getByRole('button', { name: /^View basket / }).click();
  const sheet = page.getByRole('dialog', { name: 'Basket' });
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function closeBasket(page: Page): Promise<void> {
  if (!isNarrow(page)) return;
  const sheet = page.getByRole('dialog', { name: 'Basket' });
  await button(sheet, 'Close').click();
  await expect(sheet).toBeHidden();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One basket line as the panel shows it: '{qty} × {name}', '@ £unit', then the line gross. */
export interface BasketLineText {
  qty: number;
  name: string;
  unitPence: number;
  grossPence: number;
}

/** Asserts the basket panel's lines, in basket order (D-008), exactly. */
export async function expectBasketLines(panel: Locator, lines: readonly BasketLineText[]): Promise<void> {
  const patterns = lines.map(
    (l) => new RegExp(`^${l.qty} ×\\s*${escapeRegExp(l.name)}\\s*@ ${escapeRegExp(money(l.unitPence))}\\s*${escapeRegExp(money(l.grossPence))}$`),
  );
  await expect(panel.getByRole('list', { name: 'Basket lines' }).locator(':scope > li')).toHaveText(patterns);
}

/** Member → search → tap the result named `label` ('1007 — Grace Gilmour'). */
export async function attachMember(page: Page, query: string, label: string): Promise<void> {
  await button(page, 'Member').click();
  const dialog = page.getByRole('dialog', { name: 'Attach member' });
  await dialog.getByLabel('Search members').fill(query);
  await button(dialog, label).click();
  await expect(dialog).toBeHidden();
}

/** Till → Booking: the 'Attach booking' dialog (open bookings with a deposit balance, D-028). */
export async function openBookingDialog(page: Page): Promise<Locator> {
  await button(page, 'Booking').click();
  const dialog = page.getByRole('dialog', { name: 'Attach booking' });
  await expect(dialog).toBeVisible();
  return dialog;
}

// ---------------------------------------------------------------------------
// Tabs (spec §6.6; D-063, D-064)
// ---------------------------------------------------------------------------

/** Till → Tab → New tab by Name or Table → Open tab. */
export async function openNewTab(page: Page, labelType: 'name' | 'table', label: string): Promise<void> {
  await button(page, 'Tab').click();
  const dialog = page.getByRole('dialog', { name: 'Tab' });
  if (labelType === 'table') await dialog.getByRole('radio', { name: 'Table' }).check();
  await dialog.getByLabel(labelType === 'table' ? 'Table number' : 'Tab name').fill(label);
  await button(dialog, 'Open tab').click();
  await expect(dialog).toBeHidden();
}

/** Till → Tab → press `name` in the open-tab list ('Add to Smith', 'Load Table 5') or the footer ('Save to tab'). */
export async function tabDialogAction(page: Page, name: string): Promise<void> {
  await button(page, 'Tab').click();
  const dialog = page.getByRole('dialog', { name: 'Tab' });
  await button(dialog, name).click();
  await expect(dialog).toBeHidden();
}

/** The Tabs screen card for a tab, by its display label ('Hendry', 'Table 12'). */
export function tabCard(page: Page, label: string): Locator {
  return page.getByTestId('tab-row').filter({ has: page.getByRole('heading', { level: 2, name: label, exact: true }) });
}

export interface TabCardExpectation {
  totalPence: number;
  items: number;
  /** '1003 — Clara Chalmers', or null for no member. */
  member: string | null;
}

export async function expectTabCard(page: Page, label: string, expected: TabCardExpectation): Promise<void> {
  const card = tabCard(page, label);
  await expectMoney(card.getByTestId('tab-total'), expected.totalPence);
  await expect(card).toContainText(`${expected.items} ${expected.items === 1 ? 'item' : 'items'}`);
  await expect(card.getByTestId('tab-time-open')).toHaveText(/^Open (\d+h )?\d+m$/);
  if (expected.member === null) await expect(card.getByTestId('tab-member')).toHaveCount(0);
  else await expect(card.getByTestId('tab-member')).toHaveText(expected.member);
}

// ---------------------------------------------------------------------------
// Pay (spec §6.4)
// ---------------------------------------------------------------------------

/** Till → Pay. On the phone the basket sheet must be closed (the bar's Pay is used). */
export async function openPay(page: Page): Promise<void> {
  await button(page, 'Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pay' })).toBeAttached();
}

/** The Pay screen's custom-amount keypad. */
export function payKeypad(page: Page): Locator {
  return page.getByRole('group', { name: 'Amount tendered' });
}

export async function expectPayFigures(page: Page, figures: { due: number; remaining: number; change: number }): Promise<void> {
  await expectMoney(page.getByTestId('amount-due'), figures.due);
  await expectMoney(page.getByTestId('remaining'), figures.remaining);
  await expectMoney(page.getByTestId('change-due'), figures.change);
}

/** The Pay screen's frozen order summary (collapsed under 'Order details' on the phone). */
export async function payOrderAdjustments(page: Page): Promise<Locator> {
  if (isNarrow(page)) await page.getByText('Order details', { exact: true }).click();
  return page.getByRole('list', { name: 'Discounts and deposits' });
}

// ---------------------------------------------------------------------------
// Receipt documents (D-107, D-108)
// ---------------------------------------------------------------------------

export interface ReceiptContent {
  /** The `<h1>`: the club name. */
  clubName: string;
  /** The header `<p>` lines in order (date, receipt number, staff, heading, context). */
  facts: string[];
  /** The items section as [label, amount] rows (D-107). */
  items: [string, string][];
  /** TOTAL, each tender, Change: [label, amount] rows. */
  payment: [string, string][];
  /** VAT summary rows: [rate, net, VAT, gross] (empty for a deposit). */
  vat: string[][];
  /** The whole body text, whitespace collapsed. */
  text: string;
}

async function rowPairs(doc: Page, selector: string): Promise<[string, string][]> {
  return doc.locator(selector).evaluateAll((rows) =>
    rows.map((row): [string, string] => [row.querySelector('.label')?.textContent ?? '', row.querySelector('.amount')?.textContent ?? '']),
  );
}

/** Reads a receipt popup (the layout conventions documented in src/receipt/index.ts). */
export async function readReceipt(doc: Page): Promise<ReceiptContent> {
  await expect(doc.locator('main.roll')).toBeAttached();
  const clubName = (await doc.locator('header.head h1').textContent()) ?? '';
  const facts = await doc.locator('header.head p').allTextContents();
  const items = await rowPairs(doc, 'section.items .row');
  const payment = await rowPairs(doc, 'section.payment .row');
  const vat = await doc
    .locator('section.vat-summary table.vat tbody tr')
    .evaluateAll((rows) => rows.map((tr) => Array.from(tr.querySelectorAll('td'), (td) => td.textContent ?? '')));
  const text = ((await doc.locator('body').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  return { clubName, facts, items, payment, vat, text };
}
