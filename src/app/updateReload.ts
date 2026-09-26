/**
 * The reload onto a new build after a service worker update (D-113, D-133, D-134). It behaves like
 * a refresh, so it waits while money is in flight: while a Pay session has tenders or is saving,
 * and while Pay is on screen (it may be showing the change to hand back). It also waits while the
 * receipt fallback panel is open (a blocked receipt, X read or Z report): the panel lives only in
 * memory and v1 has no way to reprint a past receipt or Z report (D-109, D-047). It happens as
 * soon as the payment is finished or cancelled, Pay is left and the panel is closed.
 */
import { usePayStore } from '../store/payStore';
import { useUiStore } from '../store/uiStore';

function mustWait(): boolean {
  const pay = usePayStore.getState();
  const tendersTaken = pay.session !== null && pay.session.tender.tenders.length > 0;
  const documentShown = useUiStore.getState().receiptFallback !== null;
  return tendersTaken || pay.committing || documentShown || window.location.hash.startsWith('#/pay');
}

/**
 * Reloads now, or once nothing is in flight: checked on every Pay or UI store change and every
 * `pollMs` (the router navigates with pushState, which fires no event to listen to).
 */
export function reloadWhenNoPaymentInFlight(reload: () => void = () => window.location.reload(), pollMs = 1000): void {
  if (!mustWait()) {
    reload();
    return;
  }
  let done = false;
  const check = (): void => {
    if (done || mustWait()) return;
    done = true;
    unsubscribePay();
    unsubscribeUi();
    window.clearInterval(timer);
    reload();
  };
  const unsubscribePay = usePayStore.subscribe(check);
  const unsubscribeUi = useUiStore.subscribe(check);
  const timer = window.setInterval(check, pollMs);
}
