/**
 * Shared set-up for the services scenario tests: a LocalAdapter on fake-indexeddb with a
 * controlled clock and sequential UUID v4 ids (D-101, D-119), a ServiceContext over the same
 * clock and ids, and a small club catalogue built through the services themselves.
 * Not a test file (vitest only runs *.test.ts).
 */
import { afterEach, expect } from 'vitest';
import { isAppError, type AppErrorCode } from '../../../src/data/errors';
import { createLocalAdapter, deleteLocalDatabase } from '../../../src/data/local';
import type { Repos } from '../../../src/data/repos';
import type { Action, BasketLine, Category, Deal, Member, Product, Role, Staff } from '../../../src/data/types';
import type { BasketState } from '../../../src/rules/basket';
import type { TenderRequest } from '../../../src/rules/tender';
import type { Session } from '../../../src/services/auth';
import { saveCategory, saveDeal, saveProduct } from '../../../src/services/catalogue';
import { createServiceContext, type ServiceContext, type StoragePort } from '../../../src/services/context';
import { saveMember } from '../../../src/services/members';
import { authoriseDirect, type Authorisation } from '../../../src/services/override';
import { completePayment, openDepositPayment, openSalePayment, takeTender, type CompletedSale, type PaySession } from '../../../src/services/pay';
import { openPeriod } from '../../../src/services/periods';
import { createPinCredentials, type PinCredentials } from '../../../src/services/pin';
import { DEFAULT_SETTINGS } from '../../../src/services/setup';
import { recordGoodsIn } from '../../../src/services/stock';
import { makeClock, makeIds, T0, type TestClock, type TestIds } from '../contract';

export { T0 };

export interface Harness {
  ctx: ServiceContext;
  repos: Repos;
  clock: TestClock;
  ids: TestIds;
  dbName: string;
}

interface HarnessOptions {
  start?: string;
  stepMs?: number;
  storage?: StoragePort;
}

const opened: { repos: Repos; dbName: string }[] = [];
let dbCounter = 0;

