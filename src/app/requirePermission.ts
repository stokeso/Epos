/**
 * The one permission gate (spec §5; D-070, D-071): call it on the button that writes data or
 * produces a document, then pass the result to exactly ONE service call.
 *
 *   const auth = await requirePermission('voidLine');
 *   if (auth === null) return;            // cancelled, locked, or nobody logged in
 *   await useBasketStore.getState().voidLine(auth, productId, qty);
 *
 * - The session's own role suffices: returns authoriseDirect(...) at once, no dialog, no
 *   override event.
 * - Otherwise: opens the PIN override dialog ('Supervisor or manager PIN' / 'Manager PIN').
 *   A PIN of sufficient level approves that ONE action; the Authorisation carries approvedById
 *   and the service writes the override audit event with the action (D-072).
 * - Cancel, or an auto-lock while the dialog is open, resolves null.
 */
import type { Action } from '../data/types';
import { authoriseDirect, type Authorisation } from '../services/override';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';

export function requirePermission(action: Action): Promise<Authorisation | null> {
  const session = useSessionStore.getState().session;
  if (session === null) return Promise.resolve(null);
  const direct = authoriseDirect(session, action);
  if (direct !== null) return Promise.resolve(direct);
  return useUiStore.getState().requestOverride(action);
}
