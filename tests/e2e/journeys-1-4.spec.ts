/**
 * End-to-end journeys 1–4 of spec §10.3, run at tablet landscape (1280×800) and phone portrait
 * (390×844) by the two Playwright projects:
 *   1. First run → create manager → load sample data → open period
 *   2. Sale with a deal and a member, split payment, receipt tab opens with the correct totals
 *   3. A tab by name and a tab by table number → add items twice → settle
 *   4. Booking → take deposit → final bill with deposit applied → balance paid
 *
 * Every money figure is worked out BY HAND below from the sample data (src/seed; D-097 prices,
 * VAT rates and eligibility, D-098 deals, D-100 members) and the pricing rules (spec §7;
 * D-002 round half up, D-004 allocation, D-014..D-017 deals, D-020 member discount, D-021 VAT,
 * D-023 deposits, D-029/D-030 tenders, D-107 receipt layout). Member discount is 15% (D-057).
 * VAT at 20% on a VAT-inclusive final f is round-half-up(f × 20 / 120).
 */
import { expect, test } from '@playwright/test';
import type { Booking, Category, Deal, Member, Period, Product, Sale, SaleLine, Settings, Staff, StockMovement, Tab } from '../../src/data/types';
import {
  CLUB_NAME,
  MANAGER,
  STAFF,
  SUPERVISOR,
  enterMoney,
  expectMoney,
  expectNoHorizontalScroll,
  freshStart,
  lock,
  login,
  navigate,
  readAuditEvents,
  readStore,
  waitForDocument,
} from './helpers';
import {
  addProduct,
  attachMember,
  button,
  closeBasket,
  expectBasketLines,
  expectHeading,
  expectPayFigures,
  expectTabCard,
  expectTillTotal,
  openBasket,
  openBookingDialog,
  openNewTab,
  openPay,
  payKeypad,
  payOrderAdjustments,
  readReceipt,
  receiptNumber,
  startTrading,
  tabDialogAction,
  toast,
} from './helpers-journeys-a';

