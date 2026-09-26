/**
 * Dexie schema for the LocalAdapter (docs/architecture.md §6; D-116).
 *
 * Store names equal the EntityName values plus 'outbox' and 'draft'. Booleans are not valid
 * IndexedDB keys, so `active` and `stockTracked` are never indexed (filtered in memory), and
 * absent optional fields are simply missing from their index.
 */
import { Dexie, type Table } from 'dexie';
import type { NewOutboxEntry } from '../outbox';
import type {
  AuditEvent,
  Booking,
  Category,
  Deal,
  Draft,
  EntityName,
  Member,
  OutboxEntry,
  Period,
  Product,
  Sale,
  Settings,
  Staff,
  StockMovement,
  Tab,
} from '../types';
import { ENTITY_NAMES, SCHEMA_VERSION } from '../types';

/** Index definitions per store (Dexie syntax: first entry is the primary key). */
export const STORE_SCHEMA = {
  staff: 'id',
  categories: 'id',
  products: 'id, categoryId',
  deals: 'id',
  members: 'id, memberNumber',
  bookings: 'id, status',
  tabs: 'id, status',
  sales: 'id, &receiptNumber, periodId, createdAt, bookingId, refundOfSaleId',
  stockMovements: 'id, productId, saleId',
  periods: 'id',
  auditEvents: 'id, periodId, type',
  settings: 'id',
  outbox: '++seq, &id, entity, entityId',
  draft: 'id',
} as const satisfies Record<EntityName | 'outbox' | 'draft', string>;

export type StoreName = keyof typeof STORE_SCHEMA;

/** Every store: the 12 synced tables, the outbox and the draft. */
export const ALL_STORES: readonly StoreName[] = [...ENTITY_NAMES, 'outbox', 'draft'];

/** The 13 stores a backup covers (D-088): synced tables + outbox (no draft). */
export const BACKUP_STORES: readonly StoreName[] = [...ENTITY_NAMES, 'outbox'];

export type ClubDb = Dexie & {
  staff: Table<Staff, string>;
  categories: Table<Category, string>;
  products: Table<Product, string>;
  deals: Table<Deal, string>;
  members: Table<Member, string>;
  bookings: Table<Booking, string>;
  tabs: Table<Tab, string>;
  sales: Table<Sale, string>;
  stockMovements: Table<StockMovement, string>;
  periods: Table<Period, string>;
  auditEvents: Table<AuditEvent, string>;
  settings: Table<Settings, string>;
  outbox: Table<OutboxEntry, number, NewOutboxEntry>;
  draft: Table<Draft, string>;
};

/** Declares the schema on a new (unopened) Dexie instance. */
export function defineClubDb(dbName: string): ClubDb {
  const db = new Dexie(dbName) as ClubDb;
  db.version(SCHEMA_VERSION).stores(STORE_SCHEMA);
  return db;
}
