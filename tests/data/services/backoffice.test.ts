/**
 * Back office: categories, products (priceChange audit), deals, staff and settings
 * (spec §5, §6.9; D-012, D-013, D-051, D-057, D-058, D-075, D-077, D-087, D-105).
 */
import { describe, expect, it } from 'vitest';
import type { NewProduct } from '../../../src/data/types';
import { login } from '../../../src/services/auth';
import {
  deleteCategory,
  listCategories,
  listDeals,
  listProducts,
  newProductDefaults,
  saveCategory,
  saveDeal,
  saveProduct,
  setDealActive,
  setProductActive,
} from '../../../src/services/catalogue';
import { approveOverride } from '../../../src/services/override';
import { getSettings, saveSettings } from '../../../src/services/settings';
import { verifyPin } from '../../../src/services/pin';
import { createStaff, listStaff, updateStaff } from '../../../src/services/staff';
import { auth, basket, card, expectAppError, makeHarness, PINS, registerCleanup, sell, setupTill, type Till } from './harness';

registerCleanup();

const cat = (t: Till) => auth(t.manager, 'editCatalogue');
const people = (t: Till) => auth(t.manager, 'manageMembersStaffSettings');

describe('categories (D-051, D-105)', () => {
  it('creates, renames, lists in order and rejects duplicate names', async () => {
    const t = await setupTill({ floatPence: null });
    const extra = await saveCategory(t.h.ctx, cat(t), null, { name: ' Hot  Food ', sortOrder: 2, colour: '#AABBCC' });
    expect(extra).toMatchObject({ name: 'Hot Food', colour: '#aabbcc' });
    expect((await listCategories(t.h.ctx)).map((c) => c.name)).toEqual(['Draught', 'Hot Food', 'Snacks', 'Wine', 'Events']);
    await expectAppError(saveCategory(t.h.ctx, cat(t), null, { name: 'hot food', sortOrder: 9, colour: '#000000' }), 'VALIDATION', 'Another category already has that name');
    const renamed = await saveCategory(t.h.ctx, cat(t), extra.id, { name: 'Hot Food', sortOrder: 9, colour: '#000000' });
    expect(renamed.sortOrder).toBe(9);
    await expectAppError(saveCategory(t.h.ctx, cat(t), null, { name: 'X', sortOrder: 1, colour: 'red' }), 'VALIDATION');
  });

  it('soft-deletes only categories no live product uses', async () => {
    const t = await setupTill({ floatPence: null });
    await expectAppError(deleteCategory(t.h.ctx, cat(t), t.c.draught.id), 'VALIDATION', 'Move or remove the products in this category first');
    const empty = await saveCategory(t.h.ctx, cat(t), null, { name: 'Empty', sortOrder: 5, colour: '#000000' });
    const deleted = await deleteCategory(t.h.ctx, cat(t), empty.id);
    expect(deleted.deletedAt).toBe(t.h.clock.iso());
    expect((await listCategories(t.h.ctx)).map((c) => c.name)).not.toContain('Empty');
    expect((await listCategories(t.h.ctx, { includeDeleted: true })).map((c) => c.name)).toContain('Empty');
    await expectAppError(deleteCategory(t.h.ctx, cat(t), empty.id), 'NOT_FOUND');
  });
});

