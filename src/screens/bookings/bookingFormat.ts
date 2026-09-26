/**
 * Display helpers for bookings (no business rules: statuses, balances and what is allowed come
 * from services/bookings.BookingSummary).
 */
import type { BookingStatus, LocalDate } from '../../data/types';
import { isValidLocalDate, londonMidnight } from '../../rules/time';

export const BOOKING_STATUS_LABELS = {
  open: 'Open',
  settled: 'Settled',
  cancelled: 'Cancelled',
} as const satisfies Record<BookingStatus, string>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const DAY_MS = 86_400_000;

/** Whole calendar days from `today` to `date` (London dates), or null for a malformed date. */
export function daysFromToday(date: LocalDate, today: LocalDate): number | null {
  if (!isValidLocalDate(date) || !isValidLocalDate(today)) return null;
  // London midnights differ by 23 or 25 hours across a clock change: round to whole days.
  return Math.round((Date.parse(londonMidnight(date)) - Date.parse(londonMidnight(today))) / DAY_MS);
}

/** 'Today', 'Tomorrow', 'In 14 days', 'Yesterday', '3 days ago'. */
export function relativeDayText(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 1 ? `In ${days} days` : `${-days} days ago`;
}

/** Parts for the calendar tile: '2026-10-26' -> { day: '26', month: 'Oct', year: '2026' }. */
export function dateTileParts(date: LocalDate): { day: string; month: string; year: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return null;
  return { day: String(Number(match[3])), month, year: match[1] ?? '' };
}
