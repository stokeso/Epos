/**
 * Login (spec §6.2; D-074, D-076, D-078).
 * The Session lives only in memory (Zustand session store); a refresh always returns to login.
 * The failed-attempt lockout is pure (rules/lockout.ts) and tracked by the UI store.
 */
import type { Role, Staff } from '../data/types';
import { isValidPinFormat } from '../rules/validation';
import type { ServiceContext } from './context';
import { verifyPin } from './pin';
import { activeStaffInLoginOrder } from './shared';

export interface Session {
  staffId: string;
  name: string;
  role: Role;
}

/**
 * Finds the first active, non-deleted staff member whose PIN matches, trying staff sorted by
 * createdAt then id (D-074). A PIN in the wrong format is rejected without hashing. Hashing runs
 * outside any transaction.
 */
export async function findStaffByPin(ctx: ServiceContext, pin: string): Promise<Staff | undefined> {
  if (!isValidPinFormat(pin)) return undefined;
  for (const staff of await activeStaffInLoginOrder(ctx)) {
    if (await verifyPin(pin, staff)) return staff;
  }
  return undefined;
}

/** Logs in: findStaffByPin -> Session, or null ('PIN not recognised') (D-074). Writes nothing. */
export async function login(ctx: ServiceContext, pin: string): Promise<Session | null> {
  const staff = await findStaffByPin(ctx, pin);
  return staff === undefined ? null : { staffId: staff.id, name: staff.name, role: staff.role };
}
