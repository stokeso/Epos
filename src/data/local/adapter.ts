/**
 * The LocalAdapter: Repos over Dexie / IndexedDB (spec §3, §3.2, §8; D-048..D-061, D-067, D-082,
 * D-088..D-095, D-115).
 *
 * How it works:
 * - Every write method runs in its own read-write Dexie transaction over the stores it touches.
 *   Inside Repos.transact() (which spans every store) Dexie turns that into a sub-transaction of
 *   the outer one, so all writes commit or roll back together. A failing sub-transaction rejects
 *   its parent too, so the outer transaction can never commit half an operation.
 * - Every record write appends exactly one outbox entry in the same transaction (D-053).
 * - The clock is read once per repository call; that instant stamps every record and outbox
 *   entry the call writes (D-049).
 * - Creates use Dexie add(), never put(), so a duplicate id or receipt number is rejected with a
 *   ConstraintError, which surfaces as AppError('CONFLICT') (D-115).
 * - Methods return Dexie promises (not native async wrappers) so a caller inside transact() awaits
 *   Dexie promises directly, which keeps Dexie's transaction zone intact.
 */
import { Dexie } from 'dexie';
import { AppError } from '../errors';
import { buildOutboxEntry } from '../outbox';
import type {
  AuditEventRepo,
  CommitSaleInput,
  DraftContent,
  DraftRepo,
  EditableRepo,
  ImportOptions,
  InitialiseInput,
  InitialiseResult,
  ListOptions,
  MemberRepo,
  OutboxRepo,
  PeriodRepo,
  Repos,
  SaleRepo,
  SettingsPatch,
  SettingsRepo,
  StockLevel,
  StockMovementRepo,
  TabRepo,
} from '../repos';
import type {
  AuditEvent,
  BackupTables,
  Booking,
  Draft,
  EditableRecord,
  EntityMap,
  EntityName,
  IsoInstant,
  NewAuditEvent,
  OutboxOperation,
  Pence,
  Period,
  Sale,
  Settings,
  StockMovement,
  SyncedRecord,
  Tab,
} from '../types';
import { ENTITY_NAMES } from '../types';
import { ALL_STORES, BACKUP_STORES, type ClubDb, type StoreName } from './db';
import { PROTECTED_KEYS, applyPatch, byCreatedAtThenId, compareStrings, stripUndefined, withoutKeys } from './records';

/** The fixed key of the single draft row (D-094). */
export const DRAFT_KEY = 'current';

/** Everything the repositories share. */
export interface AdapterEnv {
  readonly db: ClubDb;
  /** One clock read, as an ISO instant. */
  readonly nowIso: () => IsoInstant;
  readonly newId: () => string;
  readonly failSaleCommitAfterWrites: boolean;
}

type EditableEntity = 'staff' | 'categories' | 'products' | 'deals' | 'members' | 'bookings' | 'tabs';

/** The stores commitSale reads or writes (D-056). */
const COMMIT_STORES: readonly StoreName[] = ['settings', 'periods', 'sales', 'stockMovements', 'tabs', 'bookings', 'draft', 'outbox'];

/** Settings keys a SettingsPatch may change (receiptCounter changes only inside commitSale, D-059). */
const SETTINGS_PATCH_KEYS: ReadonlySet<string> = new Set<keyof SettingsPatch>([
  'clubName',
  'receiptFooter',
  'autoLockMinutes',
  'memberDiscountPercent',
  'devicePrefix',
  'lastBackupAt',
]);

/** The only optional Settings field a patch can remove (D-050). */
const SETTINGS_OPTIONAL_KEYS: ReadonlySet<string> = new Set<keyof SettingsPatch>(['lastBackupAt']);

/** Fields commitSale sets itself on a sale (D-056). */
const SALE_OWNED_KEYS: ReadonlySet<string> = new Set([...PROTECTED_KEYS, 'periodId', 'receiptNumber']);

