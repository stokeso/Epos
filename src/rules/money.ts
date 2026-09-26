/**
 * Integer-pence money helpers (spec §3.2, §7; D-001..D-007).
 *
 * Every multiply-then-divide in the rules goes through these helpers. They compute in BigInt
 * internally so intermediate products cannot overflow. They throw RangeError on non-integer or
 * unsafe inputs, or on an unsafe result; they fail loudly and never silently round.
 * Never use Math.round, floats or p / 100 on money.
 */
import type { Pence } from '../data/types';

/** Largest product unit price and deal price: £9,999.99 (D-001). */
export const MAX_PRICE_PENCE = 999_999;

/** Largest amount a money keypad can hold (7 digits): £99,999.99 (D-001, D-006). */
export const MAX_KEYPAD_PENCE = 9_999_999;

/** Digits a money keypad accepts (D-006). */
export const MAX_KEYPAD_DIGITS = 7;

/** Line quantity bounds (D-008). */
export const MIN_LINE_QTY = 1;
export const MAX_LINE_QTY = 999;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** True for a safe integer that is not -0 (D-001, D-003). */
export function isPence(value: unknown): value is Pence {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
}

/** Throws RangeError unless `value` is a safe integer and not -0 (D-001, D-003). */
export function assertPence(value: number, label = 'amount'): void {
  if (!isPence(value)) {
    throw new RangeError(`${label} must be a safe integer number of pence (got ${String(value)})`);
  }
}

