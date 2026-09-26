/**
 * First run, login, persistent storage and PIN override (spec §5, §6.1, §6.2, §8;
 * D-057, D-071..D-076, D-111, D-112).
 */
import { describe, expect, it } from 'vitest';
import { findStaffByPin, login } from '../../../src/services/auth';
import type { StoragePort } from '../../../src/services/context';
import { approveOverride, assertAuthorised, auditActor, authoriseDirect, overrideEvents } from '../../../src/services/override';
import { completeFirstRun, getBootState } from '../../../src/services/setup';
import { checkPersistentStorage, requestPersistentStorage, shouldWarnAboutStorage } from '../../../src/services/storage';
import { recordNoSale, voidLine } from '../../../src/services/till';
import { addStaff, basket, expectAppError, initialiseTill, makeHarness, PINS, registerCleanup, setupTill } from './harness';

registerCleanup();

function fakeStorage(initial: { persisted: boolean; grant: boolean; fail?: boolean }): StoragePort & { persistCalls: number } {
  let persisted = initial.persisted;
  const port = {
    persistCalls: 0,
    persisted: async (): Promise<boolean> => {
      if (initial.fail === true) throw new Error('storage unavailable');
      return persisted;
    },
    persist: async (): Promise<boolean> => {
      port.persistCalls += 1;
      if (initial.fail === true) throw new Error('storage unavailable');
      if (initial.grant) persisted = true;
      return initial.grant;
    },
  };
  return port;
}

const firstRun = { clubName: '  Oakfield   Golf Club ', managerName: 'Morgan  Manager', pin: '1234', confirmPin: '1234', loadSampleData: false };

