/**
 * The app shell's scrolling (docs/ui-plan.md §6 Layout; D-135, D-137): the shell is exactly the
 * viewport, the header and banners never move, and <main id="main"> is the only scroll container.
 * Hidden content inside <main> (visually hidden prices, table captions, the backup file input)
 * must never make the document itself taller than the viewport: a document that scrolls behind
 * the shell lets a drag over the header, or a scroll past the end of a list, carry the header
 * (Menu, Lock) off the screen and leave a blank page.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, firstRun, freshStart } from './helpers';

/** Every screen inside the shell, as hash routes. */
const ROUTES = [
  'till',
  'tabs',
  'bookings',
  'members',
  'refunds',
  'period',
  'reports/product-sales',
  'reports/vat',
  'backoffice',
  'backoffice/products',
  'backoffice/categories',
  'backoffice/deals',
  'backoffice/staff',
  'backoffice/stock',
  'backoffice/settings',
  'backoffice/backup',
] as const;

/** The document's own scroll: its height beyond the viewport, where it is scrolled to, and the header's top. */
function documentScroll(page: Page): Promise<{ overflow: number; scrollTop: number; headerTop: number }> {
  return page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    return {
      overflow: doc.scrollHeight - window.innerHeight,
      scrollTop: doc.scrollTop,
      headerTop: Math.round(document.querySelector('header')?.getBoundingClientRect().top ?? Number.NaN),
    };
  });
}

async function expectShellStill(page: Page): Promise<void> {
  expect(await documentScroll(page)).toEqual({ overflow: 0, scrollTop: 0, headerTop: 0 });
}

test('the document never scrolls behind the shell on any screen: only <main> does (ui-plan §6, D-137)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  for (const route of ROUTES) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('main h1')).toHaveCount(1);
    // Lazily loaded screens show their content once loaded; let lists render before measuring.
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    await expect.poll(async () => (await documentScroll(page)).overflow, { message: `#/${route}: the document is taller than the viewport` }).toBe(0);
    await expectNoHorizontalScroll(page);
  }
});

test('scrolling over the header or past the end of a long list leaves the header in place (D-137)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await page.goto('/#/backoffice/products');
  await expect(page.getByTestId('product-row').first()).toBeVisible();

  // The wheel over the header: nothing under it scrolls.
  const header = page.locator('header');
  const box = await header.boundingBox();
  if (box === null) throw new Error('No header');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(300);
  await expectShellStill(page);

  // Past the end of the product list: <main> scrolls to its end and stops there.
  const main = page.locator('main');
  const mainBox = await main.boundingBox();
  if (mainBox === null) throw new Error('No main');
  await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + mainBox.height / 2);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(300);
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expectShellStill(page);
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeInViewport();
});

test('choosing a backup file does not scroll the shell to reach the hidden file input (D-137)', async ({ page }) => {
  await freshStart(page);
  await firstRun(page);
  await page.goto('/#/backoffice/backup');
  const input = page.getByLabel('Choose backup file');
  await expect(input).toBeAttached();
  // Tapping the label focuses the visually hidden input: the browser scrolls it into view.
  await input.focus();
  await page.waitForTimeout(200);
  await expectShellStill(page);
});
