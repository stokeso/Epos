/**
 * Repository interfaces: the only way anything outside src/data/local/ touches storage
 * (spec §3, §3.2). The LocalAdapter (src/data/local/) implements them over Dexie. A future
 * SupabaseAdapter must implement the same interfaces and pass tests/data/contract.ts.
 *
 * Binding decisions: D-048..D-056 (records, outbox, transactions), D-059 (receipt numbers),
 * D-061 (Z numbers), D-067 (periods), D-082 (stock queries), D-088..D-092 (backup), D-094 (draft).
 *
 * General contract for every method:
 * - Every write stamps base fields from the adapter's clock (one read per call) and appends
 *   exactly one OutboxEntry per record written, in the same transaction (D-053).
 * - Returned records are the stored records (no undefined-valued keys, D-050).
 * - list() methods exclude soft-deleted rows unless `includeDeleted` is set; get() returns
 *   soft-deleted rows too, so history always resolves (D-051).
 * - list() ordering is unspecified unless stated; callers sort.
 * - Failures throw AppError (src/data/errors.ts).
 */
import type {
  AuditEvent,
  AuditEventType,
  BackupTables,
  Booking,
  BasketLine,
  Category,
  Deal,
  Draft,
  EditableRecord,
  IsoInstant,
  Member,
  NewAuditEvent,
  NewRecord,
  NewSale,
  NewStaff,
  NewStockMovement,
  OutboxEntry,
  Patch,
  Pence,
  Period,
  Product,
  Sale,
  SaleStockMovementInput,
  Settings,
  Staff,
  StockMovement,
  Tab,
} from './types';

// ---------------------------------------------------------------------------
// Generic shapes
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Include soft-deleted rows (default false). */
  includeDeleted?: boolean;
}

/** CRUD for an editable entity (D-051). There is no hard delete. */
export interface EditableRepo<T extends EditableRecord> {
  /** Returns the record even when soft-deleted; undefined when the id is unknown. */
  get(id: string): Promise<T | undefined>;
  list(options?: ListOptions): Promise<T[]>;
  /** Generates id/deviceId/createdAt/updatedAt; outbox 'create'. */
  create(input: NewRecord<T>): Promise<T>;
  /**
   * Merges the patch (undefined-valued keys remove the field, D-050), bumps updatedAt;
   * outbox 'update'. Throws NOT_FOUND for an unknown id.
   */
  update(id: string, patch: Patch<T>): Promise<T>;
  /** Sets deletedAt = updatedAt = now; outbox 'delete' with the full record. Throws NOT_FOUND. */
  softDelete(id: string): Promise<T>;
}

// ---------------------------------------------------------------------------
// Editable entity repositories
// ---------------------------------------------------------------------------

export type StaffRepo = EditableRepo<Staff>;
export type CategoryRepo = EditableRepo<Category>;
export type ProductRepo = EditableRepo<Product>;
export type DealRepo = EditableRepo<Deal>;

export interface MemberRepo extends EditableRepo<Member> {
  /** Exact match on the stored (upper-cased) memberNumber among non-deleted members. */
  findByNumber(memberNumber: string): Promise<Member | undefined>;
}

export type BookingRepo = EditableRepo<Booking>;

export interface TabRepo extends EditableRepo<Tab> {
  /** Non-deleted tabs with status 'open', sorted by openedAt ascending (D-064). */
  listOpen(): Promise<Tab[]>;
}

// ---------------------------------------------------------------------------
// Append-only repositories: NO update or delete methods (spec §3.2, D-051)
// ---------------------------------------------------------------------------

/** Sales are created only through Repos.commitSale (D-056). */
export interface SaleRepo {
  get(id: string): Promise<Sale | undefined>;
  /** Exact match on the unique receiptNumber index (D-035). */
  getByReceiptNumber(receiptNumber: string): Promise<Sale | undefined>;
  /** Every sale of any kind with this periodId (D-040). */
  listByPeriod(periodId: string): Promise<Sale[]>;
  /** Sales with fromInclusive <= createdAt < toExclusive (string comparison, D-049, D-103). */
  listByDateRange(fromInclusive: IsoInstant, toExclusive: IsoInstant): Promise<Sale[]>;
  /** Every sale (any kind) with this bookingId. */
  listByBooking(bookingId: string): Promise<Sale[]>;
  /** Kind 'refund' sales whose refundOfSaleId === saleId, in createdAt order. */
  listRefundsOf(saleId: string): Promise<Sale[]>;
  /**
   * Unused deposit balance (D-025): sum of totalPence of kind 'deposit' sales with this
   * bookingId, minus sum of depositAppliedPence of kind 'sale' sales with this bookingId.
   */
  bookingBalance(bookingId: string): Promise<Pence>;
  list(): Promise<Sale[]>;
}

/** A product with its derived on-hand stock. */
export interface StockLevel {
  product: Product;
  onHand: number;
}