describe('products and the priceChange audit (D-087, D-105)', () => {
  it('offers defaults for a new product in a category', async () => {
    const t = await setupTill({ floatPence: null });
    expect(await newProductDefaults(t.h.ctx, t.c.draught.id)).toEqual({
      name: '',
      categoryId: t.c.draught.id,
      pricePence: 0,
      vatRate: 20,
      memberDiscountEligible: true,
      stockTracked: true,
      stockUnit: 'unit',
      lowStockLevel: 0,
      buttonColour: '#b45309',
      sortOrder: 3,
      active: true,
    });
    const empty = await saveCategory(t.h.ctx, cat(t), null, { name: 'Empty', sortOrder: 5, colour: '#123456' });
    expect((await newProductDefaults(t.h.ctx, empty.id)).sortOrder).toBe(1);
    await expectAppError(newProductDefaults(t.h.ctx, 'missing'), 'NOT_FOUND');
  });

  it('writes priceChange only when an existing product’s price changes (D-087 example)', async () => {
    const t = await setupTill({ floatPence: null });
    const created = await saveProduct(t.h.ctx, cat(t), null, { ...(await newProductDefaults(t.h.ctx, t.c.draught.id)), name: 'Mild', pricePence: 390 });
    expect(await t.h.repos.auditEvents.list()).toEqual([]);

    const renamed = await saveProduct(t.h.ctx, cat(t), t.c.bitter.id, { ...t.c.bitter, name: 'Club Bitter', vatRate: 5 });
    expect(renamed).toMatchObject({ name: 'Club Bitter', vatRate: 5, pricePence: 420 });
    expect(await t.h.repos.auditEvents.list()).toEqual([]);

    await saveProduct(t.h.ctx, cat(t), t.c.bitter.id, { ...renamed, pricePence: 440 });
    const [event] = await t.h.repos.auditEvents.listByType('priceChange');
    expect(event).toMatchObject({
      staffId: t.manager.staffId,
      detail: { productId: t.c.bitter.id, productName: 'Club Bitter', oldPricePence: 420, newPricePence: 440 },
    });
    expect(event).not.toHaveProperty('periodId');
    expect(created.pricePence).toBe(390);
  });

  it('writes override + priceChange together when a supervisor is approved, with the open period', async () => {
    const t = await setupTill();
    const period = await t.h.repos.periods.getOpen();
    const approval = await approveOverride(t.h.ctx, t.supervisor, 'editCatalogue', PINS.manager);
    if (approval === null) throw new Error('expected approval');
    await saveProduct(t.h.ctx, approval, t.c.lager.id, { ...t.c.lager, pricePence: 460 });
    expect((await t.h.repos.auditEvents.list()).map((e) => [e.type, e.staffId, e.approvedById, e.periodId])).toEqual([
      ['override', t.supervisor.staffId, t.manager.staffId, period?.id],
      ['priceChange', t.supervisor.staffId, t.manager.staffId, period?.id],
    ]);
  });

  it('validates products, forcing the low-stock level to 0 when untracked', async () => {
    const t = await setupTill({ floatPence: null });
    const base: NewProduct = { ...(await newProductDefaults(t.h.ctx, t.c.snacks.id)), name: 'Nuts', pricePence: 150 };
    await expectAppError(saveProduct(t.h.ctx, cat(t), null, { ...base, name: 'crisps' }), 'VALIDATION', 'Another product already has that name');
    await expectAppError(saveProduct(t.h.ctx, cat(t), null, { ...base, pricePence: 1_000_000 }), 'VALIDATION');
    await expectAppError(saveProduct(t.h.ctx, cat(t), null, { ...base, vatRate: 17 }), 'VALIDATION', 'Choose a VAT rate');
    await expectAppError(saveProduct(t.h.ctx, cat(t), null, { ...base, categoryId: 'missing' }), 'VALIDATION', 'Choose a category');
    const untracked = await saveProduct(t.h.ctx, cat(t), null, { ...base, stockTracked: false, lowStockLevel: 5 });
    expect(untracked.lowStockLevel).toBe(0);
    await expectAppError(saveProduct(t.h.ctx, auth(t.manager, 'stockControl'), null, base), 'PERMISSION_DENIED');
    await expectAppError(saveProduct(t.h.ctx, cat(t), 'missing', base), 'NOT_FOUND');
  });

  it('deactivates and reactivates products and lists them by category then sort order', async () => {
    const t = await setupTill({ floatPence: null });
    expect((await setProductActive(t.h.ctx, cat(t), t.c.raffle.id, false)).active).toBe(false);
    expect((await listProducts(t.h.ctx)).map((p) => [p.name, p.active])).toEqual([
      ['Lager', true],
      ['Bitter', true],
      ['Crisps', true],
      ['Wine', true],
      ['Raffle Ticket', false],
    ]);
    expect((await setProductActive(t.h.ctx, cat(t), t.c.raffle.id, true)).active).toBe(true);
  });
});

