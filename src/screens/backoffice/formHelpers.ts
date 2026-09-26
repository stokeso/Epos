/**
 * Small helpers shared by the back-office forms (docs/ui-plan.md §1, §5.1, §5.5).
 *
 * Every Save goes through requirePermission(action) and passes the Authorisation to exactly one
 * service call (D-070, D-071). Forms pre-check their input with the same pure validators the
 * services use (src/rules/validation.ts) so a mistake is shown before anyone is asked for a PIN;
 * the service still validates again and its field errors are shown the same way (D-117).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { errorCode, errorMessage, fieldErrorsOf } from '../../app/errors';
import { requirePermission } from '../../app/requirePermission';
import type { Action } from '../../data/types';
import type { FieldErrors } from '../../rules/validation';
import type { Authorisation } from '../../services/override';

export type { FieldErrors };

/** Banner text when a save fails on field errors (each field shows its own message). */
export const CHECK_FIELDS_MESSAGE = 'Check the highlighted details.';

/**
 * Whole-number text -> number. Anything that is not an optional '-' and digits (after trimming)
 * gives NaN, which the validators reject with their own message ('' is NOT 0).
 */
export function parseWholeNumber(text: string): number {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Keeps only digits, at most `max` of them (PIN and quantity inputs). */
export function digitsOnly(value: string, max = 6): string {
  return value.replace(/\D/g, '').slice(0, max);
}

/** Merges field-error maps; the first message per field wins. */
export function mergeErrors(...maps: readonly FieldErrors[]): FieldErrors {
  const merged: Record<string, string> = {};
  for (const map of maps) {
    for (const [field, message] of Object.entries(map)) {
      if (merged[field] === undefined) merged[field] = message;
    }
  }
  return merged;
}

export interface GatedForm {
  busy: boolean;
  fieldErrors: FieldErrors;
  formError: string | null;
  /** Shows field errors found before asking for permission (no PIN is requested). */
  showErrors: (errors: FieldErrors, message?: string) => void;
  /** Shows a message without field errors. */
  showError: (message: string | null) => void;
  /**
   * requirePermission(action) -> work(auth). Resolves the result, or null when the permission
   * dialog was cancelled or the service failed (the error is then shown on the form).
   */
  run: <T>(action: Action, work: (auth: Authorisation) => Promise<T>) => Promise<T | null>;
}

/**
 * Busy flag, field errors and a form-level message for one gated form. `formFields` lists the
 * field keys the form shows next to a control: a VALIDATION error on any other key (e.g.
 * 'categoryId' when deleting a category) is shown as the form message instead.
 */
export function useGatedForm(formFields?: readonly string[]): GatedForm {
  const known = useRef(formFields);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const running = useRef(false);

  const showErrors = useCallback((errors: FieldErrors, message: string = CHECK_FIELDS_MESSAGE) => {
    setFieldErrors(errors);
    setFormError(Object.keys(errors).length > 0 ? message : null);
  }, []);

  const showError = useCallback((message: string | null) => {
    setFieldErrors({});
    setFormError(message);
  }, []);

  const run = useCallback(async <T>(action: Action, work: (auth: Authorisation) => Promise<T>): Promise<T | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const auth = await requirePermission(action);
      if (auth === null) return null;
      return await work(auth);
    } catch (error) {
      const fields = fieldErrorsOf(error);
      const code = errorCode(error);
      setFieldErrors(fields);
      // VALIDATION errors on the form's own fields are explained field by field; any other
      // error (or a field the form does not show) is shown as the message itself.
      const keys = Object.keys(fields);
      const allShown = keys.length > 0 && keys.every((key) => known.current === undefined || known.current.includes(key));
      setFormError(code === 'VALIDATION' && allShown ? CHECK_FIELDS_MESSAGE : errorMessage(error));
      return null;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, fieldErrors, formError, showErrors, showError, run };
}

/** After a rejected save, moves focus to the first invalid control inside `container`. */
export function useFocusFirstError(container: RefObject<HTMLElement | null>, fieldErrors: FieldErrors): void {
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return;
    const invalid = container.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid === null || invalid === undefined) return;
    invalid.focus({ preventScroll: true });
    // Centre it so its label and message stay in view.
    invalid.scrollIntoView({ block: 'center' });
  }, [container, fieldErrors]);
}
