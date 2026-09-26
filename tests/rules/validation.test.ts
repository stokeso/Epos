import { describe, expect, it } from 'vitest';
import type { Member, NewProduct, Staff, Tab } from '../../src/data/types';
import {
  canDeleteCategory,
  isValidPinFormat,
  tabDisplayLabel,
  validateBooking,
  validateCashAmount,
  validateCategory,
  validateDeal,
  validateDepositAmount,
  validateFirstRun,
  validateGoodsIn,
  validateMember,
  validateNewPin,
  validateProduct,
  validateSettings,
  validateStaffDetails,
  validateStockAdjustment,
  validateTabLabel,
  type DealFormInput,
  type FieldErrors,
  type Validation,
} from '../../src/rules/validation';
import { DEVICE, T0, makeCategory, makeProduct } from './fixtures';

function errorsOf<T>(r: Validation<T>): FieldErrors {
  if (r.ok) throw new Error(`expected errors, got ${JSON.stringify(r.value)}`);
  return r.errors;
}
function valueOf<T>(r: Validation<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.value;
}
const DELETED = '2026-09-20T00:00:00.000Z';

describe('PINs (D-073)', () => {
  it.each([
    ['1234', true],
    ['123456', true],
    ['0000', true],
    ['123', false],
    ['1234567', false],
    ['12a4', false],
    [' 1234', false],
    ['', false],
    ['１２３４', false], // full-width digits
  ])('isValidPinFormat(%j) = %s', (pin, ok) => {
    expect(isValidPinFormat(pin)).toBe(ok);
  });

  it('validateNewPin checks the format and the confirmation', () => {
    expect(validateNewPin('1234', '1234')).toEqual({ ok: true, value: '1234' });
    expect(Object.keys(errorsOf(validateNewPin('12', '12')))).toEqual(['pin']);
    expect(Object.keys(errorsOf(validateNewPin('1234', '1235')))).toEqual(['confirmPin']);
  });
});

describe('validateProduct (D-105)', () => {
  const categories = [makeCategory('cat-draught', { colour: '#b45309' }), makeCategory('cat-old', { deletedAt: DELETED })];
  const products = [makeProduct('p-bitter', { name: 'Club Bitter' }), makeProduct('p-gone', { name: 'Old Ale', deletedAt: DELETED })];
  const input: NewProduct = {
    name: '  Fairway   Lager ',
    categoryId: 'cat-draught',
    pricePence: 480,
    vatRate: 20,
    memberDiscountEligible: true,
    stockTracked: true,
    stockUnit: ' pint ',
    lowStockLevel: 22,
    buttonColour: '#B45309',
    sortOrder: 2,
    active: true,
  };
  const ctx = { products, categories };

  it('normalises and accepts a valid product', () => {
    expect(valueOf(validateProduct(input, ctx))).toEqual({
      ...input,
      name: 'Fairway Lager',
      stockUnit: 'pint',
      buttonColour: '#b45309',
    });
  });

  it('forces lowStockLevel to 0 for untracked products', () => {
    expect(valueOf(validateProduct({ ...input, stockTracked: false, lowStockLevel: 5 }, ctx)).lowStockLevel).toBe(0);
    expect(valueOf(validateProduct({ ...input, stockTracked: false, lowStockLevel: -3 }, ctx)).lowStockLevel).toBe(0);
  });

  it('requires a case-insensitively unique name among non-deleted products', () => {
    expect(errorsOf(validateProduct({ ...input, name: 'club  BITTER' }, ctx))).toHaveProperty('name');
    // Editing the same record keeps its name.
    expect(validateProduct({ ...input, name: 'Club Bitter' }, { ...ctx, editingId: 'p-bitter' }).ok).toBe(true);
    // A deleted product's name can be reused.
    expect(validateProduct({ ...input, name: 'Old Ale' }, ctx).ok).toBe(true);
  });

  it.each<[string, Partial<NewProduct>, string]>([
    ['an empty name', { name: '   ' }, 'name'],
    ['a 41-character name', { name: 'x'.repeat(41) }, 'name'],
    ['a deleted category', { categoryId: 'cat-old' }, 'categoryId'],
    ['an unknown category', { categoryId: 'cat-nope' }, 'categoryId'],
    ['a negative price', { pricePence: -1 }, 'pricePence'],
    ['a fractional price', { pricePence: 4.5 }, 'pricePence'],
    ['a price above £9,999.99', { pricePence: 1_000_000 }, 'pricePence'],
    ['VAT 17.5', { vatRate: 17.5 }, 'vatRate'],
    ['VAT 10', { vatRate: 10 }, 'vatRate'],
    ['an empty unit', { stockUnit: ' ' }, 'stockUnit'],
    ['a 21-character unit', { stockUnit: 'u'.repeat(21) }, 'stockUnit'],
    ['a negative low-stock level', { lowStockLevel: -1 }, 'lowStockLevel'],
    ['a low-stock level above 9999', { lowStockLevel: 10_000 }, 'lowStockLevel'],
    ['a bad colour', { buttonColour: 'red' }, 'buttonColour'],
    ['a short colour', { buttonColour: '#abc' }, 'buttonColour'],
    ['a fractional sort order', { sortOrder: 1.5 }, 'sortOrder'],
  ])('rejects %s', (_label, patch, field) => {
    expect(errorsOf(validateProduct({ ...input, ...patch }, ctx))).toHaveProperty(field);
  });

  it('accepts the boundaries', () => {
    for (const patch of [{ pricePence: 0 }, { pricePence: 999_999 }, { name: 'x'.repeat(40) }, { vatRate: 5 }, { vatRate: 0 }, { lowStockLevel: 9999 }, { sortOrder: -3 }]) {
      expect(validateProduct({ ...input, ...patch }, ctx).ok).toBe(true);
    }
  });
});