/** A fresh database + context. Call registerCleanup() once per test file. */
export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  dbCounter += 1;
  const dbName = `services-${dbCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const clock = makeClock(options.start ?? T0, options.stepMs ?? 0);
  const ids = makeIds();
  const repos = await createLocalAdapter({ dbName, now: clock.now, newId: ids.next });
  opened.push({ repos, dbName });
  const ctx = createServiceContext({ repos, now: clock.now, newId: ids.next, ...(options.storage === undefined ? {} : { storage: options.storage }) });
  return { ctx, repos, clock, ids, dbName };
}

/** A second connection to the same database whose commitSale fails after all its writes (D-115). */
export async function failingContext(h: Harness): Promise<ServiceContext> {
  const repos = await createLocalAdapter({ dbName: h.dbName, now: h.clock.now, newId: h.ids.next, failSaleCommitAfterWrites: true });
  opened.push({ repos, dbName: h.dbName });
  return createServiceContext({ repos, now: h.clock.now, newId: h.ids.next });
}

export function registerCleanup(): void {
  afterEach(async () => {
    const names = new Set<string>();
    for (const { repos, dbName } of opened.splice(0)) {
      await repos.close();
      names.add(dbName);
    }
    for (const name of names) await deleteLocalDatabase(name);
  });
}

// ---------------------------------------------------------------------------
// Staff and sessions (PIN hashing is slow, so credentials are cached per PIN)
// ---------------------------------------------------------------------------

export const PINS = { manager: '1234', supervisor: '2222', staff: '1111' } as const;

const credentialCache = new Map<string, Promise<PinCredentials>>();

export function credentialsFor(pin: string): Promise<PinCredentials> {
  let cached = credentialCache.get(pin);
  if (cached === undefined) {
    cached = createPinCredentials(pin);
    credentialCache.set(pin, cached);
  }
  return cached;
}

export function sessionOf(staff: Staff): Session {
  return { staffId: staff.id, name: staff.name, role: staff.role };
}

/** Authorisation for an action the session's own role allows (no override). */
export function auth(session: Session, action: Action): Authorisation {
  const result = authoriseDirect(session, action);
  if (result === null) throw new Error(`${session.role} cannot ${action} directly`);
  return result;
}

/** Initialises the till (Settings + manager) with cached credentials, as completeFirstRun would. */
export async function initialiseTill(h: Harness, clubName = 'Oakfield Golf Club'): Promise<Session> {
  const { manager } = await h.repos.initialise({
    settings: { clubName, ...DEFAULT_SETTINGS },
    manager: { name: 'Morgan Manager', role: 'manager', active: true, ...(await credentialsFor(PINS.manager)) },
  });
  return sessionOf(manager);
}

/** Adds a member of staff directly through the repository (fast path for fixtures). */
export async function addStaff(h: Harness, name: string, role: Role, pin: string, active = true): Promise<Session> {
  const staff = await h.repos.staff.create({ name, role, active, ...(await credentialsFor(pin)) });
  return sessionOf(staff);
}

// ---------------------------------------------------------------------------
// A small club catalogue (the D-042 worked-period products)
// ---------------------------------------------------------------------------

export interface Catalogue {
  draught: Category;
  snacks: Category;
  wine: Category;
  events: Category;
  lager: Product;
  bitter: Product;
  crisps: Product;
  wineBottle: Product;
  raffle: Product;
  lagerDeal: Deal;
  member: Member;
}

type ProductSpec = Pick<Product, 'name' | 'pricePence' | 'vatRate' | 'memberDiscountEligible' | 'stockTracked' | 'stockUnit' | 'lowStockLevel' | 'sortOrder'>;

async function product(h: Harness, manager: Session, category: Category, spec: ProductSpec): Promise<Product> {
  return saveProduct(h.ctx, auth(manager, 'editCatalogue'), null, {
    ...spec,
    categoryId: category.id,
    buttonColour: category.colour,
    active: true,
  });
}

/**
 * Lager 450 (20%, tracked, low 10), Bitter 420 (20%, tracked), Crisps 125 (0%, tracked),
 * Wine 2295 (20%, tracked), Raffle 100 (0%, not member-eligible, untracked);
 * deal 'Lager 3 for 2'; member #1042 Alice Archer. Opening stock: Lager 48, Bitter 48,
 * Crisps 36, Wine 12 (goods in).
 */
export async function buildCatalogue(h: Harness, manager: Session): Promise<Catalogue> {
  const cat = (name: string, sortOrder: number, colour: string): Promise<Category> =>
    saveCategory(h.ctx, auth(manager, 'editCatalogue'), null, { name, sortOrder, colour });
  const draught = await cat('Draught', 1, '#b45309');
  const snacks = await cat('Snacks', 2, '#15803d');
  const wine = await cat('Wine', 3, '#9f1239');
  const events = await cat('Events', 4, '#475569');
  const base = { memberDiscountEligible: true, stockTracked: true, lowStockLevel: 10 } as const;
  const lager = await product(h, manager, draught, { ...base, name: 'Lager', pricePence: 450, vatRate: 20, stockUnit: 'pint', sortOrder: 1 });
  const bitter = await product(h, manager, draught, { ...base, name: 'Bitter', pricePence: 420, vatRate: 20, stockUnit: 'pint', sortOrder: 2 });
  const crisps = await product(h, manager, snacks, { ...base, name: 'Crisps', pricePence: 125, vatRate: 0, stockUnit: 'packet', sortOrder: 1 });
  const wineBottle = await product(h, manager, wine, { ...base, name: 'Wine', pricePence: 2295, vatRate: 20, stockUnit: 'bottle', sortOrder: 1, lowStockLevel: 3 });
  const raffle = await product(h, manager, events, {
    name: 'Raffle Ticket',
    pricePence: 100,
    vatRate: 0,
    memberDiscountEligible: false,
    stockTracked: false,
    stockUnit: 'ticket',
    lowStockLevel: 0,
    sortOrder: 1,
  });
  const lagerDeal = await saveDeal(h.ctx, auth(manager, 'editCatalogue'), null, {
    name: 'Lager 3 for 2',
    type: 'nForM',
    n: 3,
    m: 2,
    productIds: [lager.id],
    active: true,
  });
  const member = await saveMember(h.ctx, auth(manager, 'manageMembersStaffSettings'), null, {
    memberNumber: '1042',
    firstName: 'Alice',
    lastName: 'Archer',
    active: true,
  });
  const goodsIn = async (p: Product, qty: number): Promise<void> => {
    await recordGoodsIn(h.ctx, auth(manager, 'stockControl'), { productId: p.id, qty, note: 'Opening stock' });
  };
  await goodsIn(lager, 48);
  await goodsIn(bitter, 48);
  await goodsIn(crisps, 36);
  await goodsIn(wineBottle, 12);
  return { draught, snacks, wine, events, lager, bitter, crisps, wineBottle, raffle, lagerDeal, member };
}

export interface Till {
  h: Harness;
  manager: Session;
  supervisor: Session;
  staff: Session;
  c: Catalogue;
}

/** Manager + supervisor + staff, the catalogue, and (unless floatPence is null) an open period. */
export async function setupTill(options: HarnessOptions & { floatPence?: number | null } = {}): Promise<Till> {
  const h = await makeHarness(options);
  const manager = await initialiseTill(h);
  const supervisor = await addStaff(h, 'Sue Supervisor', 'supervisor', PINS.supervisor);
  const staff = await addStaff(h, 'Sam Staff', 'staff', PINS.staff);
  const c = await buildCatalogue(h, manager);
  const floatPence = options.floatPence === undefined ? 10000 : options.floatPence;
  if (floatPence !== null) await openPeriod(h.ctx, auth(manager, 'openClosePeriod'), floatPence);
  return { h, manager, supervisor, staff, c };
}

// ---------------------------------------------------------------------------
// Baskets and payment
// ---------------------------------------------------------------------------

export function basket(lines: readonly (readonly [Product, number])[], extras: Omit<BasketState, 'lines'> = {}): BasketState {
  const basketLines: BasketLine[] = lines.map(([p, qty]) => ({ productId: p.id, qty }));
  return { lines: basketLines, ...extras };
}

export const cash = (amountPence: number | null): TenderRequest => ({ type: 'cash', amountPence });
export const card = (amountPence: number | null): TenderRequest => ({ type: 'card', amountPence });

/** Applies tenders in order, failing the test on a rejection. */
export function tenderAll<S extends PaySession>(session: S, tenders: readonly TenderRequest[]): S {
  let current: PaySession = session;
  for (const request of tenders) {
    const result = takeTender(current, request);
    if (!result.ok) throw new Error(`Tender rejected: ${result.message}`);
    current = result.session;
  }
  return current as S;
}

/** Opens Pay for the basket, takes the tenders and completes the sale. */
export async function sell(ctx: ServiceContext, session: Session, b: BasketState, tenders: readonly TenderRequest[]): Promise<CompletedSale> {
  const pay = tenderAll(await openSalePayment(ctx, b), tenders);
  return completePayment(ctx, auth(session, 'sell'), pay);
}

/** Opens a deposit payment, takes the tenders and completes it. */
export async function takeDeposit(
  ctx: ServiceContext,
  session: Session,
  bookingId: string,
  amountPence: number,
  tenders: readonly TenderRequest[],
): Promise<CompletedSale> {
  const pay = tenderAll(await openDepositPayment(ctx, bookingId, amountPence), tenders);
  return completePayment(ctx, auth(session, 'bookings'), pay);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Awaits the promise and asserts it rejects with an AppError of the given code. */
export async function expectAppError(promise: Promise<unknown>, code: AppErrorCode, message?: string | RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught), `expected AppError ${code}, got ${String(caught)}`).toBe(true);
  if (isAppError(caught)) {
    expect(caught.code).toBe(code);
    if (typeof message === 'string') expect(caught.message).toBe(message);
    else if (message !== undefined) expect(caught.message).toMatch(message);
  }
}

/** Outbox entries appended since `before` (count). */
export async function outboxSince(repos: Repos, before: number): Promise<{ entity: string; operation: string }[]> {
  const entries = await repos.outbox.list();
  return entries.slice(before).map((e) => ({ entity: e.entity, operation: e.operation }));
}
