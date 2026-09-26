/**
 * Sample data (spec §9; D-097..D-100): the fixed data set matches the decisions exactly, passes the
 * same validators the back office uses, prices the D-098 examples, and loads through the
 * repository interfaces in one transaction (LocalAdapter under fake-indexeddb).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, type AppErrorCode } from '../../src/data/errors';
import { createLocalAdapter, deleteLocalDatabase } from '../../src/data/local';
import type { MemberRepo, Repos } from '../../src/data/repos';
import type { Category, Deal, EntityName, Member, Product, Staff } from '../../src/data/types';
import { isDealWellFormed } from '../../src/rules/deals';
import { priceBasket, type PricingLine } from '../../src/rules/pricing';
import { validateBooking, validateCategory, validateDeal, validateMember, validateNewPin, validateProduct } from '../../src/rules/validation';
import { VAT_RATE_CHOICES } from '../../src/rules/vat';
import {
  OPENING_STOCK_NOTE,
  RESERVED_SAMPLE_PINS,
  SAMPLE_ALREADY_LOADED_MESSAGE,
  SAMPLE_PIN_CLASH_MESSAGE,
  SAMPLE_STAFF_PIN,
  SAMPLE_SUPERVISOR_PIN,
  loadSampleData,
  sampleData,
  type SampleData,
  type SampleLoadResult,
  type SampleProduct,
} from '../../src/seed';
import type { ServiceContext } from '../../src/services/context';
import { createPinCredentials, verifyPin } from '../../src/services/pin';
import { makeClock, makeIds } from './contract';

// ---------------------------------------------------------------------------
// Expected data, transcribed from docs/decisions.md D-097..D-100
// ---------------------------------------------------------------------------

const CATEGORIES = [
  ['Draught', 1, '#b45309'],
  ['Bottles & Cans', 2, '#a16207'],
  ['Spirits', 3, '#7c3aed'],
  ['Wine', 4, '#9f1239'],
  ['Soft Drinks', 5, '#0369a1'],
  ['Snacks', 6, '#15803d'],
  ['Events', 7, '#475569'],
] as const;

/** [category, name, price, vatRate, member-eligible, tracked, unit, starting stock, low level] */
type ProductRow = readonly [string, string, number, number, boolean, boolean, string, number, number];