describe('validateCategory and canDeleteCategory (D-105, D-051)', () => {
  const categories = [makeCategory('cat-draught', { name: 'Draught' }), makeCategory('cat-old', { name: 'Old', deletedAt: DELETED })];

  it('normalises and accepts a valid category', () => {
    expect(valueOf(validateCategory({ name: ' Soft  Drinks ', sortOrder: 5, colour: '#0369A1' }, { categories }))).toEqual({
      name: 'Soft Drinks',
      sortOrder: 5,
      colour: '#0369a1',
    });
  });

  it('checks the name, sort order and colour', () => {
    expect(errorsOf(validateCategory({ name: 'DRAUGHT', sortOrder: 1, colour: '#000000' }, { categories }))).toHaveProperty('name');
    expect(validateCategory({ name: 'DRAUGHT', sortOrder: 1, colour: '#000000' }, { categories, editingId: 'cat-draught' }).ok).toBe(true);
    expect(validateCategory({ name: 'old', sortOrder: 1, colour: '#000000' }, { categories }).ok).toBe(true);
    expect(errorsOf(validateCategory({ name: 'y'.repeat(31), sortOrder: 1, colour: '#000000' }, { categories }))).toHaveProperty('name');
    expect(errorsOf(validateCategory({ name: 'Snacks', sortOrder: 0.5, colour: '#000000' }, { categories }))).toHaveProperty('sortOrder');
    expect(errorsOf(validateCategory({ name: 'Snacks', sortOrder: 1, colour: '000000' }, { categories }))).toHaveProperty('colour');
  });

  it('allows deleting a category only when no live product uses it', () => {
    const products = [makeProduct('a', { categoryId: 'cat-draught' }), makeProduct('b', { categoryId: 'cat-old', deletedAt: DELETED })];
    expect(canDeleteCategory('cat-draught', products)).toBe(false);
    expect(canDeleteCategory('cat-old', products)).toBe(true);
    expect(canDeleteCategory('cat-empty', products)).toBe(true);
  });
});

