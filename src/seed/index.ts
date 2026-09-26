/**
 * Sample data (spec §9; D-097..D-100). The full catalogue, deals, members, staff and bookings
 * are listed in docs/decisions.md D-097..D-100; sampleData() returns exactly that.
 * Records reference each other by `key` here; the loader maps keys to generated ids.
 */
import { AppError } from '../data/errors';
import type { Repos } from '../data/repos';
import type { BookingType, DealType, LocalDate, NewDeal, NewProduct, Role, VatRate } from '../data/types';
import { addDays } from '../rules/time';
import type { ServiceContext } from '../services/context';
import { createPinCredentials, verifyPin, type PinCredentials } from '../services/pin';

/** Sample staff PINs (D-099). The setup manager may not use these when loading samples. */
export const SAMPLE_STAFF_PIN = '1111';
export const SAMPLE_SUPERVISOR_PIN = '2222';
export const RESERVED_SAMPLE_PINS = [SAMPLE_STAFF_PIN, SAMPLE_SUPERVISOR_PIN] as const;

/** Note on every opening-stock goodsIn movement (D-100). */
export const OPENING_STOCK_NOTE = 'Opening stock';

/** CONFLICT message when anything is already in the catalogue (D-100). */
export const SAMPLE_ALREADY_LOADED_MESSAGE = 'Sample data can only be loaded into an empty catalogue';

/** PIN_UNAVAILABLE message when an active staff member already uses a sample PIN (D-099). */
export const SAMPLE_PIN_CLASH_MESSAGE = 'That PIN is used by the sample staff';

export interface SampleCategory {
  key: string;
  name: string;
  sortOrder: number;
  colour: string;
}

export interface SampleProduct {
  key: string;
  categoryKey: string;
  name: string;
  pricePence: number;
  vatRate: VatRate;
  memberDiscountEligible: boolean;
  stockTracked: boolean;
  stockUnit: string;
  lowStockLevel: number;
  /** Written as one goodsIn movement 'Opening stock' when > 0 and tracked (D-100). */
  startingStock: number;
  /** 1-based position within its category. buttonColour = the category colour. */
  sortOrder: number;
}

export interface SampleDeal {
  name: string;
  type: DealType;
  n: number;
  pricePence?: number;
  m?: number;
  productKeys: readonly string[];
}

export interface SampleMember {
  memberNumber: string;
  firstName: string;
  lastName: string;
}

export interface SampleStaff {
  name: string;
  role: Role;
  pin: string;
}

export interface SampleBooking {
  type: BookingType;
  name: string;
  /** date = London today + daysFromToday. */
  daysFromToday: number;
  notes: string;
}

export interface SampleData {
  categories: readonly SampleCategory[];
  products: readonly SampleProduct[];
  deals: readonly SampleDeal[];
  members: readonly SampleMember[];
  staff: readonly SampleStaff[];
  bookings: readonly SampleBooking[];
}

// ---------------------------------------------------------------------------
// The data set (D-097..D-100)
// ---------------------------------------------------------------------------

/** A product row before its category and position are attached. */
type ProductRow = Omit<SampleProduct, 'categoryKey' | 'sortOrder'>;

interface ProductOptions {
  vatRate?: VatRate;
  memberDiscountEligible?: boolean;
  /** Omit (or pass undefined) for an untracked product: no stock, low level 0. */
  stock?: { starting: number; low: number };
}

function product(key: string, name: string, pricePence: number, stockUnit: string, options: ProductOptions = {}): ProductRow {
  const { stock } = options;
  return {
    key,
    name,
    pricePence,
    vatRate: options.vatRate ?? 20,
    memberDiscountEligible: options.memberDiscountEligible ?? true,
    stockTracked: stock !== undefined,
    stockUnit,
    lowStockLevel: stock?.low ?? 0,
    startingStock: stock?.starting ?? 0,
  };
}

/** Attaches the category and the 1-based sortOrder within it (D-097). */
function inCategory(categoryKey: string, rows: readonly ProductRow[]): SampleProduct[] {
  return rows.map((row, index) => ({ ...row, categoryKey, sortOrder: index + 1 }));
}

function sampleCategories(): SampleCategory[] {
  return [
    { key: 'draught', name: 'Draught', sortOrder: 1, colour: '#b45309' },
    { key: 'bottles', name: 'Bottles & Cans', sortOrder: 2, colour: '#a16207' },
    { key: 'spirits', name: 'Spirits', sortOrder: 3, colour: '#7c3aed' },
    { key: 'wine', name: 'Wine', sortOrder: 4, colour: '#9f1239' },
    { key: 'soft', name: 'Soft Drinks', sortOrder: 5, colour: '#0369a1' },
    { key: 'snacks', name: 'Snacks', sortOrder: 6, colour: '#15803d' },
    { key: 'events', name: 'Events', sortOrder: 7, colour: '#475569' },
  ];
}

