/**
 * Staff management (spec §5, §6.9; D-073..D-077). Viewing needs no permission; writes need
 * auth.action 'manageMembersStaffSettings'. PIN hashing and uniqueness checks run BEFORE any
 * transaction (they are async crypto); the write re-confirms the checked PINs (D-127).
 */
import { AppError } from '../data/errors';
import type { IsoInstant, Role, Staff } from '../data/types';
import { validateNewPin, validateStaffDetails, type FieldErrors, type StaffDetailsInput } from '../rules/validation';
import type { ServiceContext } from './context';
import { assertAuthorised, overrideEvents, type Authorisation } from './override';
import { createPinCredentials, verifyPin, type PinCredentials } from './pin';
import { activeStaffInLoginOrder, compareIds, compareText, openPeriodId, validationError } from './shared';

/** Staff as screens may see them: never pinHash/pinSalt. */
export interface StaffSummary {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: IsoInstant;
}

/** D-075 message. */
export const PIN_UNAVAILABLE_MESSAGE = "That PIN can't be used — choose another";

/** D-127 message: another save changed the staff PINs between the uniqueness check and the write. */
export const STAFF_CHANGED_MESSAGE = 'Staff changed while saving — try again';

function toSummary(staff: Staff): StaffSummary {
  return { id: staff.id, name: staff.name, role: staff.role, active: staff.active, createdAt: staff.createdAt };
}

/** Non-deleted staff sorted by name. */
export async function listStaff(ctx: ServiceContext): Promise<StaffSummary[]> {
  const staff = await ctx.repos.staff.list();
  return staff
    .sort((a, b) => compareText(a.name, b.name) || compareIds(a.createdAt, b.createdAt) || compareIds(a.id, b.id))
    .map(toSummary);
}

export interface NewStaffInput {
  name: string;
  role: Role;
  pin: string;
  confirmPin: string;
}

/**
 * validateStaffDetails, merged with `extraErrors`. The last-manager and self-change rules (D-077)
 * fail with AppError('LAST_MANAGER'); any other problem with AppError('VALIDATION').
 */
function staffDetailsOrThrow(
  input: StaffDetailsInput,
  staff: readonly Staff[],
  editingId: string | undefined,
  actingStaffId: string,
  extraErrors: FieldErrors = {},
): StaffDetailsInput {
  const result = validateStaffDetails(input, { staff, actingStaffId, ...(editingId === undefined ? {} : { editingId }) });
  if (result.ok && Object.keys(extraErrors).length === 0) return result.value;
  const errors: FieldErrors = { ...(result.ok ? {} : result.errors), ...extraErrors };
  if (!result.ok) {
    const existing = editingId === undefined ? undefined : staff.find((s) => s.id === editingId);
    const selfChange =
      existing !== undefined &&
      existing.id === actingStaffId &&
      (input.role !== existing.role || (!input.active && existing.active));
    const managerLeft =
      staff.some((s) => s.id !== editingId && s.role === 'manager' && s.active && s.deletedAt === undefined) ||
      (input.role === 'manager' && input.active);
    if (selfChange || !managerLeft) {
      const message = result.errors['active'] ?? result.errors['role'] ?? 'There must always be at least one active manager';
      throw new AppError('LAST_MANAGER', message, errors);
    }
  }
  throw validationError(errors);
}

/** The active staff a PIN was checked against: id -> the stored hash it was verified with. */
type CheckedPins = ReadonlyMap<string, string>;

/**
 * D-075: the PIN must not match any other active, non-deleted staff member. Runs outside
 * transactions (hashing, D-073) and returns the credentials it checked, so the write can confirm
 * they still hold (assertPinsUnchanged).
 */
async function assertPinAvailable(ctx: ServiceContext, pin: string, exceptStaffId?: string): Promise<CheckedPins> {
  const checked = new Map<string, string>();
  for (const staff of await activeStaffInLoginOrder(ctx)) {
    if (staff.id === exceptStaffId) continue;
    if (await verifyPin(pin, staff)) throw new AppError('PIN_UNAVAILABLE', PIN_UNAVAILABLE_MESSAGE, { pin: PIN_UNAVAILABLE_MESSAGE });
    checked.set(staff.id, `${staff.pinSalt}:${staff.pinHash}`);
  }
  return checked;
}