describe('validateDeal (D-013, D-012)', () => {
  const products = [makeProduct('birdie'), makeProduct('bogey'), makeProduct('gone', { deletedAt: DELETED })];
  const base: DealFormInput = {
    name: ' Any 2 bottles  for £8 ',
    type: 'nForPrice',
    n: 2,
    pricePence: 800,
    productIds: ['birdie', 'bogey', 'birdie'],
    active: true,
  };

  it('normalises and accepts an nForPrice deal, omitting absent fields', () => {
    const deal = valueOf(validateDeal(base, { products }));
    expect(deal).toEqual({ name: 'Any 2 bottles for £8', type: 'nForPrice', n: 2, pricePence: 800, productIds: ['birdie', 'bogey'], active: true });
    expect(Object.keys(deal)).not.toContain('m');
    expect(Object.keys(deal)).not.toContain('startsAt');
    expect(Object.keys(deal)).not.toContain('endsAt');
  });

  it('accepts nForM {n:3, m:2} and converts dates to the London window', () => {
    const deal = valueOf(
      validateDeal(
        { name: 'Snacks 3 for 2', type: 'nForM', n: 3, m: 2, productIds: ['birdie'], active: false, startDate: '2026-10-01', endDate: '2026-10-31' },
        { products },
      ),
    );
    expect(deal).toEqual({
      name: 'Snacks 3 for 2',
      type: 'nForM',
      n: 3,
      m: 2,
      productIds: ['birdie'],
      active: false,
      startsAt: '2026-09-30T23:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
    });
    expect(Object.keys(deal)).not.toContain('pricePence');
  });

  it.each<[string, Partial<DealFormInput>, string]>([
    ['nForM with m = n', { type: 'nForM', n: 3, m: 3, pricePence: undefined }, 'm'],
    ['nForM with m = 0', { type: 'nForM', n: 3, m: 0, pricePence: undefined }, 'm'],
    ['nForM without m', { type: 'nForM', n: 3, pricePence: undefined }, 'm'],
    ['nForM with a price', { type: 'nForM', n: 3, m: 2, pricePence: 800 }, 'pricePence'],
    ['nForPrice with n = 1', { n: 1, pricePence: 500 }, 'n'],
    ['nForPrice with n = 100', { n: 100 }, 'n'],
    ['nForPrice with a fractional n', { n: 2.5 }, 'n'],
    ['nForPrice priced at 0', { pricePence: 0 }, 'pricePence'],
    ['nForPrice priced above £9,999.99', { pricePence: 1_000_000 }, 'pricePence'],
    ['nForPrice without a price', { pricePence: undefined }, 'pricePence'],
    ['nForPrice with an m', { m: 1 }, 'm'],
    ['an unknown type', { type: 'bogof' as DealFormInput['type'] }, 'type'],
    ['an empty name', { name: '  ' }, 'name'],
    ['a 41-character name', { name: 'd'.repeat(41) }, 'name'],
    ['no products', { productIds: [] }, 'productIds'],
    ['a deleted product', { productIds: ['birdie', 'gone'] }, 'productIds'],
    ['an unknown product', { productIds: ['nope'] }, 'productIds'],
    ['an end date before the start date', { startDate: '2026-10-02', endDate: '2026-10-01' }, 'endDate'],
    ['a malformed start date', { startDate: '2026-02-30' }, 'startDate'],
    // D-126: the window ends at the start of the next day, and '10000-01-01' has no YYYY-MM-DD form.
    ['an end date of 31/12/9999', { endDate: '9999-12-31' }, 'endDate'],
    ['an end date of 31/12/9999 after a start date', { startDate: '2026-10-01', endDate: '9999-12-31' }, 'endDate'],
  ])('rejects %s', (_label, patch, field) => {
    expect(errorsOf(validateDeal({ ...base, ...patch }, { products }))).toHaveProperty(field);
  });

  it('returns a result, never a RangeError, for the last dates a date input offers (D-117, D-126)', () => {
    expect(() => validateDeal({ ...base, endDate: '9999-12-31' }, { products })).not.toThrow();
    expect(errorsOf(validateDeal({ ...base, endDate: '9999-12-31' }, { products }))).toEqual({
      endDate: 'End date must be 30/12/9999 or earlier',
    });
    expect(valueOf(validateDeal({ ...base, endDate: '9999-12-30' }, { products }))).toMatchObject({ endsAt: '9999-12-31T00:00:00.000Z' });
    expect(valueOf(validateDeal({ ...base, startDate: '9999-12-31' }, { products }))).toMatchObject({ startsAt: '9999-12-31T00:00:00.000Z' });
  });

  it('allows a one-day window and a deal priced so high it never applies', () => {
    expect(validateDeal({ ...base, startDate: '2026-10-01', endDate: '2026-10-01' }, { products }).ok).toBe(true);
    expect(validateDeal({ ...base, pricePence: 999_999 }, { products }).ok).toBe(true);
  });
});

