/**
 * LocalAdapter: Dexie / IndexedDB implementation of Repos (spec §3, D-056).
 * The only folder allowed to import 'dexie' (ESLint enforces this).
 *
 * Schema plan (Dexie version SCHEMA_VERSION = 1, database DB_NAME = 'club-epos') is in
 * docs/architecture.md, "Dexie tables and indexes", and in ./db.ts. Booleans are not valid
 * IndexedDB keys, so `active` / `stockTracked` are never indexed; filter them in memory.
 */
import { Dexie } from 'dexie';
import type { AdapterOptions, Repos } from '../repos';
import { DB_NAME } from '../types';
import { buildRepos } from './adapter';
import { defineClubDb } from './db';

/** Opens (creating if needed) the database and returns the Repos implementation. */
export async function createLocalAdapter(options: AdapterOptions = {}): Promise<Repos> {
  const db = defineClubDb(options.dbName ?? DB_NAME);
  await db.open();
  const now = options.now ?? ((): Date => new Date());
  return buildRepos({
    db,
    nowIso: () => now().toISOString(),
    newId: options.newId ?? ((): string => crypto.randomUUID()),
    failSaleCommitAfterWrites: options.failSaleCommitAfterWrites === true,
  });
}

/** Deletes the named database (tests). Close any Repos using it first. */
export function deleteLocalDatabase(dbName: string): Promise<void> {
  return Dexie.delete(dbName);
}