function sampleProducts(): SampleProduct[] {
  const pint = { starting: 88, low: 22 };
  const bottled = { starting: 48, low: 12 };
  const measure = { starting: 56, low: 14 };
  const glass = { starting: 40, low: 10 };
  const wineBottle = { starting: 12, low: 3 };
  const soft = { starting: 24, low: 6 };
  const snack = { starting: 36, low: 8 };
  const event = { memberDiscountEligible: false } as const;
  return [
    ...inCategory('draught', [
      product('club-bitter', 'Club Bitter', 420, 'pint', { stock: pint }),
      product('fairway-lager', 'Fairway Lager', 480, 'pint', { stock: pint }),
      product('links-ipa', 'Links IPA', 520, 'pint', { stock: pint }),
      product('old-caddie-stout', 'Old Caddie Stout', 500, 'pint', { stock: pint }),
      product('orchard-cider', 'Orchard Cider', 460, 'pint', { stock: pint }),
      product('shandy', 'Shandy', 380, 'pint'),
    ]),
    ...inCategory('bottles', [
      product('birdie-pale-ale', 'Birdie Pale Ale', 450, 'bottle', { stock: bottled }),
      product('bogey-brown-ale', 'Bogey Brown Ale', 450, 'bottle', { stock: bottled }),
      product('albatross-lager', 'Albatross Lager', 430, 'bottle', { stock: bottled }),
      product('eagle-cider', 'Eagle Cider', 470, 'bottle', { stock: bottled }),
      product('clubhouse-stout', 'Clubhouse Stout', 400, 'can', { stock: bottled }),
      product('zero-lager', 'Zero Lager (alcohol-free)', 350, 'bottle', { stock: bottled }),
    ]),
    ...inCategory('spirits', [
      product('house-gin', 'House Gin', 380, 'measure', { stock: measure }),
      product('house-vodka', 'House Vodka', 360, 'measure', { stock: measure }),
      product('house-whisky', 'House Whisky', 400, 'measure', { stock: measure }),
      // Starts below its low level so the low-stock list is never empty (D-097, D-082).
      product('single-malt-whisky', 'Single Malt Whisky', 550, 'measure', { stock: { starting: 10, low: 14 } }),
      product('dark-rum', 'Dark Rum', 380, 'measure', { stock: measure }),
      product('brandy', 'Brandy', 420, 'measure', { stock: measure }),
    ]),
    ...inCategory('wine', [
      product('house-red-glass', 'House Red (175ml)', 550, 'glass', { stock: glass }),
      product('house-white-glass', 'House White (175ml)', 550, 'glass', { stock: glass }),
      product('house-rose-glass', 'House Rosé (175ml)', 550, 'glass', { stock: glass }),
      product('house-red-bottle', 'House Red (bottle)', 1900, 'bottle', { stock: wineBottle }),
      product('house-white-bottle', 'House White (bottle)', 1900, 'bottle', { stock: wineBottle }),
      product('prosecco-bottle', 'Prosecco (bottle)', 2600, 'bottle', { stock: wineBottle }),
    ]),
    ...inCategory('soft', [
      product('cola', 'Cola', 250, 'glass'),
      product('lemonade', 'Lemonade', 250, 'glass'),
      product('orange-juice', 'Orange Juice', 280, 'bottle', { stock: soft }),
      product('sparkling-water', 'Sparkling Water', 220, 'bottle', { stock: soft }),
      product('still-water', 'Still Water', 200, 'bottle', { stock: soft }),
      product('apple-mango-fizz', 'Apple & Mango Fizz', 300, 'bottle', { stock: soft }),
      product('tonic-water', 'Tonic Water', 150, 'bottle', { stock: soft }),
    ]),
    ...inCategory('snacks', [
      product('ready-salted-crisps', 'Ready Salted Crisps', 120, 'packet', { stock: snack }),
      product('salt-vinegar-crisps', 'Salt & Vinegar Crisps', 120, 'packet', { stock: snack }),
      product('cheese-onion-crisps', 'Cheese & Onion Crisps', 120, 'packet', { stock: snack }),
      product('dry-roasted-peanuts', 'Dry Roasted Peanuts', 150, 'packet', { stock: snack }),
      product('pork-scratchings', 'Pork Scratchings', 150, 'packet', { stock: snack }),
      product('chocolate-bar', 'Chocolate Bar', 140, 'bar', { stock: snack }),
    ]),
    ...inCategory('events', [
      // The two 0% products, so the VAT report shows two rates (spec §9).
      product('raffle-ticket', 'Raffle Ticket', 100, 'ticket', { ...event, vatRate: 0 }),
      product('sweepstake-entry', 'Sweepstake Entry', 200, 'entry', { ...event, vatRate: 0 }),
      product('buffet-ticket', 'Buffet Ticket', 1500, 'ticket', event),
    ]),
  ];
}

