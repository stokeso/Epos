/**
 * Outbox helpers used by adapters (spec §3.2, D-053, D-054). v1 only writes entries;
 * a future sync adapter reads them.
 */
import type { EntityName, IsoInstant, OutboxEntry, OutboxOperation, SyncedRecord } from './types';

/** An outbox entry before Dexie assigns its auto-increment seq. */
export type NewOutboxEntry = Omit<OutboxEntry, 'seq'>;

/**
 * Builds the entry for one record write: { id, entity, entityId: record.id, operation,
 * payload: record (full stored snapshot), createdAt: at, syncedAt: null }.
 */
export function buildOutboxEntry(
  entity: EntityName,
  operation: OutboxOperation,
  record: SyncedRecord,
  at: IsoInstant,
  id: string,
): NewOutboxEntry {
  return { id, entity, entityId: record.id, operation, payload: record, createdAt: at, syncedAt: null };
}
