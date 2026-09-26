/**
 * Backup file structure validation (spec §8, D-088, D-089). Pure: no storage access.
 * The audited export/import flows live in src/services/backup.ts.
 *
 * Every row shape below is typed as Shape<Entity>, so the compiler checks that each field of
 * each entity in types.ts is described exactly once and that optional fields are marked
 * optional. Adding a field to an entity without describing it here is a type error.
 */
import type {
  Action,
  AuditDetailByType,
  AuditEventOf,
  AuditEventType,
  BackupFile,
  Booking,
  BookingStatus,
  BookingType,
  Category,
  Deal,
  DealType,
  EntityName,
  Member,
  OutboxEntry,
  OutboxOperation,
  Period,
  Product,
  Role,
  Sale,
  SaleDealLine,
  SaleKind,
  SaleLine,
  Settings,
  Staff,
  StockMovement,
  StockReason,
  Tab,
  TabLabelType,
  TabLine,
  TabStatus,
  Tender,
  TenderType,
} from './types';
import { BACKUP_FORMAT, ENTITY_NAMES, SCHEMA_VERSION } from './types';

/** Files above this size are rejected before parsing (D-089). */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

/** At most this many problems are reported (D-089). */
export const MAX_BACKUP_PROBLEMS = 10;

export type BackupValidation = { ok: true; file: BackupFile } | { ok: false; problems: string[] };

export const BACKUP_TOO_LARGE_MESSAGE = 'The file is larger than 50 MB';
export const BACKUP_NOT_JSON_MESSAGE = 'The file is not valid JSON';
export const BACKUP_NOT_OBJECT_MESSAGE = 'The file is not a Club EPOS backup (expected a JSON object)';
export const BACKUP_WRONG_FORMAT_MESSAGE = 'The file is not a Club EPOS backup';
export const BACKUP_WRONG_VERSION_MESSAGE = 'This backup was made by a different version';
export const BACKUP_NO_MANAGER_MESSAGE = 'The backup has no active manager';

// ---------------------------------------------------------------------------
// Field descriptions
// ---------------------------------------------------------------------------

type FieldType =
  | { readonly kind: 'string' }
  | { readonly kind: 'uuid' }
  | { readonly kind: 'instant' }
  | { readonly kind: 'instantOrNull' }
  | { readonly kind: 'localDate' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'array'; readonly of: FieldType }
  | { readonly kind: 'object'; readonly shape: AnyShape }
  | { readonly kind: 'record' }
  | { readonly kind: 'auditDetail' };

interface RequiredField {
  readonly type: FieldType;
  readonly optional?: false;
}

interface OptionalField {
  readonly type: FieldType;
  readonly optional: true;
}

type AnyField = RequiredField | OptionalField;
type AnyShape = Readonly<Record<string, AnyField>>;

/** One field description per key of T; optional keys of T must be marked optional. */
type Shape<T> = { readonly [K in keyof T]-?: object extends Pick<T, K> ? OptionalField : RequiredField };

const STRING: FieldType = { kind: 'string' };
const UUID: FieldType = { kind: 'uuid' };
const INSTANT: FieldType = { kind: 'instant' };
const INTEGER: FieldType = { kind: 'integer' };
const BOOLEAN: FieldType = { kind: 'boolean' };

/** Builds an enum type from a complete record of its values (the compiler checks completeness). */
function oneOf<T extends string>(values: Record<T, true>): FieldType {
  return { kind: 'enum', values: Object.keys(values) };
}
function arrayOf(of: FieldType): FieldType {
  return { kind: 'array', of };
}
function object(shape: AnyShape): FieldType {
  return { kind: 'object', shape };
}
function req(type: FieldType): RequiredField {
  return { type };
}
function opt(type: FieldType): OptionalField {
  return { type, optional: true };
}

