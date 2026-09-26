/**
 * Turning thrown errors into UI text (D-117): services throw AppError with a user-facing message
 * and, for VALIDATION, per-field messages. Screens show `message` and branch on `code`.
 */
import { isAppError, type AppErrorCode } from '../data/errors';

/** Shown when the device's own storage (IndexedDB) fails: its own text is technical (D-138). */
export const STORAGE_ERROR_MESSAGE = 'The till couldn’t use this device’s storage.';

/**
 * Names IndexedDB (DOMException) and Dexie give their failures. File-reading names such as
 * NotReadableError are left out: a backup file that can't be read says so itself.
 */
const STORAGE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'UnknownError',
  'QuotaExceededError',
  'AbortError',
  'ConstraintError',
  'DataError',
  'DataCloneError',
  'InvalidStateError',
  'ReadOnlyError',
  'TransactionInactiveError',
  'VersionError',
  'TimeoutError',
  'DatabaseClosedError',
  'OpenFailedError',
  'MissingAPIError',
  'InvalidTableError',
  'NoSuchDatabaseError',
  'PrematureCommitError',
  'SubTransactionError',
  'UpgradeError',
  'SchemaError',
  'BulkError',
  'ModifyError',
]);

/** True for a failure of the device's storage (not an AppError, whose message is for staff). */
export function isStorageError(error: unknown): boolean {
  if (isAppError(error) || typeof error !== 'object' || error === null || !('name' in error)) return false;
  return typeof error.name === 'string' && STORAGE_ERROR_NAMES.has(error.name);
}

/**
 * The message to show for any thrown value. A storage failure shows plain words; its technical
 * text goes to the console for whoever looks after the till.
 */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (isStorageError(error)) {
    console.error(error);
    return STORAGE_ERROR_MESSAGE;
  }
  if ((error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException)) && error.message !== '') return error.message;
  return 'Something went wrong. Try again.';
}

/** AppError.fieldErrors (VALIDATION), or {} — spread into FormField `error` props by field name. */
export function fieldErrorsOf(error: unknown): Readonly<Record<string, string>> {
  return isAppError(error) && error.fieldErrors !== undefined ? error.fieldErrors : {};
}

/** The AppError code, or null for anything else. */
export function errorCode(error: unknown): AppErrorCode | null {
  return isAppError(error) ? error.code : null;
}
