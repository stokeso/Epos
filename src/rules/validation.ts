/**
 * Field validation for every form and every service write (spec §6.9; D-105 and the entity
 * decisions it references). Pure: uniqueness checks take the existing records as parameters.
 * Services call these before writing; forms call the same functions to show errors.
 * All text is trimmed (internal whitespace collapsed for names and labels) before validation,
 * and the normalised value is returned.
 */
import type {
  BookingType,
  Category,
  DealType,
  LocalDate,
  Member,
  NewBooking,
  NewCategory,
  NewDeal,
  NewMember,
  NewProduct,
  Product,
  Role,
  Settings,
  Staff,
  Tab,
  TabLabelType,
} from '../data/types';
import { BOOKING_TYPE_LABELS } from './booking';
import { MAX_DEAL_N, MIN_DEAL_N } from './deals';
import { MAX_KEYPAD_PENCE, MAX_PRICE_PENCE, isPence } from './money';
import { ROLE_RANK } from './permissions';
import { addDays, dealWindowFromDates, isValidLocalDate } from './time';
import { VAT_RATE_CHOICES } from './vat';

/** Per-field error messages keyed by input field name. */
export type FieldErrors = Readonly<Record<string, string>>;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

/** Stock quantity bounds for goods in and adjustments (D-080, D-081). */
export const MAX_STOCK_QTY = 9999;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trim and collapse internal whitespace (names and labels, D-105). */
function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Length in characters (code points), so an emoji counts as one. */
function length(text: string): number {
  return Array.from(text).length;
}

function lengthError(label: string, text: string, min: number, max: number): string | undefined {
  const n = length(text);
  if (n < min) return min === 1 ? `Enter ${label}` : `${label} must be at least ${min} characters`;
  if (n > max) return `${label} must be ${max} characters or fewer`;
  return undefined;
}

const isIntegerIn = (value: number, min: number, max: number): boolean => Number.isSafeInteger(value) && value >= min && value <= max;

const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Collects field errors; the first error per field wins. */
class ErrorBag {
  readonly errors: Record<string, string> = {};
  add(field: string, message: string | undefined): void {
    if (message !== undefined && this.errors[field] === undefined) this.errors[field] = message;
  }
  result<T>(value: T): Validation<T> {
    return Object.keys(this.errors).length === 0 ? { ok: true, value } : { ok: false, errors: { ...this.errors } };
  }
}

const sameText = (a: string, b: string): boolean => collapse(a).toLowerCase() === collapse(b).toLowerCase();

// ---------------------------------------------------------------------------
// PINs (D-073)
// ---------------------------------------------------------------------------

/** /^\d{4,6}$/ (D-073). */
export function isValidPinFormat(pin: string): boolean {
  return /^[0-9]{4,6}$/.test(pin);
}

/** New PIN entry: format check and confirmation match (D-073). Errors keyed 'pin' / 'confirmPin'. */
export function validateNewPin(pin: string, confirmPin: string): Validation<string> {
  const bag = new ErrorBag();
  if (!isValidPinFormat(pin)) bag.add('pin', 'PIN must be 4 to 6 digits');
  if (confirmPin !== pin) bag.add('confirmPin', "PINs don't match");
  return bag.result(pin);
}

// ---------------------------------------------------------------------------
// Catalogue (D-105, D-013, D-051)
// ---------------------------------------------------------------------------

/**
 * Product (D-105): name 1..40, unique case-insensitively among non-deleted products (excluding
 * `editingId`); categoryId a non-deleted category; pricePence integer 0..MAX_PRICE_PENCE;
 * vatRate in VAT_RATE_CHOICES; stockUnit 1..20; lowStockLevel integer 0..9999 (forced to 0 when
 * untracked); buttonColour '#rrggbb' (returned lower-cased); sortOrder integer.
 */
