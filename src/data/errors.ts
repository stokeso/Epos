/**
 * The one error type thrown across the data layer and the services (D-117).
 *
 * Rules never throw AppError: they return result objects. The exception is money.ts, which
 * throws RangeError on non-integer or unsafe inputs (D-001). The UI shows `message` to the user.
 * It branches on `code`.
 */

export type AppErrorCode =
  /** Data layer: a write before initialise() created Settings (no deviceId yet). */
  | 'NOT_INITIALISED'
  /** A referenced record does not exist. */
  | 'NOT_FOUND'
  /** Input failed validation; `fieldErrors` holds per-field messages when available. */
  | 'VALIDATION'
  /** The Authorisation passed does not cover the action. */
  | 'PERMISSION_DENIED'
  /** The operation needs an open trading period and none is open. */
  | 'NO_OPEN_PERIOD'
  /** periods.open() while a period is already open. */
  | 'PERIOD_ALREADY_OPEN'
  /** Z close / tab operations need an empty (or specific) basket state. */
  | 'BASKET_NOT_EMPTY'
  /** The tab is not open (settled, deleted or missing). */
  | 'TAB_NOT_OPEN'
  /** The booking is not open. */
  | 'BOOKING_NOT_OPEN'
  /** depositAppliedPence exceeds the booking's unused balance at commit time. */
  | 'DEPOSIT_EXCEEDS_BALANCE'
  /** A refund asks for more units than remain refundable. */
  | 'REFUND_EXCEEDS_AVAILABLE'
  /** The sale kind cannot be refunded (deposit or refund). */
  | 'NOT_REFUNDABLE'
  /** A sale failed rules/sale.validateSale. */
  | 'INVALID_SALE'
  /** Uniqueness or append-only violation (e.g. re-adding an existing id). */
  | 'CONFLICT'
  /** A staff save would leave no active manager, or a user changing their own role/active flag. */
  | 'LAST_MANAGER'
  /** The chosen PIN clashes with another active staff member (or the sample staff). */
  | 'PIN_UNAVAILABLE'
  /** Backup file failed validation. */
  | 'INVALID_BACKUP'
  /** Contract-suite hook: failSaleCommitAfterWrites (D-115). */
  | 'FORCED_FAILURE';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: Readonly<Record<string, string>>;

  constructor(code: AppErrorCode, message: string, fieldErrors?: Readonly<Record<string, string>>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (fieldErrors !== undefined) this.fieldErrors = fieldErrors;
  }
}

/** Type guard for AppError, optionally of a given code. */
export function isAppError(value: unknown, code?: AppErrorCode): value is AppError {
  return value instanceof AppError && (code === undefined || value.code === code);
}
