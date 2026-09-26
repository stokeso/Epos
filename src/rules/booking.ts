/**
 * Booking status rules (spec §6.7; D-025..D-028). Pure. The balance itself is a data query
 * (SaleRepo.bookingBalance, D-025) and is passed in.
 */
import type { Booking, BookingType, Pence } from '../data/types';

export const BOOKING_TYPE_LABELS = {
  wedding: 'Wedding',
  society: 'Society day',
  eventTicket: 'Event tickets',
  other: 'Other',
} as const satisfies Record<BookingType, string>;

/** Open bookings with balance > 0 can be attached to a basket (D-028). */
export function isAttachable(booking: Booking, balancePence: Pence): boolean {
  return booking.status === 'open' && balancePence > 0;
}

/** Only open bookings can take a deposit (D-027). */
export function canTakeDeposit(booking: Booking): boolean {
  return booking.status === 'open';
}

/** 'Mark settled' is enabled iff the booking is open and its balance is exactly 0 (D-026). */
export function canSettle(booking: Booking, balancePence: Pence): boolean {
  return booking.status === 'open' && balancePence === 0;
}

/** 'Cancel' is enabled iff the booking is open and its balance is exactly 0 (D-026). */
export function canCancel(booking: Booking, balancePence: Pence): boolean {
  return booking.status === 'open' && balancePence === 0;
}

/** Only open bookings can have their details edited (D-026). */
export function canEdit(booking: Booking): boolean {
  return booking.status === 'open';
}
