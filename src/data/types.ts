/**
 * Entity and value types shared by every data adapter, the rules and the services.
 *
 * Source of truth: docs/design-spec.md §4, refined by docs/decisions.md
 * (records: D-048..D-056; model additions: D-055).
 *
 * Conventions (binding):
 * - Money is integer pence (`Pence`), never floats (D-001).
 * - Instants are ISO-8601 UTC strings from Date#toISOString() (`IsoInstant`, D-049).
 * - Optional fields are OMITTED when absent. They are never stored as null or as an
 *   undefined-valued key (D-050). The only stored null is OutboxEntry.syncedAt.
 * - Arrays embedded in a record keep meaningful order (D-052).
 * - No enums: string-literal unions only.
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** ISO-8601 UTC instant, always 24 chars: 'YYYY-MM-DDTHH:mm:ss.sssZ' (D-049). */
export type IsoInstant = string;

/** A Europe/London calendar date 'YYYY-MM-DD' (not an instant) (D-102). */
export type LocalDate = string;

/** Integer number of pence. Must satisfy Number.isSafeInteger and never be -0 (D-001, D-003). */
export type Pence = number;

/** Whole-number VAT percentage 0..100 (the back office offers 20, 5 and 0) (D-022). */
export type VatRate = number;

// ---------------------------------------------------------------------------
// Roles and permission actions (spec §5, D-069)
// Defined here because they are persisted (Staff.role, override audit detail);
// src/rules/permissions.ts re-exports them and owns the matrix.
// ---------------------------------------------------------------------------

export type Role = 'staff' | 'supervisor' | 'manager';

/** One identifier per row of the spec §5 permission matrix, in matrix order (D-069). */
export type Action =
  | 'sell'
  | 'tabs'
  | 'attachMember'
  | 'bookings'
  | 'voidLine'
  | 'noSale'
  | 'xRead'
  | 'refund'
  | 'openClosePeriod'
  | 'editCatalogue'
  | 'stockControl'
  | 'manageMembersStaffSettings'
  | 'salesReports'
  | 'backup';

// ---------------------------------------------------------------------------
// Base records (D-048, D-051)
// ---------------------------------------------------------------------------

/** Fields every synced record carries. The data layer generates all four (D-048). */
export interface BaseRecord {
  /** crypto.randomUUID() (lowercase UUID v4). */
  id: string;
  /** Settings.deviceId of the device that created the record. Never changes. */
  deviceId: string;
  createdAt: IsoInstant;
  /** Equals createdAt on create; bumped on every update. Append-only rows never change it. */
  updatedAt: IsoInstant;
}

/** Editable records may be soft-deleted (D-051). */
export interface EditableRecord extends BaseRecord {
  deletedAt?: IsoInstant;
}

/** Keys the data layer owns; create inputs omit them. */
export type BaseKeys = 'id' | 'deviceId' | 'createdAt' | 'updatedAt';

/** Create input for an entity: the record without its base fields (and without deletedAt: nothing is created deleted). */
export type NewRecord<T extends BaseRecord> = Omit<T, BaseKeys | 'deletedAt'>;

/**
 * Update input for an editable entity. Keys present are merged; a key present with the
 * value `undefined` REMOVES that optional field from the stored record (D-050).
 * deletedAt is changed only through softDelete().
 */
export type Patch<T extends EditableRecord> = Partial<Omit<T, BaseKeys | 'deletedAt'>>;

// ---------------------------------------------------------------------------
// Editable entities (spec §4)
// ---------------------------------------------------------------------------

export interface Staff extends EditableRecord {
  name: string;
  role: Role;
  /** 64-char lowercase hex of the 32-byte PBKDF2 output (D-073). Never leaves the data/services layer. */
  pinHash: string;
  /** 32-char lowercase hex of the 16-byte random salt (D-073). */
  pinSalt: string;
  active: boolean;
}

export interface Category extends EditableRecord {
  name: string;
  sortOrder: number;
  /** '#rrggbb' */
  colour: string;
}

export interface Product extends EditableRecord {
  name: string;
  categoryId: string;
  /** VAT-inclusive unit price, 0..999999 (D-001). */
  pricePence: Pence;
  vatRate: VatRate;
  memberDiscountEligible: boolean;
  stockTracked: boolean;
  /** e.g. 'pint', 'bottle' */
  stockUnit: string;
  /** 0..9999; 0 for untracked products (D-082). */
  lowStockLevel: number;
  /** '#rrggbb' */
  buttonColour: string;
  sortOrder: number;
  active: boolean;
}

