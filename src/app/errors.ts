/**
 * Turning thrown errors into UI text (D-117): services throw AppError with a user-facing message
 * and, for VALIDATION, per-field messages. Screens show `message` and branch on `code`.
 */
import { isAppError, type AppErrorCode } from '../data/errors';

/** The message to show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
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