describe('validateMember (D-105)', () => {
  const member = (id: string, memberNumber: string, deletedAt?: string): Member => ({
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    memberNumber,
    firstName: 'A',
    lastName: 'B',
    active: true,
    ...(deletedAt ? { deletedAt } : {}),
  });
  const members = [member('m1', '1001'), member('m2', 'OLD-1', DELETED)];

  it('normalises and accepts a member', () => {
    expect(valueOf(validateMember({ memberNumber: ' ab-12 ', firstName: ' Alice ', lastName: 'Archer  Smith', active: true }, { members }))).toEqual({
      memberNumber: 'AB-12',
      firstName: 'Alice',
      lastName: 'Archer Smith',
      active: true,
    });
  });

  it('requires a unique member number among non-deleted members', () => {
    expect(errorsOf(validateMember({ memberNumber: '1001', firstName: 'X', lastName: 'Y', active: true }, { members }))).toHaveProperty('memberNumber');
    expect(validateMember({ memberNumber: '1001', firstName: 'X', lastName: 'Y', active: true }, { members, editingId: 'm1' }).ok).toBe(true);
    expect(validateMember({ memberNumber: 'old-1', firstName: 'X', lastName: 'Y', active: true }, { members }).ok).toBe(true);
  });

  it('rejects bad numbers and names', () => {
    const ok = { memberNumber: '1021', firstName: 'X', lastName: 'Y', active: true };
    expect(errorsOf(validateMember({ ...ok, memberNumber: '' }, { members }))).toHaveProperty('memberNumber');
    expect(errorsOf(validateMember({ ...ok, memberNumber: '1234567890123' }, { members }))).toHaveProperty('memberNumber');
    expect(errorsOf(validateMember({ ...ok, memberNumber: '10 21' }, { members }))).toHaveProperty('memberNumber');
    expect(errorsOf(validateMember({ ...ok, memberNumber: '#1021' }, { members }))).toHaveProperty('memberNumber');
    expect(errorsOf(validateMember({ ...ok, firstName: ' ' }, { members }))).toHaveProperty('firstName');
    expect(errorsOf(validateMember({ ...ok, lastName: 'z'.repeat(41) }, { members }))).toHaveProperty('lastName');
  });
});

