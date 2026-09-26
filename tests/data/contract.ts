/**
 * The reusable repository contract suite (spec §10.2; D-115). Every adapter must pass it.
 *
 * Usage (see tests/data/local-adapter.test.ts):
 *   runRepositoryContract('LocalAdapter', (options) => createLocalAdapter(options), deleteLocalDatabase);
 *
 * Each test builds a fresh store with a unique dbName, an injected clock and a sequential UUID v4
 * generator. The suite covers create/read of every entity, soft delete, patch semantics,
 * append-only sales/stock/audit (no update/delete methods; a duplicate id is rejected, never
 * overwritten), stock on hand from movements, the low-stock list, booking balance, one outbox
 * entry per record written (payload deep-equals the stored record), commitSale re-checks and
 * atomicity (failSaleCommitAfterWrites leaves no sale, movement, counter, tab, draft or outbox
 * change), receipt and Z numbering, queries by period / date range / receipt number / booking,
 * the refunds-of-a-sale lookup, transact() commit and rollback, and the backup round trip
 * (exportAll -> importAll into a fresh DB -> exportAll deep-equals).
 *
 * Assumption about adapters: a write generates its record id with the first newId() call it
 * makes for that record (used by the duplicate-id tests, which pin newId to an existing id).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validateBackupValue } from '../../src/data/backup';
import { AppError, isAppError, type AppErrorCode } from '../../src/data/errors';
import type { DeleteDatabase, Repos, SettingsPatch } from '../../src/data/repos';
import type {
  BackupTables,
  Booking,
  Category,
  EntityName,
  Member,
  NewProduct,
  NewSale,
  NewStaff,
  OutboxEntry,
  OutboxOperation,
  Period,
  Product,
  Sale,
  SaleLine,
  SaleStockMovementInput,
  Settings,
  Staff,
  SyncedRecord,
} from '../../src/data/types';
import { APPEND_ONLY_ENTITIES, BACKUP_FORMAT, ENTITY_NAMES, SCHEMA_VERSION } from '../../src/data/types';

export interface ContractStoreOptions {
  dbName: string;
  now: () => Date;
  newId?: () => string;
  failSaleCommitAfterWrites?: boolean;
}

export type ContractStoreFactory = (options: ContractStoreOptions) => Promise<Repos>;

// ---------------------------------------------------------------------------
// Test doubles: clock and ids
// ---------------------------------------------------------------------------

export const T0 = '2026-09-26T10:00:00.000Z';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OTHER_DEVICE_ID = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';

export interface TestClock {
  now: () => Date;
  /** Current instant as ISO, without counting as a read. */
  iso: () => string;
  set: (iso: string) => void;
  advance: (ms?: number) => void;
}

/** A controllable clock. With stepMs > 0 every read advances it, so two reads never agree. */
export function makeClock(start: string = T0, stepMs = 0): TestClock {
  let ms = Date.parse(start);
  return {
    now: () => {
      const date = new Date(ms);
      ms += stepMs;
      return date;
    },
    iso: () => new Date(ms).toISOString(),
    set: (iso) => {
      ms = Date.parse(iso);
    },
    advance: (delta = 1000) => {
      ms += delta;
    },
  };
}

export interface TestIds {
  next: () => string;
  /** Every next() returns this id until unpin() (duplicate-id tests). */
  pin: (id: string) => void;
  unpin: () => void;
}

let idSpaces = 0;

