/**
 * The permission matrix (spec §5; D-069..D-072). Pure.
 * Role and Action are defined in src/data/types.ts (they are persisted) and re-exported here.
 */
import type { Action, Role } from '../data/types';

export type { Action, Role } from '../data/types';

/** Role ordering: a higher rank can do everything a lower rank can. */
export const ROLE_RANK = { staff: 0, supervisor: 1, manager: 2 } as const satisfies Record<Role, number>;

/** Minimum role per spec §5 row (D-069). */
export const MIN_ROLE = {
  sell: 'staff',
  tabs: 'staff',
  attachMember: 'staff',
  bookings: 'staff',
  voidLine: 'supervisor',
  noSale: 'supervisor',
  xRead: 'supervisor',
  refund: 'manager',
  openClosePeriod: 'manager',
  editCatalogue: 'manager',
  stockControl: 'manager',
  manageMembersStaffSettings: 'manager',
  salesReports: 'manager',
  backup: 'manager',
} as const satisfies Record<Action, Role>;

/** Every action, in spec §5 row order. */
export const ACTIONS = [
  'sell',
  'tabs',
  'attachMember',
  'bookings',
  'voidLine',
  'noSale',
  'xRead',
  'refund',
  'openClosePeriod',
  'editCatalogue',
  'stockControl',
  'manageMembersStaffSettings',
  'salesReports',
  'backup',
] as const satisfies readonly Action[];

/** The spec §5 row wording, for dialogs and tests. */
export const ACTION_LABELS = {
  sell: 'Sell, take payment',
  tabs: 'Open, add to, settle tabs',
  attachMember: 'Attach member',
  bookings: 'Create booking, take deposit, apply deposit',
  voidLine: 'Void a basket line',
  noSale: 'No sale (open drawer)',
  xRead: 'X read',
  refund: 'Refund',
  openClosePeriod: 'Open period, Z close',
  editCatalogue: 'Edit products, prices, categories, deals',
  stockControl: 'Goods in, stock adjustment',
  manageMembersStaffSettings: 'Manage members, staff, settings',
  salesReports: 'Product sales and VAT reports',
  backup: 'Export / import backup',
} as const satisfies Record<Action, string>;

/** ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE[action]] (spec §5). */
export function can(role: Role, action: Action): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE[action]];
}

/** MIN_ROLE[action]. */
export function minRoleFor(action: Action): Role {
  return MIN_ROLE[action];
}

/** Override dialog title (D-071): 'Supervisor or manager PIN' when the minimum is supervisor, else 'Manager PIN'. */
export function overridePrompt(action: Action): string {
  return MIN_ROLE[action] === 'supervisor' ? 'Supervisor or manager PIN' : 'Manager PIN';
}