describe('validateStaffDetails (D-077)', () => {
  const staffMember = (id: string, role: Staff['role'], active = true, deletedAt?: string): Staff => ({
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    name: id,
    role,
    pinHash: 'h',
    pinSalt: 's',
    active,
    ...(deletedAt ? { deletedAt } : {}),
  });
  const staff = [staffMember('morgan', 'manager'), staffMember('sue', 'supervisor'), staffMember('sam', 'staff'), staffMember('old-boss', 'manager', false)];

  it('normalises and accepts details', () => {
    expect(valueOf(validateStaffDetails({ name: ' Sam  Staff ', role: 'staff', active: true }, { staff, editingId: 'sam', actingStaffId: 'morgan' }))).toEqual({
      name: 'Sam Staff',
      role: 'staff',
      active: true,
    });
    expect(validateStaffDetails({ name: 'New', role: 'staff', active: true }, { staff, actingStaffId: 'morgan' }).ok).toBe(true);
  });

  it('rejects bad names', () => {
    expect(errorsOf(validateStaffDetails({ name: ' ', role: 'staff', active: true }, { staff, actingStaffId: 'morgan' }))).toHaveProperty('name');
    expect(errorsOf(validateStaffDetails({ name: 'n'.repeat(41), role: 'staff', active: true }, { staff, actingStaffId: 'morgan' }))).toHaveProperty('name');
  });

  it('never leaves no active manager (LAST_MANAGER)', () => {
    // Demoting or deactivating the only active manager (acting as someone else) is rejected.
    expect(errorsOf(validateStaffDetails({ name: 'Morgan', role: 'supervisor', active: true }, { staff, editingId: 'morgan', actingStaffId: 'sue' }))).toHaveProperty('role');
    expect(errorsOf(validateStaffDetails({ name: 'Morgan', role: 'manager', active: false }, { staff, editingId: 'morgan', actingStaffId: 'sue' }))).toHaveProperty('active');
    // With a second active manager it is allowed.
    const twoManagers = [...staff, staffMember('max', 'manager')];
    expect(validateStaffDetails({ name: 'Morgan', role: 'supervisor', active: true }, { staff: twoManagers, editingId: 'morgan', actingStaffId: 'max' }).ok).toBe(true);
    // A soft-deleted manager does not count.
    const deletedManager = [...staff, staffMember('ghost', 'manager', true, DELETED)];
    expect(validateStaffDetails({ name: 'Morgan', role: 'staff', active: true }, { staff: deletedManager, editingId: 'morgan', actingStaffId: 'sue' }).ok).toBe(false);
    // Promoting someone else to manager is fine.
    expect(validateStaffDetails({ name: 'Sue', role: 'manager', active: true }, { staff, editingId: 'sue', actingStaffId: 'morgan' }).ok).toBe(true);
  });

  it('stops users changing their own role or deactivating themselves', () => {
    const twoManagers = [...staff, staffMember('max', 'manager')];
    expect(errorsOf(validateStaffDetails({ name: 'Max', role: 'staff', active: true }, { staff: twoManagers, editingId: 'max', actingStaffId: 'max' }))).toHaveProperty('role');
    expect(errorsOf(validateStaffDetails({ name: 'Max', role: 'manager', active: false }, { staff: twoManagers, editingId: 'max', actingStaffId: 'max' }))).toHaveProperty('active');
    // But they can change their own name.
    expect(validateStaffDetails({ name: 'Maxine', role: 'manager', active: true }, { staff: twoManagers, editingId: 'max', actingStaffId: 'max' }).ok).toBe(true);
  });
});