const PRODUCTS: readonly ProductRow[] = [
  ['Draught', 'Club Bitter', 420, 20, true, true, 'pint', 88, 22],
  ['Draught', 'Fairway Lager', 480, 20, true, true, 'pint', 88, 22],
  ['Draught', 'Links IPA', 520, 20, true, true, 'pint', 88, 22],
  ['Draught', 'Old Caddie Stout', 500, 20, true, true, 'pint', 88, 22],
  ['Draught', 'Orchard Cider', 460, 20, true, true, 'pint', 88, 22],
  ['Draught', 'Shandy', 380, 20, true, false, 'pint', 0, 0],
  ['Bottles & Cans', 'Birdie Pale Ale', 450, 20, true, true, 'bottle', 48, 12],
  ['Bottles & Cans', 'Bogey Brown Ale', 450, 20, true, true, 'bottle', 48, 12],
  ['Bottles & Cans', 'Albatross Lager', 430, 20, true, true, 'bottle', 48, 12],
  ['Bottles & Cans', 'Eagle Cider', 470, 20, true, true, 'bottle', 48, 12],
  ['Bottles & Cans', 'Clubhouse Stout', 400, 20, true, true, 'can', 48, 12],
  ['Bottles & Cans', 'Zero Lager (alcohol-free)', 350, 20, true, true, 'bottle', 48, 12],
  ['Spirits', 'House Gin', 380, 20, true, true, 'measure', 56, 14],
  ['Spirits', 'House Vodka', 360, 20, true, true, 'measure', 56, 14],
  ['Spirits', 'House Whisky', 400, 20, true, true, 'measure', 56, 14],
  ['Spirits', 'Single Malt Whisky', 550, 20, true, true, 'measure', 10, 14],
  ['Spirits', 'Dark Rum', 380, 20, true, true, 'measure', 56, 14],
  ['Spirits', 'Brandy', 420, 20, true, true, 'measure', 56, 14],
  ['Wine', 'House Red (175ml)', 550, 20, true, true, 'glass', 40, 10],
  ['Wine', 'House White (175ml)', 550, 20, true, true, 'glass', 40, 10],
  ['Wine', 'House Rosé (175ml)', 550, 20, true, true, 'glass', 40, 10],
  ['Wine', 'House Red (bottle)', 1900, 20, true, true, 'bottle', 12, 3],
  ['Wine', 'House White (bottle)', 1900, 20, true, true, 'bottle', 12, 3],
  ['Wine', 'Prosecco (bottle)', 2600, 20, true, true, 'bottle', 12, 3],
  ['Soft Drinks', 'Cola', 250, 20, true, false, 'glass', 0, 0],
  ['Soft Drinks', 'Lemonade', 250, 20, true, false, 'glass', 0, 0],
  ['Soft Drinks', 'Orange Juice', 280, 20, true, true, 'bottle', 24, 6],
  ['Soft Drinks', 'Sparkling Water', 220, 20, true, true, 'bottle', 24, 6],
  ['Soft Drinks', 'Still Water', 200, 20, true, true, 'bottle', 24, 6],
  ['Soft Drinks', 'Apple & Mango Fizz', 300, 20, true, true, 'bottle', 24, 6],
  ['Soft Drinks', 'Tonic Water', 150, 20, true, true, 'bottle', 24, 6],
  ['Snacks', 'Ready Salted Crisps', 120, 20, true, true, 'packet', 36, 8],
  ['Snacks', 'Salt & Vinegar Crisps', 120, 20, true, true, 'packet', 36, 8],
  ['Snacks', 'Cheese & Onion Crisps', 120, 20, true, true, 'packet', 36, 8],
  ['Snacks', 'Dry Roasted Peanuts', 150, 20, true, true, 'packet', 36, 8],
  ['Snacks', 'Pork Scratchings', 150, 20, true, true, 'packet', 36, 8],
  ['Snacks', 'Chocolate Bar', 140, 20, true, true, 'bar', 36, 8],
  ['Events', 'Raffle Ticket', 100, 0, false, false, 'ticket', 0, 0],
  ['Events', 'Sweepstake Entry', 200, 0, false, false, 'entry', 0, 0],
  ['Events', 'Buffet Ticket', 1500, 20, false, false, 'ticket', 0, 0],
];

const BOTTLE_DEAL_PRODUCTS = ['Birdie Pale Ale', 'Bogey Brown Ale', 'Albatross Lager', 'Eagle Cider', 'Clubhouse Stout'];
const SNACK_DEAL_PRODUCTS = ['Ready Salted Crisps', 'Salt & Vinegar Crisps', 'Cheese & Onion Crisps', 'Dry Roasted Peanuts', 'Pork Scratchings'];

const MEMBERS = [
  ['1001', 'Alice', 'Archer'],
  ['1002', 'Ben', 'Birch'],
  ['1003', 'Clara', 'Chalmers'],
  ['1004', 'David', 'Dunmore'],
  ['1005', 'Emma', 'Ellis'],
  ['1006', 'Frank', 'Fairley'],
  ['1007', 'Grace', 'Gilmour'],
  ['1008', 'Harry', 'Hollis'],
  ['1009', 'Isla', 'Irving'],
  ['1010', 'Jack', 'Jennings'],
  ['1011', 'Katie', 'Kerr'],
  ['1012', 'Liam', 'Lockhart'],
  ['1013', 'Megan', 'Moss'],
  ['1014', 'Noah', 'Newland'],
  ['1015', 'Olivia', 'Orr'],
  ['1016', 'Peter', 'Pryce'],
  ['1017', 'Quinn', 'Quayle'],
  ['1018', 'Rosa', 'Rennie'],
  ['1019', 'Sophie', 'Sutherland'],
  ['1020', 'Tara', 'Thornton'],
] as const;

const TRACKED_COUNT = PRODUCTS.filter((p) => p[5]).length;

/** 7 + 40 + 2 + 20 + 2 + 2 + 34 records, one outbox entry each (D-053, D-100). */
const EXPECTED_RESULT: SampleLoadResult = {
  categories: 7,
  products: 40,
  deals: 2,
  members: 20,
  staff: 2,
  bookings: 2,
  stockMovements: 34,
};
const RECORDS_WRITTEN = 107;

