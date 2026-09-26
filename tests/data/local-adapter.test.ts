/**
 * Runs the repository contract (spec §10.2) against the Dexie LocalAdapter under fake-indexeddb,
 * plus checks specific to this adapter: the IndexedDB schema (D-116, architecture §6), the
 * default database name and database deletion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalAdapter, deleteLocalDatabase } from '../../src/data/local';
import type { Repos } from '../../src/data/repos';
import { DB_NAME, ENTITY_NAMES } from '../../src/data/types';
import { makeClock, makeIds, runRepositoryContract } from './contract';

runRepositoryContract('LocalAdapter', (options) => createLocalAdapter(options), deleteLocalDatabase);

function openRaw(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

interface IndexInfo {
  name: string;
  keyPath: string | string[];
  unique: boolean;
}

function describeStore(db: IDBDatabase, storeName: string): { keyPath: string | string[] | null; autoIncrement: boolean; indexes: IndexInfo[] } {
  const store = db.transaction(storeName, 'readonly').objectStore(storeName);
  const indexes = Array.from(store.indexNames)
    .map((name) => store.index(name))
    .map((index) => ({ name: index.name, keyPath: index.keyPath, unique: index.unique }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
}

describe('LocalAdapter specifics', () => {
  const opened: Repos[] = [];
  const names: string[] = [];

  async function open(dbName?: string): Promise<Repos> {
    const repos = await createLocalAdapter({ ...(dbName === undefined ? {} : { dbName }), now: makeClock().now, newId: makeIds().next });
    opened.push(repos);
    names.push(dbName ?? DB_NAME);
    return repos;
  }

  afterEach(async () => {
    for (const repos of opened.splice(0)) await repos.close();
    for (const name of names.splice(0)) await deleteLocalDatabase(name);
  });

  it('creates one object store per entity plus outbox and draft (D-116)', async () => {
    await open('schema-check');
    const raw = await openRaw('schema-check');
    try {
      expect(Array.from(raw.objectStoreNames).sort()).toEqual([...ENTITY_NAMES, 'outbox', 'draft'].sort());
      for (const name of ENTITY_NAMES) expect(describeStore(raw, name).keyPath, name).toBe('id');
      expect(describeStore(raw, 'draft').keyPath).toBe('id');
    } finally {
      raw.close();
    }
  });

  it('indexes every field the repository queries use (architecture §6)', async () => {
    await open('index-check');
    const raw = await openRaw('index-check');
    try {
      const names = (store: string): string[] => describeStore(raw, store).indexes.map((i) => i.name);
      expect(describeStore(raw, 'sales').indexes).toEqual([
        { name: 'bookingId', keyPath: 'bookingId', unique: false },
        { name: 'createdAt', keyPath: 'createdAt', unique: false },
        { name: 'periodId', keyPath: 'periodId', unique: false },
        { name: 'receiptNumber', keyPath: 'receiptNumber', unique: true },
        { name: 'refundOfSaleId', keyPath: 'refundOfSaleId', unique: false },
      ]);
      expect(names('stockMovements')).toEqual(['productId', 'saleId']);
      expect(names('auditEvents')).toEqual(['periodId', 'type']);
      expect(names('members')).toEqual(['memberNumber']);
      expect(names('products')).toEqual(['categoryId']);
      expect(names('tabs')).toEqual(['status']);
      expect(names('bookings')).toEqual(['status']);
      const outbox = describeStore(raw, 'outbox');
      expect(outbox.keyPath).toBe('seq');
      expect(outbox.autoIncrement).toBe(true);
      expect(outbox.indexes).toEqual([
        { name: 'entity', keyPath: 'entity', unique: false },
        { name: 'entityId', keyPath: 'entityId', unique: false },
        { name: 'id', keyPath: 'id', unique: true },
      ]);
    } finally {
      raw.close();
    }
  });

  it(`uses the '${DB_NAME}' database by default`, async () => {
    const repos = await open();
    await repos.initialise({
      settings: { clubName: 'Default DB', receiptFooter: '', autoLockMinutes: 5, memberDiscountPercent: 15 },
      manager: { name: 'Morgan Manager', role: 'manager', pinHash: 'ab'.repeat(32), pinSalt: 'cd'.repeat(16), active: true },
    });
    const raw = await openRaw(DB_NAME);
    try {
      const count = await new Promise<number>((resolve, reject) => {
        const request = raw.transaction('settings', 'readonly').objectStore('settings').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('count failed'));
      });
      expect(count).toBe(1);
    } finally {
      raw.close();
    }
  });

  it('deleteLocalDatabase removes every row; reopening gives an empty database', async () => {
    const repos = await createLocalAdapter({ dbName: 'delete-check', now: makeClock().now, newId: makeIds().next });
    await repos.initialise({
      settings: { clubName: 'Gone soon', receiptFooter: '', autoLockMinutes: 5, memberDiscountPercent: 15 },
      manager: { name: 'Morgan Manager', role: 'manager', pinHash: 'ab'.repeat(32), pinSalt: 'cd'.repeat(16), active: true },
    });
    await repos.close();
    await deleteLocalDatabase('delete-check');
    const reopened = await open('delete-check');
    expect(await reopened.settings.get()).toBeUndefined();
    expect(await reopened.outbox.count()).toBe(0);
  });

  it('uses crypto.randomUUID ids and the real clock when none are injected', async () => {
    const repos = await createLocalAdapter({ dbName: 'defaults-check' });
    opened.push(repos);
    names.push('defaults-check');
    const before = Date.now();
    const { settings } = await repos.initialise({
      settings: { clubName: 'Defaults', receiptFooter: '', autoLockMinutes: 5, memberDiscountPercent: 15 },
      manager: { name: 'Morgan Manager', role: 'manager', pinHash: 'ab'.repeat(32), pinSalt: 'cd'.repeat(16), active: true },
    });
    expect(settings.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Date.parse(settings.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(settings.createdAt)).toBeLessThanOrEqual(Date.now());
  });
});
