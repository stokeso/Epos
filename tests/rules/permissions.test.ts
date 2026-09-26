import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_LABELS,
  MIN_ROLE,
  ROLE_RANK,
  can,
  minRoleFor,
  overridePrompt,
  type Action,
  type Role,
} from '../../src/rules/permissions';

/**
 * Spec §5, transcribed row by row (not derived from MIN_ROLE):
 * [action, staff, supervisor, manager].
 */
const MATRIX: readonly [Action, string, boolean, boolean, boolean][] = [
  ['sell', 'Sell, take payment', true, true, true],
  ['tabs', 'Open, add to, settle tabs', true, true, true],
  ['attachMember', 'Attach member', true, true, true],
  ['bookings', 'Create booking, take deposit, apply deposit', true, true, true],
  ['voidLine', 'Void a basket line', false, true, true],
  ['noSale', 'No sale (open drawer)', false, true, true],
  ['xRead', 'X read', false, true, true],
  ['refund', 'Refund', false, false, true],
  ['openClosePeriod', 'Open period, Z close', false, false, true],
  ['editCatalogue', 'Edit products, prices, categories, deals', false, false, true],
  ['stockControl', 'Goods in, stock adjustment', false, false, true],
  ['manageMembersStaffSettings', 'Manage members, staff, settings', false, false, true],
  ['salesReports', 'Product sales and VAT reports', false, false, true],
  ['backup', 'Export / import backup', false, false, true],
];

describe('permission matrix (spec §5, D-069)', () => {
  const cells = MATRIX.flatMap(([action, , staff, supervisor, manager]) => [
    [action, 'staff', staff] as const,
    [action, 'supervisor', supervisor] as const,
    [action, 'manager', manager] as const,
  ]);

  it('covers all 14 rows x 3 roles', () => {
    expect(cells).toHaveLength(42);
    expect(MATRIX.map(([a]) => a)).toEqual([...ACTIONS]);
    expect(Object.keys(MIN_ROLE).sort()).toEqual([...ACTIONS].sort());
  });

  it.each(cells)('can(%s as %s) = %s', (action, role, allowed) => {
    expect(can(role, action)).toBe(allowed);
  });

  it('labels each action with its spec §5 row', () => {
    for (const [action, label] of MATRIX) expect(ACTION_LABELS[action]).toBe(label);
  });

  it('matches the D-069 examples', () => {
    expect(can('staff', 'voidLine')).toBe(false);
    expect(can('supervisor', 'voidLine')).toBe(true);
    expect(can('supervisor', 'refund')).toBe(false);
    expect(can('manager', 'backup')).toBe(true);
  });

  it('ranks roles staff < supervisor < manager', () => {
    expect(ROLE_RANK).toEqual({ staff: 0, supervisor: 1, manager: 2 });
  });
});

describe('minRoleFor and overridePrompt (D-071)', () => {
  it('returns the lowest role that is allowed', () => {
    for (const [action, , staff, supervisor] of MATRIX) {
      const expected: Role = staff ? 'staff' : supervisor ? 'supervisor' : 'manager';
      expect(minRoleFor(action)).toBe(expected);
    }
  });

  it('asks for a supervisor-or-manager PIN or a manager PIN', () => {
    expect(overridePrompt('voidLine')).toBe('Supervisor or manager PIN');
    expect(overridePrompt('noSale')).toBe('Supervisor or manager PIN');
    expect(overridePrompt('xRead')).toBe('Supervisor or manager PIN');
    expect(overridePrompt('refund')).toBe('Manager PIN');
    expect(overridePrompt('openClosePeriod')).toBe('Manager PIN');
    expect(overridePrompt('backup')).toBe('Manager PIN');
  });
});
