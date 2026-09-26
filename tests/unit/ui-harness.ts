/**
 * Set-up for the UI store/helper tests: a LocalAdapter on fake-indexeddb, a ServiceContext with
 * a fixed clock, a tiny catalogue, three staff, and the Zustand stores reset to their initial
 * state with the app store pointing at the new context. Not a test file.
 */
import { afterEach } from 'vitest';
import { createLocalAdapter, deleteLocalDatabase } from '../../src/data/local';
import type { Repos } from '../../src/data/repos';
import type { Category, Member, Product, Role, Staff } from '../../src/data/types';
import { EMPTY_BASKET } from '../../src/rules/basket';
import { INITIAL_PIN_ATTEMPTS } from '../../src/rules/lockout';
import type { Session } from '../../src/services/auth';
import { createServiceContext, type ServiceContext } from '../../src/services/context';
import { authoriseDirect, type Authorisation } from '../../src/services/override';
import { openPeriod } from '../../src/services/periods';
import { createPinCredentials, type PinCredentials } from '../../src/services/pin';
import { DEFAULT_SETTINGS } from '../../src/services/setup';
import { resetAppStoreForTests, useAppStore } from '../../src/store/appStore';
import { useBasketStore } from '../../src/store/basketStore';
import { usePayStore } from '../../src/store/payStore';
import { useSessionStore } from '../../src/store/sessionStore';
import { useUiStore } from '../../src/store/uiStore';

export const T0 = '2026-09-26T12:00:00.000Z';
export const PINS = { manager: '1234', supervisor: '2222', staff: '1111' } as const;

export interface UiHarness {
  ctx: ServiceContext;
  repos: Repos;
  manager: Session;
  supervisor: Session;
  staff: Session;
  lager: Product;
  crisps: Product;
  member: Member;
  /** Moves the fixed clock. */
  setNow(iso: string): void;
}

const credentialCache = new Map<string, Promise<PinCredentials>>();
function credentialsFor(pin: string): Promise<PinCredentials> {
  let cached = credentialCache.get(pin);
  if (cached === undefined) {
    cached = createPinCredentials(pin);
    credentialCache.set(pin, cached);
  }
  return cached;
}

const sessionOf = (staff: Staff): Session => ({ staffId: staff.id, name: staff.name, role: staff.role });

let counter = 0;
const opened: { repos: Repos; dbName: string }[] = [];

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `3f9c2a01-7b4d-4e8a-9c1f-${String(idCounter).padStart(12, '0')}`;
}

/** Resets every store to its initial state (the app store is left unbooted). */
export function resetStores(): void {
  resetAppStoreForTests();
  useBasketStore.setState({ basket: EMPTY_BASKET, view: null, pricing: false, error: null });
  usePayStore.setState({ session: null, opening: false, keypadPence: 0, committing: false, error: null });
  useSessionStore.setState({
    session: null,
    pinAttempts: INITIAL_PIN_ATTEMPTS,
    lastActivityMs: 0,
    banners: { backupDue: false, storageWarning: false },
    dismissed: { backupDue: false, storageWarning: false },
  });
  useUiStore.getState().clearToasts();
  useUiStore.setState({ toasts: [], receiptFallback: null, overrideRequest: null, confirmRequest: null, lockCount: 0 });
}

/** Registers afterEach clean-up (close + delete databases, reset stores). Call once per file. */
export function registerUiCleanup(): void {
  afterEach(async () => {
    resetStores();
    for (const { repos, dbName } of opened.splice(0)) {
      await repos.close();
      await deleteLocalDatabase(dbName);
    }
  });
}

async function addStaff(repos: Repos, name: string, role: Role, pin: string): Promise<Session> {
  return sessionOf(await repos.staff.create({ name, role, active: true, ...(await credentialsFor(pin)) }));
}

async function addProduct(repos: Repos, category: Category, name: string, pricePence: number, vatRate: number, sortOrder: number): Promise<Product> {
  return repos.products.create({
    name,
    categoryId: category.id,
    pricePence,
    vatRate,
    memberDiscountEligible: true,
    stockTracked: true,
    stockUnit: 'unit',
    lowStockLevel: 5,
    buttonColour: category.colour,
    sortOrder,
    active: true,
  });
}

/** A fresh till: settings, three staff, Lager 450 (20%), Crisps 125 (0%), member 1042. Stores reset and wired. */
export async function setupUi(): Promise<UiHarness> {
  resetStores();
  counter += 1;
  const dbName = `ui-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  let current = new Date(T0);
  const now = (): Date => new Date(current.getTime());
  const repos = await createLocalAdapter({ dbName, now, newId });
  opened.push({ repos, dbName });
  const ctx = createServiceContext({ repos, now, newId });

  const { manager } = await repos.initialise({
    settings: { clubName: 'Oakfield Golf Club', ...DEFAULT_SETTINGS },
    manager: { name: 'Morgan Manager', role: 'manager', active: true, ...(await credentialsFor(PINS.manager)) },
  });
  const supervisor = await addStaff(repos, 'Sue Supervisor', 'supervisor', PINS.supervisor);
  const staff = await addStaff(repos, 'Sam Staff', 'staff', PINS.staff);
  const category = await repos.categories.create({ name: 'Draught', sortOrder: 1, colour: '#b45309' });
  const lager = await addProduct(repos, category, 'Lager', 450, 20, 1);
  const crisps = await addProduct(repos, category, 'Crisps', 125, 0, 2);
  const member = await repos.members.create({ memberNumber: '1042', firstName: 'Alice', lastName: 'Archer', active: true });

  useAppStore.setState({ ctx, status: 'ready' });
  await useAppStore.getState().refreshAll();

  return {
    ctx,
    repos,
    manager: sessionOf(manager),
    supervisor,
    staff,
    lager,
    crisps,
    member,
    setNow(iso: string) {
      current = new Date(iso);
    },
  };
}

/** Authorisation the session's own role allows. */
export function direct(session: Session, action: Parameters<typeof authoriseDirect>[1]): Authorisation {
  const auth = authoriseDirect(session, action);
  if (auth === null) throw new Error(`${session.role} cannot ${action} directly`);
  return auth;
}

/** Opens a period as the manager and refreshes the app store's cache. */
export async function openTestPeriod(h: UiHarness, floatPence = 10_000): Promise<void> {
  await openPeriod(h.ctx, direct(h.manager, 'openClosePeriod'), floatPence);
  await useAppStore.getState().refreshPeriod();
}
