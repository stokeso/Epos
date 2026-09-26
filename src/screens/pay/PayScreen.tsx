/**
 * Pay (spec §6.4, §6.7, §6.10, §8; architecture §5.1–§5.3; docs/ui-plan.md §7 "pay").
 *
 * Works for both kinds of PaySession in the pay store: a sale (frozen pricing, D-011) and a
 * deposit (D-027). Every figure is the session's TenderState from services/pay; tenders go
 * through payStore.tender (services/pay.takeTender → rules/tender.applyTender, D-029..D-031),
 * so a card above the balance is refused with the service's own message.
 *
 * Completion: when a tender covers the amount due (or at once via 'Complete sale' when it is
 * £0.00, D-031) → requirePermission('sell' | 'bookings') → payStore.complete (commit, then the
 * basket and Pay state clear) → openDocument(receipt) in the same async chain (D-109; a blocked
 * tab shows the receipt fallback panel). With no change due the screen returns straight to the
 * till (or the booking, after a deposit); with change due it first shows the change to hand
 * back, then 'New sale' / 'Back to booking'.
 *
 * A failed save keeps the session and its tenders and shows 'Sale not saved: …' with
 * 'Try again' and 'Cancel payment' (D-034). Exits: 'Back to basket' / 'Back to booking' while no
 * tenders are taken; 'Cancel payment' (confirmed) once they are (D-033). Leaving a sale payment with
 * no tenders through the Menu drops it too (D-135); one with tenders is kept (D-033).
 *
 * Double taps (D-134): the tender keys ignore taps for TENDER_REST_MS after Pay opens and after
 * each tender or refusal, and nothing above them changes height when a tender is taken or refused
 * (a refusal shows under the keys; on narrow screens the tenders taken share one fixed row), so a
 * second tap never lands on a different money key or takes a second tender.
 * With no open period (a deposit session left over from before a Z close, D-134) the tender keys
 * are disabled and the screen says so.
 */
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { OpenPeriodDialog, openDocument, requirePermission } from '../../app';
import { Banner, Button, isFocusLost, Screen, useIsWide } from '../../components';
import type { Sale, Tender } from '../../data/types';
import { formatPence } from '../../rules/money';
import type { TenderRequest } from '../../rules/tender';
import { tabDisplayLabel } from '../../rules/validation';
import type { PaySession } from '../../services/pay';
import { confirmDialog, dropUntenderedPayment, toast, useBasketStore, useHasOpenPeriod, usePayStore, useSessionStore } from '../../store';
import { TENDER_LABELS } from './payLabels';
import { DepositBooking, SaleOrder } from './PayOrder';
import { PayTotals } from './PayTotals';
import { PaymentDone } from './PaymentDone';
import { TenderPanel } from './TenderPanel';
import styles from './PayScreen.module.css';

type Finish =
  /** complete() is running (the session may already be cleared). */
  | { status: 'saving' }
  /** Saved with change to hand back: show it before leaving. */
  | { status: 'done'; sale: Sale; document: string; returnTo: string; bookingName?: string };

/**
 * How long the tender keys ignore taps after Pay opens and after each tender or refusal (D-134),
 * like the Z close wizard's CONFIRM_ARM_MS: long enough to swallow the second tap of a double tap.
 */
export const TENDER_REST_MS = 400;

/** Where Pay returns to: the till after a sale, the booking after a deposit. */
function exitRoute(session: PaySession): string {
  return session.kind === 'sale' ? '/till' : `/bookings/${session.booking.id}`;
}

/** 'card £5.00, cash £10.00' */
function describeTenders(tenders: readonly Tender[]): string {
  return tenders.map((t) => `${TENDER_LABELS[t.type].toLowerCase()} ${formatPence(t.amountPence)}`).join(', ');
}

