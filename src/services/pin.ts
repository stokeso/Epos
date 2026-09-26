/**
 * PIN hashing (spec §2; D-073, D-074). Pure and async (Web Crypto); no storage.
 * Owned by the data builder. pinHash/pinSalt never reach UI state, logs or the screen.
 *
 * key = crypto.subtle.importKey('raw', UTF-8 bytes of pin, 'PBKDF2', false, ['deriveBits'])
 * bits = crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
 * Stored as lowercase hex: pinSalt 32 chars (16 bytes), pinHash 64 chars (32 bytes).
 * IMPORTANT: never call these inside Repos.transact() (non-Dexie promises end the transaction).
 */

/** Modest for a learning build (login tries every active staff member); raise before real use. */
export const PIN_ITERATIONS = 100_000;
export const PIN_SALT_BYTES = 16;
export const PIN_HASH_BYTES = 32;

export interface PinCredentials {
  pinHash: string;
  pinSalt: string;
}

const HEX_PAIRS = /^(?:[0-9a-f]{2})+$/i;
const STORED_SALT = new RegExp(`^[0-9a-f]{${PIN_SALT_BYTES * 2}}$`, 'i');
const STORED_HASH = new RegExp(`^[0-9a-f]{${PIN_HASH_BYTES * 2}}$`, 'i');

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Non-empty, even-length hex -> bytes; anything else -> null. */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!HEX_PAIRS.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, PIN_HASH_BYTES * 8);
  return new Uint8Array(bits);
}

/** 16 bytes from crypto.getRandomValues as 32-char lowercase hex. */
export function generateSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(PIN_SALT_BYTES)));
}

/**
 * PBKDF2-SHA-256 of the PIN with the hex salt; 64-char lowercase hex. iterations defaults to
 * PIN_ITERATIONS. Rejects with RangeError for a salt that is not non-empty even-length hex, or an
 * iteration count that is not a positive safe integer.
 */
export async function hashPin(pin: string, saltHex: string, iterations: number = PIN_ITERATIONS): Promise<string> {
  const salt = hexToBytes(saltHex);
  if (salt === null) throw new RangeError('hashPin: the salt must be non-empty, even-length hex');
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new RangeError('hashPin: iterations must be a positive integer');
  return bytesToHex(await derive(pin, salt, iterations));
}

/** generateSalt() + hashPin(). The caller validates the PIN format first. */
export async function createPinCredentials(pin: string): Promise<PinCredentials> {
  const pinSalt = generateSalt();
  const pinHash = await hashPin(pin, pinSalt);
  return { pinHash, pinSalt };
}

/**
 * Derives with stored.pinSalt and compares all 32 bytes with an XOR accumulator, with no early
 * exit (D-074). Malformed stored hex -> false.
 */
export async function verifyPin(pin: string, stored: PinCredentials): Promise<boolean> {
  if (!STORED_SALT.test(stored.pinSalt) || !STORED_HASH.test(stored.pinHash)) return false;
  const salt = hexToBytes(stored.pinSalt);
  const expected = hexToBytes(stored.pinHash);
  if (salt === null || expected === null) return false;
  const actual = await derive(pin, salt, PIN_ITERATIONS);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < PIN_HASH_BYTES; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}
