/**
 * Bookings (spec §6.7; D-025..D-028). Every write: auth.action 'bookings'. Booking writes do
 * NOT need an open period (D-068); taking a deposit does (services/pay.ts).
 */
import { AppError } from '../data/errors';
import type { Booking, BookingStatus } from '../data/types';
import { canCancel, canEdit, canSettle, canTakeDeposit, isAttachable } from '../rules/booking';
import { validateBooking, type BookingInput } from '../rules/validation';
import type { ServiceContext } from './context';
import { assertAuthorised, overrideEvents, type Authorisation } from './override';
import { compareIds, compareText, openPeriodId, validOrThrow } from './shared';

export interface BookingSummary {
  booking: Booking;
  /** repos.sales.bookingBalance(id) (D-025). */
  balancePence: number;
  canTakeDeposit: boolean;
  canSettle: boolean;
  canCancel: boolean;
}

async function summarise(ctx: ServiceContext, booking: Booking): Promise<BookingSummary> {
  const balancePence = await ctx.repos.sales.bookingBalance(booking.id);
  return {
    booking,
    balancePence,
    canTakeDeposit: canTakeDeposit(booking),
    canSettle: canSettle(booking, balancePence),
    canCancel: canCancel(booking, balancePence),
  };
}

function byDateThenName(a: BookingSummary, b: BookingSummary): number {
  return (
    compareIds(a.booking.date, b.booking.date) ||
    compareText(a.booking.name, b.booking.name) ||
    compareIds(a.booking.createdAt, b.booking.createdAt) ||
    compareIds(a.booking.id, b.booking.id)
  );
}

/** Every booking (never deleted) sorted by date ascending, then name. */
export async function listBookings(ctx: ServiceContext): Promise<BookingSummary[]> {
  const summaries: BookingSummary[] = [];
  for (const booking of await ctx.repos.bookings.list()) summaries.push(await summarise(ctx, booking));
  return summaries.sort(byDateThenName);
}

export async function getBookingSummary(ctx: ServiceContext, id: string): Promise<BookingSummary | undefined> {
  const booking = await ctx.repos.bookings.get(id);
  return booking === undefined ? undefined : summarise(ctx, booking);
}

/** Open bookings with balance > 0 (D-028), sorted by date, then name. */
export async function listAttachableBookings(ctx: ServiceContext): Promise<BookingSummary[]> {
  return (await listBookings(ctx)).filter((s) => isAttachable(s.booking, s.balancePence));
}

async function requireBooking(ctx: ServiceContext, id: string): Promise<Booking> {
  const booking = await ctx.repos.bookings.get(id);
  if (booking === undefined || booking.deletedAt !== undefined) throw new AppError('NOT_FOUND', 'That booking no longer exists');
  return booking;
}

/** Create (id null, status 'open') or edit an open booking's details (validateBooking). */
export async function saveBooking(ctx: ServiceContext, auth: Authorisation, id: string | null, input: BookingInput): Promise<Booking> {
  assertAuthorised(auth, 'bookings');
  const value = validOrThrow(validateBooking(input));
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    let saved: Booking;
    if (id === null) {
      saved = await ctx.repos.bookings.create(value);
    } else {
      const existing = await requireBooking(ctx, id);
      if (!canEdit(existing)) throw new AppError('BOOKING_NOT_OPEN', 'Only open bookings can be edited');
      saved = await ctx.repos.bookings.update(id, { type: value.type, name: value.name, date: value.date, notes: value.notes });
    }
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}

/** open -> settled / cancelled, only when the balance is exactly 0 (D-026). */
async function closeBooking(
  ctx: ServiceContext,
  auth: Authorisation,
  id: string,
  status: Exclude<BookingStatus, 'open'>,
): Promise<Booking> {
  assertAuthorised(auth, 'bookings');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    const booking = await requireBooking(ctx, id);
    if (booking.status !== 'open') throw new AppError('BOOKING_NOT_OPEN', 'That booking is already closed');
    const balance = await ctx.repos.sales.bookingBalance(id);
    const allowed = status === 'settled' ? canSettle(booking, balance) : canCancel(booking, balance);
    if (!allowed) {
      const verb = status === 'settled' ? 'settled' : 'cancelled';
      throw new AppError('VALIDATION', `The deposit balance must be used before the booking can be ${verb}`, {
        status: 'The deposit balance is not zero',
      });
    }
    const saved = await ctx.repos.bookings.update(id, { status });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}

/** open -> settled iff balance === 0 (D-026). */
export function settleBooking(ctx: ServiceContext, auth: Authorisation, id: string): Promise<Booking> {
  return closeBooking(ctx, auth, id, 'settled');
}

/** open -> cancelled iff balance === 0 (D-026). */
export function cancelBooking(ctx: ServiceContext, auth: Authorisation, id: string): Promise<Booking> {
  return closeBooking(ctx, auth, id, 'cancelled');
}
