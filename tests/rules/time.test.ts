import { describe, expect, it } from 'vitest';
import {
  CLUB_TIME_ZONE,
  addDays,
  datesFromDealWindow,
  dealWindowFromDates,
  fileStamp,
  formatDateTime,
  formatDuration,
  formatLocalDate,
  isInRange,
  isValidLocalDate,
  localDateRange,
  londonDateOf,
  londonMidnight,
} from '../../src/rules/time';

describe('CLUB_TIME_ZONE (D-102)', () => {
  it('is Europe/London', () => {
    expect(CLUB_TIME_ZONE).toBe('Europe/London');
  });
});

describe('londonMidnight (D-103)', () => {
  it.each([
    ['2026-09-26', '2026-09-25T23:00:00.000Z'], // BST: midnight is 23:00Z the day before
    ['2026-01-15', '2026-01-15T00:00:00.000Z'], // GMT
    ['2026-03-29', '2026-03-29T00:00:00.000Z'], // spring-forward day starts in GMT
    ['2026-03-30', '2026-03-29T23:00:00.000Z'], // first full BST day
    ['2026-10-25', '2026-10-24T23:00:00.000Z'], // fall-back day starts in BST
    ['2026-10-26', '2026-10-26T00:00:00.000Z'], // first full GMT day
  ])('%s -> %s', (date, instant) => {
    expect(londonMidnight(date)).toBe(instant);
  });

  it('throws RangeError for malformed or impossible dates', () => {
    for (const bad of ['2026-02-30', '2026-9-26', '26/09/2026', 'x', '']) {
      expect(() => londonMidnight(bad)).toThrow(RangeError);
    }
  });
});

