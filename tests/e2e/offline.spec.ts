/**
 * Spec §1.1: "It works in a browser on a tablet in landscape and on a phone in portrait, with no
 * internet connection." The app is a PWA (spec §2: vite-plugin-pwa): once it has been loaded, the
 * service worker's precache serves the page, the main chunk and the lazily loaded screens, and all
 * data lives in IndexedDB. Runs in both Playwright projects.
 */
import { expect, test, type Page } from '@playwright/test';
import type { Sale } from '../../src/data/types';
import { MANAGER, STAFF, expectNoHorizontalScroll, firstRun, freshStart, lock, login, loginKeypad, navigate, openPeriod, readStore } from './helpers';
import { addProduct, button, expectHeading, expectTillTotal, finalTender, openPay } from './helpers-journeys-b';

/** Waits until a service worker is active for this page (its precache has been installed). */
async function waitForServiceWorker(page: Page): Promise<void> {
  const scope = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.active === null ? null : registration.scope;
  });
  expect(scope, 'an active service worker').not.toBeNull();
}

test('once loaded, the till starts, logs in and sells with no internet connection', async ({ page, context }) => {
  // Load the app once while online: set up the till so the login screen has someone to log in.
  await freshStart(page);
  await firstRun(page);
  await openPeriod(page, 10_000);
  await waitForServiceWorker(page);

  // Offline from here on, including the reload.
  await context.setOffline(true);
  await page.reload();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  // The page came from the service worker, not the network.
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // The login screen renders and a PIN logs in (PBKDF2 runs locally, D-073).
  await expect(loginKeypad(page)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await login(page, STAFF.pin);
  await expect(page).toHaveURL(/#\/till$/);
  await expect(page.getByTestId('current-staff')).toHaveText(STAFF.name);

  // The till renders the catalogue from IndexedDB and a sale completes offline.
  await expect(page.getByTestId('period-status')).toHaveText('Period open');
  await addProduct(page, 'Draught', 'Club Bitter', 2);
  await expectTillTotal(page, 840);
  await expectNoHorizontalScroll(page);
  await openPay(page, 840);
  const receipt = await finalTender(page, context, 'Exact');
  await expect(receipt).toHaveTitle(/^Receipt [0-9A-Z]{1,6}-000001$/);
  // The receipt tab stays open until the end: in Chromium, closing a tab resets the context's
  // offline emulation for the remaining page (a harness quirk), and this test must stay offline.
  await expect(page).toHaveURL(/#\/till$/);
  const sales = await readStore<Sale>(page, 'sales');
  expect(sales).toEqual([expect.objectContaining({ kind: 'sale', totalPence: 840 })]);

  // Lazily loaded screens come from the precache too.
  await navigate(page, 'Period');
  await expectHeading(page, 'Period');
  await navigate(page, 'Back office');
  await expectHeading(page, 'Back office');
  await page.getByRole('link', { name: 'Stock', exact: true }).click();
  await expectHeading(page, 'Stock');
  await expect(page.getByTestId('low-stock-list')).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);

  // Lock and log in as someone else, still offline.
  await lock(page);
  await login(page, MANAGER.pin);
  await expect(page.getByTestId('current-staff')).toHaveText(MANAGER.name);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await context.setOffline(false);
  await receipt.close();
});

test('a new device that has loaded the app once can be set up offline', async ({ page, context }) => {
  await page.goto('/');
  await expectHeading(page, 'Set up this till');
  await waitForServiceWorker(page);

  await context.setOffline(true);
  await page.reload();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expectHeading(page, 'Set up this till');
  await firstRun(page);
  await expect(page.getByTestId('no-period')).toBeVisible();
  await expect(button(page.getByTestId('no-period'), 'Open period')).toBeVisible();
  await context.setOffline(false);
});