/** Fields commitSale sets itself on a sale's stock movement. */
const MOVEMENT_OWNED_KEYS: ReadonlySet<string> = new Set([...PROTECTED_KEYS, 'saleId', 'staffId']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const notInitialised = (): AppError => new AppError('NOT_INITIALISED', 'The till has not been set up yet');
const notFound = (): AppError => new AppError('NOT_FOUND', 'That record no longer exists');
const conflict = (): AppError => new AppError('CONFLICT', 'That record already exists');

function isConstraintFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConstraintError') return true;
  if (error.name !== 'BulkError') return false;
  const failures: unknown = (error as Error & { failures?: unknown }).failures;
  return Array.isArray(failures) && failures.some((failure) => failure instanceof Error && failure.name === 'ConstraintError');
}

/** AppErrors pass through; IndexedDB uniqueness failures become CONFLICT (D-115). */
function toAppError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (isConstraintFailure(error)) return conflict();
  return error;
}

function guard<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    throw toAppError(error);
  });
}

/** A resolved Dexie promise (keeps the transaction zone, unlike a native one). */
function resolved<T>(value: T): Promise<T> {
  return Dexie.Promise.resolve(value);
}

// ---------------------------------------------------------------------------
// Transactions and shared reads/writes
// ---------------------------------------------------------------------------

function rw<T>(env: AdapterEnv, stores: readonly StoreName[], work: () => Promise<T>): Promise<T> {
  return guard(env.db.transaction('rw', stores, work));
}

function ro<T>(env: AdapterEnv, stores: readonly StoreName[], work: () => Promise<T>): Promise<T> {
  return guard(env.db.transaction('r', stores, work));
}

function readSettings(db: ClubDb): Promise<Settings | undefined> {
  return db.settings.toCollection().first();
}

function requireSettings(db: ClubDb): Promise<Settings> {
  return readSettings(db).then((settings) => {
    if (settings === undefined) throw notInitialised();
    return settings;
  });
}

/** The open period of this device (D-067): its deviceId, no closedAt, not deleted. */
function findOpenPeriod(db: ClubDb, settings: Settings): Promise<Period | undefined> {
  return db.periods.toArray().then((periods) =>
    periods
      .filter((p) => p.deviceId === settings.deviceId && p.closedAt === undefined && p.deletedAt === undefined)
      .sort((a, b) => compareStrings(a.openedAt, b.openedAt) || compareStrings(a.id, b.id))
      .at(0),
  );
}

function appendOutbox(env: AdapterEnv, entity: EntityName, operation: OutboxOperation, record: SyncedRecord, at: IsoInstant): Promise<number> {
  return env.db.outbox.add(buildOutboxEntry(entity, operation, record, at, env.newId()));
}

function visible<T extends EditableRecord>(rows: T[], options?: ListOptions): T[] {
  const kept = options?.includeDeleted === true ? rows : rows.filter((row) => row.deletedAt === undefined);
  return kept.sort(byCreatedAtThenId);
}

/** D-025: deposits taken minus deposits applied. Refund sales never change it. */
function depositBalance(sales: readonly Sale[]): Pence {
  let deposits = 0;
  let applied = 0;
  for (const sale of sales) {
    if (sale.kind === 'deposit') deposits += sale.totalPence;
    else if (sale.kind === 'sale') applied += sale.depositAppliedPence;
  }
  return deposits - applied;
}

function salesOfBooking(db: ClubDb, bookingId: string): Promise<Sale[]> {
  return db.sales.where('bookingId').equals(bookingId).toArray();
}