const ROLE = oneOf<Role>({ staff: true, supervisor: true, manager: true });
const ACTION = oneOf<Action>({
  sell: true,
  tabs: true,
  attachMember: true,
  bookings: true,
  voidLine: true,
  noSale: true,
  xRead: true,
  refund: true,
  openClosePeriod: true,
  editCatalogue: true,
  stockControl: true,
  manageMembersStaffSettings: true,
  salesReports: true,
  backup: true,
});
const DEAL_TYPE = oneOf<DealType>({ nForPrice: true, nForM: true });
const BOOKING_TYPE = oneOf<BookingType>({ wedding: true, society: true, eventTicket: true, other: true });
const BOOKING_STATUS = oneOf<BookingStatus>({ open: true, settled: true, cancelled: true });
const TAB_LABEL_TYPE = oneOf<TabLabelType>({ name: true, table: true });
const TAB_STATUS = oneOf<TabStatus>({ open: true, settled: true });
const SALE_KIND = oneOf<SaleKind>({ sale: true, deposit: true, refund: true });
const TENDER_TYPE = oneOf<TenderType>({ cash: true, card: true });
const STOCK_REASON = oneOf<StockReason>({ sale: true, refund: true, goodsIn: true, adjustment: true, waste: true });
const AUDIT_TYPE = oneOf<AuditEventType>({
  void: true,
  noSale: true,
  refund: true,
  priceChange: true,
  override: true,
  stockAdjust: true,
  zClose: true,
  backupExport: true,
  backupImport: true,
});
const ENTITY = oneOf<EntityName>({
  staff: true,
  categories: true,
  products: true,
  deals: true,
  members: true,
  bookings: true,
  tabs: true,
  sales: true,
  stockMovements: true,
  periods: true,
  auditEvents: true,
  settings: true,
});
const OPERATION = oneOf<OutboxOperation>({ create: true, update: true, delete: true });

// ---------------------------------------------------------------------------
// Row shapes (types.ts)
// ---------------------------------------------------------------------------

const BASE = { id: req(UUID), deviceId: req(UUID), createdAt: req(INSTANT), updatedAt: req(INSTANT) } as const;
const EDITABLE_BASE = { ...BASE, deletedAt: opt(INSTANT) } as const;

const STAFF: Shape<Staff> = {
  ...EDITABLE_BASE,
  name: req(STRING),
  role: req(ROLE),
  pinHash: req(STRING),
  pinSalt: req(STRING),
  active: req(BOOLEAN),
};

const CATEGORY: Shape<Category> = { ...EDITABLE_BASE, name: req(STRING), sortOrder: req(INTEGER), colour: req(STRING) };

const PRODUCT: Shape<Product> = {
  ...EDITABLE_BASE,
  name: req(STRING),
  categoryId: req(UUID),
  pricePence: req(INTEGER),
  vatRate: req(INTEGER),
  memberDiscountEligible: req(BOOLEAN),
  stockTracked: req(BOOLEAN),
  stockUnit: req(STRING),
  lowStockLevel: req(INTEGER),
  buttonColour: req(STRING),
  sortOrder: req(INTEGER),
  active: req(BOOLEAN),
};

const DEAL: Shape<Deal> = {
  ...EDITABLE_BASE,
  name: req(STRING),
  type: req(DEAL_TYPE),
  n: req(INTEGER),
  pricePence: opt(INTEGER),
  m: opt(INTEGER),
  productIds: req(arrayOf(UUID)),
  active: req(BOOLEAN),
  startsAt: opt(INSTANT),
  endsAt: opt(INSTANT),
};

const MEMBER: Shape<Member> = {
  ...EDITABLE_BASE,
  memberNumber: req(STRING),
  firstName: req(STRING),
  lastName: req(STRING),
  active: req(BOOLEAN),
};

const BOOKING: Shape<Booking> = {
  ...EDITABLE_BASE,
  type: req(BOOKING_TYPE),
  name: req(STRING),
  date: req({ kind: 'localDate' }),
  notes: req(STRING),
  status: req(BOOKING_STATUS),
};

const TAB_LINE: Shape<TabLine> = { productId: req(UUID), qty: req(INTEGER) };

const TAB: Shape<Tab> = {
  ...EDITABLE_BASE,
  labelType: req(TAB_LABEL_TYPE),
  label: req(STRING),
  openedAt: req(INSTANT),
  openedBy: req(UUID),
  status: req(TAB_STATUS),
  lines: req(arrayOf(object(TAB_LINE))),
  memberId: opt(UUID),
};

const PERIOD: Shape<Period> = {
  ...EDITABLE_BASE,
  openedAt: req(INSTANT),
  openedBy: req(UUID),
  floatPence: req(INTEGER),
  closedAt: opt(INSTANT),
  closedBy: opt(UUID),
  declaredCashPence: opt(INTEGER),
  zNumber: opt(INTEGER),
};

