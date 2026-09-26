import { describe, expect, it } from 'vitest';
import {
  MAX_KEYPAD_PENCE,
  MAX_PRICE_PENCE,
  allocate,
  assertPence,
  formatPence,
  mulDivRoundHalfUp,
  negate,
  parsePoundsToPence,
  penceToPoundsText,
  pressMoneyKey,
  roundHalfUp,
  sumPence,
  type MoneyKey,
} from '../../src/rules/money';

describe('assertPence (D-001, D-003)', () => {
  it('accepts safe integers of either sign', () => {
    for (const v of [0, 1, 450, -255, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      expect(() => assertPence(v)).not.toThrow();
    }
  });

  it('throws RangeError for fractions, non-finite, unsafe values and -0', () => {
    for (const v of [1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -0]) {
      expect(() => assertPence(v, 'amount')).toThrow(RangeError);
    }
  });
});

describe('roundHalfUp (D-002)', () => {
  it.each([
    [5, 2, 3], // 2.5 -> 3
    [-5, 2, -3], // -2.5 -> -3 (away from zero, symmetric)
    [7, 3, 2], // 2.33 -> 2
    [-7, 3, -2],
    [4, 2, 2],
    [-7, 2, -4], // -3.5 -> -4
    [1, 3, 0],
    [2, 3, 1], // 0.67 -> 1
    [0, 7, 0],
  ])('roundHalfUp(%i, %i) = %i', (num, den, expected) => {
    expect(roundHalfUp(num, den)).toBe(expected);
  });

  it('never returns -0', () => {
    expect(Object.is(roundHalfUp(-1, 3), 0)).toBe(true); // -0.33 -> 0, not -0
    expect(Object.is(roundHalfUp(-0, 3), 0)).toBe(true);
  });

  it('accepts bigint inputs', () => {
    expect(roundHalfUp(3n, 2n)).toBe(2);
    // 998,999,001^2 / 998,999,001 exactly: only exact in BigInt.
    expect(roundHalfUp(998_999_001n * 998_999_001n, 998_999_001n)).toBe(998_999_001);
  });

  it('throws RangeError on a bad denominator, a non-integer input or an unsafe result', () => {
    expect(() => roundHalfUp(1, 0)).toThrow(RangeError);
    expect(() => roundHalfUp(1, -2)).toThrow(RangeError);
    expect(() => roundHalfUp(1.5, 2)).toThrow(RangeError);
    expect(() => roundHalfUp(1, 2.5)).toThrow(RangeError);
    expect(() => roundHalfUp(2n ** 60n, 1n)).toThrow(RangeError);
  });
});

describe('mulDivRoundHalfUp (D-002)', () => {
  it.each([
    [1230, 15, 100, 185], // member discount 184.5 -> 185
    [1150, 15, 100, 173], // 172.5 -> 173
    [1030, 15, 100, 155], // 154.5 -> 155
    [765, 20, 120, 128], // VAT 127.5 -> 128
    [2295, 20, 120, 383], // VAT 382.5 -> 383
    [1250, 20, 120, 208], // VAT 208.33 -> 208
    [450, 20, 120, 75],
    [-765, 20, 120, -128], // symmetric
  ])('(%i * %i) / %i = %i', (a, b, den, expected) => {
    expect(mulDivRoundHalfUp(a, b, den)).toBe(expected);
  });

  it('returns 0 rather than -0 for small negatives', () => {
    expect(Object.is(mulDivRoundHalfUp(-2, 20, 120), 0)).toBe(true); // -0.33 -> 0
  });

  it('is exact where a Number product would lose precision', () => {
    // 998,999,001 * 998,999,001 ~ 1e18 > 2^53.
    expect(mulDivRoundHalfUp(998_999_001, 998_999_001, 998_999_001)).toBe(998_999_001);
    // Max line gross at 20% VAT: 998,999,001 * 20 / 120 = 166,499,833.5 -> 166,499,834.
    expect(mulDivRoundHalfUp(998_999_001, 20, 120)).toBe(166_499_834);
  });

  it('throws RangeError on non-integer inputs or a zero denominator', () => {
    expect(() => mulDivRoundHalfUp(4.5, 2, 3)).toThrow(RangeError);
    expect(() => mulDivRoundHalfUp(4, 2, 0)).toThrow(RangeError);
  });
});

describe('allocate (D-004)', () => {
  it('matches the D-004 worked examples', () => {
    // 200 * [450,400,350] / 1200 = 75, 66.67 -> 67, 58.33 -> 58; sum 200, no remainder.
    expect(allocate(200, [450, 400, 350], [0, 1, 2])).toEqual([75, 67, 58]);
    // 33.33 each -> 33,33,33 = 99; diff +1 on priority[0].
    expect(allocate(100, [450, 450, 450], [0, 1, 2])).toEqual([34, 33, 33]);
    // 61.67 each -> 62,62,62 = 186; diff -1 on priority[0].
    expect(allocate(185, [410, 410, 410], [0, 1, 2])).toEqual([61, 62, 62]);
    // 0.5 each -> 1,1 = 2; diff -1 on priority[0].
    expect(allocate(1, [450, 450], [0, 1])).toEqual([0, 1]);
    // Cascade: 3*401/2003 = 0.6 -> 1 (x4), 3*399/2003 = 0.6 -> 1; sum 5, diff -2 -> first two lose 1.
    expect(allocate(3, [401, 401, 401, 401, 399], [0, 1, 2, 3, 4])).toEqual([0, 0, 1, 1, 1]);
  });

  it('puts the remainder where the priority says', () => {
    expect(allocate(100, [450, 450, 450], [2, 1, 0])).toEqual([33, 33, 34]);
    // 4*3/9 = 1.33 -> 1 each = 3; diff +1 on index 0.
    expect(allocate(4, [3, 3, 3], [0, 1, 2])).toEqual([2, 1, 1]);
  });

  it('clamps the walk so no share exceeds its weight', () => {
    // 6*[1,2,2,2,2]/9 = 0.67 -> 1, 1.33 -> 1 (x4); sum 5, diff +1.
    // priority[0] = index 0 is already at its weight 1, so the +1 goes to index 1.
    expect(allocate(6, [1, 2, 2, 2, 2], [0, 1, 2, 3, 4])).toEqual([1, 2, 1, 1, 1]);
  });

  it('returns zeros for a zero total or zero weights', () => {
    expect(allocate(0, [450, 400], [0, 1])).toEqual([0, 0]);
    expect(allocate(0, [0, 0], [1, 0])).toEqual([0, 0]);
    expect(allocate(0, [], [])).toEqual([]);
  });

  it('gives zero-weight entries nothing', () => {
    expect(allocate(100, [400, 0], [0, 1])).toEqual([100, 0]);
    expect(allocate(100, [0, 400], [0, 1])).toEqual([0, 100]);
  });

  it('allocates the whole total when total equals the weight sum', () => {
    expect(allocate(1000, [500, 300, 200], [0, 1, 2])).toEqual([500, 300, 200]);
  });

  it('is exact for large values', () => {
    expect(allocate(998_999_001, [499_499_501, 499_499_500], [0, 1])).toEqual([499_499_501, 499_499_500]);
  });

  it('always sums to the total with every share in 0..weight', () => {
    const weights = [1, 7, 13, 250, 999, 2, 0, 45];
    const W = weights.reduce((a, b) => a + b, 0);
    for (const total of [0, 1, 2, 3, 17, 99, 500, 1000, W - 1, W]) {
      const shares = allocate(total, weights, [4, 3, 7, 2, 1, 5, 0, 6]);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      shares.forEach((s, i) => {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(weights[i] ?? -1);
      });
    }
  });

  it('throws RangeError when a precondition fails', () => {
    expect(() => allocate(-1, [1, 1], [0, 1])).toThrow(RangeError); // negative total
    expect(() => allocate(3, [1, 1], [0, 1])).toThrow(RangeError); // total > sum(weights)
    expect(() => allocate(1, [-1, 3], [0, 1])).toThrow(RangeError); // negative weight
    expect(() => allocate(1, [1.5, 3], [0, 1])).toThrow(RangeError); // fractional weight
    expect(() => allocate(1, [1, 1], [0])).toThrow(RangeError); // priority too short
    expect(() => allocate(1, [1, 1], [0, 0])).toThrow(RangeError); // not a permutation
    expect(() => allocate(1, [1, 1], [0, 2])).toThrow(RangeError); // out of range
    expect(() => allocate(0.5, [1, 1], [0, 1])).toThrow(RangeError); // fractional total
  });
});

describe('negate (D-003)', () => {
  it('flips the sign without producing -0', () => {
    expect(negate(255)).toBe(-255);
    expect(negate(-255)).toBe(255);
    expect(Object.is(negate(0), 0)).toBe(true);
    expect(Object.is(negate(-0), 0)).toBe(true);
  });

  it('throws RangeError for a non-integer', () => {
    expect(() => negate(1.5)).toThrow(RangeError);
  });
});

describe('sumPence', () => {
  it('adds integer pence', () => {
    expect(sumPence([])).toBe(0);
    expect(sumPence([1, 2, 3])).toBe(6);
    expect(sumPence([765, 212, 9180, -255])).toBe(9902);
    expect(Object.is(sumPence([-255, 255]), 0)).toBe(true);
  });

  it('throws RangeError on a non-integer or an unsafe result', () => {
    expect(() => sumPence([1, 0.5])).toThrow(RangeError);
    expect(() => sumPence([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });

  it('throws when a running total leaves the safe range, even if later terms bring it back (D-001)', () => {
    // MAX + 2 rounds to 2^53 as a Number, and 2^53 - 2 would be a wrong but safe answer.
    expect(() => sumPence([Number.MAX_SAFE_INTEGER, 2, -2])).toThrow(RangeError);
    expect(() => sumPence([-Number.MAX_SAFE_INTEGER, -2, 2])).toThrow(RangeError);
    expect(sumPence([Number.MAX_SAFE_INTEGER, -2, 2])).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('formatPence (D-005)', () => {
  it.each([
    [0, '£0.00'],
    [5, '£0.05'],
    [99, '£0.99'],
    [100, '£1.00'],
    [450, '£4.50'],
    [99_999, '£999.99'],
    [100_000, '£1,000.00'],
    [123_456, '£1,234.56'],
    [100_000_000, '£1,000,000.00'],
    [-5, '-£0.05'],
    [-255, '-£2.55'],
    [-123_456, '-£1,234.56'],
  ])('formatPence(%i) = %s', (p, text) => {
    expect(formatPence(p)).toBe(text);
  });

  it('prints discounts via negate, and negate(0) as £0.00', () => {
    expect(formatPence(negate(173))).toBe('-£1.73');
    expect(formatPence(negate(0))).toBe('£0.00');
  });

  it('throws RangeError for a non-integer', () => {
    expect(() => formatPence(4.5)).toThrow(RangeError);
  });
});

describe('pressMoneyKey (D-006)', () => {
  const press = (keys: MoneyKey[], start = 0) => keys.reduce(pressMoneyKey, start);

  it('enters digits as pence', () => {
    expect(press(['2', '0', '0', '0'])).toBe(2000); // £20.00
    expect(press(['5'])).toBe(5); // £0.05
    expect(press(['1', '00'])).toBe(100);
    expect(press(['0', '0', '7'])).toBe(7); // leading zeros dropped
    expect(press(['00'])).toBe(0);
    expect(press(['00', '5', '00'])).toBe(500);
  });

  it('accepts at most 7 digits and ignores further keys', () => {
    const sevenNines: MoneyKey[] = ['9', '9', '9', '9', '9', '9', '9'];
    expect(press(sevenNines)).toBe(MAX_KEYPAD_PENCE);
    expect(press([...sevenNines, '9'])).toBe(9_999_999);
    expect(press([...sevenNines, '00'])).toBe(9_999_999);
    // '00' with room for only one more digit would exceed 7 digits, so the key is ignored.
    expect(press(['00'], 123_456)).toBe(123_456);
    expect(press(['00'], 12_345)).toBe(1_234_500);
  });

  it('backspace drops the last digit and clear resets', () => {
    expect(press(['backspace'], 2000)).toBe(200);
    expect(press(['backspace'], 5)).toBe(0);
    expect(press(['backspace'], 0)).toBe(0);
    expect(press(['clear'], 9_999_999)).toBe(0);
    expect(press(['1', '2', 'backspace', '5'])).toBe(15);
  });

  it('throws RangeError for a value outside the keypad range', () => {
    expect(() => pressMoneyKey(-1, '1')).toThrow(RangeError);
    expect(() => pressMoneyKey(MAX_KEYPAD_PENCE + 1, 'clear')).toThrow(RangeError);
  });
});

describe('parsePoundsToPence (D-007)', () => {
  it.each([
    ['4.5', 450],
    ['4.50', 450],
    ['£12', 1200],
    ['0.05', 5],
    ['4.35', 435], // string maths: never 434.999...
    ['  £4.35 ', 435],
    ['0', 0],
    ['007', 700],
    ['9999.99', 999_999],
  ])('%j -> %i', (text, pence) => {
    expect(parsePoundsToPence(text, MAX_PRICE_PENCE)).toEqual({ ok: true, pence });
  });

  it.each(['4.505', '-1', '1,000', '.5', '', '   ', '£', '£-1', '+1', '4.', '1e3', '££4', '4.5.6', 'abc', '£ 4'])(
    'rejects %j',
    (text) => {
      expect(parsePoundsToPence(text, MAX_PRICE_PENCE)).toMatchObject({ ok: false, error: expect.any(String) });
    },
  );

  it('rejects values above maxPence without losing precision', () => {
    expect(parsePoundsToPence('10000', MAX_PRICE_PENCE).ok).toBe(false);
    expect(parsePoundsToPence('10000.00', 1_000_000)).toEqual({ ok: true, pence: 1_000_000 });
    expect(parsePoundsToPence('123456789012345678901234', MAX_PRICE_PENCE).ok).toBe(false);
  });
});

describe('penceToPoundsText (D-007, D-120)', () => {
  it('shows the stored value for editing', () => {
    expect(penceToPoundsText(450)).toBe('4.50');
    expect(penceToPoundsText(5)).toBe('0.05');
    expect(penceToPoundsText(0)).toBe('0.00');
    expect(penceToPoundsText(1200)).toBe('12.00');
  });

  it('has no thousands separators, so it round-trips through parsePoundsToPence (D-120)', () => {
    expect(penceToPoundsText(123_456)).toBe('1234.56');
    for (const p of [0, 1, 99, 100, 435, 123_456, MAX_PRICE_PENCE]) {
      expect(parsePoundsToPence(penceToPoundsText(p), MAX_PRICE_PENCE)).toEqual({ ok: true, pence: p });
    }
  });

  it('throws RangeError for a negative or non-integer value (D-120)', () => {
    expect(() => penceToPoundsText(-1)).toThrow(RangeError);
    expect(() => penceToPoundsText(1.5)).toThrow(RangeError);
  });
});