export function validateProduct(
  input: NewProduct,
  context: { products: readonly Product[]; categories: readonly Category[]; editingId?: string },
): Validation<NewProduct> {
  const bag = new ErrorBag();
  const name = collapse(input.name);
  const stockUnit = collapse(input.stockUnit);

  bag.add('name', lengthError('a name', name, 1, 40));
  if (context.products.some((p) => p.deletedAt === undefined && p.id !== context.editingId && sameText(p.name, name))) {
    bag.add('name', 'Another product already has that name');
  }
  if (!context.categories.some((c) => c.id === input.categoryId && c.deletedAt === undefined)) {
    bag.add('categoryId', 'Choose a category');
  }
  if (!isPence(input.pricePence) || input.pricePence < 0 || input.pricePence > MAX_PRICE_PENCE) {
    bag.add('pricePence', 'Price must be £0.00 to £9,999.99');
  }
  if (!(VAT_RATE_CHOICES as readonly number[]).includes(input.vatRate)) bag.add('vatRate', 'Choose a VAT rate');
  if (typeof input.memberDiscountEligible !== 'boolean') bag.add('memberDiscountEligible', 'Choose yes or no');
  if (typeof input.stockTracked !== 'boolean') bag.add('stockTracked', 'Choose yes or no');
  bag.add('stockUnit', lengthError('a stock unit', stockUnit, 1, 20));
  const lowStockLevel = input.stockTracked ? input.lowStockLevel : 0;
  if (!isIntegerIn(lowStockLevel, 0, MAX_STOCK_QTY)) bag.add('lowStockLevel', 'Low-stock level must be 0 to 9999');
  if (!COLOUR_PATTERN.test(input.buttonColour)) bag.add('buttonColour', 'Colour must look like #b45309');
  if (!Number.isSafeInteger(input.sortOrder)) bag.add('sortOrder', 'Sort order must be a whole number');
  if (typeof input.active !== 'boolean') bag.add('active', 'Choose active or inactive');

  return bag.result<NewProduct>({
    name,
    categoryId: input.categoryId,
    pricePence: input.pricePence,
    vatRate: input.vatRate,
    memberDiscountEligible: input.memberDiscountEligible,
    stockTracked: input.stockTracked,
    stockUnit,
    lowStockLevel,
    buttonColour: input.buttonColour.toLowerCase(),
    sortOrder: input.sortOrder,
    active: input.active,
  });
}

/** Category (D-105): name 1..30 unique case-insensitively among non-deleted; sortOrder integer; colour '#rrggbb'. */
export function validateCategory(
  input: NewCategory,
  context: { categories: readonly Category[]; editingId?: string },
): Validation<NewCategory> {
  const bag = new ErrorBag();
  const name = collapse(input.name);
  bag.add('name', lengthError('a name', name, 1, 30));
  if (context.categories.some((c) => c.deletedAt === undefined && c.id !== context.editingId && sameText(c.name, name))) {
    bag.add('name', 'Another category already has that name');
  }
  if (!Number.isSafeInteger(input.sortOrder)) bag.add('sortOrder', 'Sort order must be a whole number');
  if (!COLOUR_PATTERN.test(input.colour)) bag.add('colour', 'Colour must look like #b45309');
  return bag.result<NewCategory>({ name, sortOrder: input.sortOrder, colour: input.colour.toLowerCase() });
}

/** A category can be soft-deleted only when no non-deleted product references it (D-051). */
export function canDeleteCategory(categoryId: string, products: readonly Product[]): boolean {
  return !products.some((p) => p.categoryId === categoryId && p.deletedAt === undefined);
}

/** The deal form: dates are local dates, converted with time.dealWindowFromDates (D-012). */
export interface DealFormInput {
  name: string;
  type: DealType;
  n: number;
  pricePence?: number;
  m?: number;
  productIds: readonly string[];
  active: boolean;
  startDate?: LocalDate;
  endDate?: LocalDate;
}

/**
 * Deal (D-013): name 1..40; n integer 2..99; nForPrice -> pricePence integer 1..MAX_PRICE_PENCE
 * and no m; nForM -> m integer 1..n-1 and no pricePence; productIds de-duplicated, >= 1, each a
 * non-deleted product; if both dates are set, endDate >= startDate; endDate <= 9999-12-30 (D-126).
 * Returns the NewDeal with startsAt/endsAt computed (absent fields omitted, D-050).
 */
