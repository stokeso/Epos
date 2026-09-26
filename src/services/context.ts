/**
 * The dependency bundle every service function takes as its first argument (D-101).
 *
 * Services are the only way screens touch rules and repositories together. They hold no state:
 * everything comes in through ServiceContext and parameters, so Vitest can run them against
 * the LocalAdapter under fake-indexeddb with a controlled clock and ids.
 *
 * The composition root (src/app, UI workflow) builds ONE clock and ONE id generator and hands
 * the same functions to createLocalAdapter() and createServiceContext(). A test does the same
 * with a fixed/stepping clock and a sequential id generator.
 * Device identity (deviceId, devicePrefix) comes from Settings via repos, not from the context.
 */
import type { Repos } from '../data/repos';
import type { IsoInstant } from '../data/types';

/** The parts of navigator.storage the app uses (D-112). */
export interface StoragePort {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

export interface ServiceContext {
  readonly repos: Repos;
  /** The same clock given to the adapter. Services read it for pricing instants, "today", reminders. */
  readonly now: () => Date;
  /** The same id generator given to the adapter. Services use it only for in-memory ids (PaySession.id). */
  readonly newId: () => string;
  /** navigator.storage, or undefined when unsupported (and in most tests). */
  readonly storage: StoragePort | undefined;
}

export interface ServiceContextOptions {
  repos: Repos;
  /** Default () => new Date(). */
  now?: () => Date;
  /** Default () => crypto.randomUUID(). */
  newId?: () => string;
  /** Default undefined. */
  storage?: StoragePort;
}

/** Fills defaults. */
export function createServiceContext(options: ServiceContextOptions): ServiceContext {
  return {
    repos: options.repos,
    now: options.now ?? ((): Date => new Date()),
    newId: options.newId ?? ((): string => crypto.randomUUID()),
    storage: options.storage,
  };
}

/** ctx.now().toISOString() (one clock read). */
export function nowIso(ctx: ServiceContext): IsoInstant {
  return ctx.now().toISOString();
}
