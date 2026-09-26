import { errorCode, errorMessage } from '../../app';
import { useAppStore } from '../../store';

/**
 * The message to show for an error from a till action (D-117). When a service says no period is
 * open (for example it was Z-closed elsewhere), the cached period is refreshed as well, so the
 * till switches to the 'No trading period open' prompt instead of offering actions that fail.
 */
export function tillErrorMessage(error: unknown): string {
  if (errorCode(error) === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
  return errorMessage(error);
}

/** True when the error is the "no trading period" refusal (the till shows the prompt instead). */
export function isNoPeriodError(error: unknown): boolean {
  return errorCode(error) === 'NO_OPEN_PERIOD';
}