export type DealType = 'nForPrice' | 'nForM';

/**
 * A multi-buy deal (spec §4, D-012..D-018). Flat shape: `pricePence` is present only for
 * 'nForPrice' and `m` only for 'nForM' (validated by rules/validation.ts, D-013).
 */
export interface Deal extends EditableRecord {
  name: string;
  type: DealType;
  /** Group size, integer 2..99. */
  n: number;
  /** nForPrice only: price of a group of n, 1..999999. */
  pricePence?: Pence;
  /** nForM only: units paid for in a group, 1..n-1. */
  m?: number;
  /** Distinct product ids, at least one. Order is not significant. */
  productIds: string[];
  active: boolean;
  /** Inclusive start instant (London midnight of the chosen start date) (D-012). */
  startsAt?: IsoInstant;
  /** Exclusive end instant (London midnight after the chosen end date) (D-012). */
  endsAt?: IsoInstant;
}

export interface Member extends EditableRecord {
  /** 1..12 chars of [A-Z0-9-], stored upper-cased, unique among non-deleted members. */
  memberNumber: string;
  firstName: string;
  lastName: string;
  active: boolean;
}

export type BookingType = 'wedding' | 'society' | 'eventTicket' | 'other';
export type BookingStatus = 'open' | 'settled' | 'cancelled';

export interface Booking extends EditableRecord {
  type: BookingType;
  name: string;
  /** Event date (local calendar date, not an instant). */
  date: LocalDate;
  /** '' when empty (never omitted). */
  notes: string;
  status: BookingStatus;
}

export type TabLabelType = 'name' | 'table';
export type TabStatus = 'open' | 'settled';

/** A basket / tab / draft line. Unpriced: priced from the product record when needed (D-008, D-062). */
export interface TabLine {
  productId: string;
  /** Integer 1..999. */
  qty: number;
}

/** Basket lines have the same shape as tab lines (D-008). */
export type BasketLine = TabLine;

export interface Tab extends EditableRecord {
  labelType: TabLabelType;
  /** Normalised label (trimmed, whitespace collapsed) (D-064). */
  label: string;
  openedAt: IsoInstant;
  /** Staff id of whoever opened it. */
  openedBy: string;
  status: TabStatus;
  /** Unique by productId, basket order. */
  lines: TabLine[];
  memberId?: string;
}

export interface Period extends EditableRecord {
  openedAt: IsoInstant;
  openedBy: string;
  /** 0..9999999 */
  floatPence: Pence;
  closedAt?: IsoInstant;
  closedBy?: string;
  declaredCashPence?: Pence;
  /** Assigned at Z close: 1 + max zNumber of this device's periods (D-061). */
  zNumber?: number;
}

/** Exactly one row per device database; id === deviceId (D-057). */
export interface Settings extends EditableRecord {
  clubName: string;
  /** 0..200 chars; newlines allowed; '' when empty. */
  receiptFooter: string;
  /** Integer 1..60, default 5. */
  autoLockMinutes: number;
  /** Integer 0..100, default 15. */
  memberDiscountPercent: number;
  lastBackupAt?: IsoInstant;
  /** /^[A-Z0-9]{1,6}$/, default first 4 chars of deviceId upper-cased (D-058). */
  devicePrefix: string;
  /** Last receipt number issued on this device; starts at 0 (D-059). */
  receiptCounter: number;
  // deviceId is inherited from BaseRecord and equals id.
}

// ---------------------------------------------------------------------------
// Append-only entities (D-051)
// ---------------------------------------------------------------------------

export type SaleKind = 'sale' | 'deposit' | 'refund';
export type TenderType = 'cash' | 'card';

export interface Tender {
  type: TenderType;
  /** > 0 on sales and deposits; < 0 on refunds (D-032). */
  amountPence: Pence;
}

/**
 * A priced, snapshotted sale line (spec §4 SaleLine). Net is derived (finalPence - vatPence),
 * never stored. Refund lines carry negated money and negative qty (D-037).
 */
export interface SaleLine {
  productId: string;
  nameAtSale: string;
  /** > 0 on sales, < 0 on refunds. */
  qty: number;
  /** Always positive: the unit price at sale time. */
  unitPricePence: Pence;
  vatRate: VatRate;
  dealDiscountPence: Pence;
  memberDiscountPence: Pence;
  /** qty * unitPricePence - dealDiscountPence - memberDiscountPence */
  finalPence: Pence;
  vatPence: Pence;
  /** Refund lines only: index of the original sale line being refunded (D-036, D-055). */
  refundOfLineIndex?: number;
  /** Refund lines only: true = return to stock, false = waste (D-039, D-055). */
  returnToStock?: boolean;
}

