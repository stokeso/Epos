/**
 * First run (spec §6.1; D-057, D-099, D-111, D-112).
 */
import { AppError } from '../data/errors';
import { londonDateOf } from '../rules/time';
import { validateFirstRun, type FirstRunInput } from '../rules/validation';
import { RESERVED_SAMPLE_PINS, loadSampleData } from '../seed';
import type { Session } from './auth';
import { nowIso, type ServiceContext } from './context';
import { createPinCredentials } from './pin';
import { validOrThrow } from './shared';
import { requestPersistentStorage } from './storage';

export type BootState = 'setup' | 'login';

function alreadySetUp(): AppError {
  return new AppError('CONFLICT', 'The till has already been set up');
}

/** Settings defaults applied at setup (D-057). */
export const DEFAULT_SETTINGS = {
  receiptFooter: 'Thank you for your custom',
  autoLockMinutes: 5,
  memberDiscountPercent: 15,
} as const;

/** 'setup' when the staff table has zero rows of any status, else 'login' (D-111). */
export async function getBootState(ctx: ServiceContext): Promise<BootState> {
  const staff = await ctx.repos.staff.list({ includeDeleted: true });
  return staff.length === 0 ? 'setup' : 'login';
}

/**
 * Setup submit (D-111): validateFirstRun (reserved sample PINs when loading samples) ->
 * createPinCredentials (outside any transaction) -> repos.initialise (Settings + manager,
 * transaction 1) -> if ticked, seed.loadSampleData (transaction 2, today = London date of now) ->
 * requestPersistentStorage -> returns the manager's Session (auto-login).
 * Throws AppError('VALIDATION', ..., fieldErrors) on invalid input, and AppError('CONFLICT') when
 * the till has already been set up (staff exist), re-checked inside the initialise transaction
 * so overlapping submits cannot both succeed (D-127).
 * The persistence result is not returned (the contract returns the Session); the app reads it
 * with checkPersistentStorage(), whose persisted() reflects the grant.
 */
export async function completeFirstRun(ctx: ServiceContext, input: FirstRunInput): Promise<Session> {
  const form = validOrThrow(validateFirstRun(input, input.loadSampleData ? RESERVED_SAMPLE_PINS : []));
  // Fast answer before the slow hash; the binding check is the one inside the transaction.
  if ((await getBootState(ctx)) !== 'setup') throw alreadySetUp();
  const credentials = await createPinCredentials(form.pin);
  // D-127: re-check "no staff" in the same transaction as initialise, so an overlapping submit
  // (a double tap while the first is hashing) is CONFLICT and never adds a second manager.
  const { manager } = await ctx.repos.transact(async () => {
    if ((await ctx.repos.staff.list({ includeDeleted: true })).length > 0) throw alreadySetUp();
    return ctx.repos.initialise({
      settings: { clubName: form.clubName, ...DEFAULT_SETTINGS },
      manager: { name: form.managerName, role: 'manager', active: true, ...credentials },
    });
  });
  if (form.loadSampleData) {
    await loadSampleData(ctx, { managerStaffId: manager.id, today: londonDateOf(nowIso(ctx)) });
  }
  await requestPersistentStorage(ctx);
  return { staffId: manager.id, name: manager.name, role: manager.role };
}