export function PayScreen() {
  const session = usePayStore((s) => s.session);
  const keypadPence = usePayStore((s) => s.keypadPence);
  const committing = usePayStore((s) => s.committing);
  const error = usePayStore((s) => s.error);
  const view = useBasketStore((s) => s.view);
  const wide = useIsWide();
  const navigate = useNavigate();
  const [finish, setFinish] = useState<Finish | null>(null);
  const [exitTo, setExitTo] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const hasPeriod = useHasOpenPeriod();
  const [periodDialog, setPeriodDialog] = useState(false);
  /** Guards double submit across the await before payStore.committing is set. */
  const inFlight = useRef(false);
  /** Double-tap guard (D-134): `resting` drives the panel (pointer-events), the ref the handlers. */
  const [resting, setResting] = useState(true);
  const rest = useRef({ active: true, timer: 0 });
  /** The finish block (Complete sale / Try again), which replaces the tender keys once the amount is covered. */
  const finishRef = useRef<HTMLDivElement>(null);

  /** Starts (or restarts) the rest after which the tender keys take taps again. */
  const startRest = (): void => {
    const state = rest.current;
    state.active = true;
    setResting(true);
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.active = false;
      setResting(false);
    }, TENDER_REST_MS);
  };

  // Pay opening counts as a tap: the second tap of a double tap on the till's Pay button would
  // otherwise land on whatever key is under it here.
  useEffect(() => {
    const state = rest.current;
    state.timer = window.setTimeout(() => {
      state.active = false;
      setResting(false);
    }, TENDER_REST_MS);
    return () => window.clearTimeout(state.timer);
  }, []);

  // Leaving Pay any other way than 'Back to basket' (the Menu, browser Back) drops a sale payment
  // that has no tenders, just as 'Back to basket' does: its frozen pricing would go stale, and the
  // next login would return to it and charge superseded prices (D-011, D-009, D-135). A lock ends
  // the session before Pay unmounts and keeps the Pay session for the next login (D-033, D-078).
  // Deferred a tick, so React StrictMode's dev-only unmount and remount does not drop it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const locking = useSessionStore.getState().session === null;
      window.setTimeout(() => {
        if (!mounted.current && !locking) dropUntenderedPayment((current) => current.kind === 'sale');
      }, 0);
    };
  }, []);

  // A tender that covers the amount replaces the tender keys, the focused one included, with the
  // finish block. When the save then fails nothing else takes focus (on success the next screen
  // does): put it on Try again, scrolled into view, never leave it on <body> (D-135, D-138).
  const saveFailedNow = error !== null && session !== null && session.tender.complete;
  useEffect(() => {
    if (saveFailedNow && isFocusLost()) finishRef.current?.querySelector<HTMLButtonElement>('[data-finish-action]')?.focus();
  }, [saveFailedNow]);

  /** Commits a complete session and opens its receipt (architecture §5.1 steps 4–5). */
  const commit = async (current: PaySession): Promise<void> => {
    if (inFlight.current || usePayStore.getState().committing) return;
    inFlight.current = true;
    try {
      const auth = await requirePermission(current.kind === 'sale' ? 'sell' : 'bookings');
      if (auth === null) return;
      const returnTo = exitRoute(current);
      const bookingName = current.kind === 'deposit' ? current.booking.name : undefined;
      setExitTo(returnTo);
      setFinish({ status: 'saving' });
      const done = await usePayStore.getState().complete(auth);
      if (done === null) {
        // Not saved: the store kept the session and set 'Sale not saved: …' (D-034).
        setFinish(null);
        setExitTo(null);
        return;
      }
      // D-109: straight after the commit, while the tap still counts as a user gesture.
      openDocument(done.document);
      if (done.sale.changePence > 0) {
        setFinish({ status: 'done', sale: done.sale, document: done.document, returnTo, bookingName });
        return;
      }
      toast(`${done.sale.kind === 'deposit' ? 'Deposit taken' : 'Sale complete'} · Receipt ${done.sale.receiptNumber}`, { tone: 'success' });
      navigate(returnTo, { replace: true });
    } finally {
      inFlight.current = false;
    }
  };

  const takeTender = (request: TenderRequest): void => {
    const pay = usePayStore.getState();
    if (pay.session === null || pay.committing || inFlight.current || pay.session.tender.complete) return;
    // A repeat tap (or Enter) straight after the last one is ignored (D-134).
    if (rest.current.active) return;
    startRest();
    const result = pay.tender(request);
    // A rejection (e.g. card above the balance) is in payStore.error, shown as an alert.
    if (result === null || !result.ok) return;
    const { tender } = result.session;
    const last = tender.tenders[tender.tenders.length - 1];
    if (last !== undefined) {
      const took = `${TENDER_LABELS[last.type]} ${formatPence(last.amountPence)} taken.`;
      setAnnouncement(tender.complete ? `${took} Change due ${formatPence(tender.changePence)}.` : `${took} ${formatPence(tender.remainingPence)} left to pay.`);
    }
    if (tender.complete) void commit(result.session);
  };

  const onQuickCash = (pence: number): void => takeTender({ type: 'cash', amountPence: pence });
  const onExact = (): void => {
    const current = usePayStore.getState().session;
    if (current !== null) takeTender({ type: 'cash', amountPence: current.tender.remainingPence });
  };
  const onCash = (): void => takeTender({ type: 'cash', amountPence: usePayStore.getState().keypadPence });
  const onCard = (): void => {
    const amount = usePayStore.getState().keypadPence;
    takeTender({ type: 'card', amountPence: amount > 0 ? amount : null });
  };
  const onKeypadChange = (pence: number): void => {
    const pay = usePayStore.getState();
    pay.setKeypad(pence);
    // Typing a new amount answers a tender rejection; a save failure stays until Try again.
    if (pay.error !== null && pay.session !== null && !pay.session.tender.complete) pay.clearError();
  };
  const onComplete = (): void => {
    const current = usePayStore.getState().session;
    // A £0.00 bill shows Complete sale at once: the second tap of a double tap on Pay is ignored.
    if (current !== null && current.tender.complete && !rest.current.active) void commit(current);
  };

  /** 'Back to basket' / 'Back to booking' (no tenders), or 'Cancel payment' after a confirm (D-033). */
  const leave = async (): Promise<void> => {
    const pay = usePayStore.getState();
    const current = pay.session;
    if (current === null || pay.committing || inFlight.current) return;
    const taken = current.tender.tenders;
    if (taken.length > 0) {
      const confirmed = await confirmDialog({
        title: 'Cancel this payment?',
        message: `Already taken: ${describeTenders(taken)}. Hand back the cash or reverse the card payment, then cancel. Nothing will be saved.`,
        confirmLabel: 'Yes, cancel',
        cancelLabel: 'Keep paying',
        tone: 'danger',
      });
      const latest = usePayStore.getState();
      if (!confirmed || latest.session?.id !== current.id || latest.committing) return;
    }
    setExitTo(exitRoute(current));
    usePayStore.getState().clear();
    if (taken.length > 0) toast('Payment cancelled. Nothing was saved.', { tone: 'warning' });
  };

  if (finish?.status === 'done') {
    const { sale, document, returnTo, bookingName } = finish;
    return (
      <Screen title="Pay" hideTitle width="narrow">
        <PaymentDone
          sale={sale}
          bookingName={bookingName}
          continueLabel={sale.kind === 'deposit' ? 'Back to booking' : 'New sale'}
          onContinue={() => navigate(returnTo, { replace: true })}
          onPrintAgain={() => {
            openDocument(document);
          }}
        />
      </Screen>
    );
  }

  if (session === null) {
    if (finish?.status === 'saving') {
      return (
        <Screen title="Pay">
          <p className={styles.saving} role="status">
            Saving…
          </p>
        </Screen>
      );
    }
    return <Navigate to={exitTo ?? '/till'} replace />;
  }

  const { tender } = session;
  const isSale = session.kind === 'sale';
  const saving = committing || finish?.status === 'saving';
  const tendersTaken = tender.tenders.length > 0;
  const saveFailed = error !== null && tender.complete;
  const tenderError = error !== null && !tender.complete ? error : null;
  // No period (D-068): nothing can be saved, so no money is taken (D-134). The service refuses the
  // commit anyway; this stops staff taking the customer's money first.
  const noPeriod = !hasPeriod;

  let description: string | undefined;
  if (session.kind === 'deposit') description = `Deposit for ${session.booking.name}`;
  else if (session.basket.tabId !== undefined && view?.tab?.id === session.basket.tabId) description = `Settling tab ${tabDisplayLabel(view.tab)}`;

  const exitButton = tendersTaken ? (
    <Button variant="dangerOutline" onClick={() => void leave()} disabled={saving}>
      Cancel payment
    </Button>
  ) : (
    <Button onClick={() => void leave()} disabled={saving}>
      <BackIcon />
      {isSale ? 'Back to basket' : 'Back to booking'}
    </Button>
  );

  return (
    <Screen title="Pay" description={description} actions={exitButton}>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      <div className={styles.layout}>
        <div className={styles.totals}>
          <PayTotals tender={tender} dueLabel={isSale ? 'Amount due' : 'Deposit'} compact={!wide} />
        </div>

        <div className={styles.tender}>
          {noPeriod && (
            <Banner
              tone="warning"
              title="No trading period open."
              testId="pay-no-period"
              action={
                <Button size="sm" onClick={() => setPeriodDialog(true)}>
                  Open period
                </Button>
              }
            >
              {tendersTaken
                ? `This ${isSale ? 'sale' : 'deposit'} can't be saved until a manager opens one.`
                : `Don't take any money: this ${isSale ? 'sale' : 'deposit'} can't be saved until a manager opens a period. ${isSale ? 'Go back to the basket' : 'Go back to the booking'}, or open a period first.`}
            </Banner>
          )}
          {tender.complete ? (
            <div ref={finishRef} className={`${styles.finish} ${resting ? styles.resting : ''}`}>
              {saveFailed ? (
                <Banner tone="danger" title={error} testId="pay-error">
                  {tendersTaken
                    ? `${isSale ? 'The basket and the payments' : 'The payments'} taken are kept. Try again, or cancel the payment and hand the money back.`
                    : isSale
                      ? 'The basket is kept. Try again, or go back to the basket.'
                      : 'Try again, or go back to the booking.'}
                </Banner>
              ) : tendersTaken ? (
                <p className={styles.finishText} role="status">
                  Saving the {isSale ? 'sale' : 'deposit'}…
                </p>
              ) : (
                <div className={styles.finishText}>
                  <h2 className={styles.finishTitle}>Nothing to pay</h2>
                  <p data-testid="zero-total-reason">
                    {/* Say why only when a deposit is the reason: a £0.00 product or a 100% member discount also gives £0.00 (D-031). */}
                    {session.kind === 'sale' && session.priced.depositAppliedPence > 0
                      ? 'The deposit covers the whole bill. Complete the sale to save it and print the receipt.'
                      : 'The total is £0.00. Complete the sale to save it and print the receipt.'}
                  </p>
                </div>
              )}
              <Button variant="primary" size="xl" block onClick={onComplete} busy={saving} disabled={noPeriod && !saveFailed} data-finish-action>
                {saveFailed ? 'Try again' : 'Complete sale'}
              </Button>
            </div>
          ) : (
            <TenderPanel
              remainingPence={tender.remainingPence}
              keypadPence={keypadPence}
              onKeypadChange={onKeypadChange}
              onQuickCash={onQuickCash}
              onExact={onExact}
              onCash={onCash}
              onCard={onCard}
              disabled={saving || noPeriod}
              large={wide}
              resting={resting}
              notice={
                tenderError === null ? undefined : (
                  <Banner tone="danger" onDismiss={() => usePayStore.getState().clearError()} dismissLabel="Dismiss message" testId="pay-error">
                    {tenderError}
                  </Banner>
                )
              }
            />
          )}
        </div>

        <div className={styles.order}>
          {session.kind === 'sale' ? (
            <SaleOrder session={session} view={view} collapsible={!wide} />
          ) : (
            <DepositBooking booking={session.booking} />
          )}
        </div>
      </div>
      <OpenPeriodDialog open={periodDialog} onClose={() => setPeriodDialog(false)} />
    </Screen>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