/** The receipt's date line: London 'DD/MM/YYYY HH:mm' (D-108). */
const RECEIPT_DATE = expect.stringMatching(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

/** [nameAtSale, qty, unit, VAT rate, deal discount, member discount, final, VAT] for a stored sale line. */
function lineFigures(line: SaleLine): (string | number)[] {
  return [line.nameAtSale, line.qty, line.unitPricePence, line.vatRate, line.dealDiscountPence, line.memberDiscountPence, line.finalPence, line.vatPence];
}

// ---------------------------------------------------------------------------
// Journey 1
// ---------------------------------------------------------------------------

test('journey 1: first run creates the manager, loads the sample data and opens a trading period', async ({ page }) => {
  await freshStart(page);

  // Setup (spec §6.1; D-111): 'Load sample data' starts unticked.
  const sample = page.getByLabel('Load sample data');
  await expect(sample).not.toBeChecked();
  await page.getByLabel('Club name').fill(CLUB_NAME);
  await page.getByLabel('Manager name').fill(MANAGER.name);
  await page.getByLabel('PIN', { exact: true }).fill(MANAGER.pin);
  await page.getByLabel('Confirm PIN').fill(MANAGER.pin);
  await sample.check();
  await expectNoHorizontalScroll(page);
  await button(page, 'Set up till').click();

  // D-111 step 6: the manager is logged in on the Till, which asks for a trading period.
  await page.waitForURL(/#\/till$/);
  await expect(page.getByTestId('current-staff')).toHaveText(MANAGER.name);
  await expect(page.getByRole('link', { name: CLUB_NAME })).toBeVisible();
  await expect(page.getByTestId('period-status')).toHaveText('No period open');
  const prompt = page.getByTestId('no-period');
  await expect(prompt).toContainText('No trading period open');
  // Selling is disabled until a period is open (spec §6.3, §8; D-068): no product grid, no actions.
  await expect(page.getByRole('tab')).toHaveCount(0);
  for (const name of ['Member', 'Tab', 'Booking', 'Void', 'No sale', 'Pay']) await expect(button(page, name)).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // The sample data (spec §9; D-097..D-100), read straight from IndexedDB.
  const staff = await readStore<Staff>(page, 'staff');
  expect(staff.map((s) => `${s.name}:${s.role}:${String(s.active)}`).sort()).toEqual([
    'Morgan Manager:manager:true',
    'Sam Staff:staff:true',
    'Sue Supervisor:supervisor:true',
  ]);
  const manager = staff.find((s) => s.role === 'manager');
  const categories = (await readStore<Category>(page, 'categories')).sort((a, b) => a.sortOrder - b.sortOrder);
  expect(categories.map((c) => c.name)).toEqual(['Draught', 'Bottles & Cans', 'Spirits', 'Wine', 'Soft Drinks', 'Snacks', 'Events']);
  const products = await readStore<Product>(page, 'products');
  expect(products).toHaveLength(40);
  expect(products.every((p) => p.active)).toBe(true);
  // 6 + 6 + 6 + 6 + 7 + 6 + 3 = 40 per category (D-097).
  expect(categories.map((c) => products.filter((p) => p.categoryId === c.id).length)).toEqual([6, 6, 6, 6, 7, 6, 3]);
  // At least one 0% product, so the VAT report shows two rates (spec §9).
  expect(products.filter((p) => p.vatRate === 0).map((p) => p.name).sort()).toEqual(['Raffle Ticket', 'Sweepstake Entry']);
  expect(products.filter((p) => !p.memberDiscountEligible).map((p) => p.name).sort()).toEqual(['Buffet Ticket', 'Raffle Ticket', 'Sweepstake Entry']);
  const deals = await readStore<Deal>(page, 'deals');
  expect(deals.map((d) => `${d.name}:${d.type}:${d.n}:${String(d.pricePence ?? d.m)}:${d.productIds.length}`).sort()).toEqual([
    'Any 2 bottles for £8:nForPrice:2:800:5',
    'Snacks 3 for 2:nForM:3:2:5',
  ]);
  const members = await readStore<Member>(page, 'members');
  expect(members.map((m) => m.memberNumber).sort()).toEqual(Array.from({ length: 20 }, (_, i) => String(1001 + i)));
  const bookings = await readStore<Booking>(page, 'bookings');
  expect(bookings.map((b) => `${b.name}:${b.type}:${b.status}`).sort()).toEqual(['Seniors Society Day:society:open', 'Smith & Jones Wedding:wedding:open']);
  // Opening stock: one goodsIn per tracked product (D-100). Tracked: Draught 5 (not Shandy),
  // Bottles 6, Spirits 6, Wine 6, Soft Drinks 5 (not Cola, Lemonade), Snacks 6 = 34 movements.
  // Units: 5×88 + 6×48 + (5×56 + 10) + (3×40 + 3×12) + 5×24 + 6×36 = 440 + 288 + 290 + 156 + 120 + 216 = 1510.
  const movements = await readStore<StockMovement>(page, 'stockMovements');
  expect(movements).toHaveLength(34);
  expect(movements.every((m) => m.reason === 'goodsIn' && m.note === 'Opening stock' && m.staffId === manager?.id)).toBe(true);
  expect(movements.reduce((sum, m) => sum + m.qty, 0)).toBe(1510);
  const [settings] = await readStore<Settings>(page, 'settings');
  expect(settings).toMatchObject({ clubName: CLUB_NAME, memberDiscountPercent: 15, autoLockMinutes: 5, receiptCounter: 0 });
  // Nothing has been traded yet: no period, sale, tab or audit event (D-100).
  expect(await readStore<Period>(page, 'periods')).toEqual([]);
  expect(await readStore<Sale>(page, 'sales')).toEqual([]);
  expect(await readStore<Tab>(page, 'tabs')).toEqual([]);

  // Open the period from the till's prompt with a £150.00 float (digits as pence, D-006: 1,5,0,0,0).
  await button(prompt, 'Open period').click();
  const dialog = page.getByRole('dialog', { name: 'Open period' });
  await enterMoney(dialog, 15_000);
  await expectMoney(dialog.getByTestId('float-amount'), 15_000);
  await expectNoHorizontalScroll(page);
  await button(dialog, 'Open period').click();
  await expect(dialog).toBeHidden();
  await expect(toast(page, 'Period opened with a float of £150.00')).toBeVisible();
  await expect(page.getByTestId('period-status')).toHaveText('Period open');
  await expect(prompt).toBeHidden();

  // The till can now sell: seven category tabs in sortOrder, Draught first with its six products.
  await expect(page.getByRole('tablist', { name: 'Categories' }).getByRole('tab')).toHaveText([
    'Draught',
    'Bottles & Cans',
    'Spirits',
    'Wine',
    'Soft Drinks',
    'Snacks',
    'Events',
  ]);
  await expect(page.getByRole('tab', { name: 'Draught', exact: true })).toHaveAttribute('aria-selected', 'true');
  const grid = page.getByRole('tabpanel').getByRole('button');
  const draught: [string, string][] = [
    ['Club Bitter', '£4.20'],
    ['Fairway Lager', '£4.80'],
    ['Links IPA', '£5.20'],
    ['Old Caddie Stout', '£5.00'],
    ['Orchard Cider', '£4.60'],
    ['Shandy', '£3.80'],
  ];
  await expect(grid).toHaveCount(draught.length);
  for (const [index, [name, price]] of draught.entries()) {
    await expect(grid.nth(index)).toHaveAccessibleName(name);
    await expect(grid.nth(index)).toHaveAccessibleDescription(price);
    await expect(grid.nth(index)).toBeEnabled();
  }
  for (const name of ['Member', 'Tab', 'Booking', 'No sale']) await expect(button(page, name)).toBeEnabled();
  // Void and Pay need a basket line (D-031).
  await expect(button(page, 'Void')).toBeDisabled();
  await expect(button(page, 'Pay')).toBeDisabled();
  await expectTillTotal(page, 0);
  await expectNoHorizontalScroll(page);

  // The period: float 15000, opened by the manager, still open; the manager needed no override (D-067).
  const periods = await readStore<Period>(page, 'periods');
  expect(periods).toHaveLength(1);
  expect(periods[0]).toMatchObject({ floatPence: 15_000, openedBy: manager?.id });
  expect(periods[0]?.closedAt).toBeUndefined();
  expect(await readAuditEvents(page)).toEqual([]);

  // The sample staff and supervisor accounts work (D-099) and see the open period.
  for (const person of [STAFF, SUPERVISOR]) {
    await lock(page);
    await login(page, person.pin);
    await expect(page.getByTestId('current-staff')).toHaveText(person.name);
    await expect(page.getByTestId('period-status')).toHaveText('Period open');
    await expect(page.getByRole('tab', { name: 'Draught', exact: true })).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// Journey 2
// ---------------------------------------------------------------------------

test('journey 2: a sale with a deal and a member is paid by card then cash, and the receipt tab shows the correct totals', async ({ page, context }) => {
  await startTrading(page, STAFF);

  // Basket in tap order (D-008), all 20% VAT unless stated:
  //   L0 Birdie Pale Ale ×2 @450, L1 Eagle Cider ×1 @470, L2 Clubhouse Stout ×1 @400  ('Any 2 bottles for £8')
  //   L3 Dry Roasted Peanuts ×1 @150  (in 'Snacks 3 for 2' but alone, so no deal)
  //   L4 Raffle Ticket ×2 @100  (0% VAT, not member-eligible)
  await addProduct(page, 'Bottles & Cans', 'Birdie Pale Ale', 2);
  // One group (450, 450) = 900 − 800 = 100 saving → 900 − 100 = 800.
  await expectTillTotal(page, 800);
  await addProduct(page, 'Bottles & Cans', 'Eagle Cider');
  // Units sorted by price DESC (D-014): Eagle 470, Birdie 450, Birdie 450. Group (470, 450) = 920 saves 120;
  // the second Birdie is left over. 900 + 470 − 120 = 1250.
  await expectTillTotal(page, 1250);
  await addProduct(page, 'Bottles & Cans', 'Clubhouse Stout');
  // Eagle 470, Birdie 450, Birdie 450, Clubhouse 400 → groups (470, 450) saves 120 and (450, 400) = 850 saves 50.
  // Deal total 170: 900 + 470 + 400 − 170 = 1600.
  await expectTillTotal(page, 1600);
  await addProduct(page, 'Snacks', 'Dry Roasted Peanuts');
  await expectTillTotal(page, 1750); // 1600 + 150
  await addProduct(page, 'Events', 'Raffle Ticket', 2);
  await expectTillTotal(page, 1950); // 1750 + 2 × 100

  let panel = await openBasket(page);
  await expectBasketLines(panel, [
    { qty: 2, name: 'Birdie Pale Ale', unitPence: 450, grossPence: 900 },
    { qty: 1, name: 'Eagle Cider', unitPence: 470, grossPence: 470 },
    { qty: 1, name: 'Clubhouse Stout', unitPence: 400, grossPence: 400 },
    { qty: 1, name: 'Dry Roasted Peanuts', unitPence: 150, grossPence: 150 },
    { qty: 2, name: 'Raffle Ticket', unitPence: 100, grossPence: 200 },
  ]);
  // Two groups of the same deal print as one deal line '{name} x2' (D-017).
  await expect(panel.getByTestId('deal-line')).toHaveText([/^Any 2 bottles for £8 x2\s*-£1\.70$/]);
  await expect(panel.getByTestId('member-discount-line')).toHaveCount(0);
  await closeBasket(page);

  // Attach member 1007 Grace Gilmour: the discount applies at once (spec §6.5).
  // Deal shares (D-004, D-015): group 1 allocate(120, [470, 450]): 120×470/920 = 61.30 → 61, 120×450/920 = 58.70 → 59.
  //                             group 2 allocate(50, [450, 400]): 50×450/850 = 26.47 → 26, 50×400/850 = 23.53 → 24.
  // Line deal discounts: Birdie 59 + 26 = 85, Eagle 61, Clubhouse 24 (sum 170).
  // Post-deal amounts: Birdie 900 − 85 = 815, Eagle 470 − 61 = 409, Clubhouse 400 − 24 = 376, Peanuts 150;
  // Raffle is not eligible. Base = 815 + 409 + 376 + 150 = 1750 → 1750 × 15 / 100 = 262.5 → 263 (half up, D-002).
  // Spread (D-020): 263×815/1750 = 122.48 → 122; 263×409/1750 = 61.47 → 61; 263×376/1750 = 56.51 → 57;
  // 263×150/1750 = 22.54 → 23; 122 + 61 + 57 + 23 = 263, no remainder.
  // Finals: Birdie 900 − 85 − 122 = 693, Eagle 470 − 61 − 61 = 348, Clubhouse 400 − 24 − 57 = 319,
  // Peanuts 150 − 23 = 127, Raffle 200. Total 693 + 348 + 319 + 127 + 200 = 1687 (= 1950 − 263).
  await attachMember(page, 'Gilmour', '1007 — Grace Gilmour');
  await expect(toast(page, 'Member attached: 1007 — Grace Gilmour')).toBeVisible();
  await expectTillTotal(page, 1687);
  panel = await openBasket(page);
  await expect(panel.getByTestId('member-badge')).toContainText('1007 — Grace Gilmour');
  await expect(panel.getByTestId('deal-line')).toHaveText([/^Any 2 bottles for £8 x2\s*-£1\.70$/]);
  await expect(panel.getByTestId('member-discount-line')).toHaveText(/^Member discount \(15%\)\s*-£2\.63$/);
  await expect(panel.getByTestId('deposit-line')).toHaveCount(0);
  await expectMoney(panel.getByTestId('basket-total'), 1687);
  await expectNoHorizontalScroll(page);
  await closeBasket(page);

  // Pay: £16.87 due; the order summary shows the frozen deal and member lines (D-011).
  await openPay(page);
  await expectPayFigures(page, { due: 1687, remaining: 1687, change: 0 });
  const adjustments = await payOrderAdjustments(page);
  await expect(adjustments.getByRole('listitem')).toHaveText([/^Any 2 bottles for £8 x2\s*-£1\.70$/, /^Member discount \(15%\)\s*-£2\.63$/]);
  await expectNoHorizontalScroll(page);

  // Split: Card £10.00 from the keypad (1,0,0,0) leaves 1687 − 1000 = 687.
  await enterMoney(payKeypad(page), 1000);
  await button(page, 'Card').click();
  await expectPayFigures(page, { due: 1687, remaining: 687, change: 0 });
  await expect(page.getByTestId('tender-row')).toHaveText([/Card\s*£10\.00$/]);

  // £10 cash completes it: change = 1000 − 687 = 313 (only cash gives change, D-029). The receipt opens.
  const popup = await waitForDocument(context, () => button(page, '£10').click());
  const number = await receiptNumber(page, 1);
  await expect(popup).toHaveTitle(`Receipt ${number}`);
  const receipt = await readReceipt(popup);
  expect(receipt.clubName).toBe(CLUB_NAME);
  expect(receipt.facts).toEqual([RECEIPT_DATE, `Receipt: ${number}`, `Served by: ${STAFF.name}`]);
  // D-107: the signed item rows sum to TOTAL: 900 + 470 + 400 + 150 + 200 − 170 − 263 = 1687.
  expect(receipt.items).toEqual([
    ['2 x Birdie Pale Ale @ £4.50', '£9.00'],
    ['1 x Eagle Cider @ £4.70', '£4.70'],
    ['1 x Clubhouse Stout @ £4.00', '£4.00'],
    ['1 x Dry Roasted Peanuts @ £1.50', '£1.50'],
    ['2 x Raffle Ticket @ £1.00', '£2.00'],
    ['Any 2 bottles for £8 x2', '-£1.70'],
    ['Member discount (#1007)', '-£2.63'],
  ]);
  // Tenders in the order taken; 1000 + 1000 − 313 = 1687 (D-032).
  expect(receipt.payment).toEqual([
    ['TOTAL', '£16.87'],
    ['Card', '£10.00'],
    ['Cash', '£10.00'],
    ['Change', '£3.13'],
  ]);
  // VAT per line (D-021): 693×20/120 = 115.5 → 116; 348 → 58; 319 → 53.17 → 53; 127 → 21.17 → 21.
  // 20%: gross 693 + 348 + 319 + 127 = 1487, VAT 116 + 58 + 53 + 21 = 248, net 1487 − 248 = 1239.
  // 0%: Raffle gross 200, VAT 0, net 200. Gross 1487 + 200 = 1687 = TOTAL.
  expect(receipt.vat).toEqual([
    ['20%', '£12.39', '£2.48', '£14.87'],
    ['0%', '£2.00', '£0.00', '£2.00'],
  ]);
  expect(receipt.text).toContain('Thank you for your custom');
  await popup.close();

  // Pay shows the change to hand back, then New sale returns to an empty till.
  const done = page.getByTestId('payment-complete');
  await expect(done.getByRole('heading', { name: 'Sale complete' })).toBeVisible();
  await expect(done).toContainText(number);
  await expectMoney(done.getByTestId('change-due'), 313);
  await expectNoHorizontalScroll(page);
  await button(page, 'New sale').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 0);

  // The stored sale carries exactly the figures above.
  const staff = await readStore<Staff>(page, 'staff');
  const members = await readStore<Member>(page, 'members');
  const sales = await readStore<Sale>(page, 'sales');
  expect(sales).toHaveLength(1);
  const sale = sales[0];
  expect(sale).toMatchObject({
    kind: 'sale',
    receiptNumber: number,
    staffId: staff.find((s) => s.name === STAFF.name)?.id,
    memberId: members.find((m) => m.memberNumber === '1007')?.id,
    dealLines: [expect.objectContaining({ name: 'Any 2 bottles for £8', groupCount: 2, savingPence: 170 })],
    memberDiscountPence: 263,
    depositAppliedPence: 0,
    totalPence: 1687,
    tenders: [
      { type: 'card', amountPence: 1000 },
      { type: 'cash', amountPence: 1000 },
    ],
    changePence: 313,
  });
  expect(sale?.lines.map(lineFigures)).toEqual([
    ['Birdie Pale Ale', 2, 450, 20, 85, 122, 693, 116],
    ['Eagle Cider', 1, 470, 20, 61, 61, 348, 58],
    ['Clubhouse Stout', 1, 400, 20, 24, 57, 319, 53],
    ['Dry Roasted Peanuts', 1, 150, 20, 0, 23, 127, 21],
    ['Raffle Ticket', 2, 100, 0, 0, 0, 200, 0],
  ]);
  // Stock moves for tracked products only (D-079): the Raffle Ticket is not tracked.
  const products = await readStore<Product>(page, 'products');
  const nameOf = (id: string): string => products.find((p) => p.id === id)?.name ?? id;
  const saleMoves = (await readStore<StockMovement>(page, 'stockMovements')).filter((m) => m.reason === 'sale');
  expect(saleMoves.map((m) => `${nameOf(m.productId)}:${m.qty}`).sort()).toEqual([
    'Birdie Pale Ale:-2',
    'Clubhouse Stout:-1',
    'Dry Roasted Peanuts:-1',
    'Eagle Cider:-1',
  ]);
  expect(saleMoves.every((m) => m.saleId === sale?.id)).toBe(true);
});

// ---------------------------------------------------------------------------
// Journey 3
// ---------------------------------------------------------------------------

test('journey 3: a tab by name and a tab by table number take items twice more and are both settled', async ({ page, context }) => {
  test.setTimeout(180_000);
  await startTrading(page, SUPERVISOR);

  // ---- Open the two tabs (D-063 a) ----
  // 'Hendry' (by name): 2 × Links IPA @520 = 1040.
  await addProduct(page, 'Draught', 'Links IPA', 2);
  await expectTillTotal(page, 1040);
  await openNewTab(page, 'name', 'Hendry');
  await expect(toast(page, 'Basket moved to new tab Hendry')).toBeVisible();
  await expectTillTotal(page, 0);

  // 'Table 12' (by table): 1 × House Red (bottle) @1900 with member 1003 Clara Chalmers.
  // Member discount 1900 × 15 / 100 = 285 → 1900 − 285 = 1615.
  await addProduct(page, 'Wine', 'House Red (bottle)');
  await attachMember(page, 'Chalmers', '1003 — Clara Chalmers');
  await expectTillTotal(page, 1615);
  await openNewTab(page, 'table', '12');
  await expect(toast(page, 'Basket moved to new tab Table 12')).toBeVisible();
  await expectTillTotal(page, 0);

  await navigate(page, 'Tabs');
  await expectHeading(page, 'Tabs');
  // Oldest first (D-064).
  await expect(page.getByTestId('tab-row').getByRole('heading', { level: 2 })).toHaveText(['Hendry', 'Table 12']);
  await expectTabCard(page, 'Hendry', { totalPence: 1040, items: 2, member: null });
  await expectTabCard(page, 'Table 12', { totalPence: 1615, items: 1, member: '1003 — Clara Chalmers' });
  await expect(page.getByTestId('tabs-summary')).toContainText('2 open tabs');
  await expectMoney(page.getByTestId('tabs-summary-total'), 2655); // 1040 + 1615
  await expectNoHorizontalScroll(page);

  // ---- Add items, first time: sell a round, then 'Add to' the open tab (D-063 b) ----
  await navigate(page, 'Till');
  // 1 × Links IPA + 1 × Ready Salted Crisps = 520 + 120 = 640 (a single snack: no 3 for 2).
  await addProduct(page, 'Draught', 'Links IPA');
  await addProduct(page, 'Snacks', 'Ready Salted Crisps');
  await expectTillTotal(page, 640);
  await tabDialogAction(page, 'Add to Hendry');
  await expect(toast(page, 'Added to tab Hendry')).toBeVisible();
  await expectTillTotal(page, 0);
  // 2 × Orange Juice @280 = 560. The basket has no member; the tab keeps Clara (D-063 b).
  await addProduct(page, 'Soft Drinks', 'Orange Juice', 2);
  await expectTillTotal(page, 560);
  await tabDialogAction(page, 'Add to Table 12');
  await expect(toast(page, 'Added to tab Table 12')).toBeVisible();
  await expectTillTotal(page, 0);

  await navigate(page, 'Tabs');
  // Hendry merged (D-063 b): Links IPA ×3 = 1560 and Ready Salted Crisps ×1 = 120 → 1680, 4 items.
  await expectTabCard(page, 'Hendry', { totalPence: 1680, items: 4, member: null });
  // Table 12: House Red 1900 + Orange Juice ×2 560 = base 2460; 2460 × 15 / 100 = 369 → 2091, 3 items.
  await expectTabCard(page, 'Table 12', { totalPence: 2091, items: 3, member: '1003 — Clara Chalmers' });
  await expectMoney(page.getByTestId('tabs-summary-total'), 3771); // 1680 + 2091

  // ---- Add items, second time: load the tab, add to it, 'Save to tab' (D-063 c, d) ----
  // Hendry from the Tabs screen's Load.
  await button(page, 'Load Hendry').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expect(toast(page, 'Tab Hendry is on the till')).toBeVisible();
  await expectTillTotal(page, 1680);
  await addProduct(page, 'Snacks', 'Salt & Vinegar Crisps', 2);
  // 'Snacks 3 for 2' now has three units: Ready Salted 120, S&V 120, S&V 120 → the n − m = 1 cheapest is
  // free: saving 120, spread 40/40/40 (D-016). 1560 + 120 + 240 − 120 = 1800.
  await expectTillTotal(page, 1800);
  let panel = await openBasket(page);
  await expect(panel.getByTestId('tab-badge')).toContainText('Hendry');
  await expectBasketLines(panel, [
    { qty: 3, name: 'Links IPA', unitPence: 520, grossPence: 1560 },
    { qty: 1, name: 'Ready Salted Crisps', unitPence: 120, grossPence: 120 },
    { qty: 2, name: 'Salt & Vinegar Crisps', unitPence: 120, grossPence: 240 },
  ]);
  await expect(panel.getByTestId('deal-line')).toHaveText([/^Snacks 3 for 2\s*-£1\.20$/]);
  await closeBasket(page);
  await tabDialogAction(page, 'Save to tab');
  await expect(toast(page, 'Saved to Hendry')).toBeVisible();
  await expectTillTotal(page, 0);

  // Table 12 from the till's Tab button (an empty basket offers 'Load an open tab').
  await tabDialogAction(page, 'Load Table 12');
  await expect(toast(page, 'Tab Table 12 is on the till')).toBeVisible();
  await expectTillTotal(page, 2091);
  await addProduct(page, 'Soft Drinks', 'Orange Juice');
  // Orange Juice ×3 = 840: base 1900 + 840 = 2740 → 2740 × 15 / 100 = 411 → 2740 − 411 = 2329.
  await expectTillTotal(page, 2329);
  await addProduct(page, 'Events', 'Sweepstake Entry');
  // + 200 (0% VAT, not member-eligible, so no discount on it) → 2529.
  await expectTillTotal(page, 2529);
  panel = await openBasket(page);
  await expect(panel.getByTestId('tab-badge')).toContainText('Table 12');
  await expect(panel.getByTestId('member-badge')).toContainText('1003 — Clara Chalmers');
  await expectBasketLines(panel, [
    { qty: 1, name: 'House Red (bottle)', unitPence: 1900, grossPence: 1900 },
    { qty: 3, name: 'Orange Juice', unitPence: 280, grossPence: 840 },
    { qty: 1, name: 'Sweepstake Entry', unitPence: 200, grossPence: 200 },
  ]);
  await expect(panel.getByTestId('member-discount-line')).toHaveText(/^Member discount \(15%\)\s*-£4\.11$/);
  await expect(panel.getByTestId('deal-line')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await closeBasket(page);
  await tabDialogAction(page, 'Save to tab');
  await expect(toast(page, 'Saved to Table 12')).toBeVisible();
  await expectTillTotal(page, 0);

  await navigate(page, 'Tabs');
  // Items: Hendry 3 + 1 + 2 = 6; Table 12 1 + 3 + 1 = 5.
  await expectTabCard(page, 'Hendry', { totalPence: 1800, items: 6, member: null });
  await expectTabCard(page, 'Table 12', { totalPence: 2529, items: 5, member: '1003 — Clara Chalmers' });
  await expectMoney(page.getByTestId('tabs-summary-total'), 4329); // 1800 + 2529
  await expectNoHorizontalScroll(page);

  // ---- Settle Table 12 with the Tabs screen's Settle: it loads (member attached) and opens Pay ----
  await button(page, 'Settle Table 12').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByText('Settling tab Table 12', { exact: true })).toBeVisible();
  await expectPayFigures(page, { due: 2529, remaining: 2529, change: 0 });
  // Card with an empty keypad takes the remaining balance (D-029); no change, so straight back to the till.
  let popup = await waitForDocument(context, () => button(page, 'Card').click());
  const first = await receiptNumber(page, 1);
  await expect(popup).toHaveTitle(`Receipt ${first}`);
  let receipt = await readReceipt(popup);
  expect(receipt.facts).toEqual([RECEIPT_DATE, `Receipt: ${first}`, `Served by: ${SUPERVISOR.name}`, 'Tab: Table 12']);
  // Member spread (D-020): allocate(411, [1900, 840]): 411×1900/2740 = 285 exactly, 411×840/2740 = 126 exactly.
  // Finals: House Red 1900 − 285 = 1615, Orange Juice 840 − 126 = 714, Sweepstake 200. 1900 + 840 + 200 − 411 = 2529.
  expect(receipt.items).toEqual([
    ['1 x House Red (bottle) @ £19.00', '£19.00'],
    ['3 x Orange Juice @ £2.80', '£8.40'],
    ['1 x Sweepstake Entry @ £2.00', '£2.00'],
    ['Member discount (#1003)', '-£4.11'],
  ]);
  expect(receipt.payment).toEqual([
    ['TOTAL', '£25.29'],
    ['Card', '£25.29'],
  ]);
  // VAT: 1615×20/120 = 269.17 → 269; 714×20/120 = 119. 20%: gross 1615 + 714 = 2329, VAT 388, net 1941.
  // 0%: Sweepstake gross 200, VAT 0, net 200.
  expect(receipt.vat).toEqual([
    ['20%', '£19.41', '£3.88', '£23.29'],
    ['0%', '£2.00', '£0.00', '£2.00'],
  ]);
  await popup.close();
  await expect(page).toHaveURL(/#\/till$/);
  await expect(toast(page, `Sale complete · Receipt ${first}`)).toBeVisible();
  await expectTillTotal(page, 0);

  // ---- Settle Hendry from the till: Tab → Load Hendry, then Pay in tab mode (D-063 e) ----
  await tabDialogAction(page, 'Load Hendry');
  await expectTillTotal(page, 1800);
  await openPay(page);
  await expect(page.getByText('Settling tab Hendry', { exact: true })).toBeVisible();
  await expectPayFigures(page, { due: 1800, remaining: 1800, change: 0 });
  // £20 cash: change 2000 − 1800 = 200.
  popup = await waitForDocument(context, () => button(page, '£20').click());
  const second = await receiptNumber(page, 2);
  await expect(popup).toHaveTitle(`Receipt ${second}`);
  receipt = await readReceipt(popup);
  expect(receipt.facts).toEqual([RECEIPT_DATE, `Receipt: ${second}`, `Served by: ${SUPERVISOR.name}`, 'Tab: Hendry']);
  // 1560 + 120 + 240 − 120 = 1800.
  expect(receipt.items).toEqual([
    ['3 x Links IPA @ £5.20', '£15.60'],
    ['1 x Ready Salted Crisps @ £1.20', '£1.20'],
    ['2 x Salt & Vinegar Crisps @ £1.20', '£2.40'],
    ['Snacks 3 for 2', '-£1.20'],
  ]);
  expect(receipt.payment).toEqual([
    ['TOTAL', '£18.00'],
    ['Cash', '£20.00'],
    ['Change', '£2.00'],
  ]);
  // Finals: IPA 1560 (VAT 1560×20/120 = 260), Ready Salted 120 − 40 = 80 (VAT 13.33 → 13),
  // S&V 240 − 80 = 160 (VAT 26.67 → 27). 20%: gross 1800, VAT 300, net 1500.
  expect(receipt.vat).toEqual([['20%', '£15.00', '£3.00', '£18.00']]);
  await popup.close();
  const done = page.getByTestId('payment-complete');
  await expectMoney(done.getByTestId('change-due'), 200);
  await button(page, 'New sale').click();
  await expect(page).toHaveURL(/#\/till$/);
  await expectTillTotal(page, 0);

  await navigate(page, 'Tabs');
  await expect(page.getByTestId('tabs-empty')).toContainText('No open tabs');

  // The data: both tabs settled with their settled lines; each sale carries its tab (D-063 e) and
  // Table 12's member stays attached (spec §6.6, D-065).
  const products = await readStore<Product>(page, 'products');
  const nameOf = (id: string): string => products.find((p) => p.id === id)?.name ?? id;
  const members = await readStore<Member>(page, 'members');
  const clara = members.find((m) => m.memberNumber === '1003');
  const tabs = await readStore<Tab>(page, 'tabs');
  expect(tabs).toHaveLength(2);
  const hendry = tabs.find((t) => t.labelType === 'name');
  const table12 = tabs.find((t) => t.labelType === 'table');
  expect(hendry).toMatchObject({ label: 'Hendry', status: 'settled' });
  expect(hendry?.memberId).toBeUndefined();
  expect(hendry?.lines.map((l) => `${nameOf(l.productId)}×${l.qty}`)).toEqual(['Links IPA×3', 'Ready Salted Crisps×1', 'Salt & Vinegar Crisps×2']);
  expect(table12).toMatchObject({ label: '12', status: 'settled', memberId: clara?.id });
  expect(table12?.lines.map((l) => `${nameOf(l.productId)}×${l.qty}`)).toEqual(['House Red (bottle)×1', 'Orange Juice×3', 'Sweepstake Entry×1']);

  const sales = await readStore<Sale>(page, 'sales');
  expect(sales).toHaveLength(2);
  const tableSale = sales.find((s) => s.tabId === table12?.id);
  expect(tableSale).toMatchObject({
    receiptNumber: first,
    memberId: clara?.id,
    dealLines: [],
    memberDiscountPence: 411,
    totalPence: 2529,
    tenders: [{ type: 'card', amountPence: 2529 }],
    changePence: 0,
  });
  expect(tableSale?.lines.map(lineFigures)).toEqual([
    ['House Red (bottle)', 1, 1900, 20, 0, 285, 1615, 269],
    ['Orange Juice', 3, 280, 20, 0, 126, 714, 119],
    ['Sweepstake Entry', 1, 200, 0, 0, 0, 200, 0],
  ]);
  const hendrySale = sales.find((s) => s.tabId === hendry?.id);
  expect(hendrySale).toMatchObject({
    receiptNumber: second,
    dealLines: [expect.objectContaining({ name: 'Snacks 3 for 2', groupCount: 1, savingPence: 120 })],
    memberDiscountPence: 0,
    totalPence: 1800,
    tenders: [{ type: 'cash', amountPence: 2000 }],
    changePence: 200,
  });
  expect(hendrySale?.memberId).toBeUndefined();
  expect(hendrySale?.lines.map(lineFigures)).toEqual([
    ['Links IPA', 3, 520, 20, 0, 0, 1560, 260],
    ['Ready Salted Crisps', 1, 120, 20, 40, 0, 80, 13],
    ['Salt & Vinegar Crisps', 2, 120, 20, 80, 0, 160, 27],
  ]);
});

// ---------------------------------------------------------------------------
// Journey 4
// ---------------------------------------------------------------------------

test('journey 4: a booking takes a deposit, the final bill applies it and the balance is paid', async ({ page, context }) => {
  test.setTimeout(150_000);
  await startTrading(page, STAFF);
  const bookingName = "Captain's Day";

  // ---- Create the booking (spec §6.7; D-026: every booking action is allowed for staff) ----
  await navigate(page, 'Bookings');
  await expectHeading(page, 'Bookings');
  await button(page, 'New booking').click();
  const form = page.getByRole('dialog', { name: 'New booking' });
  await form.getByRole('radio', { name: 'Society day' }).check();
  await form.getByLabel('Name', { exact: true }).fill(bookingName);
  await form.getByLabel('Date', { exact: true }).fill('2027-06-12');
  await form.getByLabel('Notes', { exact: true }).fill('Buffet and prize-giving');
  await button(form, 'Save booking').click();
  await expect(form).toBeHidden();
  await expect(page).toHaveURL(/#\/bookings\/[0-9a-f-]+$/);
  const bookingUrl = page.url();
  await expectHeading(page, bookingName);
  await expect(page.getByTestId('booking-type')).toHaveText('Society day');
  await expect(page.getByTestId('booking-date')).toHaveText('12/06/2027');
  await expect(page.getByTestId('booking-status')).toHaveText('Open');
  await expectMoney(page.getByTestId('booking-balance'), 0);
  await expectNoHorizontalScroll(page);

  // ---- Take a £50.00 deposit (D-024, D-027): £20 cash, then Card for the other £30.00 ----
  await button(page, 'Take deposit').click();
  const deposit = page.getByRole('dialog', { name: 'Take deposit' });
  await enterMoney(deposit, 5000);
  await expectMoney(deposit.getByTestId('deposit-amount'), 5000);
  await button(deposit, 'Continue to Pay').click();
  await expect(page).toHaveURL(/#\/pay$/);
  await expect(page.getByText(`Deposit for ${bookingName}`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('deposit-booking')).toContainText('Society day · 12/06/2027');
  await expectPayFigures(page, { due: 5000, remaining: 5000, change: 0 });
  await button(page, '£20').click();
  await expectPayFigures(page, { due: 5000, remaining: 3000, change: 0 }); // 5000 − 2000
  let popup = await waitForDocument(context, () => button(page, 'Card').click()); // card = the 3000 remaining
  const first = await receiptNumber(page, 1);
  await expect(popup).toHaveTitle(`Receipt ${first}`);
  let receipt = await readReceipt(popup);
  // D-108 deposit receipt: DEPOSIT heading, the booking, amount and tenders, balance now, and no VAT.
  expect(receipt.facts).toEqual([
    'DEPOSIT',
    RECEIPT_DATE,
    `Receipt: ${first}`,
    `Served by: ${STAFF.name}`,
    `Deposit — ${bookingName} (Society day, 12/06/2027)`,
  ]);
  expect(receipt.items).toEqual([]);
  expect(receipt.payment).toEqual([
    ['TOTAL', '£50.00'],
    ['Cash', '£20.00'],
    ['Card', '£30.00'],
  ]);
  expect(receipt.vat).toEqual([]);
  expect(receipt.text).toContain('Deposit balance now £50.00');
  expect(receipt.text).toContain('No VAT - deposit is a prepayment; VAT is charged on the final bill');
  await popup.close();
  // No change due, so Pay returns straight to the booking (D-027).
  await expect(page).toHaveURL(bookingUrl);
  await expect(toast(page, `Deposit taken · Receipt ${first}`)).toBeVisible();
  await expectHeading(page, bookingName);
  await expectMoney(page.getByTestId('booking-balance'), 5000);
  // A balance is left, so the booking can't be settled yet (D-026).
  await expect(button(page, 'Mark settled')).toBeDisabled();

  // ---- The final bill ----
  // Buffet Ticket ×4 @1500 = 6000 (20%, not member-eligible), Prosecco (bottle) ×2 @2600 = 5200 (20%),
  // Raffle Ticket ×5 @100 = 500 (0%). No deals, no member: finals sum 6000 + 5200 + 500 = 11700.
  await navigate(page, 'Till');
  await addProduct(page, 'Events', 'Buffet Ticket', 4);
  await addProduct(page, 'Wine', 'Prosecco (bottle)', 2);
  await addProduct(page, 'Events', 'Raffle Ticket', 5);
  await expectTillTotal(page, 11_700);

  // Attach the booking: only open bookings with a balance are offered (D-028), so not the two samples.
  const attach = await openBookingDialog(page);
  const choices = attach.getByRole('list', { name: 'Open bookings with a deposit' }).getByRole('button');
  await expect(choices).toHaveCount(1);
  await expect(choices).toHaveAccessibleName(bookingName);
  await expect(choices).toContainText('£50.00');
  await button(attach, bookingName).click();
  await expect(attach).toBeHidden();
  // Deposit applied = min(balance 5000, bill 11700) = 5000 (D-023) → total 11700 − 5000 = 6700.
  await expectTillTotal(page, 6700);
  const panel = await openBasket(page);
  await expect(panel.getByTestId('booking-badge')).toContainText(`${bookingName} · 12/06/2027`);
  await expectBasketLines(panel, [
    { qty: 4, name: 'Buffet Ticket', unitPence: 1500, grossPence: 6000 },
    { qty: 2, name: 'Prosecco (bottle)', unitPence: 2600, grossPence: 5200 },
    { qty: 5, name: 'Raffle Ticket', unitPence: 100, grossPence: 500 },
  ]);
  await expect(panel.getByTestId('deposit-line')).toHaveText(/^Deposit taken\s*-£50\.00$/);
  await expectMoney(panel.getByTestId('basket-total'), 6700);
  await expectNoHorizontalScroll(page);
  await closeBasket(page);

  // ---- Pay the balance: £50 cash, then Card for the rest ----
  await openPay(page);
  await expectPayFigures(page, { due: 6700, remaining: 6700, change: 0 });
  const adjustments = await payOrderAdjustments(page);
  await expect(adjustments.getByRole('listitem')).toHaveText([/^Deposit taken\s*-£50\.00$/]);
  await button(page, '£50').click();
  await expectPayFigures(page, { due: 6700, remaining: 1700, change: 0 }); // 6700 − 5000
  popup = await waitForDocument(context, () => button(page, 'Card').click()); // card = the 1700 remaining
  const second = await receiptNumber(page, 2);
  await expect(popup).toHaveTitle(`Receipt ${second}`);
  receipt = await readReceipt(popup);
  expect(receipt.facts).toEqual([RECEIPT_DATE, `Receipt: ${second}`, `Served by: ${STAFF.name}`, `Booking: ${bookingName}`]);
  // D-107: 6000 + 5200 + 500 − 5000 = 6700.
  expect(receipt.items).toEqual([
    ['4 x Buffet Ticket @ £15.00', '£60.00'],
    ['2 x Prosecco (bottle) @ £26.00', '£52.00'],
    ['5 x Raffle Ticket @ £1.00', '£5.00'],
    ['Deposit applied', '-£50.00'],
  ]);
  expect(receipt.payment).toEqual([
    ['TOTAL', '£67.00'],
    ['Cash', '£50.00'],
    ['Card', '£17.00'],
  ]);
  // The deposit changes neither line finals nor VAT (D-021, D-023): the VAT summary covers the full finals.
  // Buffet 6000×20/120 = 1000; Prosecco 5200×20/120 = 866.67 → 867. 20%: gross 11200, VAT 1867, net 9333.
  // 0%: Raffle gross 500, VAT 0, net 500.
  expect(receipt.vat).toEqual([
    ['20%', '£93.33', '£18.67', '£112.00'],
    ['0%', '£5.00', '£0.00', '£5.00'],
  ]);
  await popup.close();
  await expect(page).toHaveURL(/#\/till$/);
  await expect(toast(page, `Sale complete · Receipt ${second}`)).toBeVisible();
  await expectTillTotal(page, 0);

  // ---- The deposit is used up (5000 − 5000 = 0), so the booking can be marked settled ----
  await navigate(page, 'Bookings');
  const row = page.getByRole('link', { name: bookingName, exact: true });
  await expectMoney(row.getByTestId('booking-row-balance'), 0);
  await row.click();
  await expectHeading(page, bookingName);
  await expectMoney(page.getByTestId('booking-balance'), 0);
  await button(page, 'Mark settled').click();
  const confirm = page.getByRole('dialog', { name: 'Mark this booking settled?' });
  await button(confirm, 'Mark settled').click();
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId('booking-status')).toHaveText('Settled');
  await expectNoHorizontalScroll(page);

  // The data.
  const booking = (await readStore<Booking>(page, 'bookings')).find((b) => b.name === bookingName);
  expect(booking).toMatchObject({ type: 'society', date: '2027-06-12', notes: 'Buffet and prize-giving', status: 'settled' });
  const sales = await readStore<Sale>(page, 'sales');
  expect(sales).toHaveLength(2);
  const depositSale = sales.find((s) => s.kind === 'deposit');
  expect(depositSale).toMatchObject({
    receiptNumber: first,
    bookingId: booking?.id,
    lines: [],
    dealLines: [],
    memberDiscountPence: 0,
    depositAppliedPence: 0,
    totalPence: 5000,
    tenders: [
      { type: 'cash', amountPence: 2000 },
      { type: 'card', amountPence: 3000 },
    ],
    changePence: 0,
  });
  expect(depositSale?.memberId).toBeUndefined();
  const bill = sales.find((s) => s.kind === 'sale');
  expect(bill).toMatchObject({
    receiptNumber: second,
    bookingId: booking?.id,
    memberDiscountPence: 0,
    depositAppliedPence: 5000,
    totalPence: 6700,
    tenders: [
      { type: 'cash', amountPence: 5000 },
      { type: 'card', amountPence: 1700 },
    ],
    changePence: 0,
  });
  expect(bill?.lines.map(lineFigures)).toEqual([
    ['Buffet Ticket', 4, 1500, 20, 0, 0, 6000, 1000],
    ['Prosecco (bottle)', 2, 2600, 20, 0, 0, 5200, 867],
    ['Raffle Ticket', 5, 100, 0, 0, 0, 500, 0],
  ]);
});