const SETTINGS: Shape<Settings> = {
  ...EDITABLE_BASE,
  clubName: req(STRING),
  receiptFooter: req(STRING),
  autoLockMinutes: req(INTEGER),
  memberDiscountPercent: req(INTEGER),
  lastBackupAt: opt(INSTANT),
  devicePrefix: req(STRING),
  receiptCounter: req(INTEGER),
};

const SALE_LINE: Shape<SaleLine> = {
  productId: req(UUID),
  nameAtSale: req(STRING),
  qty: req(INTEGER),
  unitPricePence: req(INTEGER),
  vatRate: req(INTEGER),
  dealDiscountPence: req(INTEGER),
  memberDiscountPence: req(INTEGER),
  finalPence: req(INTEGER),
  vatPence: req(INTEGER),
  refundOfLineIndex: opt(INTEGER),
  returnToStock: opt(BOOLEAN),
};

const SALE_DEAL_LINE: Shape<SaleDealLine> = {
  dealId: req(UUID),
  name: req(STRING),
  groupCount: req(INTEGER),
  savingPence: req(INTEGER),
};

const TENDER: Shape<Tender> = { type: req(TENDER_TYPE), amountPence: req(INTEGER) };

const SALE: Shape<Sale> = {
  ...BASE,
  receiptNumber: req(STRING),
  periodId: req(UUID),
  staffId: req(UUID),
  kind: req(SALE_KIND),
  memberId: opt(UUID),
  bookingId: opt(UUID),
  tabId: opt(UUID),
  refundOfSaleId: opt(UUID),
  lines: req(arrayOf(object(SALE_LINE))),
  dealLines: req(arrayOf(object(SALE_DEAL_LINE))),
  memberDiscountPence: req(INTEGER),
  depositAppliedPence: req(INTEGER),
  totalPence: req(INTEGER),
  tenders: req(arrayOf(object(TENDER))),
  changePence: req(INTEGER),
};

const STOCK_MOVEMENT: Shape<StockMovement> = {
  ...BASE,
  productId: req(UUID),
  qty: req(INTEGER),
  reason: req(STOCK_REASON),
  saleId: opt(UUID),
  staffId: req(UUID),
  note: req(STRING),
};

/** The fields shared by every audit event; `detail` is checked against DETAIL_SHAPES by type. */
const AUDIT_EVENT: Shape<AuditEventOf<AuditEventType>> = {
  ...BASE,
  type: req(AUDIT_TYPE),
  staffId: req(UUID),
  approvedById: opt(UUID),
  periodId: opt(UUID),
  detail: req({ kind: 'auditDetail' }),
};

const DETAIL_SHAPES: { readonly [T in AuditEventType]: Shape<AuditDetailByType[T]> } = {
  void: {
    productId: req(UUID),
    productName: req(STRING),
    qty: req(INTEGER),
    unitPricePence: req(INTEGER),
    tabId: opt(UUID),
  },
  noSale: {},
  refund: {
    refundSaleId: req(UUID),
    refundReceiptNumber: req(STRING),
    originalSaleId: req(UUID),
    originalReceiptNumber: req(STRING),
    totalPence: req(INTEGER),
    tender: req(TENDER_TYPE),
    lines: req(arrayOf(object({ productId: req(UUID), qty: req(INTEGER), returnToStock: req(BOOLEAN) }))),
  },
  priceChange: {
    productId: req(UUID),
    productName: req(STRING),
    oldPricePence: req(INTEGER),
    newPricePence: req(INTEGER),
  },
  override: { action: req(ACTION) },
  stockAdjust: {
    stockMovementId: req(UUID),
    productId: req(UUID),
    productName: req(STRING),
    qty: req(INTEGER),
    reason: req(oneOf<'adjustment' | 'waste'>({ adjustment: true, waste: true })),
    note: req(STRING),
  },
  zClose: {
    zNumber: req(INTEGER),
    floatPence: req(INTEGER),
    expectedCashPence: req(INTEGER),
    declaredCashPence: req(INTEGER),
    variancePence: req(INTEGER),
  },
  backupExport: { exportedAt: req(INSTANT) },
  backupImport: { fileExportedAt: req(INSTANT), fileDeviceId: req(UUID), importedByName: req(STRING) },
};

const ROW_SHAPES: { readonly [K in EntityName]: AnyShape } = {
  staff: STAFF,
  categories: CATEGORY,
  products: PRODUCT,
  deals: DEAL,
  members: MEMBER,
  bookings: BOOKING,
  tabs: TAB,
  sales: SALE,
  stockMovements: STOCK_MOVEMENT,
  periods: PERIOD,
  auditEvents: AUDIT_EVENT,
  settings: SETTINGS,
};