/** One entry per deal applied at least once, in canonical deal order (D-017, D-055). */
export interface SaleDealLine {
  dealId: string;
  /** Deal name snapshot. */
  name: string;
  /** Number of applied groups (>= 1). */
  groupCount: number;
  /** Positive total saving; sums to the lines' dealDiscountPence. */
  savingPence: Pence;
}

export interface Sale extends BaseRecord {
  /** `${devicePrefix}-${String(n).padStart(6, '0')}` (D-059). Unique. */
  receiptNumber: string;
  /** The period open at commit time, set by the data layer (D-040, D-056). */
  periodId: string;
  /** The logged-in user who completed it (D-072). */
  staffId: string;
  kind: SaleKind;
  memberId?: string;
  bookingId?: string;
  tabId?: string;
  refundOfSaleId?: string;
  /** Unique by productId for kind 'sale'; [] for deposits. */
  lines: SaleLine[];
  /** [] for deposits and refunds (D-017). */
  dealLines: SaleDealLine[];
  /** Sum of line memberDiscountPence (<= 0 on refunds). */
  memberDiscountPence: Pence;
  /** 0 except on kind 'sale' with a booking (D-023). */
  depositAppliedPence: Pence;
  /** sale: sum(finals) - depositApplied; deposit: amount; refund: sum(finals) <= 0. */
  totalPence: Pence;
  /** In the order taken; never merged (D-029). */
  tenders: Tender[];
  /** >= 0; always 0 on refunds. */
  changePence: Pence;
}

export type StockReason = 'sale' | 'refund' | 'goodsIn' | 'adjustment' | 'waste';

export interface StockMovement extends BaseRecord {
  productId: string;
  /** Signed integer (+ in, - out). */
  qty: number;
  reason: StockReason;
  saleId?: string;
  staffId: string;
  /** '' when empty (never omitted). */
  note: string;
}

// ---------------------------------------------------------------------------
// Audit events (spec §4, D-083, D-084)
// ---------------------------------------------------------------------------

export interface VoidAuditDetail {
  productId: string;
  productName: string;
  /** Units removed: positive integer. */
  qty: number;
  /** Current product price at the time of the void. */
  unitPricePence: Pence;
  /** Set when the line came from a loaded tab. */
  tabId?: string;
}

export interface RefundAuditDetail {
  refundSaleId: string;
  refundReceiptNumber: string;
  originalSaleId: string;
  originalReceiptNumber: string;
  /** Negative (or 0). */
  totalPence: Pence;
  /** The tender type the manager chose (recorded even when the total is 0). */
  tender: TenderType;
  lines: { productId: string; /** positive units */ qty: number; returnToStock: boolean }[];
}

export interface PriceChangeAuditDetail {
  productId: string;
  /** Name after the save. */
  productName: string;
  oldPricePence: Pence;
  newPricePence: Pence;
}

export interface OverrideAuditDetail {
  action: Action;
}

export interface StockAdjustAuditDetail {
  stockMovementId: string;
  productId: string;
  productName: string;
  /** Signed, as stored on the movement. */
  qty: number;
  reason: 'adjustment' | 'waste';
  note: string;
}

export interface ZCloseAuditDetail {
  zNumber: number;
  floatPence: Pence;
  expectedCashPence: Pence;
  declaredCashPence: Pence;
  /** declared - expected (negative = short). */
  variancePence: Pence;
}

export interface BackupExportAuditDetail {
  exportedAt: IsoInstant;
}

export interface BackupImportAuditDetail {
  fileExportedAt: IsoInstant;
  fileDeviceId: string;
  /** The importer may not exist in the imported staff table. */
  importedByName: string;
}

/** detail shape for each audit type (D-084). */
export interface AuditDetailByType {
  void: VoidAuditDetail;
  noSale: Record<string, never>;
  refund: RefundAuditDetail;
  priceChange: PriceChangeAuditDetail;
  override: OverrideAuditDetail;
  stockAdjust: StockAdjustAuditDetail;
  zClose: ZCloseAuditDetail;
  backupExport: BackupExportAuditDetail;
  backupImport: BackupImportAuditDetail;
}

export type AuditEventType = keyof AuditDetailByType;