describe('addDays', () => {
  it.each([
    ['2026-09-26', 1, '2026-09-27'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-10-25', 1, '2026-10-26'],
    ['2026-09-26', 0, '2026-09-26'],
    ['2026-09-26', 30, '2026-10-26'],
  ])('%s + %i = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe('londonDateOf', () => {
  it.each([
    ['2026-09-25T23:30:00.000Z', '2026-09-26'], // 00:30 BST
    ['2026-09-25T22:59:59.999Z', '2026-09-25'],
    ['2026-01-15T23:30:00.000Z', '2026-01-15'], // 23:30 GMT
    ['2026-09-30T23:00:00.000Z', '2026-10-01'],
  ])('%s -> %s', (instant, date) => {
    expect(londonDateOf(instant)).toBe(date);
  });

  it('throws RangeError for an invalid instant', () => {
    expect(() => londonDateOf('not a date')).toThrow(RangeError);
  });
});

describe('localDateRange (D-103)', () => {
  it('converts one BST day', () => {
    expect(localDateRange('2026-09-26', '2026-09-26')).toEqual({
      fromDate: '2026-09-26',
      toDate: '2026-09-26',
      fromInclusive: '2026-09-25T23:00:00.000Z',
      toExclusive: '2026-09-26T23:00:00.000Z',
    });
  });

  it('spans 23 hours on the spring-forward day', () => {
    const r = localDateRange('2026-03-29', '2026-03-29');
    expect(r).toMatchObject({ fromInclusive: '2026-03-29T00:00:00.000Z', toExclusive: '2026-03-29T23:00:00.000Z' });
    expect(Date.parse(r!.toExclusive) - Date.parse(r!.fromInclusive)).toBe(23 * 3_600_000);
  });

  it('spans 25 hours on the fall-back day', () => {
    const r = localDateRange('2026-10-25', '2026-10-25');
    expect(r).toMatchObject({ fromInclusive: '2026-10-24T23:00:00.000Z', toExclusive: '2026-10-26T00:00:00.000Z' });
    expect(Date.parse(r!.toExclusive) - Date.parse(r!.fromInclusive)).toBe(25 * 3_600_000);
  });

  it('converts a month across the clock change', () => {
    expect(localDateRange('2026-10-01', '2026-10-31')).toMatchObject({
      fromInclusive: '2026-09-30T23:00:00.000Z',
      toExclusive: '2026-11-01T00:00:00.000Z',
    });
  });

  it('returns null when from > to or a date is malformed', () => {
    expect(localDateRange('2026-09-27', '2026-09-26')).toBeNull();
    expect(localDateRange('2026-09-xx', '2026-09-26')).toBeNull();
    expect(localDateRange('2026-09-26', '2026-02-30')).toBeNull();
  });

  it('returns null, not a RangeError, when the day after the end date is past year 9999', () => {
    // A date input accepts 31/12/9999; its next day '10000-01-01' has no YYYY-MM-DD form.
    expect(localDateRange('9999-12-31', '9999-12-31')).toBeNull();
    expect(localDateRange('2026-09-26', '9999-12-31')).toBeNull();
    expect(localDateRange('9999-12-30', '9999-12-30')).toMatchObject({ toExclusive: '9999-12-31T00:00:00.000Z' });
  });
});

describe('isInRange (D-103)', () => {
  const range = { fromInclusive: '2026-09-25T23:00:00.000Z', toExclusive: '2026-09-26T23:00:00.000Z' };
  it('is inclusive at the start and exclusive at the end', () => {
    expect(isInRange('2026-09-25T22:59:59.999Z', range)).toBe(false);
    expect(isInRange('2026-09-25T23:00:00.000Z', range)).toBe(true);
    expect(isInRange('2026-09-26T13:05:12.345Z', range)).toBe(true);
    expect(isInRange('2026-09-26T22:59:59.999Z', range)).toBe(true);
    expect(isInRange('2026-09-26T23:00:00.000Z', range)).toBe(false);
  });
});

describe('dealWindowFromDates / datesFromDealWindow (D-012)', () => {
  it('maps the form dates to London-midnight instants', () => {
    expect(dealWindowFromDates('2026-10-01', '2026-10-31')).toEqual({
      startsAt: '2026-09-30T23:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
    });
    // End date 30/09/2026 -> endsAt is midnight at the start of 01/10.
    expect(dealWindowFromDates(undefined, '2026-09-30')).toEqual({ endsAt: '2026-09-30T23:00:00.000Z' });
  });

  it('ends at 31/12/9999 at the latest; validateDeal rejects a later window end first (D-126)', () => {
    expect(dealWindowFromDates('9999-12-31', '9999-12-30')).toEqual({ startsAt: '9999-12-31T00:00:00.000Z', endsAt: '9999-12-31T00:00:00.000Z' });
    expect(() => dealWindowFromDates(undefined, '9999-12-31')).toThrow(RangeError);
  });

  it('omits the keys for missing dates (D-050)', () => {
    const none = dealWindowFromDates(undefined, undefined);
    expect(Object.keys(none)).toEqual([]);
    expect(Object.keys(dealWindowFromDates('2026-10-01', undefined))).toEqual(['startsAt']);
  });

  it('inverts back to the form dates', () => {
    expect(datesFromDealWindow('2026-09-30T23:00:00.000Z', '2026-11-01T00:00:00.000Z')).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });
    expect(datesFromDealWindow(undefined, '2026-09-30T23:00:00.000Z')).toEqual({ endDate: '2026-09-30' });
    expect(Object.keys(datesFromDealWindow(undefined, undefined))).toEqual([]);
    for (const [s, e] of [
      ['2026-03-29', '2026-03-29'],
      ['2026-10-25', '2026-10-25'],
      ['2026-12-01', '2027-01-31'],
    ] as const) {
      const w = dealWindowFromDates(s, e);
      expect(datesFromDealWindow(w.startsAt, w.endsAt)).toEqual({ startDate: s, endDate: e });
    }
  });
});

describe('formatting (D-102)', () => {
  it('formats date-times in London as DD/MM/YYYY HH:mm', () => {
    expect(formatDateTime('2026-09-26T13:05:12.345Z')).toBe('26/09/2026 14:05');
    expect(formatDateTime('2026-01-05T09:07:00.000Z')).toBe('05/01/2026 09:07');
    expect(formatDateTime('2026-09-25T23:30:00.000Z')).toBe('26/09/2026 00:30'); // hour 00, not 24
  });

  it('formats local dates as DD/MM/YYYY', () => {
    expect(formatLocalDate('2026-09-26')).toBe('26/09/2026');
    expect(formatLocalDate('2027-01-05')).toBe('05/01/2027');
    expect(() => formatLocalDate('26/09/2026')).toThrow(RangeError);
  });

  it.each([
    [0, '0m'],
    [59_999, '0m'],
    [60_000, '1m'],
    [3_599_999, '59m'],
    [3_600_000, '1h 0m'],
    [5_580_000, '1h 33m'],
    [26 * 3_600_000, '26h 0m'],
    [-5_000, '0m'],
  ])('formatDuration(%i) = %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it('makes London file stamps YYYY-MM-DD-HHmm', () => {
    expect(fileStamp('2026-09-26T13:05:12.345Z')).toBe('2026-09-26-1405');
    expect(fileStamp('2026-01-05T09:07:00.000Z')).toBe('2026-01-05-0907');
  });
});