export function validateDeal(input: DealFormInput, context: { products: readonly Product[] }): Validation<NewDeal> {
  const bag = new ErrorBag();
  const name = collapse(input.name);
  bag.add('name', lengthError('a name', name, 1, 40));

  const typeOk = input.type === 'nForPrice' || input.type === 'nForM';
  if (!typeOk) bag.add('type', 'Choose a deal type');
  const nOk = isIntegerIn(input.n, MIN_DEAL_N, MAX_DEAL_N);
  if (!nOk) bag.add('n', `Group size must be ${MIN_DEAL_N} to ${MAX_DEAL_N}`);

  if (input.type === 'nForPrice') {
    const price = input.pricePence;
    if (price === undefined || !isPence(price) || price < 1 || price > MAX_PRICE_PENCE) {
      bag.add('pricePence', 'Deal price must be £0.01 to £9,999.99');
    }
    if (input.m !== undefined) bag.add('m', 'Not used for an "n for a price" deal');
  } else if (input.type === 'nForM') {
    const m = input.m;
    if (m === undefined || !Number.isSafeInteger(m) || m < 1 || (nOk && m >= input.n)) {
      bag.add('m', 'Units paid for must be at least 1 and less than the group size');
    }
    if (input.pricePence !== undefined) bag.add('pricePence', 'Not used for an "n for m" deal');
  }

  const productIds = [...new Set(input.productIds)];
  const live = new Set(context.products.filter((p) => p.deletedAt === undefined).map((p) => p.id));
  if (productIds.length === 0) bag.add('productIds', 'Choose at least one product');
  else if (productIds.some((id) => !live.has(id))) bag.add('productIds', 'Every product must exist and not be deleted');

  if (input.startDate !== undefined && !isValidLocalDate(input.startDate)) bag.add('startDate', 'Enter a valid start date');
  if (input.endDate !== undefined) {
    if (!isValidLocalDate(input.endDate)) bag.add('endDate', 'Enter a valid end date');
    // D-126: endsAt is midnight at the start of the NEXT day, and 31/12/9999 has none in YYYY-MM-DD form.
    else if (!isValidLocalDate(addDays(input.endDate, 1))) bag.add('endDate', 'End date must be 30/12/9999 or earlier');
  }
  const datesOk = bag.errors.startDate === undefined && bag.errors.endDate === undefined;
  if (datesOk && input.startDate !== undefined && input.endDate !== undefined && input.endDate < input.startDate) {
    bag.add('endDate', 'End date must be on or after the start date');
  }

  if (Object.keys(bag.errors).length > 0) return { ok: false, errors: { ...bag.errors } };
  const deal: NewDeal = {
    name,
    type: input.type,
    n: input.n,
    ...(input.type === 'nForPrice' ? { pricePence: input.pricePence } : { m: input.m }),
    productIds,
    active: input.active,
    ...dealWindowFromDates(input.startDate, input.endDate),
  };
  return { ok: true, value: deal };
}

// ---------------------------------------------------------------------------
// Members and staff (D-105, D-077)
// ---------------------------------------------------------------------------

/** Member (D-105): memberNumber 1..12 of [A-Za-z0-9-], stored upper-cased, unique among non-deleted; names 1..40. */
export function validateMember(input: NewMember, context: { members: readonly Member[]; editingId?: string }): Validation<NewMember> {
  const bag = new ErrorBag();
  const memberNumber = input.memberNumber.trim().toUpperCase();
  const firstName = collapse(input.firstName);
  const lastName = collapse(input.lastName);
  if (!/^[A-Z0-9-]{1,12}$/.test(memberNumber)) bag.add('memberNumber', 'Member number must be 1 to 12 letters, digits or hyphens');
  if (context.members.some((m) => m.deletedAt === undefined && m.id !== context.editingId && m.memberNumber.toUpperCase() === memberNumber)) {
    bag.add('memberNumber', 'Another member already has that number');
  }
  bag.add('firstName', lengthError('a first name', firstName, 1, 40));
  bag.add('lastName', lengthError('a last name', lastName, 1, 40));
  if (typeof input.active !== 'boolean') bag.add('active', 'Choose active or inactive');
  return bag.result<NewMember>({ memberNumber, firstName, lastName, active: input.active });
}

export interface StaffDetailsInput {
  name: string;
  role: Role;
  active: boolean;
}

/**
 * Staff (D-077, D-105): name 1..40 (not unique). Rejects (error key 'role' or 'active') a change
 * that leaves no active non-deleted manager, and a user changing their own role or deactivating
 * themselves (`actingStaffId === editingId`).
 */
export function validateStaffDetails(
  input: StaffDetailsInput,
  context: { staff: readonly Staff[]; editingId?: string; actingStaffId: string },
): Validation<StaffDetailsInput> {
  const bag = new ErrorBag();
  const name = collapse(input.name);
  bag.add('name', lengthError('a name', name, 1, 40));
  if (!Object.hasOwn(ROLE_RANK, input.role)) bag.add('role', 'Choose a role');

  const existing = context.editingId === undefined ? undefined : context.staff.find((s) => s.id === context.editingId);
  if (existing !== undefined && existing.id === context.actingStaffId) {
    if (input.role !== existing.role) bag.add('role', "You can't change your own role");
    if (!input.active && existing.active) bag.add('active', "You can't deactivate yourself");
  }

  const othersHaveManager = context.staff.some(
    (s) => s.id !== context.editingId && s.role === 'manager' && s.active && s.deletedAt === undefined,
  );
  const thisIsManager = input.role === 'manager' && input.active && existing?.deletedAt === undefined;
  if (!othersHaveManager && !thisIsManager) {
    const message = 'There must always be at least one active manager';
    if (!input.active) bag.add('active', message);
    else bag.add('role', message);
  }
  return bag.result<StaffDetailsInput>({ name, role: input.role, active: input.active });
}