export interface AuditEventOf<T extends AuditEventType> extends BaseRecord {
  type: T;
  /** The requester: the logged-in user (D-072). */
  staffId: string;
  /** The approver when the action was approved by PIN override. */
  approvedById?: string;
  /** Period the event belongs to; omitted when no period is open (D-083). */
  periodId?: string;
  detail: AuditDetailByType[T];
}

/** Discriminated union of every audit event. */
export type AuditEvent = { [T in AuditEventType]: AuditEventOf<T> }[AuditEventType];

/** Create input for an audit event (discriminated). */
export type NewAuditEvent = { [T in AuditEventType]: Omit<AuditEventOf<T>, BaseKeys> }[AuditEventType];

// ---------------------------------------------------------------------------
// Entity map, outbox, draft, backup (D-053, D-054, D-088, D-094)
// ---------------------------------------------------------------------------

/** Synced tables, keyed by table/entity name. */
export interface EntityMap {
  staff: Staff;
  categories: Category;
  products: Product;
  deals: Deal;
  members: Member;
  bookings: Booking;
  tabs: Tab;
  sales: Sale;
  stockMovements: StockMovement;
  periods: Period;
  auditEvents: AuditEvent;
  settings: Settings;
}

export type EntityName = keyof EntityMap;

/** Every synced record type. */
export type SyncedRecord = EntityMap[EntityName];

/** Table names in a fixed order (backup files, Dexie schema, tests). */
export const ENTITY_NAMES = [
  'staff',
  'categories',
  'products',
  'deals',
  'members',
  'bookings',
  'tabs',
  'sales',
  'stockMovements',
  'periods',
  'auditEvents',
  'settings',
] as const satisfies readonly EntityName[];

/** Entities that are append-only: create + read only (D-051). */
export const APPEND_ONLY_ENTITIES = ['sales', 'stockMovements', 'auditEvents'] as const satisfies readonly EntityName[];

/** 'delete' is used exactly when a write sets deletedAt (D-054). */
export type OutboxOperation = 'create' | 'update' | 'delete';

/** One entry per record written to a synced table, in the same transaction (D-053, D-054). */
export interface OutboxEntry {
  /** Auto-increment primary key (Dexie '++seq'); defines push order. */
  seq: number;
  /** UUID v4. */
  id: string;
  entity: EntityName;
  entityId: string;
  operation: OutboxOperation;
  /** Full snapshot of the record exactly as stored after the write. */
  payload: SyncedRecord;
  /** The write's instant. */
  createdAt: IsoInstant;
  /** null until a future sync adapter pushes it. */
  syncedAt: IsoInstant | null;
}

/** The single device-local draft basket row (D-094, D-095). Not synced, not backed up. */
export interface Draft {
  id: 'current';
  lines: BasketLine[];
  memberId?: string;
  bookingId?: string;
  tabId?: string;
  updatedAt: IsoInstant;
}

/** Dexie database name and schema version (D-088, D-116). */
export const DB_NAME = 'club-epos';
export const SCHEMA_VERSION = 1;
export const BACKUP_FORMAT = 'club-epos-backup';

/** Every row of every synced table, plus the outbox (D-088). The draft is excluded. */
export type BackupTables = { [K in EntityName]: EntityMap[K][] } & { outbox: OutboxEntry[] };

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof SCHEMA_VERSION;
  exportedAt: IsoInstant;
  deviceId: string;
  tables: BackupTables;
}

// ---------------------------------------------------------------------------
// Convenience create-input aliases
// ---------------------------------------------------------------------------

export type NewStaff = NewRecord<Staff>;
export type NewCategory = NewRecord<Category>;
export type NewProduct = NewRecord<Product>;
export type NewDeal = NewRecord<Deal>;
export type NewMember = NewRecord<Member>;
export type NewBooking = NewRecord<Booking>;
export type NewTab = NewRecord<Tab>;
export type NewStockMovement = NewRecord<StockMovement>;

/**
 * A sale as built by the services before commit. The data layer adds id, deviceId,
 * createdAt, updatedAt, periodId and receiptNumber inside the commit transaction (D-056).
 */
export type NewSale = Omit<Sale, BaseKeys | 'periodId' | 'receiptNumber'>;

/**
 * A stock movement written by commitSale. saleId and staffId are filled from the sale
 * by the data layer (D-056, D-079, D-039).
 */
export type SaleStockMovementInput = Pick<StockMovement, 'productId' | 'qty' | 'reason' | 'note'>;
