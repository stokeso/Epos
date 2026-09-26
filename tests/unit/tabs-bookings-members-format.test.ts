/**
 * Display helpers of the Bookings screens (src/screens/bookings/bookingFormat.ts): relative day
 * text and the calendar tile. London dates (D-102), including a clock change (D-103).
 */
import { describe, expect, it } from 'vitest';
import { BOOKING_STATUS_LABELS, dateTileParts, daysFromToday, relativeDayText } from '../../src/screens/bookings/bookingFormat';

describe('daysFromToday', () => {
  it('counts whole London days, forwards and back', () => {
    expect(daysFromToday('2026-09-26', '2026-09-26')).toBe(0);
    expect(daysFromToday('2026-10-10', '2026-09-26')).toBe(14);
    expect(daysFromToday('2026-10-26', '2026-09-26')).toBe(30);
    expect(daysFromToday('2026-09-23', '2026-09-26')).toBe(-3);
  });

  it('is not thrown off by the 23- and 25-hour days of a clock change', () => {
    expect(daysFromToday('2026-03-30', '2026-03-28')).toBe(2);
    expect(daysFromToday('2026-10-26', '2026-10-24')).toBe(2);
    expect(daysFromToday('2027-09-26', '2026-09-26')).toBe(365);
  });

  it('returns null for a malformed date', () => {
    expect(daysFromToday('2026-02-30', '2026-09-26')).toBeNull();
    expect(daysFromToday('26/09/2026', '2026-09-26')).toBeNull();
  });
});

describe('relativeDayText', () => {
  it('reads naturally', () => {
    expect(relativeDayText(0)).toBe('Today');
    expect(relativeDayText(1)).toBe('Tomorrow');
    expect(relativeDayText(14)).toBe('In 14 days');
    expect(relativeDayText(-1)).toBe('Yesterday');
    expect(relativeDayText(-3)).toBe('3 days ago');
  });
});

describe('dateTileParts', () => {
  it('splits a date for the calendar tile', () => {
    expect(dateTileParts('2026-10-26')).toEqual({ day: '26', month: 'Oct', year: '2026' });
    expect(dateTileParts('2027-03-05')).toEqual({ day: '5', month: 'Mar', year: '2027' });
    expect(dateTileParts('nonsense')).toBeNull();
    expect(dateTileParts('2026-13-01')).toBeNull();
  });
});

describe('BOOKING_STATUS_LABELS', () => {
  it('labels every status', () => {
    expect(BOOKING_STATUS_LABELS).toEqual({ open: 'Open', settled: 'Settled', cancelled: 'Cancelled' });
  });
});