describe('first run (D-111, D-057)', () => {
  it('boots to setup with no staff and to login once the manager exists', async () => {
    const h = await makeHarness();
    expect(await getBootState(h.ctx)).toBe('setup');
    await initialiseTill(h);
    expect(await getBootState(h.ctx)).toBe('login');
  });

  it('creates the Settings row with defaults, device identity and the manager, then auto-logs in', async () => {
    const storage = fakeStorage({ persisted: false, grant: true });
    const h = await makeHarness({ storage });
    const session = await completeFirstRun(h.ctx, firstRun);

    const settings = await h.repos.settings.get();
    const deviceId = '3f9c2a';
    expect(settings).toMatchObject({
      clubName: 'Oakfield Golf Club',
      receiptFooter: 'Thank you for your custom',
      autoLockMinutes: 5,
      memberDiscountPercent: 15,
      receiptCounter: 0,
    });
    expect(settings?.lastBackupAt).toBeUndefined();
    expect(settings?.id).toBe(settings?.deviceId);
    expect(settings?.deviceId.startsWith(deviceId)).toBe(true);
    expect(settings?.devicePrefix).toBe(settings?.deviceId.slice(0, 4).toUpperCase());
    expect(settings?.devicePrefix).toBe('3F9C');

    const staff = await h.repos.staff.list();
    expect(staff).toHaveLength(1);
    const manager = staff[0];
    expect(manager).toMatchObject({ name: 'Morgan Manager', role: 'manager', active: true, deviceId: settings?.deviceId });
    expect(manager?.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manager?.pinSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(manager)).not.toContain('"1234"');
    expect(session).toEqual({ staffId: manager?.id, name: 'Morgan Manager', role: 'manager' });

    // One outbox entry per record written (D-053).
    expect((await h.repos.outbox.list()).map((e) => [e.entity, e.operation])).toEqual([
      ['settings', 'create'],
      ['staff', 'create'],
    ]);
    // Storage persistence was requested during setup (D-112); the result is then readable
    // without a second persist() call.
    expect(storage.persistCalls).toBe(1);
    expect(await checkPersistentStorage(h.ctx)).toBe('persisted');
    expect(storage.persistCalls).toBe(1);
    expect(await login(h.ctx, '1234')).toEqual(session);
  });

  it('rejects an invalid form with field errors and writes nothing', async () => {
    const h = await makeHarness();
    await expectAppError(completeFirstRun(h.ctx, { ...firstRun, clubName: '   ', confirmPin: '9999' }), 'VALIDATION', 'Enter the club name');
    try {
      await completeFirstRun(h.ctx, { ...firstRun, pin: '12', confirmPin: '12' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION', fieldErrors: { pin: 'PIN must be 4 to 6 digits' } });
    }
    expect(await h.repos.settings.get()).toBeUndefined();
    expect(await h.repos.outbox.count()).toBe(0);
  });

  it('reserves the sample staff PINs only when sample data is loaded (D-099)', async () => {
    const h = await makeHarness();
    await expectAppError(
      completeFirstRun(h.ctx, { ...firstRun, pin: PINS.staff, confirmPin: PINS.staff, loadSampleData: true }),
      'VALIDATION',
      'That PIN is used by the sample staff',
    );
    const session = await completeFirstRun(h.ctx, { ...firstRun, pin: PINS.staff, confirmPin: PINS.staff });
    expect(session.role).toBe('manager');
  });

  it('refuses to run twice', async () => {
    const h = await makeHarness();
    await completeFirstRun(h.ctx, firstRun);
    await expectAppError(completeFirstRun(h.ctx, { ...firstRun, pin: '5678', confirmPin: '5678' }), 'CONFLICT');
    expect(await h.repos.staff.list()).toHaveLength(1);
  });

  it('lets only one of two overlapping submits set the till up (D-124, D-075, D-127)', async () => {
    const h = await makeHarness();
    // A double-tapped Submit: the second call starts while the first is still hashing.
    const results = await Promise.allSettled([completeFirstRun(h.ctx, firstRun), completeFirstRun(h.ctx, firstRun)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'CONFLICT', message: 'The till has already been set up' });
    expect(await h.repos.staff.list({ includeDeleted: true })).toHaveLength(1);
    expect((await h.repos.outbox.list()).map((e) => [e.entity, e.operation])).toEqual([
      ['settings', 'create'],
      ['staff', 'create'],
    ]);
  });

  it('writes nothing for the losing overlapping submit when sample data is ticked (D-127)', async () => {
    const h = await makeHarness();
    const input = { ...firstRun, pin: '9876', confirmPin: '9876', loadSampleData: true };
    const results = await Promise.allSettled([completeFirstRun(h.ctx, input), completeFirstRun(h.ctx, input)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject({ code: 'CONFLICT' });
    const staff = await h.repos.staff.list({ includeDeleted: true });
    expect(staff.map((s) => s.role).sort()).toEqual(['manager', 'staff', 'supervisor']);
    expect(await h.repos.products.list()).toHaveLength(40);
  });

  it('loads the sample data in a second transaction when ticked (D-100)', async () => {
    const h = await makeHarness();
    const session = await completeFirstRun(h.ctx, { ...firstRun, loadSampleData: true });
    expect(await h.repos.categories.list()).toHaveLength(7);
    expect(await h.repos.products.list()).toHaveLength(40);
    expect(await h.repos.deals.list()).toHaveLength(2);
    expect(await h.repos.members.list()).toHaveLength(20);
    expect(await h.repos.bookings.list()).toHaveLength(2);
    expect((await h.repos.staff.list()).map((s) => s.role).sort()).toEqual(['manager', 'staff', 'supervisor']);
    expect(await h.repos.periods.getOpen()).toBeUndefined();
    const opening = await h.repos.stockMovements.list();
    expect(opening.length).toBeGreaterThan(0);
    expect(opening.every((m) => m.reason === 'goodsIn' && m.staffId === session.staffId && m.note === 'Opening stock')).toBe(true);
    expect((await login(h.ctx, PINS.staff))?.role).toBe('staff');
    expect((await login(h.ctx, PINS.supervisor))?.role).toBe('supervisor');
  });
});

describe('login (D-074)', () => {
  it('identifies the active staff member by PIN alone', async () => {
    const h = await makeHarness();
    const manager = await initialiseTill(h);
    const sue = await addStaff(h, 'Sue Supervisor', 'supervisor', PINS.supervisor);
    expect(await login(h.ctx, PINS.manager)).toEqual(manager);
    expect(await login(h.ctx, PINS.supervisor)).toEqual(sue);
    expect(await login(h.ctx, '9999')).toBeNull();
  });

  it('rejects malformed PINs without matching anyone', async () => {
    const h = await makeHarness();
    await initialiseTill(h);
    for (const pin of ['', '123', '1234567', '12a4', ' 1234']) expect(await login(h.ctx, pin)).toBeNull();
  });

  it('ignores inactive and deleted staff', async () => {
    const h = await makeHarness();
    await initialiseTill(h);
    await addStaff(h, 'Old Owen', 'staff', '4444', false);
    const deleted = await addStaff(h, 'Gone Gail', 'staff', '5555');
    await h.repos.staff.softDelete(deleted.staffId);
    expect(await login(h.ctx, '4444')).toBeNull();
    expect(await login(h.ctx, '5555')).toBeNull();
  });

  it('tries staff in createdAt then id order, so the earliest match wins', async () => {
    const h = await makeHarness();
    await initialiseTill(h);
    h.clock.advance(1000);
    const first = await addStaff(h, 'First', 'staff', '7777');
    h.clock.advance(1000);
    await addStaff(h, 'Second', 'supervisor', '7777');
    expect((await findStaffByPin(h.ctx, '7777'))?.id).toBe(first.staffId);
  });

  it('writes nothing', async () => {
    const h = await makeHarness();
    await initialiseTill(h);
    const before = await h.repos.exportAll();
    await login(h.ctx, PINS.manager);
    await login(h.ctx, '0000');
    expect(await h.repos.exportAll()).toEqual(before);
  });
});

describe('persistent storage (D-112)', () => {
  it('reports unsupported without a storage port', async () => {
    const h = await makeHarness();
    expect(await requestPersistentStorage(h.ctx)).toBe('unsupported');
    expect(await checkPersistentStorage(h.ctx)).toBe('unsupported');
  });

  it('requests persistence and reports a refusal or an error as notPersisted', async () => {
    const refused = fakeStorage({ persisted: false, grant: false });
    const h = await makeHarness({ storage: refused });
    expect(await requestPersistentStorage(h.ctx)).toBe('notPersisted');
    expect(await checkPersistentStorage(h.ctx)).toBe('notPersisted');
    expect(refused.persistCalls).toBe(2);

    const broken = await makeHarness({ storage: fakeStorage({ persisted: false, grant: true, fail: true }) });
    expect(await requestPersistentStorage(broken.ctx)).toBe('notPersisted');
    expect(await checkPersistentStorage(broken.ctx)).toBe('notPersisted');
  });

  it('checks persisted() first at app start and calls persist() only when needed', async () => {
    const already = fakeStorage({ persisted: true, grant: true });
    const h = await makeHarness({ storage: already });
    expect(await checkPersistentStorage(h.ctx)).toBe('persisted');
    expect(already.persistCalls).toBe(0);

    const granted = fakeStorage({ persisted: false, grant: true });
    const h2 = await makeHarness({ storage: granted });
    expect(await checkPersistentStorage(h2.ctx)).toBe('persisted');
    expect(granted.persistCalls).toBe(1);
  });

  it('warns managers only, and only when storage is not persisted', () => {
    const manager = { staffId: 'm', name: 'M', role: 'manager' } as const;
    const supervisor = { staffId: 's', name: 'S', role: 'supervisor' } as const;
    expect(shouldWarnAboutStorage('notPersisted', manager)).toBe(true);
    expect(shouldWarnAboutStorage('unsupported', manager)).toBe(true);
    expect(shouldWarnAboutStorage('persisted', manager)).toBe(false);
    expect(shouldWarnAboutStorage('notPersisted', supervisor)).toBe(false);
  });
});

describe('permissions and PIN override (spec §5; D-070..D-072)', () => {
  it('authorises directly only when the role allows the action', async () => {
    const t = await setupTill();
    expect(authoriseDirect(t.staff, 'sell')).toEqual({ action: 'sell', staffId: t.staff.staffId });
    expect(authoriseDirect(t.staff, 'voidLine')).toBeNull();
    expect(authoriseDirect(t.supervisor, 'voidLine')).toEqual({ action: 'voidLine', staffId: t.supervisor.staffId });
    expect(authoriseDirect(t.supervisor, 'refund')).toBeNull();
    expect(authoriseDirect(t.manager, 'backup')).toEqual({ action: 'backup', staffId: t.manager.staffId });
  });

  it('approves with the PIN of an active approver of sufficient role, recording both people', async () => {
    const t = await setupTill();
    const ctx = t.h.ctx;
    expect(await approveOverride(ctx, t.staff, 'voidLine', PINS.supervisor)).toEqual({
      action: 'voidLine',
      staffId: t.staff.staffId,
      approvedById: t.supervisor.staffId,
    });
    expect(await approveOverride(ctx, t.staff, 'voidLine', PINS.manager)).toMatchObject({ approvedById: t.manager.staffId });
    expect(await approveOverride(ctx, t.supervisor, 'refund', PINS.manager)).toMatchObject({ action: 'refund', approvedById: t.manager.staffId });
  });

  it('refuses an approver without the role, the requester’s own PIN, an unknown PIN or an inactive approver', async () => {
    const t = await setupTill();
    const ctx = t.h.ctx;
    expect(await approveOverride(ctx, t.staff, 'refund', PINS.supervisor)).toBeNull();
    expect(await approveOverride(ctx, t.staff, 'voidLine', PINS.staff)).toBeNull();
    expect(await approveOverride(ctx, t.staff, 'voidLine', '8080')).toBeNull();
    expect(await approveOverride(ctx, t.staff, 'voidLine', '22')).toBeNull();
    await t.h.repos.staff.update(t.supervisor.staffId, { active: false });
    expect(await approveOverride(ctx, t.staff, 'voidLine', PINS.supervisor)).toBeNull();
  });

  it('approves that one action only: an Authorisation for another action is refused', async () => {
    const t = await setupTill();
    const approval = await approveOverride(t.h.ctx, t.staff, 'voidLine', PINS.supervisor);
    if (approval === null) throw new Error('expected approval');
    expect(() => assertAuthorised(approval, 'noSale')).toThrow(/Not authorised/);
    await expectAppError(recordNoSale(t.h.ctx, approval), 'PERMISSION_DENIED');
    expect(await t.h.repos.auditEvents.listByType('noSale')).toEqual([]);
    expect(await t.h.repos.auditEvents.listByType('override')).toEqual([]);
  });

  it('writes the override event with the action, in the same transaction as the action (D-072)', async () => {
    const t = await setupTill();
    const approval = await approveOverride(t.h.ctx, t.staff, 'voidLine', PINS.supervisor);
    if (approval === null) throw new Error('expected approval');
    const period = await t.h.repos.periods.getOpen();
    await voidLine(t.h.ctx, approval, basket([[t.c.bitter, 1]]), t.c.bitter.id, 1);
    const events = await t.h.repos.auditEvents.list();
    const tail = events.slice(-2).map(({ type, staffId, approvedById, periodId, detail }) => ({ type, staffId, approvedById, periodId, detail }));
    expect(tail).toEqual([
      { type: 'override', staffId: t.staff.staffId, approvedById: t.supervisor.staffId, periodId: period?.id, detail: { action: 'voidLine' } },
      {
        type: 'void',
        staffId: t.staff.staffId,
        approvedById: t.supervisor.staffId,
        periodId: period?.id,
        detail: { productId: t.c.bitter.id, productName: 'Bitter', qty: 1, unitPricePence: 420 },
      },
    ]);
  });

  it('builds override events and audit actors', () => {
    const direct = { action: 'noSale', staffId: 'sue' } as const;
    const overridden = { action: 'noSale', staffId: 'sam', approvedById: 'sue' } as const;
    expect(overrideEvents(direct, 'p1')).toEqual([]);
    expect(overrideEvents(overridden, 'p1')).toEqual([
      { type: 'override', staffId: 'sam', approvedById: 'sue', periodId: 'p1', detail: { action: 'noSale' } },
    ]);
    expect(overrideEvents(overridden, undefined)).toEqual([{ type: 'override', staffId: 'sam', approvedById: 'sue', detail: { action: 'noSale' } }]);
    expect(auditActor(direct)).toEqual({ staffId: 'sue' });
    expect(Object.keys(auditActor(direct))).toEqual(['staffId']);
    expect(auditActor(overridden)).toEqual({ staffId: 'sam', approvedById: 'sue' });
  });
});