/**
 * D-127: inside the write transaction, every active non-deleted staff member other than
 * `exceptStaffId` must be one the PIN was checked against, with the same credentials. Otherwise
 * an overlapping save (a double tap, a second PIN reset) added or changed a PIN after the check,
 * and this save is CONFLICT rather than risk two active staff sharing one PIN.
 */
async function assertPinsUnchanged(ctx: ServiceContext, checked: CheckedPins, exceptStaffId?: string): Promise<void> {
  for (const staff of await ctx.repos.staff.list()) {
    if (staff.id === exceptStaffId || !staff.active || staff.deletedAt !== undefined) continue;
    if (checked.get(staff.id) !== `${staff.pinSalt}:${staff.pinHash}`) {
      throw new AppError('CONFLICT', STAFF_CHANGED_MESSAGE);
    }
  }
}

/**
 * Create (D-075): validateStaffDetails + validateNewPin; the PIN must not verify against any other
 * active non-deleted staff member (else AppError('PIN_UNAVAILABLE', "That PIN can't be used —
 * choose another")); createPinCredentials; transact: re-check the checked PINs are unchanged
 * (else AppError('CONFLICT'), D-127) + staff.create + overrideEvents.
 */
export async function createStaff(ctx: ServiceContext, auth: Authorisation, input: NewStaffInput): Promise<StaffSummary> {
  assertAuthorised(auth, 'manageMembersStaffSettings');
  const staff = await ctx.repos.staff.list({ includeDeleted: true });
  const pin = validateNewPin(input.pin, input.confirmPin);
  const details = staffDetailsOrThrow(
    { name: input.name, role: input.role, active: true },
    staff,
    undefined,
    auth.staffId,
    pin.ok ? {} : pin.errors,
  );
  const checked = await assertPinAvailable(ctx, input.pin);
  const credentials = await createPinCredentials(input.pin);
  const periodId = await openPeriodId(ctx);
  const created = await ctx.repos.transact(async () => {
    await assertPinsUnchanged(ctx, checked);
    const record = await ctx.repos.staff.create({ name: details.name, role: details.role, active: true, ...credentials });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return record;
  });
  return toSummary(created);
}

export interface UpdateStaffInput {
  name: string;
  role: Role;
  active: boolean;
  /** PIN reset. Required when reactivating a deactivated member of staff (D-075). */
  newPin?: { pin: string; confirmPin: string };
}

/**
 * Update (D-075, D-077): last-manager and self-change rules (validateStaffDetails with
 * actingStaffId = auth.staffId, re-checked inside the transaction); optional PIN reset with the
 * same uniqueness check, re-confirmed inside the transaction (D-127). Reactivating without a new
 * PIN is a VALIDATION error (key 'pin').
 */
export async function updateStaff(ctx: ServiceContext, auth: Authorisation, id: string, input: UpdateStaffInput): Promise<StaffSummary> {
  assertAuthorised(auth, 'manageMembersStaffSettings');
  const staff = await ctx.repos.staff.list({ includeDeleted: true });
  const existing = staff.find((s) => s.id === id);
  if (existing === undefined || existing.deletedAt !== undefined) throw new AppError('NOT_FOUND', 'That member of staff no longer exists');

  let pinErrors: FieldErrors = {};
  if (input.newPin !== undefined) {
    const pin = validateNewPin(input.newPin.pin, input.newPin.confirmPin);
    if (!pin.ok) pinErrors = pin.errors;
  } else if (!existing.active && input.active) {
    pinErrors = { pin: 'Set a new PIN to reactivate this member of staff' };
  }
  const details = staffDetailsOrThrow({ name: input.name, role: input.role, active: input.active }, staff, id, auth.staffId, pinErrors);

  let credentials: PinCredentials | undefined;
  let checked: CheckedPins | undefined;
  if (input.newPin !== undefined) {
    checked = await assertPinAvailable(ctx, input.newPin.pin, id);
    credentials = await createPinCredentials(input.newPin.pin);
  }
  const periodId = await openPeriodId(ctx);
  const updated = await ctx.repos.transact(async () => {
    if (checked !== undefined) await assertPinsUnchanged(ctx, checked, id);
    // The last-manager rule is re-checked against the rows as they are now (D-077).
    staffDetailsOrThrow(details, await ctx.repos.staff.list({ includeDeleted: true }), id, auth.staffId);
    const record = await ctx.repos.staff.update(id, {
      name: details.name,
      role: details.role,
      active: details.active,
      ...(credentials ?? {}),
    });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return record;
  });
  return toSummary(updated);
}