export interface StockMovementRepo {
  /**
   * Appends one movement (goods in, adjustment, manual waste). Sale and refund movements are
   * written by commitSale instead. Outbox 'create'. Re-adding an existing id is impossible
   * through this API; the adapter uses add(), never put() (D-115).
   */
  add(input: NewStockMovement): Promise<StockMovement>;
  get(id: string): Promise<StockMovement | undefined>;
  listByProduct(productId: string): Promise<StockMovement[]>;
  listBySale(saleId: string): Promise<StockMovement[]>;
  list(): Promise<StockMovement[]>;
  /** Sum of qty over the product's movements (spec §3.2, D-082). 0 when none. */
  onHand(productId: string): Promise<number>;
  /** productId -> on hand, for every product that has at least one movement. */
  onHandByProduct(): Promise<Record<string, number>>;
  /**
   * The low-stock list (D-082): products that are stockTracked, active and not deleted with
   * onHand <= lowStockLevel (negative stock always included), sorted by
   * (onHand - lowStockLevel) ascending, then name (localeCompare 'en-GB'), then id.
   */
  lowStock(): Promise<StockLevel[]>;
}

export interface AuditEventRepo {
  /** Appends events in order, one outbox 'create' each. */
  append(events: readonly NewAuditEvent[]): Promise<AuditEvent[]>;
  listByPeriod(periodId: string): Promise<AuditEvent[]>;
  listByType(type: AuditEventType): Promise<AuditEvent[]>;
  list(): Promise<AuditEvent[]>;
}

// ---------------------------------------------------------------------------
// Periods (D-061, D-067, D-047)
// ---------------------------------------------------------------------------

export interface OpenPeriodInput {
  openedBy: string;
  floatPence: Pence;
}

export interface ClosePeriodInput {
  periodId: string;
  closedBy: string;
  declaredCashPence: Pence;
}

export interface PeriodRepo {
  get(id: string): Promise<Period | undefined>;
  list(options?: ListOptions): Promise<Period[]>;
  /** The period with deviceId === Settings.deviceId and no closedAt, if any (D-067). */
  getOpen(): Promise<Period | undefined>;
  /**
   * Creates Period { openedAt: now, openedBy, floatPence } after checking, inside the same
   * transaction, that no period is open (else PERIOD_ALREADY_OPEN). Outbox 'create'.
   */
  open(input: OpenPeriodInput): Promise<Period>;
  /**
   * Closes the open period: sets closedAt = now, closedBy, declaredCashPence and
   * zNumber = 1 + max zNumber over this device's periods (1 if none) (D-061). Throws
   * NO_OPEN_PERIOD if periodId is not the open period. Outbox 'update'.
   */
  close(input: ClosePeriodInput): Promise<Period>;
}

// ---------------------------------------------------------------------------
// Settings, outbox, draft
// ---------------------------------------------------------------------------

/** Fields a settings update may change. receiptCounter changes only inside commitSale (D-059). */
export type SettingsPatch = Partial<
  Pick<Settings, 'clubName' | 'receiptFooter' | 'autoLockMinutes' | 'memberDiscountPercent' | 'devicePrefix' | 'lastBackupAt'>
>;

export interface SettingsRepo {
  /** The single Settings row, or undefined before first-run setup (D-057). */
  get(): Promise<Settings | undefined>;
  /** Throws NOT_INITIALISED before setup. Outbox 'update'. */
  update(patch: SettingsPatch): Promise<Settings>;
}

export interface OutboxRepo {
  /** All entries in seq order. */
  list(): Promise<OutboxEntry[]>;
  count(): Promise<number>;
  /** Entries with syncedAt === null, in seq order. */
  listUnsynced(): Promise<OutboxEntry[]>;
}

/** Draft basket contents without the fixed key and timestamp. */
export interface DraftContent {
  lines: BasketLine[];
  memberId?: string;
  bookingId?: string;
  tabId?: string;
}

/** Device-local draft basket (D-094). Writes no outbox entries. */
export interface DraftRepo {
  get(): Promise<Draft | undefined>;
  /** Upserts the single row with id 'current' and updatedAt = now. */
  save(content: DraftContent): Promise<Draft>;
  /** Deletes the row (no-op if absent). */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Atomic operations
// ---------------------------------------------------------------------------

/** First-run input (D-111). Settings fields the data layer does not derive. */
export interface InitialiseInput {
  settings: Pick<Settings, 'clubName' | 'receiptFooter' | 'autoLockMinutes' | 'memberDiscountPercent'>;
  manager: NewStaff;
}

export interface InitialiseResult {
  settings: Settings;
  manager: Staff;
}

/**
 * Input to commitSale (D-056). The services have already priced the sale, validated it with
 * rules/sale.validateSale and computed its stock movements with rules/stock.ts.
 */
export interface CommitSaleInput {
  sale: NewSale;
  /** Written with saleId = the new sale's id and staffId = sale.staffId. */
  stockMovements: readonly SaleStockMovementInput[];
  /** Delete the draft row in the same transaction (true for kind 'sale'; D-095). */
  clearDraft: boolean;
}

export interface ImportOptions {
  /**
   * Appended (each with its own outbox entry) in the same transaction, after the restore
   * (D-090, D-092): the backupImport event, preceded by the override event when overridden.
   */
  auditEvents?: readonly NewAuditEvent[];
}

/** Aggregate data store handed to the services (via ServiceContext). */
export interface Repos {
  readonly staff: StaffRepo;
  readonly categories: CategoryRepo;
  readonly products: ProductRepo;
  readonly deals: DealRepo;
  readonly members: MemberRepo;
  readonly bookings: BookingRepo;
  readonly tabs: TabRepo;
  readonly sales: SaleRepo;
  readonly stockMovements: StockMovementRepo;
  readonly periods: PeriodRepo;
  readonly auditEvents: AuditEventRepo;
  readonly settings: SettingsRepo;
  readonly outbox: OutboxRepo;
  readonly draft: DraftRepo;