describe('validateSettings (D-105, D-058)', () => {
  const ok = { clubName: ' Oakfield  Golf Club ', receiptFooter: '  Thank you\n  See you soon ', autoLockMinutes: 5, memberDiscountPercent: 15, devicePrefix: ' bar1 ' };

  it('normalises and accepts settings (footer newlines kept)', () => {
    expect(valueOf(validateSettings(ok))).toEqual({
      clubName: 'Oakfield Golf Club',
      receiptFooter: 'Thank you\n  See you soon',
      autoLockMinutes: 5,
      memberDiscountPercent: 15,
      devicePrefix: 'BAR1',
    });
    expect(valueOf(validateSettings({ ...ok, receiptFooter: '' })).receiptFooter).toBe('');
  });

  it.each<[string, Partial<typeof ok>, string]>([
    ['an empty club name', { clubName: ' ' }, 'clubName'],
    ['a 41-character club name', { clubName: 'c'.repeat(41) }, 'clubName'],
    ['a 201-character footer', { receiptFooter: 'f'.repeat(201) }, 'receiptFooter'],
    ['auto-lock 0', { autoLockMinutes: 0 }, 'autoLockMinutes'],
    ['auto-lock 61', { autoLockMinutes: 61 }, 'autoLockMinutes'],
    ['auto-lock 1.5', { autoLockMinutes: 1.5 }, 'autoLockMinutes'],
    ['discount 101', { memberDiscountPercent: 101 }, 'memberDiscountPercent'],
    ['discount -1', { memberDiscountPercent: -1 }, 'memberDiscountPercent'],
    ['discount 12.5', { memberDiscountPercent: 12.5 }, 'memberDiscountPercent'],
    ['a hyphenated prefix', { devicePrefix: 'BAR-1' }, 'devicePrefix'],
    ['a 7-character prefix', { devicePrefix: 'ABCDEFG' }, 'devicePrefix'],
    ['an empty prefix', { devicePrefix: '' }, 'devicePrefix'],
  ])('rejects %s', (_label, patch, field) => {
    expect(errorsOf(validateSettings({ ...ok, ...patch }))).toHaveProperty(field);
  });

  it('accepts the boundaries', () => {
    for (const patch of [{ autoLockMinutes: 1 }, { autoLockMinutes: 60 }, { memberDiscountPercent: 0 }, { memberDiscountPercent: 100 }, { devicePrefix: 'ABCDEF' }, { receiptFooter: 'f'.repeat(200) }]) {
      expect(validateSettings({ ...ok, ...patch }).ok).toBe(true);
    }
  });
});

describe('validateBooking (D-026)', () => {
  it('normalises and returns an open booking', () => {
    expect(valueOf(validateBooking({ type: 'wedding', name: ' Smith &  Jones Wedding ', date: '2026-10-26', notes: '  Evening reception ' }))).toEqual({
      type: 'wedding',
      name: 'Smith & Jones Wedding',
      date: '2026-10-26',
      notes: 'Evening reception',
      status: 'open',
    });
    expect(valueOf(validateBooking({ type: 'other', name: 'X', date: '2026-10-26', notes: '   ' })).notes).toBe('');
  });

  it('rejects bad fields', () => {
    const ok = { type: 'society' as const, name: 'Seniors', date: '2026-10-10', notes: '' };
    expect(errorsOf(validateBooking({ ...ok, name: '' }))).toHaveProperty('name');
    expect(errorsOf(validateBooking({ ...ok, name: 'n'.repeat(61) }))).toHaveProperty('name');
    expect(errorsOf(validateBooking({ ...ok, date: '2026-02-30' }))).toHaveProperty('date');
    expect(errorsOf(validateBooking({ ...ok, date: '10/10/2026' }))).toHaveProperty('date');
    expect(errorsOf(validateBooking({ ...ok, notes: 'n'.repeat(501) }))).toHaveProperty('notes');
    expect(errorsOf(validateBooking({ ...ok, type: 'party' as 'other' }))).toHaveProperty('type');
    expect(validateBooking({ ...ok, notes: 'n'.repeat(500), name: 'n'.repeat(60) }).ok).toBe(true);
  });

  it('accepts any real date the backup validator accepts, including years 0000-0099 (D-129)', () => {
    const ok = { type: 'wedding' as const, name: 'Smith wedding', notes: '' };
    expect(valueOf(validateBooking({ ...ok, date: '0026-10-10' })).date).toBe('0026-10-10');
    expect(validateBooking({ ...ok, date: '0000-02-29' }).ok).toBe(true);
    expect(errorsOf(validateBooking({ ...ok, date: '0100-02-29' }))).toHaveProperty('date');
  });
});

