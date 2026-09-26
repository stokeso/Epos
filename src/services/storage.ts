/**
 * Persistent storage (spec §8; D-112).
 */
import type { Session } from './auth';
import type { ServiceContext } from './context';

export type StorageStatus = 'persisted' | 'notPersisted' | 'unsupported';

/** Setup submit: ctx.storage.persist() (inside the user gesture). 'unsupported' when ctx.storage is undefined. */
export async function requestPersistentStorage(ctx: ServiceContext): Promise<StorageStatus> {
  const storage = ctx.storage;
  if (storage === undefined) return 'unsupported';
  try {
    return (await storage.persist()) ? 'persisted' : 'notPersisted';
  } catch {
    return 'notPersisted';
  }
}

/** Every app start: persisted(); if false, persist() again. Errors count as 'notPersisted'. */
export async function checkPersistentStorage(ctx: ServiceContext): Promise<StorageStatus> {
  const storage = ctx.storage;
  if (storage === undefined) return 'unsupported';
  try {
    if (await storage.persisted()) return 'persisted';
    return (await storage.persist()) ? 'persisted' : 'notPersisted';
  } catch {
    return 'notPersisted';
  }
}

/**
 * Managers only (own role), when status is not 'persisted': banner 'This browser may clear the
 * till's data. Install the app and back up regularly.' (in-flow, dismissible per login).
 */
export function shouldWarnAboutStorage(status: StorageStatus, session: Session): boolean {
  return session.role === 'manager' && status !== 'persisted';
}

/** The banner text (D-112). */
export const STORAGE_WARNING = "This browser may clear the till's data. Install the app and back up regularly.";
