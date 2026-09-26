/**
 * Shared Playwright helpers for every journey (architecture §7.4, docs/ui-plan.md §9).
 *
 * Conventions (D-099): club 'Oakfield Golf Club', manager 'Morgan Manager' PIN 1234; the sample
 * data adds Sam Staff (1111) and Sue Supervisor (2222). Keypad keys are real buttons, so always
 * match them with `exact: true` ('5' would otherwise also match '£5' and '£50').
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { AuditEvent } from '../../src/data/types';

export const DB_NAME = 'club-epos';
export const CLUB_NAME = 'Oakfield Golf Club';

export interface Person {
  name: string;
  pin: string;
  role: 'staff' | 'supervisor' | 'manager';
}

export const MANAGER: Person = { name: 'Morgan Manager', pin: '1234', role: 'manager' };
export const STAFF: Person = { name: 'Sam Staff', pin: '1111', role: 'staff' };
export const SUPERVISOR: Person = { name: 'Sue Supervisor', pin: '2222', role: 'supervisor' };

/** The width at or above which the till shows the side basket panel (below: bottom sheet). */
export const WIDE_MIN_WIDTH = 900;

/** Every store in the database (D-116): the entity names plus 'outbox' and 'draft'. */
export type StoreName =
  | 'staff'
  | 'categories'
  | 'products'
  | 'deals'
  | 'members'
  | 'bookings'
  | 'tabs'
  | 'sales'
  | 'stockMovements'
  | 'periods'
  | 'auditEvents'
  | 'settings'
  | 'outbox'
  | 'draft';

// ---------------------------------------------------------------------------
// Start-up, first run, login, lock
// ---------------------------------------------------------------------------

/**
 * Starts from an empty device: deletes the 'club-epos' database and clears web storage, then
 * reloads and waits for the Setup screen. (Each Playwright test already gets a fresh context;
 * this makes it explicit and works mid-test.)
 */
export async function freshStart(page: Page): Promise<void> {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.evaluate(async (dbName) => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // The app's open connection closes on 'versionchange'; the delete then completes.
      request.onblocked = () => resolve();
    });
    localStorage.clear();
    sessionStorage.clear();
  }, DB_NAME);
  await page.goto('/#/');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set up this till' })).toBeVisible();
}

export interface FirstRunOptions {
  managerName?: string;
  pin?: string;
  clubName?: string;
  /** Tick 'Load sample data'. Default true. */
  loadSample?: boolean;
}

/**
 * Completes the Setup screen (spec §6.1) and waits for the manager to land on the Till.
 * Defaults: Morgan Manager, PIN 1234, Oakfield Golf Club, sample data loaded.
 */