describe('tab labels (D-064)', () => {
  const tab = (id: string, labelType: Tab['labelType'], label: string, extra: Partial<Tab> = {}): Tab => ({
    id,
    deviceId: DEVICE,
    createdAt: T0,
    updatedAt: T0,
    labelType,
    label,
    openedAt: T0,
    openedBy: 'sam',
    status: 'open',
    lines: [],
    ...extra,
  });
  const openTabs = [tab('t1', 'name', 'Smith'), tab('t2', 'table', '5'), tab('t3', 'name', 'Jones', { status: 'settled' }), tab('t4', 'name', 'Brown', { deletedAt: DELETED })];

  it('normalises labels', () => {
    expect(validateTabLabel('name', '  Mr   Green ', { openTabs })).toEqual({ ok: true, value: 'Mr Green' });
    expect(validateTabLabel('table', ' 12 - A ', { openTabs })).toEqual({ ok: true, value: '12 - A' });
  });

  it('requires unique (type, case-insensitive label) among open tabs', () => {
    // With a name tab "Smith" open, 'smith ' is rejected as a name tab.
    expect(errorsOf(validateTabLabel('name', 'smith ', { openTabs }))).toHaveProperty('label');
    // A table tab "5" and a name tab "5" can coexist.
    expect(validateTabLabel('name', '5', { openTabs }).ok).toBe(true);
    expect(errorsOf(validateTabLabel('table', '5', { openTabs }))).toHaveProperty('label');
    // Settled or deleted tabs free their label; the tab itself can be excepted.
    expect(validateTabLabel('name', 'Jones', { openTabs }).ok).toBe(true);
    expect(validateTabLabel('name', 'brown', { openTabs }).ok).toBe(true);
    expect(validateTabLabel('name', 'Smith', { openTabs, exceptTabId: 't1' }).ok).toBe(true);
  });

  it('checks lengths and table characters', () => {
    expect(validateTabLabel('name', 'n'.repeat(30), { openTabs }).ok).toBe(true);
    expect(errorsOf(validateTabLabel('name', 'n'.repeat(31), { openTabs }))).toHaveProperty('label');
    expect(errorsOf(validateTabLabel('name', '   ', { openTabs }))).toHaveProperty('label');
    expect(validateTabLabel('table', 'Terrace 10', { openTabs }).ok).toBe(true);
    expect(errorsOf(validateTabLabel('table', 'Terrace 100', { openTabs }))).toHaveProperty('label');
    expect(errorsOf(validateTabLabel('table', '#5', { openTabs }))).toHaveProperty('label');
  });

  it('displays table labels as "Table {label}"', () => {
    expect(tabDisplayLabel({ labelType: 'name', label: 'Smith' })).toBe('Smith');
    expect(tabDisplayLabel({ labelType: 'table', label: '5' })).toBe('Table 5');
  });
});