const OUTBOX: Shape<OutboxEntry> = {
  seq: req(INTEGER),
  id: req(UUID),
  entity: req(ENTITY),
  entityId: req(UUID),
  operation: req(OPERATION),
  payload: req({ kind: 'record' }),
  createdAt: req(INSTANT),
  syncedAt: req({ kind: 'instantOrNull' }),
};

const TOP_LEVEL_KEYS: readonly (keyof BackupFile)[] = ['format', 'version', 'exportedAt', 'deviceId', 'tables'];
const TABLE_KEYS: readonly string[] = [...ENTITY_NAMES, 'outbox'];

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 'YYYY-MM-DDTHH:mm:ss.sssZ' naming a real instant (D-049). */
function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !LOCAL_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// ---------------------------------------------------------------------------
// Problem collection
// ---------------------------------------------------------------------------

class Problems {
  readonly list: string[] = [];

  add(message: string): void {
    if (this.list.length < MAX_BACKUP_PROBLEMS) this.list.push(message);
  }

  get full(): boolean {
    return this.list.length >= MAX_BACKUP_PROBLEMS;
  }
}

function checkType(value: unknown, type: FieldType, path: string, problems: Problems): void {
  switch (type.kind) {
    case 'string':
      if (typeof value !== 'string') problems.add(`${path}: must be text`);
      return;
    case 'uuid':
      if (typeof value !== 'string' || !UUID_V4.test(value)) problems.add(`${path}: must be a UUID v4`);
      return;
    case 'instant':
      if (!isIsoInstant(value)) problems.add(`${path}: must be an ISO timestamp`);
      return;
    case 'instantOrNull':
      if (value !== null && !isIsoInstant(value)) problems.add(`${path}: must be an ISO timestamp or null`);
      return;
    case 'localDate':
      if (!isLocalDate(value)) problems.add(`${path}: must be a date (YYYY-MM-DD)`);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) problems.add(`${path}: must be a whole number`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') problems.add(`${path}: must be true or false`);
      return;
    case 'enum':
      if (typeof value !== 'string' || !type.values.includes(value)) {
        problems.add(`${path}: must be one of ${type.values.join(', ')}`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        problems.add(`${path}: must be a list`);
        return;
      }
      for (let i = 0; i < value.length && !problems.full; i++) checkType(value[i], type.of, `${path}[${i}]`, problems);
      return;
    case 'object':
      checkObject(value, type.shape, path, problems);
      return;
    case 'record':
    case 'auditDetail':
      // Checked by the caller, which knows the entity / audit type.
      if (!isRecordObject(value)) problems.add(`${path}: must be an object`);
      return;
  }
}

function checkObject(value: unknown, shape: AnyShape, path: string, problems: Problems): void {
  if (!isRecordObject(value)) {
    problems.add(`${path}: must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!hasOwn(shape, key)) problems.add(`${path}: unknown field "${key}"`);
  }
  for (const [key, field] of Object.entries(shape)) {
    if (problems.full) return;
    if (!hasOwn(value, key)) {
      if (field.optional !== true) problems.add(`${path}: missing field "${key}"`);
      continue;
    }
    checkType(value[key], field.type, `${path}.${key}`, problems);
  }
}

/** Checks one row of a synced table, including an audit event's typed detail. */
function checkRecord(entity: EntityName, value: unknown, path: string, problems: Problems): void {
  checkObject(value, ROW_SHAPES[entity], path, problems);
  if (entity !== 'auditEvents' || !isRecordObject(value)) return;
  const type = value['type'];
  if (typeof type === 'string' && hasOwn(DETAIL_SHAPES, type) && isRecordObject(value['detail'])) {
    checkObject(value['detail'], DETAIL_SHAPES[type as AuditEventType], `${path}.detail`, problems);
  }
}

function checkOutboxRow(value: unknown, path: string, problems: Problems): void {
  checkObject(value, OUTBOX, path, problems);
  if (!isRecordObject(value)) return;
  const entity = value['entity'];
  if (typeof entity === 'string' && hasOwn(ROW_SHAPES, entity) && isRecordObject(value['payload'])) {
    checkRecord(entity as EntityName, value['payload'], `${path}.payload`, problems);
  }
}

function checkDuplicates(rows: readonly unknown[], key: string, table: string, problems: Problems): void {
  const seen = new Set<unknown>();
  for (const row of rows) {
    if (problems.full) return;
    if (!isRecordObject(row) || !hasOwn(row, key)) continue;
    const value = row[key];
    if (seen.has(value)) problems.add(`tables.${table}: duplicate ${key} ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

function hasActiveManager(staff: readonly unknown[]): boolean {
  return staff.some(
    (row) => isRecordObject(row) && row['role'] === 'manager' && row['active'] === true && !hasOwn(row, 'deletedAt'),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a parsed JSON value against the backup format (D-089): format, version
 * (message 'This backup was made by a different version'), exportedAt, exactly the 13 table
 * keys with array values, per-row required/unknown fields and primitive types, integer money and
 * qty fields, UUID v4 ids, ISO timestamps, no duplicate ids (outbox: no duplicate seq or id),
 * exactly one settings row, and at least one active non-deleted manager.
 *
 * The format and version are checked first; a file that fails either is rejected with that one
 * problem, because its rows cannot be interpreted. Never throws.
 */
export function validateBackupValue(value: unknown): BackupValidation {
  if (!isRecordObject(value)) return { ok: false, problems: [BACKUP_NOT_OBJECT_MESSAGE] };
  if (value['format'] !== BACKUP_FORMAT) return { ok: false, problems: [BACKUP_WRONG_FORMAT_MESSAGE] };
  if (value['version'] !== SCHEMA_VERSION) return { ok: false, problems: [BACKUP_WRONG_VERSION_MESSAGE] };

  const problems = new Problems();
  for (const key of Object.keys(value)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) problems.add(`unknown field "${key}"`);
  }
  if (!isIsoInstant(value['exportedAt'])) problems.add('exportedAt is not a valid ISO instant');
  const deviceId = value['deviceId'];
  if (typeof deviceId !== 'string' || !UUID_V4.test(deviceId)) problems.add('deviceId must be a UUID v4');

  const tables = value['tables'];
  if (!isRecordObject(tables)) {
    problems.add('tables must be an object');
    return { ok: false, problems: problems.list };
  }
  for (const key of TABLE_KEYS) {
    if (!hasOwn(tables, key)) problems.add(`tables is missing "${key}"`);
    else if (!Array.isArray(tables[key])) problems.add(`tables.${key} must be a list`);
  }
  for (const key of Object.keys(tables)) {
    if (!TABLE_KEYS.includes(key)) problems.add(`tables has an unknown key "${key}"`);
  }

  const rowsOf = (key: string): readonly unknown[] | undefined => {
    const rows = hasOwn(tables, key) ? tables[key] : undefined;
    return Array.isArray(rows) ? rows : undefined;
  };

  for (const entity of ENTITY_NAMES) {
    const rows = rowsOf(entity);
    if (rows === undefined) continue;
    for (let i = 0; i < rows.length && !problems.full; i++) checkRecord(entity, rows[i], `tables.${entity}[${i}]`, problems);
    checkDuplicates(rows, 'id', entity, problems);
  }
  const outbox = rowsOf('outbox');
  if (outbox !== undefined) {
    for (let i = 0; i < outbox.length && !problems.full; i++) checkOutboxRow(outbox[i], `tables.outbox[${i}]`, problems);
    checkDuplicates(outbox, 'seq', 'outbox', problems);
    checkDuplicates(outbox, 'id', 'outbox', problems);
  }

  const settings = rowsOf('settings');
  if (settings !== undefined && settings.length !== 1) {
    problems.add(`tables.settings must have exactly one row (found ${settings.length})`);
  }
  const staff = rowsOf('staff');
  if (staff !== undefined && !hasActiveManager(staff)) problems.add(BACKUP_NO_MANAGER_MESSAGE);

  if (problems.list.length > 0) return { ok: false, problems: problems.list };
  return { ok: true, file: value as unknown as BackupFile };
}

/** Size check, then JSON.parse (failure is a problem, not a throw), then validateBackupValue. */
export function parseBackupText(text: string, sizeBytes: number): BackupValidation {
  if (sizeBytes > MAX_BACKUP_BYTES) return { ok: false, problems: [BACKUP_TOO_LARGE_MESSAGE] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: [BACKUP_NOT_JSON_MESSAGE] };
  }
  return validateBackupValue(value);
}

/** JSON.stringify(file, null, 2) (D-088). */
export function serialiseBackup(file: BackupFile): string {
  return JSON.stringify(file, null, 2);
}
