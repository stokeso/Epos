import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll } from './helpers';

test('a new device opens on the setup screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up this till' })).toBeVisible();
  await expect(page).toHaveURL(/#\/setup$/);
  await expect(page).toHaveTitle('Set up · Club EPOS');
  await expectNoHorizontalScroll(page);
});

test('any other route leads to setup until the till is set up', async ({ page }) => {
  await page.goto('/#/till');
  await expect(page).toHaveURL(/#\/setup$/);
  await page.goto('/#/login');
  await expect(page).toHaveURL(/#\/setup$/);
  await page.goto('/#/no-such-screen');
  await expect(page).toHaveURL(/#\/setup$/);
});