describe('stock forms (D-080, D-081)', () => {
  it('goods in: qty 1..9999 and a note of up to 100 characters', () => {
    expect(validateGoodsIn({ productId: 'lager', qty: 24, note: '  Delivery ' })).toEqual({ ok: true, value: { productId: 'lager', qty: 24, note: 'Delivery' } });
    expect(validateGoodsIn({ productId: 'lager', qty: 9999, note: '' }).ok).toBe(true);
    expect(errorsOf(validateGoodsIn({ productId: 'lager', qty: 0, note: '' }))).toHaveProperty('qty');
    expect(errorsOf(validateGoodsIn({ productId: 'lager', qty: 10_000, note: '' }))).toHaveProperty('qty');
    expect(errorsOf(validateGoodsIn({ productId: 'lager', qty: 1.5, note: '' }))).toHaveProperty('qty');
    expect(errorsOf(validateGoodsIn({ productId: 'lager', qty: 1, note: 'n'.repeat(101) }))).toHaveProperty('note');
    expect(errorsOf(validateGoodsIn({ productId: ' ', qty: 1, note: '' }))).toHaveProperty('productId');
  });

  it('adjustments are signed and non-zero; waste is entered positive and stored negative', () => {
    expect(valueOf(validateStockAdjustment({ productId: 'bitter', kind: 'adjustment', qty: -3, note: 'Count' }))).toEqual({
      productId: 'bitter',
      reason: 'adjustment',
      qty: -3,
      note: 'Count',
    });
    // Waste 2 x Club Bitter "Spilt" -> qty -2, reason waste.
    expect(valueOf(validateStockAdjustment({ productId: 'bitter', kind: 'waste', qty: 2, note: ' Spilt ' }))).toEqual({
      productId: 'bitter',
      reason: 'waste',
      qty: -2,
      note: 'Spilt',
    });
    expect(validateStockAdjustment({ productId: 'bitter', kind: 'adjustment', qty: 9999, note: 'x' }).ok).toBe(true);
    expect(validateStockAdjustment({ productId: 'bitter', kind: 'adjustment', qty: -9999, note: 'x' }).ok).toBe(true);
    expect(errorsOf(validateStockAdjustment({ productId: 'bitter', kind: 'adjustment', qty: 0, note: 'x' }))).toHaveProperty('qty');
    expect(errorsOf(validateStockAdjustment({ productId: 'bitter', kind: 'adjustment', qty: 10_000, note: 'x' }))).toHaveProperty('qty');
    expect(errorsOf(validateStockAdjustment({ productId: 'bitter', kind: 'waste', qty: -2, note: 'x' }))).toHaveProperty('qty');
    expect(errorsOf(validateStockAdjustment({ productId: 'bitter', kind: 'waste', qty: 0, note: 'x' }))).toHaveProperty('qty');
    expect(errorsOf(validateStockAdjustment({ productId: 'bitter', kind: 'waste', qty: 2, note: '  ' }))).toHaveProperty('note');
    expect(errorsOf(validateStockAdjustment({ productId: 'bitter', kind: 'waste', qty: 2, note: 'n'.repeat(101) }))).toHaveProperty('note');
    expect(errorsOf(validateStockAdjustment({ productId: 'bitter', kind: 'count' as 'waste', qty: 2, note: 'x' }))).toHaveProperty('kind');
  });
});

describe('money amounts (D-001, D-027)', () => {
  it('cash amounts (float, declared cash) are 0..9,999,999', () => {
    expect(validateCashAmount(0)).toBe(true);
    expect(validateCashAmount(9_999_999)).toBe(true);
    expect(validateCashAmount(10_000_000)).toBe(false);
    expect(validateCashAmount(-1)).toBe(false);
    expect(validateCashAmount(1.5)).toBe(false);
    expect(validateCashAmount(-0)).toBe(false);
    expect(validateCashAmount(Number.NaN)).toBe(false);
  });

  it('deposit amounts are 1..9,999,999', () => {
    expect(validateDepositAmount(0)).toBe(false);
    expect(validateDepositAmount(1)).toBe(true);
    expect(validateDepositAmount(9_999_999)).toBe(true);
    expect(validateDepositAmount(10_000_000)).toBe(false);
    expect(validateDepositAmount(50.5)).toBe(false);
  });
});

describe('validateFirstRun (D-111, D-099)', () => {
  const ok = { clubName: ' Oakfield Golf Club ', managerName: ' Morgan  Manager ', pin: '1234', confirmPin: '1234', loadSampleData: true };

  it('normalises and accepts the setup form', () => {
    expect(valueOf(validateFirstRun(ok, ['1111', '2222']))).toEqual({
      clubName: 'Oakfield Golf Club',
      managerName: 'Morgan Manager',
      pin: '1234',
      confirmPin: '1234',
      loadSampleData: true,
    });
  });

  it('rejects the sample staff PINs only when loading sample data', () => {
    expect(errorsOf(validateFirstRun({ ...ok, pin: '1111', confirmPin: '1111' }, ['1111', '2222']))).toEqual({ pin: 'That PIN is used by the sample staff' });
    expect(validateFirstRun({ ...ok, pin: '1111', confirmPin: '1111', loadSampleData: false }, ['1111', '2222']).ok).toBe(true);
  });

  it('checks every field', () => {
    const errors = errorsOf(validateFirstRun({ clubName: '', managerName: 'm'.repeat(41), pin: '12', confirmPin: '13', loadSampleData: false }, []));
    expect(Object.keys(errors).sort()).toEqual(['clubName', 'confirmPin', 'managerName', 'pin']);
  });
});