function sampleDeals(): SampleDeal[] {
  return [
    {
      // Zero Lager is left out: 350 + 400 < 800, so it could never save (D-098).
      name: 'Any 2 bottles for £8',
      type: 'nForPrice',
      n: 2,
      pricePence: 800,
      productKeys: ['birdie-pale-ale', 'bogey-brown-ale', 'albatross-lager', 'eagle-cider', 'clubhouse-stout'],
    },
    {
      // Chocolate Bar is left out (D-098).
      name: 'Snacks 3 for 2',
      type: 'nForM',
      n: 3,
      m: 2,
      productKeys: ['ready-salted-crisps', 'salt-vinegar-crisps', 'cheese-onion-crisps', 'dry-roasted-peanuts', 'pork-scratchings'],
    },
  ];
}

function sampleMembers(): SampleMember[] {
  const names: readonly (readonly [string, string])[] = [
    ['Alice', 'Archer'],
    ['Ben', 'Birch'],
    ['Clara', 'Chalmers'],
    ['David', 'Dunmore'],
    ['Emma', 'Ellis'],
    ['Frank', 'Fairley'],
    ['Grace', 'Gilmour'],
    ['Harry', 'Hollis'],
    ['Isla', 'Irving'],
    ['Jack', 'Jennings'],
    ['Katie', 'Kerr'],
    ['Liam', 'Lockhart'],
    ['Megan', 'Moss'],
    ['Noah', 'Newland'],
    ['Olivia', 'Orr'],
    ['Peter', 'Pryce'],
    ['Quinn', 'Quayle'],
    ['Rosa', 'Rennie'],
    ['Sophie', 'Sutherland'],
    ['Tara', 'Thornton'],
  ];
  return names.map(([firstName, lastName], index) => ({ memberNumber: String(1001 + index), firstName, lastName }));
}

function sampleStaff(): SampleStaff[] {
  return [
    { name: 'Sam Staff', role: 'staff', pin: SAMPLE_STAFF_PIN },
    { name: 'Sue Supervisor', role: 'supervisor', pin: SAMPLE_SUPERVISOR_PIN },
  ];
}

function sampleBookings(): SampleBooking[] {
  return [
    { type: 'wedding', name: 'Smith & Jones Wedding', daysFromToday: 30, notes: 'Evening reception' },
    { type: 'society', name: 'Seniors Society Day', daysFromToday: 14, notes: '36 golfers' },
  ];
}

/**
 * The fixed sample data set (7 categories, 40 products, 2 deals, 20 members, 2 staff, 2 bookings).
 * Every call returns fresh objects, so a caller can never change the set for anyone else.
 */
export function sampleData(): SampleData {
  return {
    categories: sampleCategories(),
    products: sampleProducts(),
    deals: sampleDeals(),
    members: sampleMembers(),
    staff: sampleStaff(),
    bookings: sampleBookings(),
  };
}

// ---------------------------------------------------------------------------
// Loader (D-100)
// ---------------------------------------------------------------------------

export interface LoadSampleDataInput {
  /** The setup manager: staffId on the opening-stock movements. */
  managerStaffId: string;
  /** London today, for booking dates. */
  today: LocalDate;
}

export interface SampleLoadResult {
  categories: number;
  products: number;
  deals: number;
  members: number;
  staff: number;
  bookings: number;
  stockMovements: number;
}

/** Looks up a key the fixed data set guarantees; a miss is a programming error. */
function idFor(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`Sample data refers to an unknown key: ${key}`);
  return id;
}

/** CONFLICT when any category or product exists, deleted or not (D-100). */
async function assertCatalogueEmpty(repos: Repos): Promise<void> {
  const categories = await repos.categories.list({ includeDeleted: true });
  const products = await repos.products.list({ includeDeleted: true });
  if (categories.length > 0 || products.length > 0) throw new AppError('CONFLICT', SAMPLE_ALREADY_LOADED_MESSAGE);
}

/**
 * PINs must be unique among active staff (D-075). The setup form already reserves the sample
 * PINs (D-099); this re-checks every active staff member so the loader is safe on its own.
 * Hashes, so it must run outside any transaction.
 */