/** Stamps and adds audit events in order, one outbox entry each (shared by append and importAll). */
async function addAuditEvents(env: AdapterEnv, deviceId: string, events: readonly NewAuditEvent[], at: IsoInstant): Promise<AuditEvent[]> {
  const stored: AuditEvent[] = [];
  for (const event of events) {
    const record = { ...withoutKeys(event, PROTECTED_KEYS), id: env.newId(), deviceId, createdAt: at, updatedAt: at } as AuditEvent;
    await env.db.auditEvents.add(record);
    await appendOutbox(env, 'auditEvents', 'create', record, at);
    stored.push(record);
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Editable repositories
// ---------------------------------------------------------------------------

function editableRepo<K extends EditableEntity>(env: AdapterEnv, entity: K): EditableRepo<EntityMap[K]> {
  type T = EntityMap[K];
  const table = env.db.table<T, string>(entity);
  const stores: readonly StoreName[] = [entity, 'settings', 'outbox'];

  return {
    get: (id) => guard(table.get(id)),
    list: (options) => guard(table.toArray().then((rows) => visible(rows, options))),
    create: (input) => {
      const at = env.nowIso();
      return rw(env, stores, async () => {
        const settings = await requireSettings(env.db);
        const record = {
          ...withoutKeys(input, PROTECTED_KEYS),
          id: env.newId(),
          deviceId: settings.deviceId,
          createdAt: at,
          updatedAt: at,
        } as T;
        await table.add(record);
        await appendOutbox(env, entity, 'create', record, at);
        return record;
      });
    },
    update: (id, patch) => {
      const at = env.nowIso();
      return rw(env, stores, async () => {
        const existing = await table.get(id);
        if (existing === undefined) throw notFound();
        const record: T = { ...applyPatch(existing, patch, PROTECTED_KEYS), updatedAt: at };
        await table.put(record);
        await appendOutbox(env, entity, 'update', record, at);
        return record;
      });
    },
    softDelete: (id) => {
      const at = env.nowIso();
      return rw(env, stores, async () => {
        const existing = await table.get(id);
        if (existing === undefined) throw notFound();
        // Already deleted: nothing is written, so no outbox entry (D-053).
        if (existing.deletedAt !== undefined) return existing;
        const record: T = { ...existing, deletedAt: at, updatedAt: at };
        await table.put(record);
        await appendOutbox(env, entity, 'delete', record, at);
        return record;
      });
    },
  };
}

function memberRepo(env: AdapterEnv): MemberRepo {
  return {
    ...editableRepo(env, 'members'),
    findByNumber: (memberNumber) =>
      guard(
        env.db.members
          .where('memberNumber')
          .equals(memberNumber)
          .toArray()
          .then((rows) => visible(rows).at(0)),
      ),
  };
}

function tabRepo(env: AdapterEnv): TabRepo {
  return {
    ...editableRepo(env, 'tabs'),
    listOpen: () =>
      guard(
        env.db.tabs
          .where('status')
          .equals('open')
          .toArray()
          .then((rows) =>
            rows
              .filter((tab) => tab.deletedAt === undefined)
              .sort((a, b) => compareStrings(a.openedAt, b.openedAt) || compareStrings(a.id, b.id)),
          ),
      ),
  };
}

// ---------------------------------------------------------------------------
// Append-only repositories (no update or delete methods, D-051)
// ---------------------------------------------------------------------------

function saleRepo(env: AdapterEnv): SaleRepo {
  const { db } = env;
  const sorted = (rows: Sale[]): Sale[] => rows.sort(byCreatedAtThenId);
  return {
    get: (id) => guard(db.sales.get(id)),
    getByReceiptNumber: (receiptNumber) => guard(db.sales.where('receiptNumber').equals(receiptNumber).first()),
    listByPeriod: (periodId) => guard(db.sales.where('periodId').equals(periodId).toArray().then(sorted)),
    listByDateRange: (fromInclusive, toExclusive) =>
      fromInclusive < toExclusive
        ? guard(db.sales.where('createdAt').between(fromInclusive, toExclusive, true, false).toArray().then(sorted))
        : resolved([]),
    listByBooking: (bookingId) => guard(salesOfBooking(db, bookingId).then(sorted)),
    listRefundsOf: (saleId) =>
      guard(
        db.sales
          .where('refundOfSaleId')
          .equals(saleId)
          .toArray()
          .then((rows) => sorted(rows.filter((sale) => sale.kind === 'refund'))),
      ),
    bookingBalance: (bookingId) => guard(salesOfBooking(db, bookingId).then(depositBalance)),
    list: () => guard(db.sales.toArray().then(sorted)),
  };
}

function sumQty(movements: readonly StockMovement[]): number {
  let total = 0;
  for (const movement of movements) total += movement.qty;
  return total;
}

function totalsByProduct(movements: readonly StockMovement[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const movement of movements) totals[movement.productId] = (totals[movement.productId] ?? 0) + movement.qty;
  return totals;
}

function stockMovementRepo(env: AdapterEnv): StockMovementRepo {
  const { db } = env;
  const sorted = (rows: StockMovement[]): StockMovement[] => rows.sort(byCreatedAtThenId);
  return {
    add: (input) => {
      const at = env.nowIso();
      return rw(env, ['stockMovements', 'settings', 'outbox'], async () => {
        const settings = await requireSettings(db);
        const record = {
          ...withoutKeys(input, PROTECTED_KEYS),
          id: env.newId(),
          deviceId: settings.deviceId,
          createdAt: at,
          updatedAt: at,
        } as StockMovement;
        await db.stockMovements.add(record);
        await appendOutbox(env, 'stockMovements', 'create', record, at);
        return record;
      });
    },
    get: (id) => guard(db.stockMovements.get(id)),
    listByProduct: (productId) => guard(db.stockMovements.where('productId').equals(productId).toArray().then(sorted)),
    listBySale: (saleId) => guard(db.stockMovements.where('saleId').equals(saleId).toArray().then(sorted)),
    list: () => guard(db.stockMovements.toArray().then(sorted)),
    onHand: (productId) => guard(db.stockMovements.where('productId').equals(productId).toArray().then(sumQty)),
    onHandByProduct: () => guard(db.stockMovements.toArray().then(totalsByProduct)),
    lowStock: () =>
      ro(env, ['products', 'stockMovements'], async () => {
        const products = await db.products.toArray();
        const totals = totalsByProduct(await db.stockMovements.toArray());
        const levels: StockLevel[] = products
          .filter((product) => product.stockTracked && product.active && product.deletedAt === undefined)
          .map((product) => ({ product, onHand: totals[product.id] ?? 0 }))
          .filter(({ product, onHand }) => onHand <= product.lowStockLevel);
        return levels.sort(
          (a, b) =>
            a.onHand - a.product.lowStockLevel - (b.onHand - b.product.lowStockLevel) ||
            a.product.name.localeCompare(b.product.name, 'en-GB') ||
            compareStrings(a.product.id, b.product.id),
        );
      }),
  };
}

function auditEventRepo(env: AdapterEnv): AuditEventRepo {
  const { db } = env;
  const sorted = (rows: AuditEvent[]): AuditEvent[] => rows.sort(byCreatedAtThenId);
  return {
    append: (events) => {
      if (events.length === 0) return resolved([]);
      const at = env.nowIso();
      return rw(env, ['auditEvents', 'settings', 'outbox'], async () => {
        const settings = await requireSettings(db);
        return addAuditEvents(env, settings.deviceId, events, at);
      });
    },
    listByPeriod: (periodId) => guard(db.auditEvents.where('periodId').equals(periodId).toArray().then(sorted)),
    listByType: (type) => guard(db.auditEvents.where('type').equals(type).toArray().then(sorted)),
    list: () => guard(db.auditEvents.toArray().then(sorted)),
  };
}

// ---------------------------------------------------------------------------
// Periods, settings, outbox, draft
// ---------------------------------------------------------------------------

function periodRepo(env: AdapterEnv): PeriodRepo {
  const { db } = env;
  const stores: readonly StoreName[] = ['periods', 'settings', 'outbox'];
  return {
    get: (id) => guard(db.periods.get(id)),
    list: (options) => guard(db.periods.toArray().then((rows) => visible(rows, options))),
    getOpen: () =>
      ro(env, ['settings', 'periods'], async () => {
        const settings = await readSettings(db);
        return settings === undefined ? undefined : findOpenPeriod(db, settings);
      }),
    open: (input) => {
      const at = env.nowIso();
      return rw(env, stores, async () => {
        const settings = await requireSettings(db);
        if ((await findOpenPeriod(db, settings)) !== undefined) {
          throw new AppError('PERIOD_ALREADY_OPEN', 'A trading period is already open');
        }
        const period: Period = {
          id: env.newId(),
          deviceId: settings.deviceId,
          createdAt: at,
          updatedAt: at,
          openedAt: at,
          openedBy: input.openedBy,
          floatPence: input.floatPence,
        };
        await db.periods.add(period);
        await appendOutbox(env, 'periods', 'create', period, at);
        return period;
      });
    },
    close: (input) => {
      const at = env.nowIso();
      return rw(env, stores, async () => {
        const settings = await requireSettings(db);
        const open = await findOpenPeriod(db, settings);
        if (open === undefined || open.id !== input.periodId) {
          throw new AppError('NO_OPEN_PERIOD', 'That trading period is not open');
        }
        // D-061: 1 + the highest zNumber among this device's periods.
        let maxZ = 0;
        for (const period of await db.periods.toArray()) {
          if (period.deviceId === settings.deviceId) maxZ = Math.max(maxZ, period.zNumber ?? 0);
        }
        const closed: Period = {
          ...open,
          closedAt: at,
          closedBy: input.closedBy,
          declaredCashPence: input.declaredCashPence,
          zNumber: maxZ + 1,
          updatedAt: at,
        };
        await db.periods.put(closed);
        await appendOutbox(env, 'periods', 'update', closed, at);
        return closed;
      });
    },
  };
}

/** Only SettingsPatch keys apply; undefined removes lastBackupAt and is ignored for required keys. */
function applySettingsPatch(existing: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTINGS_PATCH_KEYS.has(key)) continue;
    if (value === undefined) {
      if (SETTINGS_OPTIONAL_KEYS.has(key)) delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as unknown as Settings;
}

function settingsRepo(env: AdapterEnv): SettingsRepo {
  const { db } = env;
  return {
    get: () => guard(readSettings(db)),
    update: (patch) => {
      const at = env.nowIso();
      return rw(env, ['settings', 'outbox'], async () => {
        const existing = await requireSettings(db);
        const settings: Settings = { ...applySettingsPatch(existing, patch), updatedAt: at };
        await db.settings.put(settings);
        await appendOutbox(env, 'settings', 'update', settings, at);
        return settings;
      });
    },
  };
}

function outboxRepo(env: AdapterEnv): OutboxRepo {
  const { db } = env;
  return {
    list: () => guard(db.outbox.toArray()),
    count: () => guard(db.outbox.count()),
    listUnsynced: () => guard(db.outbox.toArray().then((rows) => rows.filter((row) => row.syncedAt === null))),
  };
}

function draftRepo(env: AdapterEnv): DraftRepo {
  const { db } = env;
  return {
    get: () => guard(db.draft.get(DRAFT_KEY)),
    save: (content: DraftContent) => {
      const at = env.nowIso();
      return rw(env, ['draft'], async () => {
        const draft: Draft = stripUndefined({
          id: DRAFT_KEY,
          lines: content.lines.map((line) => ({ productId: line.productId, qty: line.qty })),
          memberId: content.memberId,
          bookingId: content.bookingId,
          tabId: content.tabId,
          updatedAt: at,
        });
        await db.draft.put(draft);
        return draft;
      });
    },
    clear: () => rw(env, ['draft'], () => db.draft.delete(DRAFT_KEY)),
  };
}

// ---------------------------------------------------------------------------
// Atomic operations
// ---------------------------------------------------------------------------

function initialise(env: AdapterEnv, input: InitialiseInput): Promise<InitialiseResult> {
  const { db } = env;
  const at = env.nowIso();
  return rw(env, ['settings', 'staff', 'outbox'], async () => {
    const existing = await readSettings(db);
    let settings: Settings;
    if (existing === undefined) {
      const deviceId = env.newId();
      settings = stripUndefined({
        clubName: input.settings.clubName,
        receiptFooter: input.settings.receiptFooter,
        autoLockMinutes: input.settings.autoLockMinutes,
        memberDiscountPercent: input.settings.memberDiscountPercent,
        id: deviceId,
        deviceId,
        createdAt: at,
        updatedAt: at,
        devicePrefix: deviceId.slice(0, 4).toUpperCase(),
        receiptCounter: 0,
      });
      await db.settings.add(settings);
      await appendOutbox(env, 'settings', 'create', settings, at);
    } else {
      settings = { ...existing, clubName: input.settings.clubName, updatedAt: at };
      await db.settings.put(settings);
      await appendOutbox(env, 'settings', 'update', settings, at);
    }
    const manager = {
      ...withoutKeys(input.manager, PROTECTED_KEYS),
      id: env.newId(),
      deviceId: settings.deviceId,
      createdAt: at,
      updatedAt: at,
    } as EntityMap['staff'];
    await db.staff.add(manager);
    await appendOutbox(env, 'staff', 'create', manager, at);
    return { settings, manager };
  });
}

async function requireOpenBooking(db: ClubDb, bookingId: string | undefined): Promise<Booking> {
  const booking = bookingId === undefined ? undefined : await db.bookings.get(bookingId);
  if (booking === undefined || booking.deletedAt !== undefined || booking.status !== 'open') {
    throw new AppError('BOOKING_NOT_OPEN', 'That booking is no longer open');
  }
  return booking;
}

/** D-036: every refund line must fit in what is left to refund on its original line. */
async function checkRefundAvailable(db: ClubDb, sale: CommitSaleInput['sale']): Promise<void> {
  const original = sale.refundOfSaleId === undefined ? undefined : await db.sales.get(sale.refundOfSaleId);
  if (original === undefined || original.kind !== 'sale') {
    throw new AppError('NOT_REFUNDABLE', "This receipt can't be refunded");
  }
  const earlier = (await db.sales.where('refundOfSaleId').equals(original.id).toArray()).filter((s) => s.kind === 'refund');
  const alreadyRefunded = new Map<number, number>();
  for (const refund of earlier) {
    for (const line of refund.lines) {
      if (line.refundOfLineIndex === undefined) continue;
      alreadyRefunded.set(line.refundOfLineIndex, (alreadyRefunded.get(line.refundOfLineIndex) ?? 0) + Math.abs(line.qty));
    }
  }
  const requested = new Map<number, number>();
  for (const line of sale.lines) {
    const index = line.refundOfLineIndex ?? -1;
    requested.set(index, (requested.get(index) ?? 0) + Math.abs(line.qty));
  }
  for (const [index, qty] of requested) {
    const available = (original.lines[index]?.qty ?? 0) - (alreadyRefunded.get(index) ?? 0);
    if (qty > available) {
      throw new AppError('REFUND_EXCEEDS_AVAILABLE', 'That is more than is left to refund on this receipt');
    }
  }
}

function commitSale(env: AdapterEnv, input: CommitSaleInput): Promise<Sale> {
  const { db } = env;
  const at = env.nowIso();
  return rw(env, COMMIT_STORES, async () => {
    // 1. The open period.
    const settings = await requireSettings(db);
    const period = await findOpenPeriod(db, settings);
    if (period === undefined) throw new AppError('NO_OPEN_PERIOD', 'No trading period is open');

    // 2. Transactional re-checks (D-056).
    const { sale } = input;
    let tab: Tab | undefined;
    if (sale.tabId !== undefined) {
      tab = await db.tabs.get(sale.tabId);
      if (tab === undefined || tab.deletedAt !== undefined || tab.status !== 'open') {
        throw new AppError('TAB_NOT_OPEN', 'That tab is no longer open');
      }
    }
    if (sale.kind === 'deposit') await requireOpenBooking(db, sale.bookingId);
    if (sale.kind === 'sale' && sale.depositAppliedPence > 0) {
      const booking = await requireOpenBooking(db, sale.bookingId);
      const balance = depositBalance(await salesOfBooking(db, booking.id));
      if (sale.depositAppliedPence > balance) {
        throw new AppError('DEPOSIT_EXCEEDS_BALANCE', "The deposit applied is more than the booking's remaining balance");
      }
    }
    if (sale.kind === 'refund') await checkRefundAvailable(db, sale);

    // 3. Receipt number (D-059).
    const next = settings.receiptCounter + 1;
    const receiptNumber = `${settings.devicePrefix}-${String(next).padStart(6, '0')}`;
    const updatedSettings: Settings = { ...settings, receiptCounter: next, updatedAt: at };

    // 4. The sale.
    const stored = {
      ...withoutKeys(sale, SALE_OWNED_KEYS),
      id: env.newId(),
      deviceId: settings.deviceId,
      createdAt: at,
      updatedAt: at,
      periodId: period.id,
      receiptNumber,
    } as Sale;
    await db.sales.add(stored);

    // 5. Stock movements.
    const movements: StockMovement[] = [];
    for (const movementInput of input.stockMovements) {
      const movement = {
        ...withoutKeys(movementInput, MOVEMENT_OWNED_KEYS),
        saleId: stored.id,
        staffId: stored.staffId,
        id: env.newId(),
        deviceId: settings.deviceId,
        createdAt: at,
        updatedAt: at,
      } as StockMovement;
      await db.stockMovements.add(movement);
      movements.push(movement);
    }

    await db.settings.put(updatedSettings);

    // 6. Tab settlement.
    let settledTab: Tab | undefined;
    if (tab !== undefined) {
      settledTab = {
        ...tab,
        status: 'settled',
        lines: stored.lines.map((line) => ({ productId: line.productId, qty: line.qty })),
        updatedAt: at,
      };
      await db.tabs.put(settledTab);
    }

    // 7. Draft.
    if (input.clearDraft) await db.draft.delete(DRAFT_KEY);

    // 8. Outbox: one entry per record written.
    await appendOutbox(env, 'sales', 'create', stored, at);
    for (const movement of movements) await appendOutbox(env, 'stockMovements', 'create', movement, at);
    await appendOutbox(env, 'settings', 'update', updatedSettings, at);
    if (settledTab !== undefined) await appendOutbox(env, 'tabs', 'update', settledTab, at);

    if (env.failSaleCommitAfterWrites) {
      throw new AppError('FORCED_FAILURE', 'Forced failure after every sale write (test hook)');
    }
    return stored;
  });
}

/** Synced tables by createdAt, then id (D-119); the outbox in seq order (its primary key). */
function exportAll(env: AdapterEnv): Promise<BackupTables> {
  const { db } = env;
  const ordered = async <T extends { createdAt: string; id: string }>(rows: Promise<T[]>): Promise<T[]> => (await rows).sort(byCreatedAtThenId);
  return ro(env, BACKUP_STORES, async () => ({
    staff: await ordered(db.staff.toArray()),
    categories: await ordered(db.categories.toArray()),
    products: await ordered(db.products.toArray()),
    deals: await ordered(db.deals.toArray()),
    members: await ordered(db.members.toArray()),
    bookings: await ordered(db.bookings.toArray()),
    tabs: await ordered(db.tabs.toArray()),
    sales: await ordered(db.sales.toArray()),
    stockMovements: await ordered(db.stockMovements.toArray()),
    periods: await ordered(db.periods.toArray()),
    auditEvents: await ordered(db.auditEvents.toArray()),
    settings: await ordered(db.settings.toArray()),
    outbox: await db.outbox.toArray(),
  }));
}

function importAll(env: AdapterEnv, tables: BackupTables, options?: ImportOptions): Promise<void> {
  const { db } = env;
  const at = env.nowIso();
  return rw(env, ALL_STORES, async () => {
    for (const store of ALL_STORES) await db.table(store).clear();
    for (const entity of ENTITY_NAMES) {
      const rows: readonly SyncedRecord[] = tables[entity];
      if (rows.length > 0) await db.table(entity).bulkAdd(rows);
    }
    if (tables.outbox.length > 0) await db.outbox.bulkAdd(tables.outbox);
    const events = options?.auditEvents ?? [];
    if (events.length > 0) {
      const settings = await requireSettings(db);
      await addAuditEvents(env, settings.deviceId, events, at);
    }
  });
}

/** Builds the Repos implementation over an open database. */
export function buildRepos(env: AdapterEnv): Repos {
  return {
    staff: editableRepo(env, 'staff'),
    categories: editableRepo(env, 'categories'),
    products: editableRepo(env, 'products'),
    deals: editableRepo(env, 'deals'),
    members: memberRepo(env),
    bookings: editableRepo(env, 'bookings'),
    tabs: tabRepo(env),
    sales: saleRepo(env),
    stockMovements: stockMovementRepo(env),
    periods: periodRepo(env),
    auditEvents: auditEventRepo(env),
    settings: settingsRepo(env),
    outbox: outboxRepo(env),
    draft: draftRepo(env),
    initialise: (input) => initialise(env, input),
    commitSale: (input) => commitSale(env, input),
    transact: (work) => guard(env.db.transaction('rw', ALL_STORES, async () => work())),
    exportAll: () => exportAll(env),
    importAll: (tables, options) => importAll(env, tables, options),
    close: () => {
      env.db.close();
      return Promise.resolve();
    },
  };
}