/** Sequential UUID v4 strings; every generator has its own space, so stores never collide. */
export function makeIds(): TestIds {
  idSpaces += 1;
  const head = (0x3f9c2a00 + idSpaces).toString(16).padStart(8, '0');
  let n = 0;
  let pinned: string | undefined;
  return {
    next: () => {
      if (pinned !== undefined) return pinned;
      n += 1;
      return `${head}-7b4d-4e8a-9c1f-${n.toString(16).padStart(12, '0')}`;
    },
    pin: (id) => {
      pinned = id;
    },
    unpin: () => {
      pinned = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function neg(value: number): number {
  return value === 0 ? 0 : -value;
}

/** Round-half-up VAT for small non-negative test amounts (D-021). */
function vatOf(finalPence: number, rate: number): number {
  const numerator = finalPence * rate;
  const denominator = 100 + rate;
  const quotient = Math.floor(numerator / denominator);
  return 2 * (numerator - quotient * denominator) >= denominator ? quotient + 1 : quotient;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

function staffInput(overrides: Partial<NewStaff> = {}): NewStaff {
  return { name: 'Morgan Manager', role: 'manager', pinHash: 'ab'.repeat(32), pinSalt: 'cd'.repeat(16), active: true, ...overrides };
}

function productInput(categoryId: string, overrides: Partial<NewProduct> = {}): NewProduct {
  return {
    name: 'Fairway Lager',
    categoryId,
    pricePence: 450,
    vatRate: 20,
    memberDiscountEligible: true,
    stockTracked: true,
    stockUnit: 'pint',
    lowStockLevel: 10,
    buttonColour: '#b45309',
    sortOrder: 1,
    active: true,
    ...overrides,
  };
}

function saleLine(product: Product, qty: number, dealDiscountPence = 0): SaleLine {
  const finalPence = qty * product.pricePence - dealDiscountPence;
  return {
    productId: product.id,
    nameAtSale: product.name,
    qty,
    unitPricePence: product.pricePence,
    vatRate: product.vatRate,
    dealDiscountPence,
    memberDiscountPence: 0,
    finalPence,
    vatPence: vatOf(finalPence, product.vatRate),
  };
}

/** A kind 'sale' paid exactly in cash (or with no tenders when the total is 0). */
function saleOf(staffId: string, lines: SaleLine[], extra: Partial<NewSale> = {}): NewSale {
  const depositAppliedPence = extra.depositAppliedPence ?? 0;
  const totalPence = sum(lines.map((l) => l.finalPence)) - depositAppliedPence;
  return {
    staffId,
    kind: 'sale',
    lines,
    dealLines: [],
    memberDiscountPence: 0,
    totalPence,
    tenders: totalPence > 0 ? [{ type: 'cash', amountPence: totalPence }] : [],
    changePence: 0,
    ...extra,
    depositAppliedPence,
  };
}

function depositOf(staffId: string, bookingId: string, amountPence: number): NewSale {
  return {
    staffId,
    kind: 'deposit',
    bookingId,
    lines: [],
    dealLines: [],
    memberDiscountPence: 0,
    depositAppliedPence: 0,
    totalPence: amountPence,
    tenders: [{ type: 'cash', amountPence }],
    changePence: 0,
  };
}

interface RefundPick {
  index: number;
  qty: number;
  returnToStock?: boolean;
}

/** A cash refund of whole units from lines without discounts. */
function refundOf(staffId: string, original: Sale, picks: readonly RefundPick[]): NewSale {
  const lines = picks.map(({ index, qty, returnToStock = true }): SaleLine => {
    const line = defined(original.lines[index]);
    const gross = qty * line.unitPricePence;
    return {
      productId: line.productId,
      nameAtSale: line.nameAtSale,
      qty: neg(qty),
      unitPricePence: line.unitPricePence,
      vatRate: line.vatRate,
      dealDiscountPence: 0,
      memberDiscountPence: 0,
      finalPence: neg(gross),
      vatPence: neg(vatOf(gross, line.vatRate)),
      refundOfLineIndex: index,
      returnToStock,
    };
  });
  const totalPence = sum(lines.map((l) => l.finalPence));
  return {
    staffId,
    kind: 'refund',
    refundOfSaleId: original.id,
    lines,
    dealLines: [],
    memberDiscountPence: 0,
    depositAppliedPence: 0,
    totalPence,
    tenders: totalPence === 0 ? [] : [{ type: 'cash', amountPence: totalPence }],
    changePence: 0,
  };
}

function saleMovements(lines: readonly SaleLine[], tracked: readonly Product[]): SaleStockMovementInput[] {
  const trackedIds = new Set(tracked.map((p) => p.id));
  return lines
    .filter((line) => trackedIds.has(line.productId))
    .map((line) => ({ productId: line.productId, qty: neg(line.qty), reason: 'sale', note: '' }));
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

async function expectAppError(promise: Promise<unknown>, code: AppErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect(isAppError(error, code), `expected code ${code}, got ${String((error as AppError | undefined)?.code)}`).toBe(true);
}

interface ExpectedWrite {
  entity: EntityName;
  operation: OutboxOperation;
  record: SyncedRecord;
}

function writeKey(entity: string, entityId: string, operation: string): string {
  return `${entity}:${entityId}:${operation}`;
}

/**
 * The outbox entries added since `before` are exactly one per expected write (in any order), each
 * with the full stored record as payload, the write instant and syncedAt null (D-053, D-054, D-115).
 */
async function expectOutboxWrites(repos: Repos, before: number, expected: readonly ExpectedWrite[], at: string): Promise<OutboxEntry[]> {
  const added = (await repos.outbox.list()).slice(before);
  expect(added.map((e) => writeKey(e.entity, e.entityId, e.operation)).sort()).toEqual(
    expected.map((w) => writeKey(w.entity, w.record.id, w.operation)).sort(),
  );
  for (const entry of added) {
    const match = expected.find((w) => w.entity === entry.entity && w.record.id === entry.entityId && w.operation === entry.operation);
    expect(entry.payload).toEqual(match?.record);
    expect(entry.createdAt).toBe(at);
    expect(entry.syncedAt).toBeNull();
    expect(entry.id).toMatch(UUID_V4);
  }
  return added;
}

function expectNoUndefinedKeys(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      expect(item).not.toBeUndefined();
      if (typeof item === 'object' && item !== null) expectNoUndefinedKeys(item);
    }
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export function runRepositoryContract(name: string, makeStore: ContractStoreFactory, deleteDatabase?: DeleteDatabase): void {
  describe(`repository contract: ${name}`, () => {
    const openStores: Repos[] = [];
    const dbNames = new Set<string>();
    let dbCounter = 0;

    interface Harness {
      repos: Repos;
      clock: TestClock;
      ids: TestIds;
      dbName: string;
    }

    interface StoreOptions {
      clock?: TestClock;
      ids?: TestIds;
      dbName?: string;
      failSaleCommitAfterWrites?: boolean;
    }

    async function newStore(options: StoreOptions = {}): Promise<Harness> {
      const clock = options.clock ?? makeClock();
      const ids = options.ids ?? makeIds();
      dbCounter += 1;
      const dbName = options.dbName ?? `contract-${name.replace(/[^A-Za-z0-9]+/g, '-')}-${dbCounter}-${Date.now().toString(36)}`;
      const repos = await makeStore({ dbName, now: clock.now, newId: ids.next, failSaleCommitAfterWrites: options.failSaleCommitAfterWrites });
      openStores.push(repos);
      dbNames.add(dbName);
      return { repos, clock, ids, dbName };
    }

    /** Opens a second store over the same database (e.g. with the fault-injection hook). */
    function reopen(h: Harness, options: Omit<StoreOptions, 'clock' | 'ids' | 'dbName'> = {}): Promise<Harness> {
      return newStore({ ...options, clock: h.clock, ids: h.ids, dbName: h.dbName });
    }

    afterEach(async () => {
      for (const repos of openStores.splice(0)) await repos.close();
      if (deleteDatabase !== undefined) for (const dbName of dbNames) await deleteDatabase(dbName);
      dbNames.clear();
    });

    interface Seeded {
      h: Harness;
      repos: Repos;
      clock: TestClock;
      settings: Settings;
      manager: Staff;
      category: Category;
      lager: Product;
      crisps: Product;
      raffle: Product;
      member: Member;
      booking: Booking;
      period: Period;
    }

    /** Settings + manager, a category, three products, a member, an open booking, an open period. */
    async function seed(h?: Harness): Promise<Seeded> {
      const harness = h ?? (await newStore());
      const { repos, clock } = harness;
      const { manager } = await repos.initialise({
        settings: { clubName: 'Oakfield Golf Club', receiptFooter: 'Thank you for your custom', autoLockMinutes: 5, memberDiscountPercent: 15 },
        manager: staffInput(),
      });
      clock.advance();
      const category = await repos.categories.create({ name: 'Draught', sortOrder: 1, colour: '#b45309' });
      const lager = await repos.products.create(productInput(category.id));
      const crisps = await repos.products.create(
        productInput(category.id, { name: 'Ready Salted Crisps', pricePence: 125, vatRate: 0, stockUnit: 'packet', lowStockLevel: 8, sortOrder: 2 }),
      );
      const raffle = await repos.products.create(
        productInput(category.id, { name: 'Raffle Ticket', pricePence: 100, vatRate: 0, stockTracked: false, memberDiscountEligible: false, lowStockLevel: 0, sortOrder: 3 }),
      );
      const member = await repos.members.create({ memberNumber: '1042', firstName: 'Alice', lastName: 'Archer', active: true });
      const booking = await repos.bookings.create({ type: 'wedding', name: 'Smith wedding', date: '2026-10-26', notes: '', status: 'open' });
      const period = await repos.periods.open({ openedBy: manager.id, floatPence: 10000 });
      clock.advance();
      return { h: harness, repos, clock, settings: defined(await repos.settings.get()), manager, category, lager, crisps, raffle, member, booking, period };
    }

    function sell(s: Seeded, lines: SaleLine[], extra: Partial<NewSale> = {}, clearDraft = true): Promise<Sale> {
      return s.repos.commitSale({ sale: saleOf(s.manager.id, lines, extra), stockMovements: saleMovements(lines, [s.lager, s.crisps]), clearDraft });
    }

    // -----------------------------------------------------------------------
    describe('initialise and settings', () => {
      it('has no settings and no open period before initialise', async () => {
        const { repos } = await newStore();
        expect(await repos.settings.get()).toBeUndefined();
        expect(await repos.periods.getOpen()).toBeUndefined();
        expect(await repos.outbox.count()).toBe(0);
      });

      it('rejects writes with NOT_INITIALISED before initialise and writes nothing', async () => {
        const { repos } = await newStore();
        await expectAppError(repos.categories.create({ name: 'Draught', sortOrder: 1, colour: '#b45309' }), 'NOT_INITIALISED');
        await expectAppError(
          repos.stockMovements.add({ productId: OTHER_DEVICE_ID, qty: 1, reason: 'goodsIn', staffId: OTHER_DEVICE_ID, note: '' }),
          'NOT_INITIALISED',
        );
        await expectAppError(repos.auditEvents.append([{ type: 'noSale', staffId: OTHER_DEVICE_ID, detail: {} }]), 'NOT_INITIALISED');
        await expectAppError(repos.periods.open({ openedBy: OTHER_DEVICE_ID, floatPence: 0 }), 'NOT_INITIALISED');
        await expectAppError(repos.settings.update({ clubName: 'X' }), 'NOT_INITIALISED');
        await expectAppError(
          repos.commitSale({ sale: depositOf(OTHER_DEVICE_ID, OTHER_DEVICE_ID, 100), stockMovements: [], clearDraft: false }),
          'NOT_INITIALISED',
        );
        expect(await repos.outbox.count()).toBe(0);
        expect(await repos.categories.list({ includeDeleted: true })).toEqual([]);
      });

      it('initialise creates the settings row and the first manager, one outbox entry each (D-057)', async () => {
        const { repos, clock } = await newStore();
        const { settings, manager } = await repos.initialise({
          settings: { clubName: 'Oakfield Golf Club', receiptFooter: 'Thank you for your custom', autoLockMinutes: 5, memberDiscountPercent: 15 },
          manager: staffInput(),
        });
        expect(settings.id).toMatch(UUID_V4);
        expect(settings).toEqual({
          id: settings.id,
          deviceId: settings.id,
          createdAt: T0,
          updatedAt: T0,
          clubName: 'Oakfield Golf Club',
          receiptFooter: 'Thank you for your custom',
          autoLockMinutes: 5,
          memberDiscountPercent: 15,
          devicePrefix: settings.id.slice(0, 4).toUpperCase(),
          receiptCounter: 0,
        });
        expect(manager).toEqual({ ...staffInput(), id: manager.id, deviceId: settings.deviceId, createdAt: T0, updatedAt: T0 });
        expect(await repos.settings.get()).toEqual(settings);
        expect(await repos.staff.get(manager.id)).toEqual(manager);
        await expectOutboxWrites(
          repos,
          0,
          [
            { entity: 'settings', operation: 'create', record: settings },
            { entity: 'staff', operation: 'create', record: manager },
          ],
          clock.iso(),
        );
      });

      it('initialise with an existing settings row updates clubName and adds the manager', async () => {
        const s = await seed();
        const before = await s.repos.outbox.count();
        const at = s.h.clock.iso();
        const { settings, manager } = await s.repos.initialise({
          settings: { clubName: 'Renamed Club', receiptFooter: 'ignored', autoLockMinutes: 9, memberDiscountPercent: 9 },
          manager: staffInput({ name: 'Second Manager' }),
        });
        expect(settings).toEqual({ ...s.settings, clubName: 'Renamed Club', updatedAt: at });
        expect(manager.deviceId).toBe(s.settings.deviceId);
        await expectOutboxWrites(
          s.repos,
          before,
          [
            { entity: 'settings', operation: 'update', record: settings },
            { entity: 'staff', operation: 'create', record: manager },
          ],
          at,
        );
      });

      it('settings.update changes the patchable fields, bumps updatedAt and writes one outbox entry', async () => {
        const s = await seed();
        const before = await s.repos.outbox.count();
        const at = s.h.clock.iso();
        const updated = await s.repos.settings.update({ clubName: 'New Name', devicePrefix: 'BAR1', lastBackupAt: T0, autoLockMinutes: 10 });
        expect(updated).toEqual({ ...s.settings, clubName: 'New Name', devicePrefix: 'BAR1', lastBackupAt: T0, autoLockMinutes: 10, updatedAt: at });
        expect(await s.repos.settings.get()).toEqual(updated);
        await expectOutboxWrites(s.repos, before, [{ entity: 'settings', operation: 'update', record: updated }], at);
      });

      it('settings.update never changes receiptCounter or the identity fields', async () => {
        const s = await seed();
        const patch = { receiptCounter: 99, deviceId: OTHER_DEVICE_ID, id: OTHER_DEVICE_ID, createdAt: T0 } as unknown as SettingsPatch;
        const updated = await s.repos.settings.update(patch);
        expect(updated).toEqual({ ...s.settings, updatedAt: s.h.clock.iso() });
      });

      it('settings.update with undefined removes lastBackupAt but never a required field (D-050)', async () => {
        const s = await seed();
        await s.repos.settings.update({ lastBackupAt: T0 });
        const cleared = await s.repos.settings.update({ lastBackupAt: undefined, clubName: undefined });
        expect('lastBackupAt' in cleared).toBe(false);
        expect(cleared.clubName).toBe('Oakfield Golf Club');
        expect(await s.repos.settings.get()).toEqual(cleared);
      });
    });

    // -----------------------------------------------------------------------
    describe('editable entities', () => {
      it('creates and reads every editable entity, with base fields and one outbox entry each (D-048)', async () => {
        const s = await seed();
        const { repos, clock } = s;
        clock.advance();
        const at = clock.iso();
        const deviceId = s.settings.deviceId;

        async function check<T extends { id: string }>(
          entity: EntityName,
          repo: { get(id: string): Promise<T | undefined>; list(): Promise<T[]> },
          create: () => Promise<T>,
          input: object,
        ): Promise<void> {
          const before = await repos.outbox.count();
          const record = await create();
          expect(record.id).toMatch(UUID_V4);
          expect(record).toEqual({ ...input, id: record.id, deviceId, createdAt: at, updatedAt: at });
          expectNoUndefinedKeys(record);
          expect(await repo.get(record.id)).toEqual(record);
          expect(await repo.list()).toContainEqual(record);
          await expectOutboxWrites(repos, before, [{ entity, operation: 'create', record: record as unknown as SyncedRecord }], at);
        }

        const staff = staffInput({ name: 'Sam Staff', role: 'staff' });
        await check('staff', repos.staff, () => repos.staff.create(staff), staff);
        const category = { name: 'Snacks', sortOrder: 6, colour: '#15803d' };
        await check('categories', repos.categories, () => repos.categories.create(category), category);
        const product = productInput(s.category.id, { name: 'Chocolate Bar', pricePence: 140 });
        await check('products', repos.products, () => repos.products.create(product), product);
        const deal = {
          name: 'Any 2 for £8',
          type: 'nForPrice' as const,
          n: 2,
          pricePence: 800,
          productIds: [s.lager.id, s.crisps.id],
          active: true,
          startsAt: '2026-09-30T23:00:00.000Z',
          endsAt: '2026-11-01T00:00:00.000Z',
        };
        await check('deals', repos.deals, () => repos.deals.create(deal), deal);
        const member = { memberNumber: '1001', firstName: 'Ben', lastName: 'Birch', active: true };
        await check('members', repos.members, () => repos.members.create(member), member);
        const booking = { type: 'society' as const, name: 'Seniors Society Day', date: '2026-10-10', notes: '36 golfers', status: 'open' as const };
        await check('bookings', repos.bookings, () => repos.bookings.create(booking), booking);
        const tab = {
          labelType: 'name' as const,
          label: 'Smith',
          openedAt: at,
          openedBy: s.manager.id,
          status: 'open' as const,
          lines: [{ productId: s.lager.id, qty: 2 }],
          memberId: s.member.id,
        };
        await check('tabs', repos.tabs, () => repos.tabs.create(tab), tab);
      });

      it('omits optional fields that are absent or undefined (D-050)', async () => {
        const s = await seed();
        const deal = await s.repos.deals.create({
          name: '3 for 2',
          type: 'nForM',
          n: 3,
          m: 2,
          pricePence: undefined,
          productIds: [s.crisps.id],
          active: true,
          startsAt: undefined,
        });
        expect(Object.keys(deal).sort()).toEqual(
          ['id', 'deviceId', 'createdAt', 'updatedAt', 'name', 'type', 'n', 'm', 'productIds', 'active'].sort(),
        );
        const stored = defined(await s.repos.deals.get(deal.id));
        expect('pricePence' in stored).toBe(false);
        expect('startsAt' in stored).toBe(false);
        expectNoUndefinedKeys(stored);
      });

      it('ignores caller-supplied base fields on create', async () => {
        const s = await seed();
        const sneaky = {
          name: 'Sneaky',
          sortOrder: 1,
          colour: '#000000',
          id: OTHER_DEVICE_ID,
          deviceId: OTHER_DEVICE_ID,
          createdAt: '2000-01-01T00:00:00.000Z',
          deletedAt: '2000-01-01T00:00:00.000Z',
        } as unknown as Parameters<Repos['categories']['create']>[0];
        const created = await s.repos.categories.create(sneaky);
        expect(created.id).not.toBe(OTHER_DEVICE_ID);
        expect(created.deviceId).toBe(s.settings.deviceId);
        expect(created.createdAt).toBe(s.h.clock.iso());
        expect('deletedAt' in created).toBe(false);
      });

      it('update merges the patch, bumps only updatedAt and writes one outbox update', async () => {
        const s = await seed();
        s.h.clock.advance();
        const at = s.h.clock.iso();
        const before = await s.repos.outbox.count();
        const updated = await s.repos.products.update(s.lager.id, { pricePence: 480, name: 'Fairway Lager (pint)' });
        expect(updated).toEqual({ ...s.lager, pricePence: 480, name: 'Fairway Lager (pint)', updatedAt: at });
        expect(updated.createdAt).toBe(s.lager.createdAt);
        expect(await s.repos.products.get(s.lager.id)).toEqual(updated);
        await expectOutboxWrites(s.repos, before, [{ entity: 'products', operation: 'update', record: updated }], at);
      });

      it('update with an undefined value removes that field (D-050)', async () => {
        const s = await seed();
        const deal = await s.repos.deals.create({
          name: '2 for £8',
          type: 'nForPrice',
          n: 2,
          pricePence: 800,
          productIds: [s.lager.id],
          active: true,
          endsAt: '2026-10-01T00:00:00.000Z',
        });
        const noEnd = await s.repos.deals.update(deal.id, { endsAt: undefined });
        expect('endsAt' in noEnd).toBe(false);
        expect('endsAt' in defined(await s.repos.deals.get(deal.id))).toBe(false);

        const tab = await s.repos.tabs.create({
          labelType: 'table',
          label: '5',
          openedAt: T0,
          openedBy: s.manager.id,
          status: 'open',
          lines: [{ productId: s.lager.id, qty: 1 }],
          memberId: s.member.id,
        });
        const detached = await s.repos.tabs.update(tab.id, { memberId: undefined, lines: [{ productId: s.crisps.id, qty: 3 }] });
        expect(detached).toEqual({
          id: tab.id,
          deviceId: tab.deviceId,
          createdAt: tab.createdAt,
          updatedAt: s.h.clock.iso(),
          labelType: 'table',
          label: '5',
          openedAt: T0,
          openedBy: s.manager.id,
          status: 'open',
          lines: [{ productId: s.crisps.id, qty: 3 }],
        });
        expect(await s.repos.tabs.get(tab.id)).toEqual(detached);
      });

      it('update never changes base fields or deletedAt', async () => {
        const s = await seed();
        s.h.clock.advance();
        const patch = { id: OTHER_DEVICE_ID, deviceId: OTHER_DEVICE_ID, createdAt: T0, deletedAt: T0, firstName: 'Alicia' };
        const updated = await s.repos.members.update(s.member.id, patch as unknown as Parameters<Repos['members']['update']>[1]);
        expect(updated).toEqual({ ...s.member, firstName: 'Alicia', updatedAt: s.h.clock.iso() });
      });

      it('update and softDelete throw NOT_FOUND for an unknown id and write nothing', async () => {
        const s = await seed();
        const before = await s.repos.outbox.count();
        await expectAppError(s.repos.products.update(OTHER_DEVICE_ID, { pricePence: 1 }), 'NOT_FOUND');
        await expectAppError(s.repos.categories.softDelete(OTHER_DEVICE_ID), 'NOT_FOUND');
        expect(await s.repos.outbox.count()).toBe(before);
      });

      it('softDelete keeps the record readable, hides it from list and writes one outbox delete (D-051, D-054)', async () => {
        const s = await seed();
        const spare = await s.repos.categories.create({ name: 'Old stock', sortOrder: 9, colour: '#000000' });
        s.h.clock.advance();
        const at = s.h.clock.iso();
        const before = await s.repos.outbox.count();
        const deleted = await s.repos.categories.softDelete(spare.id);
        expect(deleted).toEqual({ ...spare, deletedAt: at, updatedAt: at });
        expect(await s.repos.categories.get(spare.id)).toEqual(deleted);
        expect((await s.repos.categories.list()).map((c) => c.id)).toEqual([s.category.id]);
        expect((await s.repos.categories.list({ includeDeleted: true })).map((c) => c.id).sort()).toEqual([s.category.id, spare.id].sort());
        await expectOutboxWrites(s.repos, before, [{ entity: 'categories', operation: 'delete', record: deleted }], at);
      });

      it('softDelete of an already deleted record changes and writes nothing', async () => {
        const s = await seed();
        const deleted = await s.repos.products.softDelete(s.raffle.id);
        s.h.clock.advance();
        const before = await s.repos.outbox.count();
        expect(await s.repos.products.softDelete(s.raffle.id)).toEqual(deleted);
        expect(await s.repos.outbox.count()).toBe(before);
      });

      it('list excludes soft-deleted rows for every editable repository', async () => {
        const s = await seed();
        await s.repos.members.softDelete(s.member.id);
        await s.repos.bookings.softDelete(s.booking.id);
        await s.repos.products.softDelete(s.raffle.id);
        expect(await s.repos.members.list()).toEqual([]);
        expect(await s.repos.bookings.list()).toEqual([]);
        expect((await s.repos.products.list()).map((p) => p.name).sort()).toEqual(['Fairway Lager', 'Ready Salted Crisps']);
        expect(await s.repos.members.list({ includeDeleted: true })).toHaveLength(1);
      });

      it('members.findByNumber matches the stored number exactly among non-deleted members', async () => {
        const s = await seed();
        expect(await s.repos.members.findByNumber('1042')).toEqual(s.member);
        expect(await s.repos.members.findByNumber('104')).toBeUndefined();
        expect(await s.repos.members.findByNumber('10420')).toBeUndefined();
        await s.repos.members.softDelete(s.member.id);
        expect(await s.repos.members.findByNumber('1042')).toBeUndefined();
        const again = await s.repos.members.create({ memberNumber: '1042', firstName: 'New', lastName: 'Member', active: true });
        expect(await s.repos.members.findByNumber('1042')).toEqual(again);
      });

      it('tabs.listOpen lists open, non-deleted tabs by openedAt (D-064)', async () => {
        const s = await seed();
        const base = { labelType: 'name' as const, openedBy: s.manager.id, lines: [{ productId: s.lager.id, qty: 1 }] };
        const late = await s.repos.tabs.create({ ...base, label: 'Late', openedAt: '2026-09-26T12:00:00.000Z', status: 'open' });
        const early = await s.repos.tabs.create({ ...base, label: 'Early', openedAt: '2026-09-26T09:00:00.000Z', status: 'open' });
        await s.repos.tabs.create({ ...base, label: 'Settled', openedAt: '2026-09-26T08:00:00.000Z', status: 'settled' });
        const parked = await s.repos.tabs.create({ ...base, label: 'Parked', openedAt: '2026-09-26T07:00:00.000Z', status: 'open' });
        await s.repos.tabs.softDelete(parked.id);
        expect((await s.repos.tabs.listOpen()).map((t) => t.label)).toEqual(['Early', 'Late']);
        expect((await s.repos.tabs.listOpen()).map((t) => t.id)).toEqual([early.id, late.id]);
      });
    });

    // -----------------------------------------------------------------------
    describe('append-only records (spec §3.2, D-051)', () => {
      it('sales, stock movements and audit events expose no update or delete methods', async () => {
        const { repos } = await newStore();
        // The shared list is exactly D-051's append-only set, so the list and this check can't drift.
        expect([...APPEND_ONLY_ENTITIES]).toEqual(['sales', 'stockMovements', 'auditEvents']);
        const forbidden = ['update', 'softDelete', 'delete', 'remove', 'put', 'bulkPut', 'clear', 'modify', 'upsert'];
        for (const entity of APPEND_ONLY_ENTITIES) {
          for (const method of forbidden) expect(method in repos[entity], `${entity}.${method}`).toBe(false);
        }
        // Sales are created only through commitSale (D-056).
        expect('add' in repos.sales).toBe(false);
        expect('create' in repos.sales).toBe(false);
        expect(typeof repos.commitSale).toBe('function');
      });

      it('a stock movement with an existing id is rejected with CONFLICT, never overwritten (D-115)', async () => {
        const s = await seed();
        const original = await s.repos.stockMovements.add({ productId: s.lager.id, qty: 10, reason: 'goodsIn', staffId: s.manager.id, note: 'Delivery' });
        const before = await s.repos.outbox.count();
        s.h.ids.pin(original.id);
        try {
          await expectAppError(
            s.repos.stockMovements.add({ productId: s.lager.id, qty: -99, reason: 'adjustment', staffId: s.manager.id, note: 'Overwrite?' }),
            'CONFLICT',
          );
        } finally {
          s.h.ids.unpin();
        }
        expect(await s.repos.stockMovements.get(original.id)).toEqual(original);
        expect(await s.repos.stockMovements.onHand(s.lager.id)).toBe(10);
        expect(await s.repos.outbox.count()).toBe(before);
      });

      it('an audit event with an existing id is rejected with CONFLICT, never overwritten', async () => {
        const s = await seed();
        const [original] = await s.repos.auditEvents.append([{ type: 'noSale', staffId: s.manager.id, periodId: s.period.id, detail: {} }]);
        const before = await s.repos.outbox.count();
        s.h.ids.pin(defined(original).id);
        try {
          await expectAppError(
            s.repos.auditEvents.append([{ type: 'override', staffId: s.manager.id, detail: { action: 'refund' } }]),
            'CONFLICT',
          );
        } finally {
          s.h.ids.unpin();
        }
        expect(await s.repos.auditEvents.list()).toEqual([original]);
        expect(await s.repos.outbox.count()).toBe(before);
      });

      it('a sale with an existing id is rejected with CONFLICT and consumes no receipt number', async () => {
        const s = await seed();
        const original = await sell(s, [saleLine(s.lager, 1)]);
        const before = await s.repos.exportAll();
        s.h.ids.pin(original.id);
        try {
          await expectAppError(sell(s, [saleLine(s.crisps, 2)]), 'CONFLICT');
        } finally {
          s.h.ids.unpin();
        }
        expect(await s.repos.exportAll()).toEqual(before);
        expect(await s.repos.sales.get(original.id)).toEqual(original);
      });
    });

    // -----------------------------------------------------------------------
    describe('stock (spec §3.2, D-082)', () => {
      it('stock on hand is the sum of the product movements, including sales and refunds', async () => {
        const s = await seed();
        const { repos } = s;
        expect(await repos.stockMovements.onHand(s.lager.id)).toBe(0);
        const goodsIn = await repos.stockMovements.add({ productId: s.lager.id, qty: 48, reason: 'goodsIn', staffId: s.manager.id, note: 'Opening stock' });
        await repos.stockMovements.add({ productId: s.lager.id, qty: -3, reason: 'adjustment', staffId: s.manager.id, note: 'Recount' });
        await repos.stockMovements.add({ productId: s.crisps.id, qty: 36, reason: 'goodsIn', staffId: s.manager.id, note: '' });
        const sale = await sell(s, [saleLine(s.lager, 2), saleLine(s.crisps, 1), saleLine(s.raffle, 5)]);
        expect(await repos.stockMovements.onHand(s.lager.id)).toBe(43);
        expect(await repos.stockMovements.onHand(s.crisps.id)).toBe(35);
        expect(await repos.stockMovements.onHand(s.raffle.id)).toBe(0);

        await repos.commitSale({
          sale: refundOf(s.manager.id, sale, [{ index: 0, qty: 1 }]),
          stockMovements: [{ productId: s.lager.id, qty: 1, reason: 'refund', note: '' }],
          clearDraft: false,
        });
        expect(await repos.stockMovements.onHand(s.lager.id)).toBe(44);
        expect(await repos.stockMovements.onHandByProduct()).toEqual({ [s.lager.id]: 44, [s.crisps.id]: 35 });

        const lagerMovements = await repos.stockMovements.listByProduct(s.lager.id);
        expect(lagerMovements.map((m) => m.qty).sort((a, b) => a - b)).toEqual([-3, -2, 1, 48]);
        expect(await repos.stockMovements.get(goodsIn.id)).toEqual(goodsIn);
        expect(await repos.stockMovements.list()).toHaveLength(6);
        // The product record itself never stores stock.
        expect(await repos.products.get(s.lager.id)).toEqual(s.lager);
      });

      it('stockMovements.add stamps base fields, keeps the note and writes one outbox entry', async () => {
        const s = await seed();
        const before = await s.repos.outbox.count();
        const at = s.h.clock.iso();
        const movement = await s.repos.stockMovements.add({ productId: s.lager.id, qty: -2, reason: 'waste', staffId: s.manager.id, note: 'Spilt' });
        expect(movement).toEqual({
          id: movement.id,
          deviceId: s.settings.deviceId,
          createdAt: at,
          updatedAt: at,
          productId: s.lager.id,
          qty: -2,
          reason: 'waste',
          staffId: s.manager.id,
          note: 'Spilt',
        });
        await expectOutboxWrites(s.repos, before, [{ entity: 'stockMovements', operation: 'create', record: movement }], at);
      });

      it('the low-stock list holds tracked, active, non-deleted products at or below their level, most urgent first', async () => {
        const s = await seed();
        const { repos } = s;
        const make = (name: string, lowStockLevel: number, extra: Partial<NewProduct> = {}): Promise<Product> =>
          repos.products.create(productInput(s.category.id, { name, lowStockLevel, ...extra }));
        const move = (product: Product, qty: number): Promise<unknown> =>
          repos.stockMovements.add({ productId: product.id, qty, reason: qty > 0 ? 'goodsIn' : 'adjustment', staffId: s.manager.id, note: '' });

        // Remove the seeded products from consideration.
        for (const product of [s.lager, s.crisps, s.raffle]) await repos.products.update(product.id, { active: false });

        const stout = await make('Stout', 10);
        await move(stout, 12);
        const bitter = await make('Bitter', 22);
        await move(bitter, 3);
        await move(bitter, -5);
        const cider = await make('Cider', 10);
        await move(cider, 10);
        const gin = await make('Gin', 3);
        const ale = await make('Ale', 5);
        await move(ale, 2);
        const shandy = await make('Shandy', 0, { stockTracked: false });
        await move(shandy, -1);
        await make('Old Porter', 5, { active: false });
        const mild = await make('Mild', 5);
        await repos.products.softDelete(mild.id);

        const low = await repos.stockMovements.lowStock();
        expect(low.map(({ product, onHand }) => [product.name, onHand])).toEqual([
          ['Bitter', -2],
          ['Ale', 2],
          ['Gin', 0],
          ['Cider', 10],
        ]);
        expect(first(low).product).toEqual(bitter);
        expect(low.map((l) => l.product.id)).toEqual([bitter.id, ale.id, gin.id, cider.id]);
      });
    });

    // -----------------------------------------------------------------------
    describe('commitSale (spec §8, D-056, D-059)', () => {
      it('fails with NO_OPEN_PERIOD when no period is open, writing nothing', async () => {
        const s = await seed();
        await s.repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 10000 });
        const before = await s.repos.exportAll();
        await expectAppError(sell(s, [saleLine(s.lager, 1)]), 'NO_OPEN_PERIOD');
        expect(await s.repos.exportAll()).toEqual(before);
      });

      it('writes the sale, its stock movements and the receipt counter at one instant, one outbox entry each (D-049, D-053)', async () => {
        const clock = makeClock(T0, 1); // every clock read advances 1 ms
        const s = await seed(await newStore({ clock }));
        await s.repos.draft.save({ lines: [{ productId: s.lager.id, qty: 2 }] });
        const before = await s.repos.outbox.count();
        const at = clock.iso(); // the next read
        const lines = [saleLine(s.lager, 2), saleLine(s.crisps, 1), saleLine(s.raffle, 1)];
        const sale = await s.repos.commitSale({
          sale: saleOf(s.manager.id, lines, { memberId: s.member.id, tenders: [{ type: 'cash', amountPence: 2000 }], changePence: 875 }),
          stockMovements: saleMovements(lines, [s.lager, s.crisps]),
          clearDraft: true,
        });
        expect(sale).toEqual({
          ...saleOf(s.manager.id, lines, { memberId: s.member.id, tenders: [{ type: 'cash', amountPence: 2000 }], changePence: 875 }),
          id: sale.id,
          deviceId: s.settings.deviceId,
          createdAt: at,
          updatedAt: at,
          periodId: s.period.id,
          receiptNumber: `${s.settings.devicePrefix}-000001`,
        });
        expect(await s.repos.sales.get(sale.id)).toEqual(sale);

        const movements = await s.repos.stockMovements.listBySale(sale.id);
        expect(movements.map((m) => [m.productId, m.qty, m.reason, m.note, m.staffId, m.saleId, m.createdAt]).sort()).toEqual(
          [
            [s.lager.id, -2, 'sale', '', s.manager.id, sale.id, at],
            [s.crisps.id, -1, 'sale', '', s.manager.id, sale.id, at],
          ].sort(),
        );
        const settings = defined(await s.repos.settings.get());
        expect(settings).toEqual({ ...s.settings, receiptCounter: 1, updatedAt: at });
        expect(await s.repos.draft.get()).toBeUndefined();

        await expectOutboxWrites(
          s.repos,
          before,
          [
            { entity: 'sales', operation: 'create', record: sale },
            ...movements.map((m): ExpectedWrite => ({ entity: 'stockMovements', operation: 'create', record: m })),
            { entity: 'settings', operation: 'update', record: settings },
          ],
          at,
        );
      });

      it('numbers receipts sequentially per device for every kind, continuing across a prefix change (D-058..D-060)', async () => {
        const s = await seed();
        const prefix = s.settings.devicePrefix;
        const first = await sell(s, [saleLine(s.lager, 1)]);
        const deposit = await s.repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 5000), stockMovements: [], clearDraft: false });
        const refund = await s.repos.commitSale({
          sale: refundOf(s.manager.id, first, [{ index: 0, qty: 1 }]),
          stockMovements: [{ productId: s.lager.id, qty: 1, reason: 'refund', note: '' }],
          clearDraft: false,
        });
        expect([first, deposit, refund].map((sale) => sale.receiptNumber)).toEqual([`${prefix}-000001`, `${prefix}-000002`, `${prefix}-000003`]);
        await s.repos.settings.update({ devicePrefix: 'BAR1' });
        const renamed = await sell(s, [saleLine(s.crisps, 1)]);
        expect(renamed.receiptNumber).toBe('BAR1-000004');
        expect((await s.repos.settings.get())?.receiptCounter).toBe(4);
        for (const sale of [first, deposit, refund, renamed]) {
          expect(await s.repos.sales.getByReceiptNumber(sale.receiptNumber)).toEqual(sale);
        }
        expect(await s.repos.sales.getByReceiptNumber(`${prefix}-000099`)).toBeUndefined();
      });

      it('stores optional sale fields only when present (D-050)', async () => {
        const s = await seed();
        const sale = await s.repos.commitSale({
          sale: { ...saleOf(s.manager.id, [saleLine(s.lager, 1)]), memberId: undefined, bookingId: undefined, tabId: undefined },
          stockMovements: [],
          clearDraft: false,
        });
        for (const key of ['memberId', 'bookingId', 'tabId', 'refundOfSaleId']) expect(key in sale).toBe(false);
        expectNoUndefinedKeys(defined(await s.repos.sales.get(sale.id)));
      });

      it('settles the tab in the same transaction and rejects a tab that is not open (D-063)', async () => {
        const s = await seed();
        const tab = await s.repos.tabs.create({
          labelType: 'name',
          label: 'Smith',
          openedAt: T0,
          openedBy: s.manager.id,
          status: 'open',
          lines: [{ productId: s.lager.id, qty: 2 }],
          memberId: s.member.id,
        });
        s.h.clock.advance();
        const at = s.h.clock.iso();
        const before = await s.repos.outbox.count();
        const lines = [saleLine(s.lager, 2), saleLine(s.crisps, 1)];
        const sale = await sell(s, lines, { tabId: tab.id, memberId: s.member.id });
        const settled = defined(await s.repos.tabs.get(tab.id));
        expect(settled).toEqual({
          ...tab,
          status: 'settled',
          lines: [
            { productId: s.lager.id, qty: 2 },
            { productId: s.crisps.id, qty: 1 },
          ],
          updatedAt: at,
        });
        const movements = await s.repos.stockMovements.listBySale(sale.id);
        await expectOutboxWrites(
          s.repos,
          before,
          [
            { entity: 'sales', operation: 'create', record: sale },
            ...movements.map((m): ExpectedWrite => ({ entity: 'stockMovements', operation: 'create', record: m })),
            { entity: 'settings', operation: 'update', record: defined(await s.repos.settings.get()) },
            { entity: 'tabs', operation: 'update', record: settled },
          ],
          at,
        );
        expect(await s.repos.tabs.listOpen()).toEqual([]);

        const state = await s.repos.exportAll();
        await expectAppError(sell(s, [saleLine(s.lager, 1)], { tabId: tab.id }), 'TAB_NOT_OPEN');
        await expectAppError(sell(s, [saleLine(s.lager, 1)], { tabId: OTHER_DEVICE_ID }), 'TAB_NOT_OPEN');
        const parked = await s.repos.tabs.create({ labelType: 'table', label: '7', openedAt: T0, openedBy: s.manager.id, status: 'open', lines: [] });
        await s.repos.tabs.softDelete(parked.id);
        const stateWithParked = await s.repos.exportAll();
        await expectAppError(sell(s, [saleLine(s.lager, 1)], { tabId: parked.id }), 'TAB_NOT_OPEN');
        expect(await s.repos.exportAll()).toEqual(stateWithParked);
        expect(state.sales).toEqual(stateWithParked.sales);
      });

      it('deletes the draft only when clearDraft is set (D-095)', async () => {
        const s = await seed();
        const draft = await s.repos.draft.save({ lines: [{ productId: s.lager.id, qty: 1 }], memberId: s.member.id });
        await s.repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 1000), stockMovements: [], clearDraft: false });
        expect(await s.repos.draft.get()).toEqual(draft);
        await sell(s, [saleLine(s.lager, 1)], {}, false);
        expect(await s.repos.draft.get()).toEqual(draft);
        await sell(s, [saleLine(s.lager, 1)], {}, true);
        expect(await s.repos.draft.get()).toBeUndefined();
      });

      it('re-checks that a deposit booking is open (D-027)', async () => {
        const s = await seed();
        const deposit = await s.repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 5000), stockMovements: [], clearDraft: false });
        expect(deposit).toMatchObject({ kind: 'deposit', bookingId: s.booking.id, totalPence: 5000, lines: [] });
        expect(await s.repos.stockMovements.listBySale(deposit.id)).toEqual([]);

        const settled = await s.repos.bookings.create({ type: 'other', name: 'Old do', date: '2026-01-01', notes: '', status: 'settled' });
        const cancelled = await s.repos.bookings.create({ type: 'other', name: 'Off', date: '2026-01-01', notes: '', status: 'cancelled' });
        const removed = await s.repos.bookings.create({ type: 'other', name: 'Gone', date: '2026-01-01', notes: '', status: 'open' });
        await s.repos.bookings.softDelete(removed.id);
        const before = await s.repos.exportAll();
        for (const bookingId of [settled.id, cancelled.id, removed.id, OTHER_DEVICE_ID]) {
          await expectAppError(s.repos.commitSale({ sale: depositOf(s.manager.id, bookingId, 100), stockMovements: [], clearDraft: false }), 'BOOKING_NOT_OPEN');
        }
        const { bookingId: _omitted, ...noBooking } = depositOf(s.manager.id, s.booking.id, 100);
        await expectAppError(s.repos.commitSale({ sale: noBooking, stockMovements: [], clearDraft: false }), 'BOOKING_NOT_OPEN');
        expect(await s.repos.exportAll()).toEqual(before);
      });

      it('re-checks the booking and its balance when a deposit is applied (D-025, D-028)', async () => {
        const s = await seed();
        const { repos } = s;
        const wine = await repos.products.create(productInput(s.category.id, { name: 'House Red (bottle)', pricePence: 9000 }));
        await repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 20000), stockMovements: [], clearDraft: false });
        await repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 5000), stockMovements: [], clearDraft: false });
        expect(await repos.sales.bookingBalance(s.booking.id)).toBe(25000);

        const twoBottles = [saleLine(wine, 2)];
        const bill = await sell(s, twoBottles, { bookingId: s.booking.id, depositAppliedPence: 18000 });
        expect(bill.totalPence).toBe(0);
        expect(bill.tenders).toEqual([]);
        expect(await repos.sales.bookingBalance(s.booking.id)).toBe(7000);

        const before = await repos.exportAll();
        await expectAppError(sell(s, twoBottles, { bookingId: s.booking.id, depositAppliedPence: 7001 }), 'DEPOSIT_EXCEEDS_BALANCE');
        const { bookingId: _omitted, ...withoutBooking } = saleOf(s.manager.id, twoBottles, { bookingId: s.booking.id, depositAppliedPence: 100 });
        await expectAppError(repos.commitSale({ sale: withoutBooking, stockMovements: [], clearDraft: false }), 'BOOKING_NOT_OPEN');
        expect(await repos.exportAll()).toEqual(before);

        // Exactly the balance is fine; refunds never change it.
        const last = await sell(s, twoBottles, { bookingId: s.booking.id, depositAppliedPence: 7000 });
        expect(await repos.sales.bookingBalance(s.booking.id)).toBe(0);
        await repos.commitSale({ sale: refundOf(s.manager.id, last, [{ index: 0, qty: 1 }]), stockMovements: [], clearDraft: false });
        expect(await repos.sales.bookingBalance(s.booking.id)).toBe(0);

        await repos.bookings.update(s.booking.id, { status: 'cancelled' });
        await expectAppError(sell(s, twoBottles, { bookingId: s.booking.id, depositAppliedPence: 1 }), 'BOOKING_NOT_OPEN');
        expect(await repos.sales.bookingBalance(OTHER_DEVICE_ID)).toBe(0);
      });

      it('re-checks refunds against the original sale and what is left to refund (D-035, D-036)', async () => {
        const s = await seed();
        const { repos } = s;
        const original = await sell(s, [saleLine(s.lager, 3), saleLine(s.crisps, 2)]);
        const refund = (picks: RefundPick[], of: Sale = original): Promise<Sale> =>
          repos.commitSale({ sale: refundOf(s.manager.id, of, picks), stockMovements: [], clearDraft: false });

        const r1 = await refund([{ index: 0, qty: 1 }]);
        s.h.clock.advance();
        const r2 = await refund([
          { index: 0, qty: 2 },
          { index: 1, qty: 1 },
        ]);
        expect(r1).toMatchObject({ kind: 'refund', refundOfSaleId: original.id, totalPence: -450 });

        const before = await repos.exportAll();
        await expectAppError(refund([{ index: 0, qty: 1 }]), 'REFUND_EXCEEDS_AVAILABLE');
        await expectAppError(refund([{ index: 1, qty: 2 }]), 'REFUND_EXCEEDS_AVAILABLE');
        const outOfRange = refundOf(s.manager.id, original, [{ index: 1, qty: 1 }]);
        await expectAppError(
          repos.commitSale({
            sale: { ...outOfRange, lines: outOfRange.lines.map((l) => ({ ...l, refundOfLineIndex: 5 })) },
            stockMovements: [],
            clearDraft: false,
          }),
          'REFUND_EXCEEDS_AVAILABLE',
        );

        const deposit = await repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 1000), stockMovements: [], clearDraft: false });
        const afterDeposit = await repos.exportAll();
        const fakeDepositLine: Sale = { ...deposit, lines: original.lines };
        await expectAppError(refund([{ index: 0, qty: 1 }], fakeDepositLine), 'NOT_REFUNDABLE');
        await expectAppError(refund([{ index: 0, qty: 1 }], { ...r1, lines: original.lines }), 'NOT_REFUNDABLE');
        await expectAppError(refund([{ index: 0, qty: 1 }], { ...original, id: OTHER_DEVICE_ID }), 'NOT_REFUNDABLE');
        expect(await repos.exportAll()).toEqual(afterDeposit);
        expect(afterDeposit.sales).toHaveLength(before.sales.length + 1);

        // The last crisp can still be refunded.
        await refund([{ index: 1, qty: 1 }]);
        expect((await repos.sales.listRefundsOf(original.id)).map((r) => r.id).slice(0, 2)).toEqual([r1.id, r2.id]);
        expect(await repos.sales.listRefundsOf(original.id)).toHaveLength(3);
        expect(await repos.sales.listRefundsOf(r1.id)).toEqual([]);
      });

      it('a forced failure after every write leaves nothing behind (D-115)', async () => {
        const h = await newStore();
        const s = await seed(h);
        await s.repos.stockMovements.add({ productId: s.lager.id, qty: 48, reason: 'goodsIn', staffId: s.manager.id, note: '' });
        await sell(s, [saleLine(s.lager, 1)]);
        const tab = await s.repos.tabs.create({
          labelType: 'name',
          label: 'Smith',
          openedAt: T0,
          openedBy: s.manager.id,
          status: 'open',
          lines: [{ productId: s.lager.id, qty: 2 }],
        });
        const draft = await s.repos.draft.save({ lines: [{ productId: s.lager.id, qty: 2 }], tabId: tab.id });
        await s.repos.close();

        const failing = (await reopen(h, { failSaleCommitAfterWrites: true })).repos;
        const before = await failing.exportAll();
        h.clock.advance();
        const lines = [saleLine(s.lager, 2), saleLine(s.crisps, 1)];
        const attempt = {
          sale: saleOf(s.manager.id, lines, { tabId: tab.id }),
          stockMovements: saleMovements(lines, [s.lager, s.crisps]),
          clearDraft: true,
        };
        await expectAppError(failing.commitSale(attempt), 'FORCED_FAILURE');

        expect(await failing.exportAll()).toEqual(before);
        expect(await failing.sales.list()).toHaveLength(1);
        expect(await failing.stockMovements.onHand(s.lager.id)).toBe(47);
        expect(await failing.stockMovements.onHand(s.crisps.id)).toBe(0);
        expect((await failing.settings.get())?.receiptCounter).toBe(1);
        expect(await failing.tabs.get(tab.id)).toEqual(tab);
        expect(await failing.draft.get()).toEqual(draft);
        expect(await failing.outbox.count()).toBe(before.outbox.length);

        // Inside transact() the whole outer transaction rolls back too.
        await expectAppError(
          failing.transact(async () => {
            await failing.auditEvents.append([{ type: 'noSale', staffId: s.manager.id, periodId: s.period.id, detail: {} }]);
            return failing.commitSale(attempt);
          }),
          'FORCED_FAILURE',
        );
        expect(await failing.exportAll()).toEqual(before);
        await failing.close();

        // The same input commits on a store without the hook.
        const healthy = (await reopen(h)).repos;
        const sale = await healthy.commitSale(attempt);
        expect(sale.receiptNumber).toBe(`${s.settings.devicePrefix}-000002`);
        expect((await healthy.tabs.get(tab.id))?.status).toBe('settled');
        expect(await healthy.draft.get()).toBeUndefined();
      });

      it('joins an outer transact() and rolls back with it', async () => {
        const s = await seed();
        const { repos } = s;
        const sale = await repos.transact(async () => {
          const committed = await sell(s, [saleLine(s.lager, 1)]);
          await repos.auditEvents.append([{ type: 'noSale', staffId: s.manager.id, periodId: s.period.id, detail: {} }]);
          return committed;
        });
        expect(await repos.sales.get(sale.id)).toEqual(sale);
        expect(await repos.auditEvents.list()).toHaveLength(1);

        const before = await repos.exportAll();
        await expect(
          repos.transact(async () => {
            await sell(s, [saleLine(s.lager, 1)]);
            throw new Error('boom after the sale');
          }),
        ).rejects.toThrow('boom after the sale');
        expect(await repos.exportAll()).toEqual(before);
      });
    });

    // -----------------------------------------------------------------------
    describe('sale queries', () => {
      it('finds sales by period, date range, booking and receipt number (D-040, D-103)', async () => {
        const s = await seed();
        const { repos, clock } = s;
        clock.set('2026-09-26T11:00:00.000Z');
        const a = await sell(s, [saleLine(s.lager, 1)]);
        clock.set('2026-09-26T12:00:00.000Z');
        const deposit = await repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 3000), stockMovements: [], clearDraft: false });
        clock.set('2026-09-26T13:00:00.000Z');
        const withBooking = await sell(s, [saleLine(s.lager, 2)], { bookingId: s.booking.id, depositAppliedPence: 900 });
        await repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 0 });
        clock.set('2026-09-27T09:00:00.000Z');
        const period2 = await repos.periods.open({ openedBy: s.manager.id, floatPence: 5000 });
        const refund = await repos.commitSale({ sale: refundOf(s.manager.id, a, [{ index: 0, qty: 1 }]), stockMovements: [], clearDraft: false });

        expect((await repos.sales.listByPeriod(s.period.id)).map((x) => x.id)).toEqual([a.id, deposit.id, withBooking.id]);
        expect((await repos.sales.listByPeriod(period2.id)).map((x) => x.id)).toEqual([refund.id]);
        expect(refund.periodId).toBe(period2.id);
        expect(await repos.sales.listByPeriod(OTHER_DEVICE_ID)).toEqual([]);

        const ids = async (from: string, to: string): Promise<string[]> => (await repos.sales.listByDateRange(from, to)).map((x) => x.id);
        expect(await ids('2026-09-26T12:00:00.000Z', '2026-09-26T13:00:00.000Z')).toEqual([deposit.id]);
        expect(await ids('2026-09-26T11:00:00.000Z', '2026-09-26T13:00:00.001Z')).toEqual([a.id, deposit.id, withBooking.id]);
        expect(await ids('2026-09-25T23:00:00.000Z', '2026-09-26T23:00:00.000Z')).toEqual([a.id, deposit.id, withBooking.id]);
        expect(await ids('2026-09-26T23:00:00.000Z', '2026-09-27T23:00:00.000Z')).toEqual([refund.id]);
        expect(await ids('2026-09-26T13:00:00.000Z', '2026-09-26T13:00:00.000Z')).toEqual([]);
        expect(await ids('2026-09-27T00:00:00.000Z', '2026-09-26T00:00:00.000Z')).toEqual([]);

        expect((await repos.sales.listByBooking(s.booking.id)).map((x) => x.id)).toEqual([deposit.id, withBooking.id]);
        expect(await repos.sales.bookingBalance(s.booking.id)).toBe(2100);
        expect((await repos.sales.list()).map((x) => x.id)).toEqual([a.id, deposit.id, withBooking.id, refund.id]);
        expect(await repos.sales.getByReceiptNumber(refund.receiptNumber)).toEqual(refund);
        expect(await repos.sales.get(OTHER_DEVICE_ID)).toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    describe('periods (D-047, D-061, D-067)', () => {
      it('opens one period at a time and finds it', async () => {
        const s = await seed();
        expect(s.period).toEqual({
          id: s.period.id,
          deviceId: s.settings.deviceId,
          createdAt: s.period.openedAt,
          updatedAt: s.period.openedAt,
          openedAt: s.period.openedAt,
          openedBy: s.manager.id,
          floatPence: 10000,
        });
        expect(await s.repos.periods.getOpen()).toEqual(s.period);
        expect(await s.repos.periods.get(s.period.id)).toEqual(s.period);
        const before = await s.repos.outbox.count();
        await expectAppError(s.repos.periods.open({ openedBy: s.manager.id, floatPence: 0 }), 'PERIOD_ALREADY_OPEN');
        expect(await s.repos.outbox.count()).toBe(before);
        expect(await s.repos.periods.list()).toEqual([s.period]);
      });

      it('close sets the closing fields and sequential Z numbers, one outbox update each', async () => {
        const s = await seed();
        const { repos, clock } = s;
        const at = clock.iso();
        const before = await repos.outbox.count();
        const z1 = await repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 16900 });
        expect(z1).toEqual({ ...s.period, closedAt: at, closedBy: s.manager.id, declaredCashPence: 16900, zNumber: 1, updatedAt: at });
        expect(await repos.periods.getOpen()).toBeUndefined();
        await expectOutboxWrites(repos, before, [{ entity: 'periods', operation: 'update', record: z1 }], at);

        clock.advance();
        const p2 = await repos.periods.open({ openedBy: s.manager.id, floatPence: 5000 });
        expect(await repos.periods.getOpen()).toEqual(p2);
        const z2 = await repos.periods.close({ periodId: p2.id, closedBy: s.manager.id, declaredCashPence: 0 });
        expect(z2.zNumber).toBe(2);
        expect((await repos.periods.list()).map((p) => p.zNumber)).toEqual([1, 2]);
      });

      it('close rejects a period that is not the open one', async () => {
        const s = await seed();
        await expectAppError(s.repos.periods.close({ periodId: OTHER_DEVICE_ID, closedBy: s.manager.id, declaredCashPence: 0 }), 'NO_OPEN_PERIOD');
        await s.repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 0 });
        await expectAppError(s.repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 0 }), 'NO_OPEN_PERIOD');
      });

      it('a Z close inside transact() is atomic with its audit event', async () => {
        const s = await seed();
        const { repos } = s;
        const before = await repos.exportAll();
        await expect(
          repos.transact(async () => {
            const closed = await repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 16900 });
            await repos.auditEvents.append([
              {
                type: 'zClose',
                staffId: s.manager.id,
                periodId: closed.id,
                detail: { zNumber: 1, floatPence: 10000, expectedCashPence: 16902, declaredCashPence: 16900, variancePence: -2 },
              },
            ]);
            throw new Error('printer on fire');
          }),
        ).rejects.toThrow('printer on fire');
        expect(await repos.exportAll()).toEqual(before);
        expect(await repos.periods.getOpen()).toEqual(s.period);

        const closed = await repos.transact(async () => {
          const period = await repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 16900 });
          await repos.auditEvents.append([
            {
              type: 'zClose',
              staffId: s.manager.id,
              periodId: period.id,
              detail: { zNumber: 1, floatPence: 10000, expectedCashPence: 16902, declaredCashPence: 16900, variancePence: -2 },
            },
          ]);
          return period;
        });
        expect(closed.zNumber).toBe(1);
        expect(await repos.auditEvents.listByPeriod(s.period.id)).toHaveLength(1);
      });

      it("Z numbers and the open period belong to this device only (D-061, D-067)", async () => {
        const a = await seed();
        const tables = await a.repos.exportAll();
        const foreign = (extra: Partial<Period>): Period => ({
          id: crypto.randomUUID(),
          deviceId: OTHER_DEVICE_ID,
          createdAt: T0,
          updatedAt: T0,
          openedAt: T0,
          openedBy: a.manager.id,
          floatPence: 0,
          ...extra,
        });
        const withForeign: BackupTables = {
          ...tables,
          periods: [...tables.periods, foreign({ closedAt: T0, closedBy: a.manager.id, declaredCashPence: 0, zNumber: 50 }), foreign({})],
        };
        const b = await newStore();
        await b.repos.importAll(withForeign);
        expect(await b.repos.periods.getOpen()).toEqual(a.period);
        await expectAppError(b.repos.periods.open({ openedBy: a.manager.id, floatPence: 0 }), 'PERIOD_ALREADY_OPEN');
        const closed = await b.repos.periods.close({ periodId: a.period.id, closedBy: a.manager.id, declaredCashPence: 0 });
        expect(closed.zNumber).toBe(1);
        expect(await b.repos.periods.getOpen()).toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    describe('audit events (D-083, D-084)', () => {
      it('append stamps events in order, at one instant, with one outbox entry each', async () => {
        const s = await seed();
        const before = await s.repos.outbox.count();
        const at = s.h.clock.iso();
        const events = await s.repos.auditEvents.append([
          { type: 'override', staffId: s.manager.id, approvedById: s.manager.id, periodId: s.period.id, detail: { action: 'voidLine' } },
          {
            type: 'void',
            staffId: s.manager.id,
            approvedById: s.manager.id,
            periodId: s.period.id,
            detail: { productId: s.lager.id, productName: 'Fairway Lager', qty: 1, unitPricePence: 450 },
          },
        ]);
        expect(events.map((e) => e.type)).toEqual(['override', 'void']);
        for (const event of events) {
          expect(event).toMatchObject({ deviceId: s.settings.deviceId, createdAt: at, updatedAt: at });
          expect(event.id).toMatch(UUID_V4);
        }
        const added = await expectOutboxWrites(
          s.repos,
          before,
          events.map((record): ExpectedWrite => ({ entity: 'auditEvents', operation: 'create', record })),
          at,
        );
        expect(added.map((e) => e.entityId)).toEqual(events.map((e) => e.id));

        const noPeriod = await s.repos.auditEvents.append([{ type: 'noSale', staffId: s.manager.id, periodId: undefined, detail: {} }]);
        expect('periodId' in first(noPeriod)).toBe(false);
        expect('approvedById' in first(noPeriod)).toBe(false);

        expect((await s.repos.auditEvents.listByPeriod(s.period.id)).map((e) => e.type).sort()).toEqual(['override', 'void']);
        expect((await s.repos.auditEvents.listByType('noSale')).map((e) => e.id)).toEqual(noPeriod.map((e) => e.id));
        expect(await s.repos.auditEvents.listByType('zClose')).toEqual([]);
        expect(await s.repos.auditEvents.list()).toHaveLength(3);
      });

      it('append([]) writes nothing', async () => {
        const s = await seed();
        const before = await s.repos.outbox.count();
        expect(await s.repos.auditEvents.append([])).toEqual([]);
        expect(await s.repos.outbox.count()).toBe(before);
      });
    });

    // -----------------------------------------------------------------------
    describe('outbox (D-053, D-054)', () => {
      it('holds one unsynced entry per record written, in write order', async () => {
        const s = await seed();
        const entries = await s.repos.outbox.list();
        // settings, manager, category, 3 products, member, booking, period
        expect(entries.map((e) => [e.entity, e.operation])).toEqual([
          ['settings', 'create'],
          ['staff', 'create'],
          ['categories', 'create'],
          ['products', 'create'],
          ['products', 'create'],
          ['products', 'create'],
          ['members', 'create'],
          ['bookings', 'create'],
          ['periods', 'create'],
        ]);
        const seqs = entries.map((e) => e.seq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
        expect(await s.repos.outbox.count()).toBe(entries.length);
        expect(await s.repos.outbox.listUnsynced()).toEqual(entries);
        for (const entry of entries) expect(entry.entityId).toBe(entry.payload.id);
      });

      it('reads never write', async () => {
        const s = await seed();
        await sell(s, [saleLine(s.lager, 1)]);
        const before = await s.repos.exportAll();
        await s.repos.staff.list();
        await s.repos.products.get(s.lager.id);
        await s.repos.members.findByNumber('1042');
        await s.repos.tabs.listOpen();
        await s.repos.sales.listByPeriod(s.period.id);
        await s.repos.sales.bookingBalance(s.booking.id);
        await s.repos.stockMovements.lowStock();
        await s.repos.stockMovements.onHandByProduct();
        await s.repos.auditEvents.list();
        await s.repos.periods.getOpen();
        await s.repos.settings.get();
        await s.repos.draft.get();
        await s.repos.outbox.listUnsynced();
        expect(await s.repos.exportAll()).toEqual(before);
      });
    });

    // -----------------------------------------------------------------------
    describe('draft (D-094, D-095)', () => {
      it('saves, replaces and clears the single draft row without outbox entries', async () => {
        const s = await seed();
        const before = await s.repos.outbox.count();
        expect(await s.repos.draft.get()).toBeUndefined();
        const at = s.h.clock.iso();
        const saved = await s.repos.draft.save({
          lines: [{ productId: s.lager.id, qty: 2 }],
          memberId: s.member.id,
          bookingId: s.booking.id,
          tabId: undefined,
        });
        expect(saved).toEqual({
          id: 'current',
          lines: [{ productId: s.lager.id, qty: 2 }],
          memberId: s.member.id,
          bookingId: s.booking.id,
          updatedAt: at,
        });
        expect(await s.repos.draft.get()).toEqual(saved);
        s.h.clock.advance();
        const replaced = await s.repos.draft.save({ lines: [{ productId: s.crisps.id, qty: 1 }] });
        expect(replaced).toEqual({ id: 'current', lines: [{ productId: s.crisps.id, qty: 1 }], updatedAt: s.h.clock.iso() });
        expect(await s.repos.draft.get()).toEqual(replaced);
        await s.repos.draft.clear();
        expect(await s.repos.draft.get()).toBeUndefined();
        await s.repos.draft.clear();
        expect(await s.repos.outbox.count()).toBe(before);
      });
    });

    // -----------------------------------------------------------------------
    describe('transact (D-056)', () => {
      it('commits every write together, sees its own writes and returns the result', async () => {
        const s = await seed();
        const { repos } = s;
        // Service-style helpers: native async functions that await only repository calls.
        const addProduct = async (name: string): Promise<Product> => {
          const category = await repos.categories.create({ name: `${name} category`, sortOrder: 2, colour: '#123456' });
          return repos.products.create(productInput(category.id, { name }));
        };
        const before = await repos.outbox.count();
        const result = await repos.transact(async () => {
          const product = await addProduct('Tonic Water');
          expect(await repos.products.get(product.id)).toEqual(product);
          await repos.stockMovements.add({ productId: product.id, qty: 24, reason: 'goodsIn', staffId: s.manager.id, note: '' });
          expect(await repos.stockMovements.onHand(product.id)).toBe(24);
          // Multi-store reads and parallel repository calls also join the transaction.
          expect(await repos.periods.getOpen()).toEqual(s.period);
          expect((await repos.stockMovements.lowStock()).map((l) => l.product.id)).toContain(s.lager.id);
          const [members, open] = await Promise.all([repos.members.list(), repos.tabs.listOpen()]);
          expect(members).toEqual([s.member]);
          expect(open).toEqual([]);
          await repos.draft.clear();
          return product;
        });
        expect(await repos.products.get(result.id)).toEqual(result);
        expect(await repos.stockMovements.onHand(result.id)).toBe(24);
        expect(await repos.outbox.count()).toBe(before + 3);
      });

      it('parallel writes inside transact() roll back together', async () => {
        const s = await seed();
        const { repos } = s;
        const before = await repos.exportAll();
        await expect(
          repos.transact(async () => {
            await Promise.all([
              repos.members.update(s.member.id, { firstName: 'Changed' }),
              repos.stockMovements.add({ productId: s.lager.id, qty: 5, reason: 'goodsIn', staffId: s.manager.id, note: '' }),
            ]);
            throw new Error('undo both');
          }),
        ).rejects.toThrow('undo both');
        expect(await repos.exportAll()).toEqual(before);
      });

      it('nested transact() calls join the outer transaction', async () => {
        const s = await seed();
        const { repos } = s;
        const before = await repos.exportAll();
        await expect(
          repos.transact(async () => {
            await repos.transact(() => repos.members.update(s.member.id, { firstName: 'Inner' }));
            throw new Error('outer fails');
          }),
        ).rejects.toThrow('outer fails');
        expect(await repos.exportAll()).toEqual(before);
      });

      it('a throw rolls back every write and outbox entry', async () => {
        const s = await seed();
        const { repos } = s;
        const before = await repos.exportAll();
        const draft = await repos.draft.save({ lines: [{ productId: s.lager.id, qty: 1 }] });
        await expect(
          repos.transact(async () => {
            const category = await repos.categories.create({ name: 'Doomed', sortOrder: 2, colour: '#123456' });
            await repos.products.create(productInput(category.id, { name: 'Doomed product' }));
            await repos.products.update(s.lager.id, { pricePence: 999 });
            await repos.members.softDelete(s.member.id);
            await repos.settings.update({ clubName: 'Doomed' });
            await repos.draft.clear();
            throw new AppError('VALIDATION', 'rejected by a service');
          }),
        ).rejects.toThrow('rejected by a service');
        expect(await repos.exportAll()).toEqual(before);
        expect(await repos.draft.get()).toEqual(draft);
      });
    });

    // -----------------------------------------------------------------------
    describe('backup (spec §10.2, D-088..D-092)', () => {
      /** Exercises every entity, operation and audit type, including soft-deleted rows. */
      async function buildRichData(): Promise<Seeded> {
        const s = await seed();
        const { repos, clock } = s;
        await repos.staff.create(staffInput({ name: 'Sam Staff', role: 'staff', active: false }));
        const old = await repos.categories.create({ name: 'Old', sortOrder: 9, colour: '#000000' });
        await repos.categories.softDelete(old.id);
        const deal = await repos.deals.create({
          name: '2 for £8',
          type: 'nForPrice',
          n: 2,
          pricePence: 800,
          productIds: [s.lager.id],
          active: true,
          startsAt: T0,
          endsAt: '2026-12-31T00:00:00.000Z',
        });
        await repos.deals.create({ name: 'Crisps 3 for 2', type: 'nForM', n: 3, m: 2, productIds: [s.crisps.id], active: false });
        const adjustment = await repos.stockMovements.add({ productId: s.lager.id, qty: 48, reason: 'goodsIn', staffId: s.manager.id, note: 'Opening stock' });
        const tab = await repos.tabs.create({
          labelType: 'name',
          label: 'Smith',
          openedAt: clock.iso(),
          openedBy: s.manager.id,
          status: 'open',
          lines: [{ productId: s.lager.id, qty: 2 }],
          memberId: s.member.id,
        });
        const parked = await repos.tabs.create({ labelType: 'table', label: '5', openedAt: clock.iso(), openedBy: s.manager.id, status: 'open', lines: [] });
        await repos.tabs.softDelete(parked.id);
        clock.advance();
        const withDeal = [saleLine(s.lager, 2, 100), saleLine(s.crisps, 2)];
        const sale1 = await sell(s, withDeal, {
          memberId: s.member.id,
          dealLines: [{ dealId: deal.id, name: deal.name, groupCount: 1, savingPence: 100 }],
          tenders: [
            { type: 'card', amountPence: 500 },
            { type: 'cash', amountPence: 2000 },
          ],
          changePence: 1450,
        });
        await repos.commitSale({ sale: depositOf(s.manager.id, s.booking.id, 5000), stockMovements: [], clearDraft: false });
        await sell(s, [saleLine(s.lager, 1)], { bookingId: s.booking.id, depositAppliedPence: 450 });
        await sell(s, [saleLine(s.lager, 2)], { tabId: tab.id, memberId: s.member.id });
        const refund = await repos.commitSale({
          sale: refundOf(s.manager.id, sale1, [{ index: 0, qty: 1, returnToStock: false }]),
          stockMovements: [
            { productId: s.lager.id, qty: 1, reason: 'refund', note: '' },
            { productId: s.lager.id, qty: -1, reason: 'waste', note: 'Refund - wasted' },
          ],
          clearDraft: false,
        });
        await repos.auditEvents.append([
          { type: 'override', staffId: s.manager.id, approvedById: s.manager.id, periodId: s.period.id, detail: { action: 'voidLine' } },
          {
            type: 'void',
            staffId: s.manager.id,
            approvedById: s.manager.id,
            periodId: s.period.id,
            detail: { productId: s.lager.id, productName: 'Fairway Lager', qty: 1, unitPricePence: 450, tabId: tab.id },
          },
          { type: 'noSale', staffId: s.manager.id, periodId: s.period.id, detail: {} },
          { type: 'priceChange', staffId: s.manager.id, detail: { productId: s.lager.id, productName: 'Fairway Lager', oldPricePence: 450, newPricePence: 480 } },
          {
            type: 'stockAdjust',
            staffId: s.manager.id,
            detail: { stockMovementId: adjustment.id, productId: s.lager.id, productName: 'Fairway Lager', qty: -2, reason: 'waste', note: 'Spilt' },
          },
          {
            type: 'refund',
            staffId: s.manager.id,
            periodId: s.period.id,
            detail: {
              refundSaleId: refund.id,
              refundReceiptNumber: refund.receiptNumber,
              originalSaleId: sale1.id,
              originalReceiptNumber: sale1.receiptNumber,
              totalPence: refund.totalPence,
              tender: 'cash',
              lines: [{ productId: s.lager.id, qty: 1, returnToStock: false }],
            },
          },
          { type: 'backupExport', staffId: s.manager.id, detail: { exportedAt: T0 } },
          { type: 'backupImport', staffId: s.manager.id, detail: { fileExportedAt: T0, fileDeviceId: s.settings.deviceId, importedByName: 'Morgan Manager' } },
        ]);
        await repos.transact(async () => {
          const closed = await repos.periods.close({ periodId: s.period.id, closedBy: s.manager.id, declaredCashPence: 16900 });
          await repos.auditEvents.append([
            {
              type: 'zClose',
              staffId: s.manager.id,
              periodId: closed.id,
              detail: { zNumber: 1, floatPence: 10000, expectedCashPence: 16902, declaredCashPence: 16900, variancePence: -2 },
            },
          ]);
        });
        clock.advance();
        await repos.periods.open({ openedBy: s.manager.id, floatPence: 5000 });
        await repos.members.update(s.member.id, { lastName: 'Archer-Smith' });
        await repos.products.update(s.lager.id, { pricePence: 480 });
        await repos.settings.update({ lastBackupAt: clock.iso() });
        await repos.draft.save({ lines: [{ productId: s.crisps.id, qty: 1 }] });
        return s;
      }

      it('exportAll returns every row of every synced table and the outbox, but not the draft', async () => {
        const s = await buildRichData();
        const tables = await s.repos.exportAll();
        expect(Object.keys(tables).sort()).toEqual([...ENTITY_NAMES, 'outbox'].sort());
        expect(tables.categories.some((c) => c.deletedAt !== undefined)).toBe(true);
        expect(tables.tabs.some((t) => t.deletedAt !== undefined)).toBe(true);
        expect(tables.staff).toHaveLength(2);
        expect(tables.sales).toHaveLength(5);
        expect(tables.periods).toHaveLength(2);
        expect(tables.settings).toHaveLength(1);
        expect(new Set(tables.auditEvents.map((e) => e.type)).size).toBe(9);
        expect(tables.outbox).toEqual(await s.repos.outbox.list());
        expect(JSON.stringify(tables)).not.toContain('"current"');
      });

      it('the export is plain JSON and forms a valid backup file (D-088, D-089)', async () => {
        const s = await buildRichData();
        const tables = await s.repos.exportAll();
        expect(JSON.parse(JSON.stringify(tables))).toEqual(tables);
        const result = validateBackupValue({
          format: BACKUP_FORMAT,
          version: SCHEMA_VERSION,
          exportedAt: s.h.clock.iso(),
          deviceId: s.settings.deviceId,
          tables: JSON.parse(JSON.stringify(tables)) as unknown,
        });
        expect(result.ok ? [] : result.problems).toEqual([]);
      });

      it('a round trip into a fresh database gives identical data (D-092)', async () => {
        const a = await buildRichData();
        const exported = await a.repos.exportAll();
        const b = await newStore();
        await b.repos.importAll(JSON.parse(JSON.stringify(exported)) as BackupTables);
        expect(await b.repos.exportAll()).toEqual(exported);
        expect(await b.repos.settings.get()).toEqual(first(exported.settings));
        expect(await b.repos.draft.get()).toBeUndefined();
      });

      it('exportAll lists every table by createdAt, then id, and the outbox by seq (D-119)', async () => {
        // Ids that count DOWN, so id order and creation order disagree.
        let n = 0xfff;
        const descending: TestIds = {
          next: () => {
            n -= 1;
            return `3f9c2aff-7b4d-4e8a-9c1f-${n.toString(16).padStart(12, '0')}`;
          },
          pin: () => undefined,
          unpin: () => undefined,
        };
        const s = await seed(await newStore({ ids: descending, clock: makeClock(T0, 1000) }));
        await s.repos.members.create({ memberNumber: '1043', firstName: 'Ben', lastName: 'Birch', active: true });
        await sell(s, [saleLine(s.lager, 1)]);
        // One commit, one instant: the two stock movements tie on createdAt and fall back to id.
        await sell(s, [saleLine(s.lager, 2), saleLine(s.crisps, 1)]);
        const exported = await s.repos.exportAll();
        const byCreatedAtThenId = (a: SyncedRecord, b: SyncedRecord): number =>
          a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        for (const entity of ENTITY_NAMES) {
          const rows: readonly SyncedRecord[] = exported[entity];
          expect(rows.map((r) => r.id), entity).toEqual([...rows].sort(byCreatedAtThenId).map((r) => r.id));
        }
        expect(exported.members.map((m) => m.memberNumber)).toEqual(['1042', '1043']);
        expect(exported.products.map((p) => p.name)).toEqual([s.lager.name, s.crisps.name, s.raffle.name]);
        expect(exported.sales.map((sale) => sale.lines.length)).toEqual([1, 2]);
        const lastSaleMovements = exported.stockMovements.slice(-2);
        expect(lastSaleMovements[0]?.createdAt).toBe(lastSaleMovements[1]?.createdAt);
        expect((lastSaleMovements[0]?.id ?? '') < (lastSaleMovements[1]?.id ?? '')).toBe(true);
        expect(exported.outbox.map((e) => e.seq)).toEqual([...exported.outbox.map((e) => e.seq)].sort((a, b) => a - b));
      });

      it('import replaces all existing data and clears the draft, generating no outbox entries (D-090)', async () => {
        const a = await buildRichData();
        const exported = await a.repos.exportAll();
        const b = await seed();
        await sell(b, [saleLine(b.lager, 3)]);
        await b.repos.draft.save({ lines: [{ productId: b.lager.id, qty: 1 }] });
        await b.repos.importAll(exported);
        expect(await b.repos.exportAll()).toEqual(exported);
        expect(await b.repos.draft.get()).toBeUndefined();
        expect(await b.repos.outbox.list()).toEqual(exported.outbox);
        expect(await b.repos.products.get(b.lager.id)).toBeUndefined();
        // Imported settings restore the till's identity and numbering.
        const settings = defined(await b.repos.settings.get());
        expect(settings).toEqual(first(exported.settings));
        expect(settings.lastBackupAt).toBe(first(exported.settings).lastBackupAt);
      });

      it('import appends the given audit events, stamped with the imported device id, after the restore', async () => {
        const a = await buildRichData();
        const exported = await a.repos.exportAll();
        const b = await newStore({ clock: makeClock('2026-10-01T08:00:00.000Z') });
        const at = b.clock.iso();
        const maxSeq = Math.max(...exported.outbox.map((e) => e.seq));
        await b.repos.importAll(exported, {
          auditEvents: [
            { type: 'override', staffId: a.manager.id, approvedById: a.manager.id, detail: { action: 'backup' } },
            {
              type: 'backupImport',
              staffId: a.manager.id,
              approvedById: a.manager.id,
              detail: { fileExportedAt: T0, fileDeviceId: a.settings.deviceId, importedByName: 'Morgan Manager' },
            },
          ],
        });
        const after = await b.repos.exportAll();
        const added = after.auditEvents.filter((e) => !exported.auditEvents.some((x) => x.id === e.id));
        expect(added.map((e) => e.type).sort()).toEqual(['backupImport', 'override']);
        for (const event of added) expect(event).toMatchObject({ deviceId: a.settings.deviceId, createdAt: at, updatedAt: at });
        const newEntries = after.outbox.slice(exported.outbox.length);
        expect(after.outbox.slice(0, exported.outbox.length)).toEqual(exported.outbox);
        expect(newEntries.map((e) => (e.payload as { type?: string }).type)).toEqual(['override', 'backupImport']);
        for (const entry of newEntries) {
          expect(entry.seq).toBeGreaterThan(maxSeq);
          expect(entry.entity).toBe('auditEvents');
          expect(entry.createdAt).toBe(at);
        }
        expect({ ...after, auditEvents: exported.auditEvents, outbox: exported.outbox }).toEqual(exported);
      });

      it('a failed import leaves the existing data untouched', async () => {
        const a = await buildRichData();
        const exported = await a.repos.exportAll();
        const b = await seed();
        await sell(b, [saleLine(b.lager, 1)]);
        const draft = await b.repos.draft.save({ lines: [{ productId: b.lager.id, qty: 1 }] });
        const before = await b.repos.exportAll();

        const duplicated: BackupTables = { ...exported, members: [...exported.members, first(exported.members)] };
        await expectAppError(b.repos.importAll(duplicated), 'CONFLICT');
        expect(await b.repos.exportAll()).toEqual(before);
        expect(await b.repos.draft.get()).toEqual(draft);

        const noSettings: BackupTables = { ...exported, settings: [] };
        await expectAppError(
          b.repos.importAll(noSettings, { auditEvents: [{ type: 'backupImport', staffId: a.manager.id, detail: { fileExportedAt: T0, fileDeviceId: a.settings.deviceId, importedByName: 'X' } }] }),
          'NOT_INITIALISED',
        );
        expect(await b.repos.exportAll()).toEqual(before);
        expect(await b.repos.draft.get()).toEqual(draft);
      });

      it('restores synced outbox entries as they were; listUnsynced skips them (D-054)', async () => {
        const a = await seed();
        const exported = await a.repos.exportAll();
        const syncedAt = '2026-09-26T12:00:00.000Z';
        const outbox = exported.outbox.map((entry, i) => (i < 3 ? { ...entry, syncedAt } : entry));
        const b = await newStore();
        await b.repos.importAll({ ...exported, outbox });
        expect(await b.repos.outbox.list()).toEqual(outbox);
        expect(await b.repos.outbox.count()).toBe(outbox.length);
        expect(await b.repos.outbox.listUnsynced()).toEqual(outbox.slice(3));
      });

      it('after an import, new writes continue the imported numbering and device identity (D-059, D-090)', async () => {
        const a = await seed();
        const exported = await a.repos.exportAll();
        const settings = first(exported.settings);
        const b = await newStore();
        await b.repos.importAll({ ...exported, settings: [{ ...settings, receiptCounter: 999999 }] });
        const sale = await b.repos.commitSale({ sale: saleOf(a.manager.id, [saleLine(a.lager, 1)]), stockMovements: [], clearDraft: true });
        expect(sale.receiptNumber).toBe(`${settings.devicePrefix}-1000000`);
        expect(sale.deviceId).toBe(settings.deviceId);
        expect(sale.periodId).toBe(a.period.id);
        const outbox = await b.repos.outbox.list();
        const maxImported = Math.max(...exported.outbox.map((e) => e.seq));
        expect(outbox.slice(exported.outbox.length).every((e) => e.seq > maxImported)).toBe(true);
      });
    });
  });
}