// ---------------------------------------------------------------------------
// Settings (D-105, D-058)
// ---------------------------------------------------------------------------

export type SettingsInput = Pick<
  Settings,
  'clubName' | 'receiptFooter' | 'autoLockMinutes' | 'memberDiscountPercent' | 'devicePrefix'
>;

/**
 * Settings (D-105, D-058): clubName 1..40; receiptFooter 0..200 (trimmed; newlines allowed, not
 * collapsed); autoLockMinutes integer 1..60; memberDiscountPercent integer 0..100; devicePrefix
 * upper-cased then /^[A-Z0-9]{1,6}$/.
 */
export function validateSettings(input: SettingsInput): Validation<SettingsInput> {
  const bag = new ErrorBag();
  const clubName = collapse(input.clubName);
  const receiptFooter = input.receiptFooter.trim();
  const devicePrefix = input.devicePrefix.trim().toUpperCase();
  bag.add('clubName', lengthError('the club name', clubName, 1, 40));
  bag.add('receiptFooter', lengthError('the receipt footer', receiptFooter, 0, 200));
  if (!isIntegerIn(input.autoLockMinutes, 1, 60)) bag.add('autoLockMinutes', 'Auto-lock must be 1 to 60 minutes');
  if (!isIntegerIn(input.memberDiscountPercent, 0, 100)) bag.add('memberDiscountPercent', 'Member discount must be a whole number 0 to 100');
  if (!/^[A-Z0-9]{1,6}$/.test(devicePrefix)) bag.add('devicePrefix', 'Device prefix must be 1 to 6 letters or digits');
  return bag.result<SettingsInput>({
    clubName,
    receiptFooter,
    autoLockMinutes: input.autoLockMinutes,
    memberDiscountPercent: input.memberDiscountPercent,
    devicePrefix,
  });
}

// ---------------------------------------------------------------------------
// Bookings and tabs (D-026, D-064)
// ---------------------------------------------------------------------------

export interface BookingInput {
  type: BookingType;
  name: string;
  date: LocalDate;
  notes: string;
}

/** Booking (D-026): name 1..60; date a real 'YYYY-MM-DD'; notes 0..500 ('' when empty). Returns status 'open'. */
export function validateBooking(input: BookingInput): Validation<NewBooking> {
  const bag = new ErrorBag();
  const name = collapse(input.name);
  const notes = input.notes.trim();
  if (!Object.hasOwn(BOOKING_TYPE_LABELS, input.type)) bag.add('type', 'Choose a booking type');
  bag.add('name', lengthError('a name', name, 1, 60));
  if (!isValidLocalDate(input.date)) bag.add('date', 'Enter a valid date');
  bag.add('notes', lengthError('Notes', notes, 0, 500));
  return bag.result<NewBooking>({ type: input.type, name, date: input.date, notes, status: 'open' });
}

/**
 * Tab label (D-064): trim + collapse whitespace; 'name' 1..30 chars; 'table' 1..10 chars of
 * letters, digits, spaces or hyphens. Unique (labelType, case-insensitive label) among open
 * non-deleted tabs (excluding `exceptTabId`).
 */
export function validateTabLabel(
  labelType: TabLabelType,
  label: string,
  context: { openTabs: readonly Tab[]; exceptTabId?: string },
): Validation<string> {
  const bag = new ErrorBag();
  const value = collapse(label);
  if (labelType === 'name') {
    bag.add('label', lengthError('a name', value, 1, 30));
  } else if (labelType === 'table') {
    bag.add('label', lengthError('a table', value, 1, 10));
    if (!/^[A-Za-z0-9 -]*$/.test(value)) bag.add('label', 'A table can only use letters, digits, spaces and hyphens');
  } else {
    bag.add('labelType', 'Choose name or table');
  }
  const clash = context.openTabs.some(
    (t) =>
      t.id !== context.exceptTabId &&
      t.status === 'open' &&
      t.deletedAt === undefined &&
      t.labelType === labelType &&
      sameText(t.label, value),
  );
  if (clash) bag.add('label', `${tabDisplayLabel({ labelType, label: value })} is already open`);
  return bag.result(value);
}

