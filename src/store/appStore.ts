/**
 * App-wide state (architecture §7.2): the ServiceContext, boot state, a Settings snapshot, the
 * open-period cache and the storage-persistence status. Persistent data lives in the data layer;
 * this is only a cache, refreshed after settings or period changes.
 */
import { create } from 'zustand';
import type { Period, Settings } from '../data/types';
import type { ServiceContext } from '../services/context';
import { getOpenPeriod } from '../services/periods';
import { findSettings } from '../services/settings';
import { getBootState, type BootState } from '../services/setup';
import { checkPersistentStorage, type StorageStatus } from '../services/storage';

export type AppStatus = 'booting' | 'ready' | 'failed';

export interface AppState {
  status: AppStatus;
  /** Set once boot() succeeds. Use getCtx()/useCtx() rather than reading it directly. */
  ctx: ServiceContext | null;
  /** 'setup' until the first manager exists, then 'login' (D-111). null while booting. */
  bootState: BootState | null;
  /** The message for the full-screen error when boot fails. */
  bootError: string | null;
  /** The Settings row (null before setup). Refresh with refreshSettings() after saving settings. */
  settings: Settings | null;
  /** The open period, or null. Refresh with refreshPeriod() after opening or closing one. */
  openPeriod: Period | null;
  /** From checkPersistentStorage() at app start and after setup (D-112, D-124). */
  storageStatus: StorageStatus | null;

  /** Opens the database via `createContext` (src/app/bootstrap) and loads everything above. Runs once. */
  boot(createContext: () => Promise<ServiceContext>, failureMessage: string): Promise<void>;
  /** Re-reads the Settings row. */
  refreshSettings(): Promise<Settings | null>;
  /** Re-reads the open period. */
  refreshPeriod(): Promise<Period | null>;
  /** Re-reads boot state, settings and the open period (after first run or a backup import). */
  refreshAll(): Promise<void>;
  /** Re-checks navigator.storage persistence (after setup). */
  refreshStorageStatus(): Promise<StorageStatus>;
}

let bootPromise: Promise<void> | null = null;

export const useAppStore = create<AppState>()((set, get) => ({
  status: 'booting',
  ctx: null,
  bootState: null,
  bootError: null,
  settings: null,
  openPeriod: null,
  storageStatus: null,

  boot(createContext, failureMessage) {
    if (bootPromise !== null) return bootPromise;
    bootPromise = (async () => {
      let ctx: ServiceContext;
      try {
        ctx = await createContext();
      } catch {
        set({ status: 'failed', bootError: failureMessage });
        return;
      }
      set({ ctx });
      try {
        await get().refreshAll();
        set({ storageStatus: await checkPersistentStorage(ctx) });
        set({ status: 'ready' });
      } catch {
        set({ status: 'failed', bootError: failureMessage });
      }
    })();
    return bootPromise;
  },

  async refreshSettings() {
    const ctx = getCtx();
    const settings = (await findSettings(ctx)) ?? null;
    set({ settings });
    return settings;
  },

  async refreshPeriod() {
    const ctx = getCtx();
    const openPeriod = (await getOpenPeriod(ctx)) ?? null;
    set({ openPeriod });
    return openPeriod;
  },

  async refreshAll() {
    const ctx = getCtx();
    const bootState = await getBootState(ctx);
    set({ bootState });
    await get().refreshSettings();
    await get().refreshPeriod();
  },

  async refreshStorageStatus() {
    const storageStatus = await checkPersistentStorage(getCtx());
    set({ storageStatus });
    return storageStatus;
  },
}));

/** The ServiceContext for non-React code (stores, app helpers). Throws before boot. */
export function getCtx(): ServiceContext {
  const ctx = useAppStore.getState().ctx;
  if (ctx === null) throw new Error('The app has not finished starting');
  return ctx;
}

/** The ServiceContext inside components. Screens only render after boot, so it is never null there. */
export function useCtx(): ServiceContext {
  const ctx = useAppStore((s) => s.ctx);
  if (ctx === null) throw new Error('The app has not finished starting');
  return ctx;
}

/** True when a trading period is open (selling allowed, D-068). */
export function useHasOpenPeriod(): boolean {
  return useAppStore((s) => s.openPeriod !== null);
}

/** Test hook: forget the boot promise so a test can boot again. */
export function resetAppStoreForTests(): void {
  bootPromise = null;
  useAppStore.setState({ status: 'booting', ctx: null, bootState: null, bootError: null, settings: null, openPeriod: null, storageStatus: null });
}
