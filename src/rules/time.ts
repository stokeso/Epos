/**
 * Time helpers (D-101..D-103, D-129). Pure: never read the clock; every "now" is a parameter.
 * Local dates are proleptic Gregorian 'YYYY-MM-DD', 0000-01-01..9999-12-31.
 * The club's time zone is fixed as Europe/London. It is NOT the device zone, so tests are
 * deterministic on a UTC machine. Use Intl.DateTimeFormat({ timeZone: CLUB_TIME_ZONE,
 * hourCycle: 'h23' }).formatToParts and assemble strings by hand.
 */
import type { IsoInstant, LocalDate } from '../data/types';

export const CLUB_TIME_ZONE = 'Europe/London';

/** A half-open instant range for reports (D-103): fromInclusive <= t < toExclusive. */
export interface InstantRange {
  fromInclusive: IsoInstant;
  toExclusive: IsoInstant;
}

/** A report range as chosen (inclusive local dates) plus its instant bounds (D-103). */
export interface LocalDateRange extends InstantRange {
  fromDate: LocalDate;
  toDate: LocalDate;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

// No `year` field: Intl's year is era-based and prints year 0000 as 1 (BC). See londonWallClock (D-129).
const LONDON_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLUB_TIME_ZONE,
  hourCycle: 'h23',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** A proleptic Gregorian year as 4+ digits: 26 -> '0026', 10000 -> '10000', -1 -> '-0001'. */
function yearText(year: number): string {
  return year < 0 ? `-${String(-year).padStart(4, '0')}` : String(year).padStart(4, '0');
}

function dateText(year: number, month: number, day: number): LocalDate {
  return `${yearText(year)}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Epoch ms of UTC midnight at the start of y-m-d (month and day may overflow, as with Date.UTC).
 * Unlike Date.UTC, years 0-99 are taken as given, not as 1900-1999 (D-129). NaN when out of range.
 */
function utcMidnightMs(year: number, month: number, day: number): number {
  return new Date(0).setUTCFullYear(year, month - 1, day);
}

function part(fields: Record<string, string>, name: string): number {
  const value = Number(fields[name]);
  if (!Number.isInteger(value)) throw new RangeError(`Intl gave no ${name}`);
  return value;
}

/**
 * London wall-clock fields for an epoch-ms value. Month, day and time come from Intl. The year is
 * the UTC year, moved by one across New Year: London is always within a day of UTC (D-129).
 */
function londonWallClock(ms: number): WallClock {
  const fields: Record<string, string> = {};
  for (const p of LONDON_PARTS.formatToParts(new Date(ms))) fields[p.type] = p.value;
  const month = part(fields, 'month');
  const utc = new Date(ms);
  const utcYear = utc.getUTCFullYear();
  const utcMonth = utc.getUTCMonth() + 1;
  const year = month === 12 && utcMonth === 1 ? utcYear - 1 : month === 1 && utcMonth === 12 ? utcYear + 1 : utcYear;
  const hour = part(fields, 'hour');
  return {
    year,
    month,
    day: part(fields, 'day'),
    // Some engines print midnight as '24' even with h23; normalise defensively.
    hour: hour === 24 ? 0 : hour,
    minute: part(fields, 'minute'),
    second: part(fields, 'second'),
  };
}

/**
 * London's offset from UTC at `ms`, in ms: 0 in GMT, 3600000 in BST, and -75000 under London Mean
 * Time (GMT-0:01:15, before 01/12/1847). Offsets are whole seconds, so milliseconds carry over.
 */
function londonOffsetMs(ms: number): number {
  const w = londonWallClock(ms);
  const wallMs =
    utcMidnightMs(w.year, w.month, w.day) +
    w.hour * HOUR_MS +
    w.minute * MINUTE_MS +
    w.second * SECOND_MS +
    new Date(ms).getUTCMilliseconds();
  return wallMs - ms;
}

function parseInstant(instant: IsoInstant): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid instant: ${instant}`);
  return ms;
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a real calendar date 'YYYY-MM-DD' (proleptic Gregorian, 0000-01-01..9999-12-31, the same
 * set the backup validator accepts, D-129); null when malformed or impossible (e.g. 2026-02-30).
 */
function parseLocalDate(date: LocalDate): { y: number; m: number; d: number } | null {
  const match = LOCAL_DATE_PATTERN.exec(date);
  if (match === null) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(utcMidnightMs(y, m, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

function requireLocalDate(date: LocalDate): { y: number; m: number; d: number } {
  const parsed = parseLocalDate(date);
  if (parsed === null) throw new RangeError(`Invalid date: ${date}`);
  return parsed;
}

/** True for a real calendar date in 'YYYY-MM-DD' form. */
export function isValidLocalDate(date: string): boolean {
  return parseLocalDate(date) !== null;
}

function utcDateString(ms: number): LocalDate {
  if (Number.isNaN(ms)) throw new RangeError('Date out of range');
  const d = new Date(ms);
  return dateText(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * The UTC instant of London midnight at the start of `date` (D-103, generalised by D-129):
 * t0 = UTC midnight of Y-M-D; result = t0 - London's offset at t0. Since 1847 the offset is a
 * whole number of hours h (0 in GMT, 1 in BST), which is D-103's t0 - h * 3600000; before that
 * London Mean Time was GMT-0:01:15.
 * Examples: '2026-09-26' -> '2026-09-25T23:00:00.000Z'; '2026-03-29' -> '2026-03-29T00:00:00.000Z';
 * '2026-10-25' -> '2026-10-24T23:00:00.000Z'; '1800-01-01' -> '1800-01-01T00:01:15.000Z'.
 * Throws RangeError for a malformed date.
 */
export function londonMidnight(date: LocalDate): IsoInstant {
  const { y, m, d } = requireLocalDate(date);
  const t0 = utcMidnightMs(y, m, d);
  return new Date(t0 - londonOffsetMs(t0)).toISOString();
}

/**
 * Calendar arithmetic on 'YYYY-MM-DD' (proleptic Gregorian; years 0-99 stay as given, D-129).
 * A result outside 0000-01-01..9999-12-31 is returned in expanded form ('10000-01-01',
 * '-0001-12-31'), which isValidLocalDate rejects. Throws RangeError for a malformed date or a
 * result beyond the range of Date.
 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const { y, m, d } = requireLocalDate(date);
  if (!Number.isSafeInteger(days)) throw new RangeError('days must be an integer');
  return utcDateString(utcMidnightMs(y, m, d + days));
}

/** The London calendar date containing `instant`. '2026-09-25T23:30:00.000Z' -> '2026-09-26'. */
export function londonDateOf(instant: IsoInstant): LocalDate {
  const w = londonWallClock(parseInstant(instant));
  return dateText(w.year, w.month, w.day);
}

/**
 * Inclusive local-date range -> half-open instants (D-103):
 * [londonMidnight(from), londonMidnight(addDays(to, 1))). Returns null when from > to, a date is
 * malformed, or the day after `to` is past year 9999.
 * Example: 26/09/2026..26/09/2026 -> ['2026-09-25T23:00:00.000Z', '2026-09-26T23:00:00.000Z').
 * 25/10/2026 (clocks go back) spans 25 hours: ['2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z').
 */
export function localDateRange(fromDate: LocalDate, toDate: LocalDate): LocalDateRange | null {
  if (!isValidLocalDate(fromDate) || !isValidLocalDate(toDate) || fromDate > toDate) return null;
  const dayAfter = addDays(toDate, 1);
  if (!isValidLocalDate(dayAfter)) return null; // 31/12/9999: '10000-01-01' has no YYYY-MM-DD form
  return {
    fromDate,
    toDate,
    fromInclusive: londonMidnight(fromDate),
    toExclusive: londonMidnight(dayAfter),
  };
}

/** fromInclusive <= instant < toExclusive (string comparison is valid for the fixed format, D-049). */
export function isInRange(instant: IsoInstant, range: InstantRange): boolean {
  return range.fromInclusive <= instant && instant < range.toExclusive;
}

/**
 * Deal form dates -> deal window (D-012): startsAt = londonMidnight(startDate);
 * endsAt = londonMidnight(endDate + 1 day). Each is omitted when its date is omitted.
 * Throws RangeError for a malformed date or an endDate of 9999-12-31, whose next day has no
 * YYYY-MM-DD form; validateDeal rejects both first (D-117, D-126).
 * Example: 01/10/2026..31/10/2026 -> startsAt '2026-09-30T23:00:00.000Z', endsAt '2026-11-01T00:00:00.000Z'.
 */
export function dealWindowFromDates(
  startDate: LocalDate | undefined,
  endDate: LocalDate | undefined,
): { startsAt?: IsoInstant; endsAt?: IsoInstant } {
  return {
    ...(startDate === undefined ? {} : { startsAt: londonMidnight(startDate) }),
    ...(endDate === undefined ? {} : { endsAt: londonMidnight(addDays(endDate, 1)) }),
  };
}

/** Inverse of dealWindowFromDates for editing: endsAt maps back to the day BEFORE its London date. */
export function datesFromDealWindow(
  startsAt: IsoInstant | undefined,
  endsAt: IsoInstant | undefined,
): { startDate?: LocalDate; endDate?: LocalDate } {
  return {
    ...(startsAt === undefined ? {} : { startDate: londonDateOf(startsAt) }),
    ...(endsAt === undefined ? {} : { endDate: addDays(londonDateOf(endsAt), -1) }),
  };
}

/** Receipt/report date-time in London: 'DD/MM/YYYY HH:mm' (24-hour). '2026-09-26T13:05:12.345Z' -> '26/09/2026 14:05'. */
export function formatDateTime(instant: IsoInstant): string {
  const w = londonWallClock(parseInstant(instant));
  return `${pad2(w.day)}/${pad2(w.month)}/${yearText(w.year)} ${pad2(w.hour)}:${pad2(w.minute)}`;
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY'. Throws RangeError for a malformed date. */
export function formatLocalDate(date: LocalDate): string {
  requireLocalDate(date);
  const [y, m, d] = date.split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/** Elapsed time for 'time open' (D-064): 'Xh Ym', or 'Ym' under an hour; negative -> '0m'. */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalMinutes = Math.floor(safe / MINUTE_MS);
  const minutes = totalMinutes % 60;
  const hours = (totalMinutes - minutes) / 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** London wall-clock stamp for file names: 'YYYY-MM-DD-HHmm' (D-088). */
export function fileStamp(instant: IsoInstant): string {
  const w = londonWallClock(parseInstant(instant));
  return `${dateText(w.year, w.month, w.day)}-${pad2(w.hour)}${pad2(w.minute)}`;
}
