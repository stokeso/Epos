/**
 * One booking (spec §6.7; D-024..D-028; architecture §5.2, §5.3).
 *
 * - Deposit balance (services/bookings.getBookingSummary, D-025) and 'Take deposit' (money keypad
 *   -> deposit Pay session -> #/pay; needs an open period and an open booking).
 * - Details (type, name, date, notes) with 'Edit details' while the booking is open.
 * - 'Mark settled' / 'Cancel booking': enabled from BookingSummary.canSettle / canCancel (open and a
 *   balance of exactly £0.00, D-026), each confirmed and then gated by requirePermission('bookings').
 *   Refused while a deposit for this booking has tenders taken; a deposit Pay session for it with
 *   nothing taken is dropped once the booking closes (D-134).
 * Settled and cancelled bookings are read-only.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { errorMessage, OpenPeriodDialog, requirePermission, useLoad } from '../../app';
import { Banner, Button, ButtonLink, keepFocusWhenRemoved, MoneyText, Screen } from '../../components';
import type { Booking, LocalDate } from '../../data/types';
import { BOOKING_TYPE_LABELS } from '../../rules/booking';
import { formatPence } from '../../rules/money';
import { formatLocalDate } from '../../rules/time';
import { cancelBooking, getBookingSummary, settleBooking, type BookingSummary } from '../../services/bookings';
import type { PaySession } from '../../services/pay';
import { todayLocal } from '../../services/reports';
import { confirmDialog, dropUntenderedPayment, getCtx, toast, useHasOpenPeriod, usePayStore } from '../../store';
import { BookingFormDialog } from './BookingFormDialog';
import { daysFromToday, relativeDayText } from './bookingFormat';
import { DepositDialog } from './DepositDialog';
import { BackChevron, DateTile, StatusBadge } from './parts';
import styles from './bookings.module.css';

function safeDate(date: LocalDate): string {
  try {
    return formatLocalDate(date);
  } catch {
    return date;
  }
}

function AllBookingsLink() {
  return (
    <ButtonLink to="/bookings" variant="ghost" className={styles.backLink}>
      <BackChevron />
      All bookings
    </ButtonLink>
  );
}

export function BookingDetailScreen() {
  const { id = '' } = useParams();
  const load = useLoad(async (ctx) => ({ summary: await getBookingSummary(ctx, id), today: todayLocal(ctx) }), [id]);
  const data = load.data;

  if (data === undefined) {
    return (
      <Screen title="Booking" actions={<AllBookingsLink />}>
        {load.error !== null ? <Banner tone="danger">{load.error}</Banner> : <p className={styles.muted}>Loading booking…</p>}
      </Screen>
    );
  }
  if (data.summary === undefined) {
    return (
      <Screen title="Booking not found" actions={<AllBookingsLink />}>
        <Banner tone="warning" role="none">
          That booking doesn't exist on this till.
        </Banner>
      </Screen>
    );
  }
  return <BookingDetail key={data.summary.booking.id} summary={data.summary} today={data.today} reload={load.reload} loadError={load.error} />;
}

type Busy = 'settle' | 'cancel' | null;

const DEPOSIT_IN_PROGRESS_MESSAGE = 'A deposit payment for this booking is in progress. Finish or cancel it before closing the booking.';

function BookingDetail({
  summary,
  today,
  reload,
  loadError,
}: {
  summary: BookingSummary;
  today: LocalDate;
  reload: () => void;
  loadError: string | null;
}) {
  const { booking, balancePence } = summary;
  const hasPeriod = useHasOpenPeriod();
  const paySession = usePayStore((s) => s.session);
  const [dialog, setDialog] = useState<'edit' | 'deposit' | 'period' | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const isOpen = booking.status === 'open';
  const days = daysFromToday(booking.date, today);
  const paymentInProgress = paySession !== null && paySession.tender.tenders.length > 0;
  // Money already taken for a deposit on this booking: it must be saved or handed back before
  // the booking closes, or it could never be saved (D-134).
  const depositInProgress = paymentInProgress && paySession?.kind === 'deposit' && paySession.booking.id === booking.id;

  const edited = (saved: Booking): void => {
    setDialog(null);
    toast(`Booking saved: ${saved.name}`, { tone: 'success' });
    reload();
  };

  /** True when the Pay session is a deposit for this booking. */
  const isThisDeposit = (session: PaySession): boolean => session.kind === 'deposit' && session.booking.id === booking.id;

  /** `control` is the pressed button: it goes with the 'Close this booking' card once the booking closes. */
  const close = async (kind: 'settle' | 'cancel', control: HTMLElement): Promise<void> => {
    if (busy !== null) return;
    setError(null);
    const pay = usePayStore.getState().session;
    if (pay !== null && pay.tender.tenders.length > 0 && isThisDeposit(pay)) {
      setError(DEPOSIT_IN_PROGRESS_MESSAGE);
      return;
    }
    const confirmed = await confirmDialog(
      kind === 'settle'
        ? {
            title: 'Mark this booking settled?',
            message: `${booking.name} will be closed as settled. Settled bookings can't be changed or take deposits.`,
            confirmLabel: 'Mark settled',
            cancelLabel: 'Keep open',
          }
        : {
            title: 'Cancel this booking?',
            message: `${booking.name} will be closed as cancelled. Cancelled bookings can't be changed or take deposits.`,
            confirmLabel: 'Cancel booking',
            cancelLabel: 'Keep booking',
            tone: 'danger',
          },
    );
    if (!confirmed) return;
    const auth = await requirePermission('bookings');
    if (auth === null) return;
    // The confirm (and any PIN override) gave focus back to the pressed button. When the booking
    // closes, the card with it goes: focus then moves to <main>, not <body> (D-135, D-137).
    keepFocusWhenRemoved(control);
    setBusy(kind);
    try {
      if (kind === 'settle') await settleBooking(getCtx(), auth, booking.id);
      else await cancelBooking(getCtx(), auth, booking.id);
      // A deposit Pay session for this booking with nothing taken can no longer be saved (D-134).
      dropUntenderedPayment(isThisDeposit);
      toast(kind === 'settle' ? `${booking.name} marked settled` : `${booking.name} cancelled`, { tone: 'success' });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const openDeposit = (): void => {
    setError(null);
    setDialog('deposit');
  };

  return (
    <Screen
      title={booking.name}
      description={
        <span className={styles.headMeta}>
          <StatusBadge status={booking.status} testId="booking-status" />
          <span>{BOOKING_TYPE_LABELS[booking.type]}</span>
          <span aria-hidden="true">·</span>
          <span>{safeDate(booking.date)}</span>
          {days !== null && isOpen && (
            <>
              <span aria-hidden="true">·</span>
              <span className={days < 0 ? styles.past : undefined}>{relativeDayText(days)}</span>
            </>
          )}
        </span>
      }
      actions={<AllBookingsLink />}
    >
      {loadError !== null && <Banner tone="danger">{loadError}</Banner>}
      {error !== null && (
        <Banner tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {!isOpen && (
        <Banner tone="info" role="none" testId="booking-closed">
          This booking is {booking.status === 'settled' ? 'settled' : 'cancelled'}. Settled and cancelled bookings are read-only.
        </Banner>
      )}

      <div className={styles.detailGrid}>
        <section className={`${styles.card} ${styles.depositCard}`} aria-labelledby="deposit-heading">
          <h2 id="deposit-heading" className={styles.cardTitle}>
            Deposit
          </h2>
          <div className={styles.balance}>
            <span className={styles.balanceLabel} id="deposit-balance-label">
              Unused deposit balance
            </span>
            <MoneyText pence={balancePence} size="3xl" strong testId="booking-balance" />
          </div>
          {isOpen && (
            <>
              {balancePence > 0 && (
                <p className={styles.muted}>To use it, attach this booking to the final bill at the till (Booking button).</p>
              )}
              {!hasPeriod ? (
                <Banner
                  tone="warning"
                  role="none"
                  action={
                    <Button size="sm" onClick={() => setDialog('period')}>
                      Open period
                    </Button>
                  }
                >
                  No trading period open. Deposits can be taken once a manager opens one.
                </Banner>
              ) : paymentInProgress ? (
                <Banner tone="warning" role="none" action={<ButtonLink to="/pay" size="sm">Back to Pay</ButtonLink>}>
                  A payment is in progress. Finish or cancel it before taking a deposit.
                </Banner>
              ) : null}
              <Button
                variant="primary"
                size="lg"
                onClick={openDeposit}
                disabled={!summary.canTakeDeposit || !hasPeriod || paymentInProgress || busy !== null}
                className={styles.cardAction}
              >
                Take deposit
              </Button>
            </>
          )}
        </section>

        <section className={styles.card} aria-labelledby="details-heading">
          <div className={styles.cardHead}>
            <h2 id="details-heading" className={styles.cardTitle}>
              Details
            </h2>
            {isOpen && (
              <Button size="sm" onClick={() => setDialog('edit')} disabled={busy !== null}>
                Edit details
              </Button>
            )}
          </div>
          <div className={styles.detailsBody}>
            <DateTile date={booking.date} muted={!isOpen} />
            <dl className={styles.facts}>
              <div>
                <dt>Type</dt>
                <dd data-testid="booking-type">{BOOKING_TYPE_LABELS[booking.type]}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd data-testid="booking-date">{safeDate(booking.date)}</dd>
              </div>
              <div className={styles.factWide}>
                <dt>Notes</dt>
                <dd data-testid="booking-notes" className={booking.notes === '' ? styles.muted : styles.notes}>
                  {booking.notes === '' ? 'None' : booking.notes}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {isOpen && (
          <section className={`${styles.card} ${styles.closeCard}`} aria-labelledby="close-heading">
            <h2 id="close-heading" className={styles.cardTitle}>
              Close this booking
            </h2>
            <p className={styles.muted}>
              {summary.canSettle
                ? 'The deposit balance is £0.00, so the booking can be marked settled or cancelled.'
                : `Mark settled and Cancel booking become available when the deposit balance is £0.00 (it is ${formatPence(balancePence)} now).`}
            </p>
            {depositInProgress && (
              <Banner tone="warning" role="none" testId="booking-deposit-in-progress" action={<ButtonLink to="/pay" size="sm">Back to Pay</ButtonLink>}>
                {DEPOSIT_IN_PROGRESS_MESSAGE}
              </Banner>
            )}
            <div className={styles.closeActions}>
              <Button
                variant="secondary"
                onClick={(event) => void close('settle', event.currentTarget)}
                disabled={!summary.canSettle || depositInProgress || busy !== null}
                busy={busy === 'settle'}
              >
                Mark settled
              </Button>
              <Button
                variant="dangerOutline"
                onClick={(event) => void close('cancel', event.currentTarget)}
                disabled={!summary.canCancel || depositInProgress || busy !== null}
                busy={busy === 'cancel'}
              >
                Cancel booking
              </Button>
            </div>
          </section>
        )}
      </div>

      {dialog === 'edit' && <BookingFormDialog booking={booking} onClose={() => setDialog(null)} onSaved={edited} />}
      {dialog === 'deposit' && <DepositDialog booking={booking} onClose={() => setDialog(null)} />}
      <OpenPeriodDialog open={dialog === 'period'} onClose={() => setDialog(null)} />
    </Screen>
  );
}