describe('deals (D-012, D-013)', () => {
  it('converts local dates to the deal window and removes cleared fields on update (D-050)', async () => {
    const t = await setupTill({ floatPence: null });
    const deal = await saveDeal(t.h.ctx, cat(t), null, {
      name: 'October pints',
      type: 'nForPrice',
      n: 2,
      pricePence: 800,
      productIds: [t.c.lager.id, t.c.bitter.id, t.c.lager.id],
      active: true,
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });
    expect(deal).toMatchObject({
      productIds: [t.c.lager.id, t.c.bitter.id],
      startsAt: '2026-09-30T23:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
      pricePence: 800,
    });
    expect(deal).not.toHaveProperty('m');

    const edited = await saveDeal(t.h.ctx, cat(t), deal.id, {
      name: 'Pints 3 for 2',
      type: 'nForM',
      n: 3,
      m: 2,
      productIds: [t.c.lager.id],
      active: true,
      startDate: '2026-10-01',
    });
    expect(edited).toMatchObject({ name: 'Pints 3 for 2', type: 'nForM', n: 3, m: 2, startsAt: '2026-09-30T23:00:00.000Z' });
    expect(edited).not.toHaveProperty('pricePence');
    expect(edited).not.toHaveProperty('endsAt');
  });

  it('validates deals (D-013 examples)', async () => {
    const t = await setupTill({ floatPence: null });
    const base = { name: 'Deal', productIds: [t.c.lager.id], active: true };
    await expectAppError(saveDeal(t.h.ctx, cat(t), null, { ...base, type: 'nForM', n: 3, m: 3 }), 'VALIDATION');
    await expectAppError(saveDeal(t.h.ctx, cat(t), null, { ...base, type: 'nForPrice', n: 1, pricePence: 500 }), 'VALIDATION');
    await expectAppError(saveDeal(t.h.ctx, cat(t), null, { ...base, type: 'nForPrice', n: 2, pricePence: 0 }), 'VALIDATION');
    await expectAppError(saveDeal(t.h.ctx, cat(t), null, { ...base, type: 'nForM', n: 3, m: 2, productIds: [] }), 'VALIDATION', 'Choose at least one product');
    await expectAppError(
      saveDeal(t.h.ctx, cat(t), null, { ...base, type: 'nForM', n: 3, m: 2, startDate: '2026-10-02', endDate: '2026-10-01' }),
      'VALIDATION',
      'End date must be on or after the start date',
    );
    // D-126: a VALIDATION AppError, not a RangeError escaping transact().
    await expectAppError(
      saveDeal(t.h.ctx, cat(t), null, { ...base, type: 'nForM', n: 3, m: 2, endDate: '9999-12-31' }),
      'VALIDATION',
      'End date must be 30/12/9999 or earlier',
    );
    expect((await saveDeal(t.h.ctx, cat(t), null, { ...base, type: 'nForM', n: 3, m: 2 })).m).toBe(2);
  });

  it('lists deals in canonical order and deactivated deals stop applying', async () => {
    const t = await setupTill();
    t.h.clock.advance(1000);
    const second = await saveDeal(t.h.ctx, cat(t), null, { name: 'Bitter pair', type: 'nForPrice', n: 2, pricePence: 800, productIds: [t.c.bitter.id], active: true });
    expect((await listDeals(t.h.ctx)).map((d) => d.name)).toEqual(['Lager 3 for 2', 'Bitter pair']);
    await setDealActive(t.h.ctx, cat(t), t.c.lagerDeal.id, false);
    const { sale } = await sell(t.h.ctx, t.staff, basket([[t.c.lager, 3], [t.c.bitter, 2]]), [card(null)]);
    expect(sale.dealLines.map((d) => d.dealId)).toEqual([second.id]);
    expect(sale.totalPence).toBe(1350 + 800);
  });
});