/** Throws RangeError unless `value` is a safe integer (-0 allowed: it is treated as 0). */
function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer (got ${String(value)})`);
  }
}

function toBigInt(value: number | bigint, label: string): bigint {
  if (typeof value === 'bigint') return value;
  assertSafeInteger(value, label);
  return BigInt(value);
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new RangeError(`${label} is outside the safe integer range`);
  }
  // Number(0n) is +0, so this never produces -0.
  return Number(value);
}

/**
 * Round half away from zero of num / den (D-002). den > 0.
 * a = |num|; q = a / den (truncating); if 2 * (a % den) >= den then q += 1; result = sign(num) * q.
 * Symmetric: roundHalfUp(-x, d) === -roundHalfUp(x, d). Never returns -0.
 * Examples: (5,2) -> 3; (-5,2) -> -3; (7,3) -> 2; (-1,3) -> 0.
 */
export function roundHalfUp(num: number | bigint, den: number | bigint): number {
  const n = toBigInt(num, 'numerator');
  const d = toBigInt(den, 'denominator');
  if (d <= 0n) throw new RangeError('denominator must be > 0');
  const negative = n < 0n;
  const a = negative ? -n : n;
  let q = a / d;
  if (2n * (a % d) >= d) q += 1n;
  return toSafeNumber(negative ? -q : q, 'rounded result');
}

/**
 * roundHalfUp(BigInt(a) * BigInt(b), den) (D-002).
 * Examples: (1230, 15, 100) -> 185 (184.5); (765, 20, 120) -> 128 (127.5).
 */
export function mulDivRoundHalfUp(a: number, b: number, den: number): number {
  return roundHalfUp(toBigInt(a, 'a') * toBigInt(b, 'b'), toBigInt(den, 'denominator'));
}

/**
 * Proportional allocation (D-004). Preconditions (RangeError otherwise): weights are
 * non-negative integers, 0 <= total <= sum(weights), priority is a permutation of the indices.
 * 1. W = sum(weights); total === 0 or W === 0 -> all zeros.
 * 2. share_i = mulDivRoundHalfUp(total, w_i, W).
 * 3. diff = total - sum(share).
 * 4. Walk `priority` until diff === 0: diff > 0 -> add min(diff, w_i - share_i);
 *    diff < 0 -> subtract min(-diff, share_i).
 * Guarantees 0 <= share_i <= w_i and sum(share) === total.
 * Examples: (200,[450,400,350],[0,1,2]) -> [75,67,58]; (100,[450,450,450],[0,1,2]) -> [34,33,33];
 * (185,[410,410,410],[0,1,2]) -> [61,62,62]; (3,[401,401,401,401,399],[0,1,2,3,4]) -> [0,0,1,1,1].
 */
export function allocate(total: number, weights: readonly number[], priority: readonly number[]): number[] {
  assertSafeInteger(total, 'total');
  if (total < 0) throw new RangeError('total must be >= 0');
  let sumWeights = 0n;
  for (const w of weights) {
    assertSafeInteger(w, 'weight');
    if (w < 0) throw new RangeError('weights must be >= 0');
    sumWeights += BigInt(w);
  }
  if (priority.length !== weights.length) throw new RangeError('priority must be a permutation of the weight indices');
  const seen = new Set<number>();
  for (const p of priority) {
    if (!Number.isInteger(p) || p < 0 || p >= weights.length || seen.has(p)) {
      throw new RangeError('priority must be a permutation of the weight indices');
    }
    seen.add(p);
  }
  const bigTotal = BigInt(total);
  if (bigTotal > sumWeights) throw new RangeError('total must not exceed the sum of the weights');

  if (total === 0 || sumWeights === 0n) return weights.map(() => 0);

  const shares = weights.map((w) => roundHalfUp(bigTotal * BigInt(w), sumWeights));
  let diff = total - shares.reduce((a, s) => a + s, 0);
  for (const i of priority) {
    if (diff === 0) break;
    const share = shares[i] ?? 0;
    const weight = weights[i] ?? 0;
    if (diff > 0) {
      const add = Math.min(diff, weight - share);
      shares[i] = share + add;
      diff -= add;
    } else {
      const sub = Math.min(-diff, share);
      shares[i] = share - sub;
      diff += sub;
    }
  }
  return shares;
}

/** p === 0 ? 0 : -p. The only way to flip a money sign (D-003). */
export function negate(p: Pence): Pence {
  assertSafeInteger(p, 'amount');
  return p === 0 ? 0 : -p;
}

/**
 * Sum of integer pence values (plain addition). Every running total is asserted safe: adding two
 * safe integers is exact whenever the true sum is safe, and otherwise lands on or past 2^53, so
 * a total can never silently round and come back into range.
 */
export function sumPence(values: readonly Pence[]): Pence {
  let total = 0;
  for (const v of values) {
    assertSafeInteger(v, 'amount');
    total += v;
    assertSafeInteger(total, 'sum');
  }
  // 0 + -0 is +0, so the sum is never -0.
  return total;
}

/** Whole pounds with thousands separators and two-digit pence, for |p|. */
function poundsAndPence(abs: number, separators: boolean): string {
  const pence = abs % 100;
  const pounds = (abs - pence) / 100;
  const poundsText = separators ? String(pounds).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(pounds);
  return `${poundsText}.${String(pence).padStart(2, '0')}`;
}

/**
 * Display format (D-005), integer maths only, no Intl: '-' if p < 0, then '£', whole pounds
 * with ',' thousands separators, '.', two-digit pence.
 * Examples: 0 -> '£0.00'; 5 -> '£0.05'; 123456 -> '£1,234.56'; -255 -> '-£2.55'.
 * -0 prints as '£0.00'.
 */
export function formatPence(p: Pence): string {
  assertSafeInteger(p, 'amount');
  const sign = p < 0 ? '-' : '';
  return `${sign}£${poundsAndPence(Math.abs(p), true)}`;
}

/** Money keypad keys (D-006). */
export type MoneyKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '00' | 'backspace' | 'clear';

/** Number of significant digits the keypad shows for a value (0 has none). */
function keypadDigits(value: number): number {
  return value === 0 ? 0 : String(value).length;
}

/**
 * Digits-as-pence keypad entry (D-006): digit -> value * 10 + d; '00' -> two zero digits;
 * 'backspace' -> drops the last digit ((value - value % 10) / 10); 'clear' -> 0. Leading zeros
 * are dropped. A key that would exceed MAX_KEYPAD_DIGITS digits is ignored (value unchanged),
 * so '00' with room for only one more digit is ignored as a whole.
 * Examples: 2,0,0,0 -> 2000; 1,'00' -> 100; 0,0,7 -> 7; an 8th digit is ignored.
 * Throws RangeError when valuePence is not an integer 0..MAX_KEYPAD_PENCE.
 */
export function pressMoneyKey(valuePence: Pence, key: MoneyKey): Pence {
  assertSafeInteger(valuePence, 'keypad value');
  if (valuePence < 0 || valuePence > MAX_KEYPAD_PENCE) throw new RangeError('keypad value out of range');
  const value = valuePence === 0 ? 0 : valuePence;
  switch (key) {
    case 'clear':
      return 0;
    case 'backspace':
      return (value - (value % 10)) / 10;
    case '00': {
      if (value === 0) return 0;
      return keypadDigits(value) + 2 > MAX_KEYPAD_DIGITS ? value : value * 100;
    }
    default: {
      const digit = Number(key);
      const next = value * 10 + digit;
      return keypadDigits(next) > MAX_KEYPAD_DIGITS ? value : next;
    }
  }
}

export type ParsePenceResult = { ok: true; pence: Pence } | { ok: false; error: string };

const POUNDS_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Back-office price text -> pence (D-007). Trim; strip one optional leading '£'; require
 * /^\d+(\.\d{1,2})?$/; pence = pounds * 100 + fraction right-padded to 2 digits (string maths,
 * never parseFloat). Rejects '', signs, commas, > 2 decimals, a bare leading '.', and values
 * above maxPence.
 * Examples: '4.5' -> 450; '£12' -> 1200; '0.05' -> 5; '4.35' -> 435; '4.505' / '-1' / '1,000' /
 * '.5' / '' -> error.
 */
export function parsePoundsToPence(text: string, maxPence: Pence): ParsePenceResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a price' };
  const body = trimmed.startsWith('£') ? trimmed.slice(1) : trimmed;
  const match = POUNDS_PATTERN.exec(body);
  if (match === null) return { ok: false, error: 'Enter a price like 4.50' };
  const pounds = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const pence = BigInt(pounds) * 100n + BigInt(fraction);
  if (pence > BigInt(maxPence)) return { ok: false, error: `The most it can be is ${formatPence(maxPence)}` };
  return { ok: true, pence: Number(pence) };
}

/**
 * The stored value as editable text (D-007, D-120): pounds and two-digit pence with no '£' and no
 * thousands separators, so it round-trips through parsePoundsToPence. 450 -> '4.50';
 * 123456 -> '1234.56'. Throws RangeError for a negative or non-integer value.
 */
export function penceToPoundsText(p: Pence): string {
  assertSafeInteger(p, 'amount');
  if (p < 0) throw new RangeError('penceToPoundsText needs a value >= 0');
  return poundsAndPence(p === 0 ? 0 : p, false);
}