const TODAY = '2026-09-26';
const MANAGER_PIN = '1234';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

const RECORD = { deviceId: 'dev', createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z' };

/** In-memory Category/Product records keyed by sample key, for the pure validators and pricing. */
function asRecords(data: SampleData): { categories: Category[]; products: Product[] } {
  const categories = data.categories.map((c) => ({ ...RECORD, id: c.key, name: c.name, sortOrder: c.sortOrder, colour: c.colour }));
  const colours = new Map(data.categories.map((c) => [c.key, c.colour]));
  const products = data.products.map((p) => ({
    ...RECORD,
    id: p.key,
    name: p.name,
    categoryId: p.categoryKey,
    pricePence: p.pricePence,
    vatRate: p.vatRate,
    memberDiscountEligible: p.memberDiscountEligible,
    stockTracked: p.stockTracked,
    stockUnit: p.stockUnit,
    lowStockLevel: p.lowStockLevel,
    buttonColour: must(colours.get(p.categoryKey), p.categoryKey),
    sortOrder: p.sortOrder,
    active: true,
  }));
  return { categories, products };
}

function sampleDealRecords(data: SampleData): Deal[] {
  return data.deals.map((d, index) => ({
    ...RECORD,
    id: `deal-${index}`,
    name: d.name,
    type: d.type,
    n: d.n,
    ...(d.pricePence === undefined ? {} : { pricePence: d.pricePence }),
    ...(d.m === undefined ? {} : { m: d.m }),
    productIds: [...d.productKeys],
    active: true,
  }));
}

function productByName(data: SampleData, name: string): SampleProduct {
  return must(
    data.products.find((p) => p.name === name),
    name,
  );
}

function pricingLine(data: SampleData, name: string, qty: number): PricingLine {
  const p = productByName(data, name);
  return { productId: p.key, name: p.name, qty, unitPricePence: p.pricePence, vatRate: p.vatRate, memberDiscountEligible: p.memberDiscountEligible };
}

async function expectAppError(promise: Promise<unknown>, code: AppErrorCode, message?: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAppError(error, code), `expected AppError ${code}, got ${String(error)}`).toBe(true);
  if (message !== undefined && isAppError(error)) expect(error.message).toBe(message);
}

interface Store {
  repos: Repos;
  ctx: ServiceContext;
  manager: Staff;
  deviceId: string;
}

let databases = 0;
const opened: { repos: Repos; dbName: string }[] = [];

/** A fresh, initialised LocalAdapter with the setup manager (PIN hashed before initialise). */
async function openStore(managerPin = MANAGER_PIN): Promise<Store> {
  databases += 1;
  const dbName = `seed-test-${databases}`;
  const clock = makeClock('2026-09-26T10:00:00.000Z');
  const ids = makeIds();
  const repos = await createLocalAdapter({ dbName, now: clock.now, newId: ids.next });
  opened.push({ repos, dbName });
  const credentials = await createPinCredentials(managerPin);
  const { manager, settings } = await repos.initialise({
    settings: { clubName: 'Oakfield Golf Club', receiptFooter: 'Thank you for your custom', autoLockMinutes: 5, memberDiscountPercent: 15 },
    manager: { name: 'Morgan Manager', role: 'manager', active: true, ...credentials },
  });
  return { repos, ctx: { repos, now: clock.now, newId: ids.next, storage: undefined }, manager, deviceId: settings.deviceId };
}

async function closeAll(): Promise<void> {
  for (const { repos, dbName } of opened.splice(0)) {
    await repos.close();
    await deleteLocalDatabase(dbName);
  }
}

/** Row counts of every synced table plus the outbox, to prove a failed load wrote nothing. */
async function snapshot(repos: Repos): Promise<Record<string, number>> {
  const tables = await repos.exportAll();
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
}

// ---------------------------------------------------------------------------
// The fixed data set
// ---------------------------------------------------------------------------

