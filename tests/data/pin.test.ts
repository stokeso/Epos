/**
 * PIN hashing (spec §2; D-073, D-074): PBKDF2-SHA-256 via Web Crypto, 100,000 iterations,
 * 16-byte random salt, 32-byte hash, lowercase hex, constant-time comparison.
 */
import { describe, expect, it } from 'vitest';
import {
  PIN_HASH_BYTES,
  PIN_ITERATIONS,
  PIN_SALT_BYTES,
  createPinCredentials,
  generateSalt,
  hashPin,
  verifyPin,
} from '../../src/services/pin';

/** hex('salt'), as used by the published PBKDF2-HMAC-SHA256 test vectors. */
const SALT_HEX = '73616c74';
const FIXED_SALT = '000102030405060708090a0b0c0d0e0f';

describe('parameters (D-073)', () => {
  it('uses 100,000 iterations, a 16-byte salt and a 32-byte hash', () => {
    expect(PIN_ITERATIONS).toBe(100_000);
    expect(PIN_SALT_BYTES).toBe(16);
    expect(PIN_HASH_BYTES).toBe(32);
  });
});

describe('generateSalt', () => {
  it('returns 16 random bytes as 32 lowercase hex characters', () => {
    const salts = new Set(Array.from({ length: 50 }, () => generateSalt()));
    expect(salts.size).toBe(50);
    for (const salt of salts) expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('hashPin', () => {
  it('matches the published PBKDF2-HMAC-SHA256 test vectors', async () => {
    expect(await hashPin('password', SALT_HEX, 1)).toBe('120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
    expect(await hashPin('password', SALT_HEX, 2)).toBe('ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43');
    expect(await hashPin('password', SALT_HEX, 4096)).toBe('c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a');
    expect(await hashPin('passwd', SALT_HEX, 1)).toBe('55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc');
  });

  it('defaults to PIN_ITERATIONS and returns 64 lowercase hex characters', async () => {
    const hash = await hashPin('1234', FIXED_SALT);
    expect(hash).toBe('869e6c8350c5beb0acc399fbaac3b60d220433896b26a647734d0d8f1586e1fa');
    expect(hash).toBe(await hashPin('1234', FIXED_SALT, PIN_ITERATIONS));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts upper-case salt hex and treats it as the same bytes', async () => {
    expect(await hashPin('1234', FIXED_SALT.toUpperCase(), 1)).toBe(await hashPin('1234', FIXED_SALT, 1));
  });

  it('gives different hashes for different PINs and different salts', async () => {
    const a = await hashPin('1234', FIXED_SALT, 10);
    expect(await hashPin('1235', FIXED_SALT, 10)).not.toBe(a);
    expect(await hashPin('1234', 'ff'.repeat(16), 10)).not.toBe(a);
  });

  it('rejects a malformed salt or iteration count with RangeError', async () => {
    await expect(hashPin('1234', '')).rejects.toBeInstanceOf(RangeError);
    await expect(hashPin('1234', 'abc')).rejects.toBeInstanceOf(RangeError);
    await expect(hashPin('1234', 'zz'.repeat(16))).rejects.toBeInstanceOf(RangeError);
    await expect(hashPin('1234', FIXED_SALT, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(hashPin('1234', FIXED_SALT, 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('createPinCredentials and verifyPin (D-074)', () => {
  it('creates a fresh salt and a hash that verifies only the same PIN', async () => {
    const credentials = await createPinCredentials('4321');
    expect(credentials.pinSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(credentials.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(credentials.pinHash).toBe(await hashPin('4321', credentials.pinSalt));
    expect(await verifyPin('4321', credentials)).toBe(true);
    expect(await verifyPin('4322', credentials)).toBe(false);
    expect(await verifyPin('432', credentials)).toBe(false);
    expect(await verifyPin('', credentials)).toBe(false);
  });

  it('salts every credential, so the same PIN never stores the same hash twice', async () => {
    const [a, b] = await Promise.all([createPinCredentials('1111'), createPinCredentials('1111')]);
    expect(a.pinSalt).not.toBe(b.pinSalt);
    expect(a.pinHash).not.toBe(b.pinHash);
  });

  it('compares every byte: a hash differing only in its last byte fails', async () => {
    const pinHash = await hashPin('2468', FIXED_SALT);
    const lastByte = Number.parseInt(pinHash.slice(-2), 16);
    const tampered = pinHash.slice(0, -2) + ((lastByte ^ 1).toString(16).padStart(2, '0'));
    expect(await verifyPin('2468', { pinHash, pinSalt: FIXED_SALT })).toBe(true);
    expect(await verifyPin('2468', { pinHash: tampered, pinSalt: FIXED_SALT })).toBe(false);
  });

  it('accepts stored hex in either case', async () => {
    const pinHash = await hashPin('2468', FIXED_SALT);
    expect(await verifyPin('2468', { pinHash: pinHash.toUpperCase(), pinSalt: FIXED_SALT.toUpperCase() })).toBe(true);
  });

  it('returns false (never throws) for malformed stored credentials', async () => {
    const pinHash = await hashPin('2468', FIXED_SALT);
    const cases = [
      { pinHash: '', pinSalt: FIXED_SALT },
      { pinHash: pinHash.slice(0, 62), pinSalt: FIXED_SALT },
      { pinHash: `${pinHash}00`, pinSalt: FIXED_SALT },
      { pinHash: `zz${pinHash.slice(2)}`, pinSalt: FIXED_SALT },
      { pinHash, pinSalt: '' },
      { pinHash, pinSalt: FIXED_SALT.slice(0, 30) },
      { pinHash, pinSalt: `${FIXED_SALT}00` },
      { pinHash, pinSalt: `g${FIXED_SALT.slice(1)}` },
    ];
    for (const stored of cases) expect(await verifyPin('2468', stored)).toBe(false);
  });
});
