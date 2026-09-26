/**
 * Composition root (architecture §5.11, D-111, D-118): the ONLY place that constructs the
 * LocalAdapter. One clock and one id generator are shared by the adapter and the services.
 */
import { DB_NAME } from '../data/types';
import { createServiceContext, type ServiceContext, type StoragePort } from '../services/context';
import { now } from './clock';

/** The message for the full-screen error when the database cannot be opened (D-111). */
export const STORAGE_UNAVAILABLE_MESSAGE = "This browser can't store the till's data";

function newId(): string {
  return crypto.randomUUID();
}

/** navigator.storage when it has persist()/persisted(), else undefined (D-112). */
function storagePort(): StoragePort | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const storage = navigator.storage as StorageManager | undefined;
  if (storage === undefined || typeof storage.persist !== 'function' || typeof storage.persisted !== 'function') return undefined;
  return {
    persist: () => storage.persist(),
    persisted: () => storage.persisted(),
  };
}

/**
 * Opens the 'club-epos' database and returns the ServiceContext.
 * Rejects when IndexedDB is unavailable (the caller shows STORAGE_UNAVAILABLE_MESSAGE).
 */
export async function bootstrap(): Promise<ServiceContext> {
  // Loaded on demand: keeps Dexie and the adapter out of the first chunk (the PWA precaches both).
  const { createLocalAdapter } = await import('../data/local');
  const repos = await createLocalAdapter({ dbName: DB_NAME, now, newId });
  return createServiceContext({ repos, now, newId, storage: storagePort() });
}