describe('staff (D-073, D-075, D-077)', () => {
  it('creates staff with a unique PIN and never exposes PIN hashes', async () => {
    const t = await setupTill({ floatPence: null });
    const created = await createStaff(t.h.ctx, people(t), { name: ' Pat  Porter ', role: 'staff', pin: '4321', confirmPin: '4321' });
    expect(created).toEqual({ id: created.id, name: 'Pat Porter', role: 'staff', active: true, createdAt: t.h.clock.iso() });
    expect(await login(t.h.ctx, '4321')).toEqual({ staffId: created.id, name: 'Pat Porter', role: 'staff' });

    const list = await listStaff(t.h.ctx);
    expect(list.map((s) => s.name)).toEqual(['Morgan Manager', 'Pat Porter', 'Sam Staff', 'Sue Supervisor']);
    expect(JSON.stringify(list)).not.toMatch(/pinHash|pinSalt/);

    await expectAppError(createStaff(t.h.ctx, people(t), { name: 'Dup', role: 'staff', pin: PINS.supervisor, confirmPin: PINS.supervisor }), 'PIN_UNAVAILABLE', "That PIN can't be used — choose another");
    await expectAppError(createStaff(t.h.ctx, people(t), { name: 'Typo', role: 'staff', pin: '5555', confirmPin: '5556' }), 'VALIDATION', "PINs don't match");
    await expectAppError(createStaff(t.h.ctx, people(t), { name: '', role: 'staff', pin: '5555', confirmPin: '5555' }), 'VALIDATION');
    expect(await listStaff(t.h.ctx)).toHaveLength(4);
  });

  it('protects the last active manager and forbids changing your own role or deactivating yourself (D-077)', async () => {
    const t = await setupTill({ floatPence: null });
    const m = t.manager;
    await expectAppError(updateStaff(t.h.ctx, people(t), m.staffId, { name: m.name, role: 'supervisor', active: true }), 'LAST_MANAGER', "You can't change your own role");
    await expectAppError(updateStaff(t.h.ctx, people(t), m.staffId, { name: m.name, role: 'manager', active: false }), 'LAST_MANAGER', "You can't deactivate yourself");

    // A second manager cannot demote the only other manager... until there are two.
    const second = await createStaff(t.h.ctx, people(t), { name: 'Max Manager', role: 'manager', pin: '8888', confirmPin: '8888' });
    const asSecond = auth({ staffId: second.id, name: second.name, role: 'manager' }, 'manageMembersStaffSettings');
    const demoted = await updateStaff(t.h.ctx, asSecond, m.staffId, { name: m.name, role: 'supervisor', active: true });
    expect(demoted.role).toBe('supervisor');
    // Morgan (now a supervisor, approved by Max) cannot remove the last active manager.
    const approval = await approveOverride(t.h.ctx, { ...m, role: 'supervisor' }, 'manageMembersStaffSettings', '8888');
    if (approval === null) throw new Error('expected approval');
    await expectAppError(updateStaff(t.h.ctx, approval, second.id, { name: second.name, role: 'staff', active: true }), 'LAST_MANAGER', 'There must always be at least one active manager');
    await expectAppError(updateStaff(t.h.ctx, approval, second.id, { name: second.name, role: 'manager', active: false }), 'LAST_MANAGER');
    expect((await t.h.repos.staff.get(second.id))?.role).toBe('manager');
  });

  it('lets you change your own name and PIN', async () => {
    const t = await setupTill({ floatPence: null });
    const updated = await updateStaff(t.h.ctx, people(t), t.manager.staffId, {
      name: 'Morgan M',
      role: 'manager',
      active: true,
      newPin: { pin: '9876', confirmPin: '9876' },
    });
    expect(updated.name).toBe('Morgan M');
    expect(await login(t.h.ctx, PINS.manager)).toBeNull();
    expect((await login(t.h.ctx, '9876'))?.staffId).toBe(t.manager.staffId);
    // Resetting to your own current PIN is fine; someone else's is not.
    await updateStaff(t.h.ctx, people(t), t.manager.staffId, { name: 'Morgan M', role: 'manager', active: true, newPin: { pin: '9876', confirmPin: '9876' } });
    await expectAppError(
      updateStaff(t.h.ctx, people(t), t.manager.staffId, { name: 'Morgan M', role: 'manager', active: true, newPin: { pin: PINS.staff, confirmPin: PINS.staff } }),
      'PIN_UNAVAILABLE',
    );
  });

  it('deactivates staff, and reactivating needs a new PIN in the same save (D-075)', async () => {
    const t = await setupTill({ floatPence: null });
    const sam = t.staff;
    await updateStaff(t.h.ctx, people(t), sam.staffId, { name: sam.name, role: 'staff', active: false });
    expect(await login(t.h.ctx, PINS.staff)).toBeNull();
    await expectAppError(updateStaff(t.h.ctx, people(t), sam.staffId, { name: sam.name, role: 'staff', active: true }), 'VALIDATION', 'Set a new PIN to reactivate this member of staff');
    // While Sam is inactive his old PIN is free for someone else.
    await createStaff(t.h.ctx, people(t), { name: 'New Nia', role: 'staff', pin: PINS.staff, confirmPin: PINS.staff });
    await expectAppError(
      updateStaff(t.h.ctx, people(t), sam.staffId, { name: sam.name, role: 'staff', active: true, newPin: { pin: PINS.staff, confirmPin: PINS.staff } }),
      'PIN_UNAVAILABLE',
    );
    const back = await updateStaff(t.h.ctx, people(t), sam.staffId, { name: sam.name, role: 'staff', active: true, newPin: { pin: '6060', confirmPin: '6060' } });
    expect(back.active).toBe(true);
    expect((await login(t.h.ctx, '6060'))?.staffId).toBe(sam.staffId);
    await expectAppError(updateStaff(t.h.ctx, people(t), 'missing', { name: 'X', role: 'staff', active: true }), 'NOT_FOUND');
  });

  describe('overlapping saves never leave two active staff with one PIN (D-075, D-127)', () => {
    const conflict = { code: 'CONFLICT', message: 'Staff changed while saving — try again' };

    async function activeStaffWithPin(t: Till, pin: string): Promise<string[]> {
      const ids: string[] = [];
      for (const s of await t.h.repos.staff.list()) if (s.active && (await verifyPin(pin, s))) ids.push(s.id);
      return ids;
    }

    it('rejects the second of two double-submitted creates', async () => {
      const t = await setupTill({ floatPence: null });
      const input = { name: 'Sam', role: 'staff', pin: '5555', confirmPin: '5555' } as const;
      const results = await Promise.allSettled([createStaff(t.h.ctx, people(t), input), createStaff(t.h.ctx, people(t), input)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const created = results.find((r) => r.status === 'fulfilled');
      expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject(conflict);
      expect((await t.h.repos.staff.list()).filter((s) => s.name === 'Sam')).toHaveLength(1);
      expect((await login(t.h.ctx, '5555'))?.staffId).toBe(created?.status === 'fulfilled' ? created.value.id : 'none');
      // Trying again gives the ordinary answer.
      await expectAppError(createStaff(t.h.ctx, people(t), input), 'PIN_UNAVAILABLE');
    });

    it('rejects a PIN reset that overlaps a create with the same PIN', async () => {
      const t = await setupTill({ floatPence: null });
      const sam = t.staff;
      const results = await Promise.allSettled([
        createStaff(t.h.ctx, people(t), { name: 'Pat', role: 'staff', pin: '7070', confirmPin: '7070' }),
        updateStaff(t.h.ctx, people(t), sam.staffId, { name: sam.name, role: 'staff', active: true, newPin: { pin: '7070', confirmPin: '7070' } }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject(conflict);
      expect(await activeStaffWithPin(t, '7070')).toHaveLength(1);
    });

    it('rejects the second of two overlapping PIN resets to the same PIN', async () => {
      const t = await setupTill({ floatPence: null });
      const reset = (who: typeof t.staff) =>
        updateStaff(t.h.ctx, people(t), who.staffId, { name: who.name, role: who.role, active: true, newPin: { pin: '8181', confirmPin: '8181' } });
      const results = await Promise.allSettled([reset(t.staff), reset(t.supervisor)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject(conflict);
      expect(await activeStaffWithPin(t, '8181')).toHaveLength(1);
      // The loser keeps its old PIN.
      const loggedIn = [await login(t.h.ctx, PINS.staff), await login(t.h.ctx, PINS.supervisor)].filter((s) => s !== null);
      expect(loggedIn).toHaveLength(1);
    });

    it('still lets a save through when other staff changed only their name or role meanwhile', async () => {
      const t = await setupTill({ floatPence: null });
      const sue = t.supervisor;
      const [created, renamed] = await Promise.all([
        createStaff(t.h.ctx, people(t), { name: 'Pat', role: 'staff', pin: '7171', confirmPin: '7171' }),
        updateStaff(t.h.ctx, people(t), sue.staffId, { name: 'Sue S', role: 'manager', active: true }),
      ]);
      expect(created.name).toBe('Pat');
      expect(renamed).toMatchObject({ name: 'Sue S', role: 'manager' });
    });
  });
});

describe('settings (D-057, D-058)', () => {
  it('throws NOT_INITIALISED before setup', async () => {
    const h = await makeHarness();
    await expectAppError(getSettings(h.ctx), 'NOT_INITIALISED');
  });

  it('saves the editable settings, never the receipt counter, and the prefix change keeps numbering (D-058)', async () => {
    const t = await setupTill();
    await sell(t.h.ctx, t.staff, basket([[t.c.lager, 1]]), [card(null)]);
    const saved = await saveSettings(t.h.ctx, people(t), {
      clubName: ' Oakfield  GC ',
      receiptFooter: ' Thanks!\nSee you soon ',
      autoLockMinutes: 10,
      memberDiscountPercent: 10,
      devicePrefix: 'bar1',
    });
    expect(saved).toMatchObject({ clubName: 'Oakfield GC', receiptFooter: 'Thanks!\nSee you soon', autoLockMinutes: 10, memberDiscountPercent: 10, devicePrefix: 'BAR1', receiptCounter: 1 });
    const { sale } = await sell(t.h.ctx, t.staff, basket([[t.c.lager, 1]]), [card(null)]);
    expect(sale.receiptNumber).toBe('BAR1-000002');

    await expectAppError(saveSettings(t.h.ctx, people(t), { ...saved, devicePrefix: 'BAR-1' }), 'VALIDATION', 'Device prefix must be 1 to 6 letters or digits');
    await expectAppError(saveSettings(t.h.ctx, people(t), { ...saved, autoLockMinutes: 0 }), 'VALIDATION');
    await expectAppError(saveSettings(t.h.ctx, people(t), { ...saved, memberDiscountPercent: 101 }), 'VALIDATION');
    await expectAppError(saveSettings(t.h.ctx, auth(t.manager, 'backup'), saved), 'PERMISSION_DENIED');
    expect((await getSettings(t.h.ctx)).devicePrefix).toBe('BAR1');
  });
});