describe('sampleData() (D-097..D-100)', () => {
  const data = sampleData();
  const { categories, products } = asRecords(data);

  it('has the seven categories in order with their sort orders and colours (D-097)', () => {
    expect(data.categories.map((c) => [c.name, c.sortOrder, c.colour])).toEqual(CATEGORIES.map((c) => [...c]));
    expect(new Set(data.categories.map((c) => c.key)).size).toBe(7);
  });

  it('has exactly the 40 D-097 products with their prices, VAT, eligibility, units and stock', () => {
    const categoryName = new Map(data.categories.map((c) => [c.key, c.name]));
    const actual = data.products.map((p) => [
      categoryName.get(p.categoryKey),
      p.name,
      p.pricePence,
      p.vatRate,
      p.memberDiscountEligible,
      p.stockTracked,
      p.stockUnit,
      p.startingStock,
      p.lowStockLevel,
    ]);
    expect(actual).toEqual(PRODUCTS.map((p) => [...p]));
    expect(data.products).toHaveLength(40);
    expect(new Set(data.products.map((p) => p.key)).size).toBe(40);
  });

  it('numbers products 1.. within each category (D-097)', () => {
    for (const category of data.categories) {
      const inCategory = data.products.filter((p) => p.categoryKey === category.key);
      expect(inCategory.map((p) => p.sortOrder), category.name).toEqual(inCategory.map((_, i) => i + 1));
    }
    const counts = data.categories.map((c) => data.products.filter((p) => p.categoryKey === c.key).length);
    expect(counts).toEqual([6, 6, 6, 6, 7, 6, 3]);
  });

  it('is mostly 20% with Raffle Ticket and Sweepstake Entry at 0% (spec §9, D-097)', () => {
    expect(data.products.filter((p) => p.vatRate === 0).map((p) => p.name)).toEqual(['Raffle Ticket', 'Sweepstake Entry']);
    expect(data.products.filter((p) => p.vatRate === 20)).toHaveLength(38);
    for (const p of data.products) expect(VAT_RATE_CHOICES as readonly number[]).toContain(p.vatRate);
  });

  it('gives tracked products opening stock and untracked products none, with low level 0 (D-082, D-100)', () => {
    for (const p of data.products) {
      if (p.stockTracked) expect(p.startingStock, p.name).toBeGreaterThan(0);
      else expect([p.startingStock, p.lowStockLevel], p.name).toEqual([0, 0]);
    }
    expect(TRACKED_COUNT).toBe(34);
    const malt = productByName(data, 'Single Malt Whisky');
    expect(malt.startingStock).toBeLessThanOrEqual(malt.lowStockLevel);
    const belowLow = data.products.filter((p) => p.stockTracked && p.startingStock <= p.lowStockLevel).map((p) => p.name);
    expect(belowLow).toEqual(['Single Malt Whisky']);
  });

  it('passes the back-office validators unchanged (D-105)', () => {
    categories.forEach((category, index) => {
      const result = validateCategory(category, { categories: categories.slice(0, index) });
      expect(result, category.name).toEqual({ ok: true, value: { name: category.name, sortOrder: category.sortOrder, colour: category.colour } });
    });
    products.forEach((product, index) => {
      const result = validateProduct(product, { products: products.slice(0, index), categories });
      expect(result.ok, product.name).toBe(true);
      if (result.ok) expect(result.value.name).toBe(product.name);
    });
  });

  it('has one nForPrice and one nForM deal that validate and reference existing products (D-098)', () => {
    expect(data.deals.map((d) => [d.name, d.type, d.n, d.pricePence, d.m])).toEqual([
      ['Any 2 bottles for £8', 'nForPrice', 2, 800, undefined],
      ['Snacks 3 for 2', 'nForM', 3, undefined, 2],
    ]);
    const keys = new Set(data.products.map((p) => p.key));
    const nameOf = new Map(data.products.map((p) => [p.key, p.name]));
    for (const deal of data.deals) {
      for (const key of deal.productKeys) expect(keys.has(key), key).toBe(true);
      const result = validateDeal({ ...deal, productIds: deal.productKeys, active: true }, { products });
      expect(result.ok, deal.name).toBe(true);
    }
    for (const deal of sampleDealRecords(data)) expect(isDealWellFormed(deal), deal.name).toBe(true);
    const [bottles, snacks] = data.deals;
    expect(must(bottles, 'bottle deal').productKeys.map((k) => nameOf.get(k))).toEqual(BOTTLE_DEAL_PRODUCTS);
    expect(must(snacks, 'snack deal').productKeys.map((k) => nameOf.get(k))).toEqual(SNACK_DEAL_PRODUCTS);
    const all = data.deals.flatMap((d) => d.productKeys);
    expect(new Set(all).size).toBe(all.length);
  });

  it('prices the D-098 examples with the sample products and deals', () => {
    const deals = sampleDealRecords(data);
    const at = '2026-09-26T13:05:00.000Z';
    const price = (lines: PricingLine[], memberDiscountPercent: number | null): ReturnType<typeof priceBasket> =>
      priceBasket({ lines, deals, at, memberDiscountPercent, depositBalancePence: null });

    const two = price([pricingLine(data, 'Birdie Pale Ale', 2)], null);
    expect(two.lines.map((l) => [l.dealDiscountPence, l.finalPence])).toEqual([[100, 800]]);
    const twoMember = price([pricingLine(data, 'Birdie Pale Ale', 2)], 15);
    expect([twoMember.memberDiscountPence, twoMember.totalPence, twoMember.lines[0]?.vatPence]).toEqual([120, 680, 113]);

    const mixed = price([pricingLine(data, 'Birdie Pale Ale', 2), pricingLine(data, 'Fairway Lager', 1)], 15);
    expect(mixed.lines.map((l) => [l.memberDiscountPence, l.finalPence, l.vatPence])).toEqual([
      [120, 680, 113],
      [72, 408, 68],
    ]);
    expect(mixed.totalPence).toBe(1088);

    const snacks = price([pricingLine(data, 'Ready Salted Crisps', 3), pricingLine(data, 'Chocolate Bar', 1)], null);
    expect(snacks.dealDiscountPence).toBe(120);
    expect(snacks.lines.map((l) => l.finalPence)).toEqual([240, 140]);
    expect(snacks.totalPence).toBe(380);
    expect(snacks.dealLines.map((d) => [d.name, d.groupCount, d.savingPence])).toEqual([['Snacks 3 for 2', 1, 120]]);

    // Zero Lager is outside the bottle deal (D-098): 2 x Zero Lager pays full price.
    expect(price([pricingLine(data, 'Zero Lager (alcohol-free)', 2)], null).totalPence).toBe(700);
  });

  it('has the 20 D-100 members, numbered 1001 to 1020, which validate as unique', () => {
    expect(data.members.map((m) => [m.memberNumber, m.firstName, m.lastName])).toEqual(MEMBERS.map((m) => [...m]));
    const accepted: Member[] = [];
    for (const member of data.members) {
      const result = validateMember({ ...member, active: true }, { members: accepted });
      expect(result, member.memberNumber).toEqual({ ok: true, value: { ...member, active: true } });
      accepted.push({ ...RECORD, id: member.memberNumber, ...member, active: true });
    }
  });

  it('has the sample staff and supervisor with the documented PINs (D-099)', () => {
    expect(data.staff).toEqual([
      { name: 'Sam Staff', role: 'staff', pin: '1111' },
      { name: 'Sue Supervisor', role: 'supervisor', pin: '2222' },
    ]);
    expect([SAMPLE_STAFF_PIN, SAMPLE_SUPERVISOR_PIN]).toEqual(['1111', '2222']);
    expect([...RESERVED_SAMPLE_PINS]).toEqual(data.staff.map((s) => s.pin));
    for (const s of data.staff) expect(validateNewPin(s.pin, s.pin).ok).toBe(true);
  });

  it('has one wedding and one society day with no deposits (D-100)', () => {
    expect(data.bookings).toEqual([
      { type: 'wedding', name: 'Smith & Jones Wedding', daysFromToday: 30, notes: 'Evening reception' },
      { type: 'society', name: 'Seniors Society Day', daysFromToday: 14, notes: '36 golfers' },
    ]);
    for (const b of data.bookings) {
      expect(validateBooking({ type: b.type, name: b.name, date: '2026-10-26', notes: b.notes }).ok, b.name).toBe(true);
    }
  });

  it('returns fresh objects on every call', () => {
    const first = sampleData();
    (first.products as SampleProduct[]).length = 0;
    const firstCategory = must(first.categories[0], 'category');
    firstCategory.name = 'Changed';
    const second = sampleData();
    expect(second.products).toHaveLength(40);
    expect(second.categories[0]?.name).toBe('Draught');
  });
});