async function assertSamplePinsFree(repos: Repos, staff: readonly SampleStaff[]): Promise<void> {
  const active = (await repos.staff.list()).filter((member) => member.active);
  const checks = active.flatMap((member) => staff.map((sample) => verifyPin(sample.pin, member)));
  const clashes = await Promise.all(checks);
  if (clashes.some(Boolean)) throw new AppError('PIN_UNAVAILABLE', SAMPLE_PIN_CLASH_MESSAGE);
}

/**
 * Loads the sample data (D-100): hashes the sample PINs FIRST (async crypto), then ONE
 * repos.transact() creating categories, products, deals, members, bookings, staff and one
 * goodsIn 'Opening stock' movement per tracked product (one outbox entry per record). Throws
 * AppError('CONFLICT') if any category or product already exists. Creates no period, sales or tabs.
 *
 * Also throws, writing nothing:
 * - AppError('PIN_UNAVAILABLE', 'That PIN is used by the sample staff') when an active staff
 *   member already uses 1111 or 2222 (D-075, D-099);
 * - AppError('NOT_FOUND') when managerStaffId is not a staff record;
 * - RangeError when `today` is not a real 'YYYY-MM-DD' date.
 */
export async function loadSampleData(ctx: ServiceContext, input: LoadSampleDataInput): Promise<SampleLoadResult> {
  const { repos } = ctx;
  const data = sampleData();
  // Everything that can fail without touching storage happens first.
  const bookingDates = data.bookings.map((booking) => addDays(input.today, booking.daysFromToday));
  await assertCatalogueEmpty(repos);
  await assertSamplePinsFree(repos, data.staff);
  const credentials: PinCredentials[] = await Promise.all(data.staff.map((person) => createPinCredentials(person.pin)));

  return repos.transact(async () => {
    // Re-checked inside the transaction, so two overlapping loads can never both write.
    await assertCatalogueEmpty(repos);
    const manager = await repos.staff.get(input.managerStaffId);
    if (manager === undefined) throw new AppError('NOT_FOUND', 'The setup manager was not found');

    const categoryIds = new Map<string, string>();
    const categoryColours = new Map<string, string>();
    for (const category of data.categories) {
      const created = await repos.categories.create({ name: category.name, sortOrder: category.sortOrder, colour: category.colour });
      categoryIds.set(category.key, created.id);
      categoryColours.set(category.key, created.colour);
    }

    const productIds = new Map<string, string>();
    for (const item of data.products) {
      const newProduct: NewProduct = {
        name: item.name,
        categoryId: idFor(categoryIds, item.categoryKey),
        pricePence: item.pricePence,
        vatRate: item.vatRate,
        memberDiscountEligible: item.memberDiscountEligible,
        stockTracked: item.stockTracked,
        stockUnit: item.stockUnit,
        lowStockLevel: item.stockTracked ? item.lowStockLevel : 0,
        buttonColour: idFor(categoryColours, item.categoryKey),
        sortOrder: item.sortOrder,
        active: true,
      };
      const created = await repos.products.create(newProduct);
      productIds.set(item.key, created.id);
    }

    for (const deal of data.deals) {
      const newDeal: NewDeal = {
        name: deal.name,
        type: deal.type,
        n: deal.n,
        ...(deal.pricePence === undefined ? {} : { pricePence: deal.pricePence }),
        ...(deal.m === undefined ? {} : { m: deal.m }),
        productIds: deal.productKeys.map((key) => idFor(productIds, key)),
        active: true,
      };
      await repos.deals.create(newDeal);
    }

    for (const member of data.members) {
      await repos.members.create({ ...member, active: true });
    }

    for (const [index, booking] of data.bookings.entries()) {
      const date = bookingDates[index];
      if (date === undefined) throw new Error('Sample booking date missing');
      await repos.bookings.create({ type: booking.type, name: booking.name, date, notes: booking.notes, status: 'open' });
    }

    for (const [index, person] of data.staff.entries()) {
      const pin = credentials[index];
      if (pin === undefined) throw new Error('Sample staff credentials missing');
      await repos.staff.create({ name: person.name, role: person.role, pinHash: pin.pinHash, pinSalt: pin.pinSalt, active: true });
    }

    let stockMovements = 0;
    for (const item of data.products) {
      if (!item.stockTracked || item.startingStock <= 0) continue;
      await repos.stockMovements.add({
        productId: idFor(productIds, item.key),
        qty: item.startingStock,
        reason: 'goodsIn',
        staffId: manager.id,
        note: OPENING_STOCK_NOTE,
      });
      stockMovements += 1;
    }

    return {
      categories: data.categories.length,
      products: data.products.length,
      deals: data.deals.length,
      members: data.members.length,
      staff: data.staff.length,
      bookings: data.bookings.length,
      stockMovements,
    };
  });
}