/** 'Smith' for names; 'Table 5' for tables (D-064). */
export function tabDisplayLabel(tab: Pick<Tab, 'labelType' | 'label'>): string {
  return tab.labelType === 'table' ? `Table ${tab.label}` : tab.label;
}

// ---------------------------------------------------------------------------
// Stock (D-080, D-081)
// ---------------------------------------------------------------------------

/** Goods in (D-080): qty integer 1..9999; note 0..100 (trimmed). */
export function validateGoodsIn(input: { productId: string; qty: number; note: string }): Validation<{ productId: string; qty: number; note: string }> {
  const bag = new ErrorBag();
  const note = input.note.trim();
  if (input.productId.trim() === '') bag.add('productId', 'Choose a product');
  if (!isIntegerIn(input.qty, 1, MAX_STOCK_QTY)) bag.add('qty', `Quantity must be 1 to ${MAX_STOCK_QTY}`);
  bag.add('note', lengthError('The note', note, 0, 100));
  return bag.result({ productId: input.productId, qty: input.qty, note });
}

export interface StockAdjustmentInput {
  productId: string;
  kind: 'adjustment' | 'waste';
  /** adjustment: signed non-zero -9999..9999; waste: positive 1..9999 (stored negative). */
  qty: number;
  /** Required reason, 1..100 chars. */
  note: string;
}

/** Stock adjustment / manual waste (D-081). Returns the SIGNED qty to store. */
export function validateStockAdjustment(
  input: StockAdjustmentInput,
): Validation<{ productId: string; reason: 'adjustment' | 'waste'; qty: number; note: string }> {
  const bag = new ErrorBag();
  const note = input.note.trim();
  if (input.productId.trim() === '') bag.add('productId', 'Choose a product');
  if (input.kind === 'adjustment') {
    if (!isIntegerIn(input.qty, -MAX_STOCK_QTY, MAX_STOCK_QTY) || input.qty === 0) {
      bag.add('qty', `Adjustment must be a non-zero whole number from -${MAX_STOCK_QTY} to ${MAX_STOCK_QTY}`);
    }
  } else if (input.kind === 'waste') {
    if (!isIntegerIn(input.qty, 1, MAX_STOCK_QTY)) bag.add('qty', `Waste must be 1 to ${MAX_STOCK_QTY}`);
  } else {
    bag.add('kind', 'Choose adjustment or waste');
  }
  bag.add('note', lengthError('a reason', note, 1, 100));
  const qty = input.kind === 'waste' ? -input.qty : input.qty;
  return bag.result({ productId: input.productId, reason: input.kind, qty, note });
}

// ---------------------------------------------------------------------------
// Money amounts (D-001, D-027)
// ---------------------------------------------------------------------------

/** Float or declared cash (D-001): integer 0..MAX_KEYPAD_PENCE (never -0). */
export function validateCashAmount(pence: number): boolean {
  return isPence(pence) && pence >= 0 && pence <= MAX_KEYPAD_PENCE;
}

/** Deposit amount (D-027): integer 1..MAX_KEYPAD_PENCE. */
export function validateDepositAmount(pence: number): boolean {
  return isPence(pence) && pence >= 1 && pence <= MAX_KEYPAD_PENCE;
}

// ---------------------------------------------------------------------------
// First run (D-111, D-099)
// ---------------------------------------------------------------------------

export interface FirstRunInput {
  clubName: string;
  managerName: string;
  pin: string;
  confirmPin: string;
  loadSampleData: boolean;
}

/**
 * First-run form (D-111, D-099): clubName 1..40; managerName 1..40; validateNewPin; when
 * loadSampleData, the PIN may not be one of the sample staff PINs (error 'That PIN is used by the
 * sample staff').
 */
export function validateFirstRun(input: FirstRunInput, reservedPins: readonly string[]): Validation<FirstRunInput> {
  const bag = new ErrorBag();
  const clubName = collapse(input.clubName);
  const managerName = collapse(input.managerName);
  bag.add('clubName', lengthError('the club name', clubName, 1, 40));
  bag.add('managerName', lengthError('your name', managerName, 1, 40));
  const pin = validateNewPin(input.pin, input.confirmPin);
  if (!pin.ok) for (const [field, message] of Object.entries(pin.errors)) bag.add(field, message);
  if (input.loadSampleData && reservedPins.includes(input.pin)) bag.add('pin', 'That PIN is used by the sample staff');
  return bag.result<FirstRunInput>({ clubName, managerName, pin: input.pin, confirmPin: input.confirmPin, loadSampleData: input.loadSampleData });
}