describe('every YYYY-MM-DD date, 0000-01-01 to 9999-12-31 (D-129)', () => {
  // Date.UTC(y, ...) maps years 0-99 to 1900-1999, and Intl prints year 0000 as era year 1 (1 BC).
  // The backup validator (D-089) accepts every real calendar date, so the rules must too.
  it('accepts real dates in years 0000-0099 and rejects impossible ones', () => {
    for (const date of ['0000-01-01', '0000-02-29', '0004-02-29', '0026-10-10', '0099-12-31', '0100-01-01', '1800-01-01']) {
      expect(isValidLocalDate(date), date).toBe(true);
    }
    for (const date of ['0001-02-29', '0100-02-29', '1900-02-29', '0026-02-30', '0000-00-01', '0000-13-01', '0026-10-00']) {
      expect(isValidLocalDate(date), date).toBe(false);
    }
  });

  it.each([
    ['0100-01-01', -1, '0099-12-31'],
    ['0026-10-10', 1, '0026-10-11'],
    ['0099-12-31', 1, '0100-01-01'],
    ['0000-12-31', 1, '0001-01-01'],
    ['0000-03-01', -1, '0000-02-29'],
    ['0026-10-10', 365, '0027-10-10'],
  ])('addDays(%s, %i) = %s, not a 1900s date', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it('gives no YYYY-MM-DD date before 0000-01-01 or after 9999-12-31', () => {
    expect(addDays('0000-01-01', -1)).toBe('-0001-12-31');
    expect(isValidLocalDate(addDays('0000-01-01', -1))).toBe(false);
    expect(addDays('9999-12-31', 1)).toBe('10000-01-01');
    expect(() => addDays('2026-09-26', 1e9)).toThrow(RangeError); // beyond the range of Date
  });

  it('formats early dates', () => {
    expect(formatLocalDate('0026-10-10')).toBe('10/10/0026');
    expect(formatLocalDate('0000-02-29')).toBe('29/02/0000');
  });

  it('finds true London midnight under London Mean Time (GMT-0:01:15, until 01/12/1847)', () => {
    expect(londonMidnight('0000-01-01')).toBe('0000-01-01T00:01:15.000Z');
    expect(londonMidnight('0026-10-10')).toBe('0026-10-10T00:01:15.000Z');
    expect(londonMidnight('1800-01-01')).toBe('1800-01-01T00:01:15.000Z');
    expect(londonMidnight('1847-12-01')).toBe('1847-12-01T00:01:15.000Z'); // the switch to GMT
    expect(londonMidnight('1847-12-02')).toBe('1847-12-02T00:00:00.000Z');
  });

  it('reads London dates and times in year 0000 as 0000, not era year 1', () => {
    expect(londonDateOf('0000-06-01T12:00:00.000Z')).toBe('0000-06-01');
    expect(formatDateTime('0000-06-01T12:00:00.000Z')).toBe('01/06/0000 11:58');
    expect(londonDateOf('0026-01-01T00:00:00.000Z')).toBe('0025-12-31'); // 23:58:45 LMT
    expect(fileStamp('0026-01-01T00:00:00.000Z')).toBe('0025-12-31-2358');
    expect(formatDateTime('0001-01-01T00:00:00.000Z')).toBe('31/12/0000 23:58');
  });

  it.each([
    '0000-01-01',
    '0000-02-29',
    '0026-10-10',
    '0099-12-31',
    '0100-01-01',
    '1800-01-01',
    '1847-11-30',
    '1847-12-01',
    '1847-12-02',
    '1916-05-21',
    '1941-06-01',
    '1970-01-01',
    '2026-03-29',
    '2026-09-26',
    '2026-10-25',
    '9999-12-30',
  ])('%s: London midnight, the report range and the deal window all agree with londonDateOf', (date) => {
    const midnight = londonMidnight(date);
    const nextMidnight = londonMidnight(addDays(date, 1));
    expect(londonDateOf(midnight)).toBe(date);
    expect(londonDateOf(new Date(Date.parse(nextMidnight) - 1).toISOString())).toBe(date);
    if (date !== '0000-01-01') {
      expect(londonDateOf(new Date(Date.parse(midnight) - 1).toISOString())).toBe(addDays(date, -1));
    }
    expect(localDateRange(date, date)).toEqual({ fromDate: date, toDate: date, fromInclusive: midnight, toExclusive: nextMidnight });
    const window = dealWindowFromDates(date, date);
    expect(window).toEqual({ startsAt: midnight, endsAt: nextMidnight });
    expect(datesFromDealWindow(window.startsAt, window.endsAt)).toEqual({ startDate: date, endDate: date });
  });
});