// ---------------------------------------------------------------------------
// The loader against the LocalAdapter
// ---------------------------------------------------------------------------

describe('loadSampleData() (D-100)', () => {
  let store: Store;
  let result: SampleLoadResult;
  let outboxBefore: number;

  beforeAll(async () => {
    store = await openStore();
    outboxBefore = await store.repos.outbox.count();
    result = await loadSampleData(store.ctx, { managerStaffId: store.manager.id, today: TODAY });
  });

  afterAll(closeAll);

  it('reports what it created', () => {
    expect(result).toEqual(EXPECTED_RESULT);
  });

  it('creates the categories and products with ids, colours and categories resolved', async () => {
    const { repos, deviceId } = store;
    const categories = await repos.categories.list();
    expect(categories.map((c) => [c.name, c.sortOrder, c.colour]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual(CATEGORIES.map((c) => [...c]));
    const byId = new Map(categories.map((c) => [c.id, c]));

    const products = await repos.products.list();
    expect(products).toHaveLength(40);
    const expected = new Map(PRODUCTS.map((p) => [p[1], p]));
    for (const product of products) {
      const row = must(expected.get(product.name), product.name);
      const category = must(byId.get(product.categoryId), `${product.name} category`);
      expect(
        [category.name, product.name, product.pricePence, product.vatRate, product.memberDiscountEligible, product.stockTracked, product.stockUnit, product.lowStockLevel],
        product.name,
      ).toEqual([row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[8]]);
      expect(product.buttonColour, product.name).toBe(category.colour);
      expect(product.active).toBe(true);
      expect(product.deviceId).toBe(deviceId);
      expect(product.deletedAt).toBeUndefined();
    }
  });

  it('creates both deals, active, undated and pointing at real products (D-098)', async () => {
    const { repos } = store;
    const products = await repos.products.list();
    const nameOf = new Map(products.map((p) => [p.id, p.name]));
    const deals = (await repos.deals.list()).sort((a, b) => a.name.localeCompare(b.name));
    expect(deals.map((d) => [d.name, d.type, d.n, d.pricePence, d.m, d.active, d.startsAt, d.endsAt])).toEqual([
      ['Any 2 bottles for £8', 'nForPrice', 2, 800, undefined, true, undefined, undefined],
      ['Snacks 3 for 2', 'nForM', 3, undefined, 2, true, undefined, undefined],
    ]);
    const [bottles, snacks] = deals;
    expect(must(bottles, 'bottles').productIds.map((id) => nameOf.get(id))).toEqual(BOTTLE_DEAL_PRODUCTS);
    expect(must(snacks, 'snacks').productIds.map((id) => nameOf.get(id))).toEqual(SNACK_DEAL_PRODUCTS);
    for (const deal of deals) {
      expect(Object.hasOwn(deal, deal.type === 'nForPrice' ? 'm' : 'pricePence'), deal.name).toBe(false);
      expect(isDealWellFormed(deal)).toBe(true);
      expect(validateDeal({ ...deal, productIds: deal.productIds }, { products }).ok, deal.name).toBe(true);
    }
  });

  it('creates the 20 members, active and findable by number', async () => {
    const { repos } = store;
    const members = await repos.members.list();
    expect(members.map((m) => [m.memberNumber, m.firstName, m.lastName]).sort()).toEqual(MEMBERS.map((m) => [...m]));
    expect(members.every((m) => m.active)).toBe(true);
    expect((await repos.members.findByNumber('1001'))?.lastName).toBe('Archer');
  });

  it('creates the sample staff with PINs that verify, alongside the setup manager (D-099)', async () => {
    const { repos, manager } = store;
    const staff = await repos.staff.list();
    expect(staff.map((s) => [s.name, s.role, s.active]).sort()).toEqual([
      ['Morgan Manager', 'manager', true],
      ['Sam Staff', 'staff', true],
      ['Sue Supervisor', 'supervisor', true],
    ]);
    const sam = must(
      staff.find((s) => s.name === 'Sam Staff'),
      'Sam',
    );
    const sue = must(
      staff.find((s) => s.name === 'Sue Supervisor'),
      'Sue',
    );
    expect(sam.pinSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(sam.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sam.pinSalt).not.toBe(sue.pinSalt);
    expect(await verifyPin(SAMPLE_STAFF_PIN, sam)).toBe(true);
    expect(await verifyPin(SAMPLE_SUPERVISOR_PIN, sue)).toBe(true);
    expect(await verifyPin(SAMPLE_SUPERVISOR_PIN, sam)).toBe(false);
    expect(await verifyPin(SAMPLE_STAFF_PIN, sue)).toBe(false);
    expect(await verifyPin(MANAGER_PIN, sam)).toBe(false);
    expect(await verifyPin(MANAGER_PIN, must(await repos.staff.get(manager.id), 'manager'))).toBe(true);
  });

  it('creates the two open bookings dated from London today, with no deposits (D-100)', async () => {
    const { repos } = store;
    const bookings = (await repos.bookings.list()).sort((a, b) => a.date.localeCompare(b.date));
    expect(bookings.map((b) => [b.type, b.name, b.date, b.notes, b.status])).toEqual([
      ['society', 'Seniors Society Day', '2026-10-10', '36 golfers', 'open'],
      ['wedding', 'Smith & Jones Wedding', '2026-10-26', 'Evening reception', 'open'],
    ]);
    for (const b of bookings) expect(await repos.sales.bookingBalance(b.id)).toBe(0);
  });

  it('writes one Opening stock goods-in movement per tracked product, by the manager', async () => {
    const { repos, manager } = store;
    const products = await repos.products.list();
    const movements = await repos.stockMovements.list();
    expect(movements).toHaveLength(TRACKED_COUNT);
    const starting = new Map(PRODUCTS.map((p) => [p[1], p[7]]));
    const nameOf = new Map(products.map((p) => [p.id, p.name]));
    for (const m of movements) {
      const name = must(nameOf.get(m.productId), m.productId);
      expect([m.reason, m.qty, m.note, m.staffId], name).toEqual(['goodsIn', starting.get(name), OPENING_STOCK_NOTE, manager.id]);
      expect(m.saleId).toBeUndefined();
    }
    expect(new Set(movements.map((m) => m.productId)).size).toBe(TRACKED_COUNT);
    expect(OPENING_STOCK_NOTE).toBe('Opening stock');
  });

  it('derives stock on hand from the movements, with only Single Malt Whisky low (D-082)', async () => {
    const { repos } = store;
    const products = await repos.products.list();
    const onHand = await repos.stockMovements.onHandByProduct();
    for (const product of products) {
      const row = must(
        PRODUCTS.find((p) => p[1] === product.name),
        product.name,
      );
      const fromMovements = (await repos.stockMovements.listByProduct(product.id)).reduce((total, m) => total + m.qty, 0);
      expect(await repos.stockMovements.onHand(product.id), product.name).toBe(row[7]);
      expect(fromMovements, product.name).toBe(row[7]);
      expect(onHand[product.id] ?? 0, product.name).toBe(row[7]);
    }
    const low = await repos.stockMovements.lowStock();
    expect(low.map((level) => [level.product.name, level.onHand, level.product.lowStockLevel])).toEqual([['Single Malt Whisky', 10, 14]]);
  });

  it('writes one outbox create per record and nothing else: no periods, sales, tabs or audit events', async () => {
    const { repos } = store;
    const entries = (await repos.outbox.list()).slice(outboxBefore);
    expect(entries).toHaveLength(RECORDS_WRITTEN);
    expect(entries.every((e) => e.operation === 'create' && e.syncedAt === null)).toBe(true);
    const perEntity: Partial<Record<EntityName, number>> = {};
    for (const e of entries) perEntity[e.entity] = (perEntity[e.entity] ?? 0) + 1;
    expect(perEntity).toEqual({ categories: 7, products: 40, deals: 2, members: 20, bookings: 2, staff: 2, stockMovements: 34 });
    expect(await repos.periods.list()).toEqual([]);
    expect(await repos.sales.list()).toEqual([]);
    expect(await repos.tabs.list({ includeDeleted: true })).toEqual([]);
    expect(await repos.auditEvents.list()).toEqual([]);
    expect((await repos.settings.get())?.receiptCounter).toBe(0);
  });

  it('refuses to load twice and writes nothing the second time', async () => {
    const { repos, ctx, manager } = store;
    const before = await snapshot(repos);
    await expectAppError(loadSampleData(ctx, { managerStaffId: manager.id, today: TODAY }), 'CONFLICT', SAMPLE_ALREADY_LOADED_MESSAGE);
    expect(await snapshot(repos)).toEqual(before);
  });
});

describe('loadSampleData() guards (D-099, D-100)', () => {
  afterEach(closeAll);

  it('refuses when any category exists, even a deleted one', async () => {
    const { repos, ctx, manager } = await openStore();
    const category = await repos.categories.create({ name: 'Old', sortOrder: 1, colour: '#000000' });
    await repos.categories.softDelete(category.id);
    const before = await snapshot(repos);
    await expectAppError(loadSampleData(ctx, { managerStaffId: manager.id, today: TODAY }), 'CONFLICT');
    expect(await snapshot(repos)).toEqual(before);
  });

  it('refuses when an active staff member already uses a sample PIN, and writes nothing', async () => {
    const { repos, ctx, manager } = await openStore(SAMPLE_SUPERVISOR_PIN);
    const before = await snapshot(repos);
    await expectAppError(loadSampleData(ctx, { managerStaffId: manager.id, today: TODAY }), 'PIN_UNAVAILABLE', SAMPLE_PIN_CLASH_MESSAGE);
    expect(await snapshot(repos)).toEqual(before);
  });

  it('ignores a deactivated staff member holding a sample PIN (D-075)', async () => {
    const { repos, ctx, manager } = await openStore();
    const credentials = await createPinCredentials(SAMPLE_STAFF_PIN);
    await repos.staff.create({ name: 'Former Staff', role: 'staff', active: false, ...credentials });
    expect(await loadSampleData(ctx, { managerStaffId: manager.id, today: TODAY })).toEqual(EXPECTED_RESULT);
  });

  it('refuses an unknown manager id and writes nothing', async () => {
    const { repos, ctx } = await openStore();
    const before = await snapshot(repos);
    await expectAppError(loadSampleData(ctx, { managerStaffId: '3f9c2a99-7b4d-4e8a-9c1f-000000000999', today: TODAY }), 'NOT_FOUND');
    expect(await snapshot(repos)).toEqual(before);
  });

  it('rejects a malformed date before writing anything', async () => {
    const { repos, ctx, manager } = await openStore();
    const before = await snapshot(repos);
    await expect(loadSampleData(ctx, { managerStaffId: manager.id, today: '2026-02-30' })).rejects.toThrow(RangeError);
    expect(await snapshot(repos)).toEqual(before);
  });

  it('dates bookings across a month end in London dates', async () => {
    const { repos, ctx, manager } = await openStore();
    await loadSampleData(ctx, { managerStaffId: manager.id, today: '2026-12-20' });
    const dates = (await repos.bookings.list()).map((b) => [b.name, b.date]).sort();
    expect(dates).toEqual([
      ['Seniors Society Day', '2027-01-03'],
      ['Smith & Jones Wedding', '2027-01-19'],
    ]);
  });

  it('is one transaction: a failure part-way leaves nothing behind, and a retry then succeeds', async () => {
    const { repos, ctx, manager } = await openStore();
    const before = await snapshot(repos);

    let memberCreates = 0;
    const failingMembers = new Proxy(repos.members, {
      get(target, prop, receiver): unknown {
        if (prop !== 'create') return Reflect.get(target, prop, receiver) as unknown;
        const create: MemberRepo['create'] = (input) => {
          memberCreates += 1;
          if (memberCreates === 10) throw new Error('forced failure after 9 members');
          return target.create(input);
        };
        return create;
      },
    });
    const failingRepos = new Proxy(repos, {
      get(target, prop, receiver): unknown {
        return prop === 'members' ? failingMembers : (Reflect.get(target, prop, receiver) as unknown);
      },
    });

    await expect(loadSampleData({ ...ctx, repos: failingRepos }, { managerStaffId: manager.id, today: TODAY })).rejects.toThrow('forced failure');
    expect(memberCreates).toBe(10);
    expect(await snapshot(repos)).toEqual(before);

    expect(await loadSampleData(ctx, { managerStaffId: manager.id, today: TODAY })).toEqual(EXPECTED_RESULT);
  });
});