export async function firstRun(page: Page, options: FirstRunOptions = {}): Promise<void> {
  const { managerName = MANAGER.name, pin = MANAGER.pin, clubName = CLUB_NAME, loadSample = true } = options;
  if (page.url() === 'about:blank') await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up this till' })).toBeVisible();
  await page.getByLabel('Club name').fill(clubName);
  await page.getByLabel('Manager name').fill(managerName);
  await page.getByLabel('PIN', { exact: true }).fill(pin);
  await page.getByLabel('Confirm PIN').fill(pin);
  if (loadSample) await page.getByLabel('Load sample data').check();
  await page.getByRole('button', { name: 'Set up till' }).click();
  await page.waitForURL(/#\/till$/);
  await expect(page.getByTestId('current-staff')).toHaveText(managerName);
}

/** The login screen's PIN keypad. */
export function loginKeypad(page: Page): Locator {
  return page.getByRole('group', { name: 'Enter your PIN' });
}

/** Presses a PIN on a PinKeypad inside `scope` (login screen or override dialog), then Enter. */
export async function enterPin(scope: Page | Locator, pin: string): Promise<void> {
  for (const digit of pin) await scope.getByRole('button', { name: digit, exact: true }).click();
  await scope.getByRole('button', { name: 'Enter', exact: true }).click();
}

/** Logs in on the login screen and waits for #/till (or #/pay when a Pay session survived a lock). */
export async function login(page: Page, pin: string): Promise<void> {
  const keypad = loginKeypad(page);
  await expect(keypad).toBeVisible();
  await enterPin(keypad, pin);
  await page.waitForURL(/#\/(till|pay)$/);
}

/** Presses the header's Lock button and waits for the login screen. */
export async function lock(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(loginKeypad(page)).toBeVisible();
}

/** Approves a pending PIN override dialog (D-071) with `pin` and waits for it to close. */
export async function approveOverride(page: Page, pin: string): Promise<void> {
  const dialog = page.getByTestId('override-dialog');
  await expect(dialog).toBeVisible();
  await enterPin(dialog, pin);
  await expect(dialog).toBeHidden();
}

// ---------------------------------------------------------------------------
// Navigation and periods
// ---------------------------------------------------------------------------

/** Opens the header Menu and follows the link named `linkName` (e.g. 'Tabs', 'VAT report', 'Back office'). */
export async function navigate(page: Page, linkName: string): Promise<void> {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await menu.getByRole('link', { name: linkName, exact: true }).click();
  await expect(menu).toBeHidden();
}

/**
 * Opens a trading period from the Till's 'No trading period open' prompt via the UI (D-067):
 * 'Open period' -> float on the money keypad -> 'Open period'. Log in as the manager first
 * (anyone else gets the Manager PIN override; approve it with approveOverride).
 */
export async function openPeriod(page: Page, floatPence = 10_000): Promise<void> {
  if (!/#\/till$/.test(page.url())) await navigate(page, 'Till');
  await page.getByTestId('no-period').getByRole('button', { name: 'Open period' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open period' });
  await enterMoney(dialog, floatPence);
  await dialog.getByRole('button', { name: 'Open period' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('period-status')).toHaveText('Period open');
}

// ---------------------------------------------------------------------------
// Keypads and money
// ---------------------------------------------------------------------------

/** Clears a NumericKeypad inside `scope` and enters `pence` as digits (D-006: 2000 -> £20.00). */
export async function enterMoney(scope: Page | Locator, pence: number): Promise<void> {
  if (!Number.isSafeInteger(pence) || pence < 0) throw new RangeError(`enterMoney needs whole pence >= 0 (got ${pence})`);
  await scope.getByRole('button', { name: 'Clear', exact: true }).click();
  if (pence === 0) return;
  for (const digit of String(pence)) await scope.getByRole('button', { name: digit, exact: true }).click();
}

/** formatPence (D-005) for assertions: 0 -> '£0.00', 123456 -> '£1,234.56', -255 -> '-£2.55'. */
export function money(pence: number): string {
  if (!Number.isSafeInteger(pence)) throw new RangeError(`money needs whole pence (got ${pence})`);
  const abs = Math.abs(pence);
  const pounds = String((abs - (abs % 100)) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${pence < 0 ? '-' : ''}£${pounds}.${String(abs % 100).padStart(2, '0')}`;
}

/** '£1,234.56' / '-£2.55' -> pence. Throws on anything else. */
export function parseMoney(text: string): number {
  const match = /^\s*(-)?£([\d,]+)\.(\d{2})\s*$/.exec(text);
  if (match === null) throw new Error(`Not a money amount: ${JSON.stringify(text)}`);
  const pence = Number((match[2] ?? '').replace(/,/g, '')) * 100 + Number(match[3]);
  return match[1] === '-' && pence !== 0 ? -pence : pence;
}

/** Reads a money element's text as pence (e.g. getByTestId('basket-total')). */
export async function readMoney(locator: Locator): Promise<number> {
  return parseMoney((await locator.textContent()) ?? '');
}

/** Asserts a money element shows exactly `pence` (retries until it does). */
export async function expectMoney(locator: Locator, pence: number): Promise<void> {
  await expect(locator).toHaveText(money(pence));
}

// ---------------------------------------------------------------------------
// Documents (receipts, X read, Z report) and the database
// ---------------------------------------------------------------------------

/**
 * Runs `action` (e.g. clicking the final tender) and returns the popup tab it opens (D-109).
 * Check it with: await expect(popup).toHaveTitle('Receipt 3F9C-000001') / 'X read' / 'Z report 1'.
 */
export async function waitForDocument(context: BrowserContext, action: () => Promise<unknown>): Promise<Page> {
  const [popup] = await Promise.all([context.waitForEvent('page'), action()]);
  await popup.waitForLoadState();
  return popup;
}

/**
 * Reads every row of an object store straight from IndexedDB. Opens 'club-epos' WITHOUT a
 * version (D-119: Dexie stores native version 10, so opening with 1 fails).
 */
export async function readStore<T = unknown>(page: Page, store: StoreName): Promise<T[]> {
  return page.evaluate(
    ({ dbName, storeName }) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error ?? new Error('indexedDB.open failed'));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            resolve([]);
            return;
          }
          const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          request.onsuccess = () => {
            resolve(request.result as T[]);
            db.close();
          };
          request.onerror = () => {
            reject(request.error ?? new Error('getAll failed'));
            db.close();
          };
        };
      }),
    { dbName: DB_NAME, storeName: store },
  );
}

/** Every audit event (D-116), e.g. to assert one 'override' and one 'void' after journey 5. */
export function readAuditEvents(page: Page): Promise<AuditEvent[]> {
  return readStore<AuditEvent>(page, 'auditEvents');
}

// ---------------------------------------------------------------------------
// Layout checks
// ---------------------------------------------------------------------------

/** True for the phone-portrait project (bottom sheet layout). */
export function isNarrow(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < WIDE_MIN_WIDTH;
}

/**
 * Asserts nothing scrolls sideways (390 px phone rule): the page, <main>, and the topmost open
 * dialog (Modal, bottom sheet, menu). Dialogs are fixed layers portalled to <body>, so they never
 * change the page's scroll width: the dialog panel must sit inside the viewport, and no scroll
 * container inside it may be wider than its box. Intentional sideways scrollers are exempt:
 * DataTable's scroll region (role=region) and CategoryTabs (role=tablist), or anything marked
 * data-scroll-x.
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(async () => {
    // Let opening animations (a sheet sliding up, the menu sliding in) finish before measuring.
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => undefined))), new Promise((resolve) => setTimeout(resolve, 2000))]);
    const doc = document.documentElement;
    const main = document.getElementById('main');
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((d) => d.getClientRects().length > 0);
    const dialog = dialogs[dialogs.length - 1];
    const problems: string[] = [];
    if (dialog !== undefined) {
      const name = dialog.getAttribute('aria-label') ?? document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent ?? 'dialog';
      const box = dialog.getBoundingClientRect();
      if (box.left < -1 || box.right > window.innerWidth + 1) problems.push(`dialog '${name}' spans ${Math.round(box.left)}..${Math.round(box.right)} in a ${window.innerWidth} px viewport`);
      for (const el of [dialog, ...dialog.querySelectorAll<HTMLElement>('*')]) {
        const style = getComputedStyle(el);
        if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
        if (el.matches('[role="region"], [role="tablist"], [data-scroll-x]')) continue;
        if (el.scrollWidth > el.clientWidth + 1) {
          const label = `${el.tagName.toLowerCase()}${el.className === '' ? '' : `.${String(el.className).split(' ')[0]}`}`;
          problems.push(`in dialog '${name}': ${label} is ${el.scrollWidth} px wide inside ${el.clientWidth} px`);
        }
      }
    }
    return {
      page: doc.scrollWidth - doc.clientWidth,
      main: main === null ? 0 : main.scrollWidth - main.clientWidth,
      dialog: problems,
    };
  });
  expect(overflow.page, 'page scrolls horizontally').toBeLessThanOrEqual(0);
  expect(overflow.main, 'main content scrolls horizontally').toBeLessThanOrEqual(0);
  expect(overflow.dialog, 'the open dialog scrolls horizontally').toEqual([]);
}
