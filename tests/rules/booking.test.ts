import { describe, expect, it } from 'vitest';
import type { Booking, BookingStatus } from '../../src/data/types';
import { BOOKING_TYPE_LABELS, canCancel, canEdit, canSettle, canTakeDeposit, isAttachable } from '../../src/rules/booking';
import { DEVICE, T0 } from './fixtures';

const booking = (status: BookingStatus): Booking => ({
  id: 'booking-smith',
  deviceId: DEVICE,
  createdAt: T0,
  updatedAt: T0,
  type: 'wedding',
  name: 'Smith & Jones Wedding',
  date: '2026-10-26',
  notes: '',
  status,
});

describe('booking rules (D-026..D-028)', () => {
  it('labels the booking types', () => {
    expect(BOOKING_TYPE_LABELS).toEqual({ wedding: 'Wedding', society: 'Society day', eventTicket: 'Event tickets', other: 'Other' });
  });

  it('attaches only open bookings with a balance (D-028)', () => {
    expect(isAttachable(booking('open'), 7000)).toBe(true);
    expect(isAttachable(booking('open'), 1)).toBe(true);
    expect(isAttachable(booking('open'), 0)).toBe(false);
    expect(isAttachable(booking('settled'), 7000)).toBe(false);
    expect(isAttachable(booking('cancelled'), 7000)).toBe(false);
  });

  it('takes deposits and edits only while open (D-026, D-027)', () => {
    expect(canTakeDeposit(booking('open'))).toBe(true);
    expect(canTakeDeposit(booking('settled'))).toBe(false);
    expect(canTakeDeposit(booking('cancelled'))).toBe(false);
    expect(canEdit(booking('open'))).toBe(true);
    expect(canEdit(booking('settled'))).toBe(false);
    expect(canEdit(booking('cancelled'))).toBe(false);
  });

  it('settles or cancels only an open booking with exactly 0 balance (D-026)', () => {
    // Balance 820 after a bill: "Mark settled" is disabled; once the 820 is used, it is enabled.
    expect(canSettle(booking('open'), 820)).toBe(false);
    expect(canSettle(booking('open'), 0)).toBe(true);
    expect(canCancel(booking('open'), 820)).toBe(false);
    expect(canCancel(booking('open'), 0)).toBe(true); // including one that never took a deposit
    expect(canSettle(booking('settled'), 0)).toBe(false);
    expect(canCancel(booking('cancelled'), 0)).toBe(false);
    expect(canSettle(booking('cancelled'), 0)).toBe(false);
    expect(canCancel(booking('settled'), 0)).toBe(false);
  });
});