  /**
   * First-run transaction 1 (D-111, D-057). If no Settings row exists: generates
   * deviceId = newId(), creates Settings { id: deviceId, deviceId, devicePrefix: first 4 chars
   * of deviceId upper-cased, receiptCounter: 0, ...input.settings } and then the manager Staff
   * (stamped with that deviceId). If a Settings row exists, updates clubName instead.
   * One outbox entry per record written.
   */
  initialise(input: InitialiseInput): Promise<InitialiseResult>;

  /**
   * THE sale transaction (spec §8, D-056). One rw transaction over every table:
   *  1. Look up the open period (else NO_OPEN_PERIOD); sale.periodId = its id.
   *  2. Transactional re-checks:
   *     - tabId set: tab exists, not deleted, status 'open' (else TAB_NOT_OPEN).
   *     - kind 'deposit': booking exists with status 'open' (else BOOKING_NOT_OPEN).
   *     - kind 'sale' with depositAppliedPence > 0: booking 'open' (else BOOKING_NOT_OPEN) and
   *       depositAppliedPence <= bookingBalance (else DEPOSIT_EXCEEDS_BALANCE).
   *     - kind 'refund': original exists with kind 'sale' (else NOT_REFUNDABLE) and for every
   *       line, |qty| <= original line qty - already refunded for that refundOfLineIndex
   *       (else REFUND_EXCEEDS_AVAILABLE).
   *  3. next = settings.receiptCounter + 1; receiptNumber = `${devicePrefix}-${pad6(next)}`;
   *     settings.receiptCounter = next.
   *  4. Add the Sale (Dexie add; unique receiptNumber).
   *  5. Add the stock movements (saleId, staffId from the sale).
   *  6. tabId set: tab.status = 'settled', tab.lines = sale lines as {productId, qty}.
   *  7. clearDraft: delete the draft row.
   *  8. Outbox: one entry per record written (sale, each movement, settings, tab).
   * With AdapterOptions.failSaleCommitAfterWrites the adapter throws FORCED_FAILURE after
   * step 8, so nothing is left behind (D-115). May be called inside transact(); it then joins
   * the outer transaction.
   */
  commitSale(input: CommitSaleInput): Promise<Sale>;

  /**
   * Runs `work` in ONE read-write transaction over every table. Every repository call made
   * inside `work` joins it, and any throw rolls everything back (D-056).
   * CONSTRAINT: `work` may await ONLY repository calls. No crypto.subtle, fetch or timers, and no
   * other non-repository promise, or the transaction commits early. Do async prep (PIN hashing) before.
   */
  transact<T>(work: () => Promise<T>): Promise<T>;

  /**
   * Every row of every synced table plus the outbox, exactly as stored (D-092). Excludes draft.
   * Each synced table is ordered by createdAt, then id (D-119); the outbox by seq.
   */
  exportAll(): Promise<BackupTables>;

  /**
   * One transaction (D-090, D-092): clear all 13 tables and the draft, bulkAdd every row
   * verbatim (no outbox entries generated; the file's outbox rows are restored as-is), then
   * append options.auditEvents (if any) with their outbox entries, stamped with the IMPORTED
   * deviceId.
   * Does not touch lastBackupAt beyond restoring the file's value.
   */
  importAll(tables: BackupTables, options?: ImportOptions): Promise<void>;

  /** Closes the underlying database connection. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter factory (implemented in src/data/local/index.ts)
// ---------------------------------------------------------------------------

export interface AdapterOptions {
  /** Database name; default DB_NAME ('club-epos'). Tests use a unique name each. */
  dbName?: string;
  /** Clock; default () => new Date(). Read once per repository call (D-049, D-101). */
  now?: () => Date;
  /** Id generator; default () => crypto.randomUUID(). */
  newId?: () => string;
  /** Contract-suite hook: commitSale throws FORCED_FAILURE after all its writes (D-115). */
  failSaleCommitAfterWrites?: boolean;
}

/** Creates (opening or upgrading) a data store. */
export type RepoFactory = (options?: AdapterOptions) => Promise<Repos>;

/** Deletes a database by name (tests). Close the Repos first. */
export type DeleteDatabase = (dbName: string) => Promise<void>;
