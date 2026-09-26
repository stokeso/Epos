/**
 * Attach a booking to the bill (spec §6.7; D-023, D-028): lists open bookings with an unused
 * deposit balance. Attaching adds the 'Deposit taken' line; detaching is free.
 */
import { useState } from 'react';
import { useLoad } from '../../app';
import { Banner, Button, ButtonLink, Modal, MoneyText } from '../../components';
import { BOOKING_TYPE_LABELS } from '../../rules/booking';
import { formatPence } from '../../rules/money';
import { formatLocalDate } from '../../rules/time';
import { listAttachableBookings, type BookingSummary } from '../../services/bookings';
import { toast, useBasketStore } from '../../store';
import { tillErrorMessage } from './tillErrors';
import styles from './TillDialogs.module.css';

export const BOOKING_DIALOG_TITLE = 'Attach booking';

export interface BookingDialogProps {
  open: boolean;
  onClose: () => void;
}

export function BookingDialog({ open, onClose }: BookingDialogProps) {
  if (!open) return null;
  return <BookingDialogBody onClose={onClose} />;
}

function BookingDialogBody({ onClose }: { onClose: () => void }) {
  const bookings = useLoad(listAttachableBookings, []);
  const bookingId = useBasketStore((s) => s.basket.bookingId);
  const current = useBasketStore((s) => s.view?.booking);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attach = async (summary: BookingSummary): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const attached = await useBasketStore.getState().attachBooking(summary.booking.id);
      if (attached) {
        toast(`Booking attached: ${summary.booking.name}`, { tone: 'success' });
        onClose();
      }
    } catch (caught) {
      setError(tillErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const detach = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await useBasketStore.getState().detachBooking();
      toast('Booking removed from the basket');
      onClose();
    } catch (caught) {
      setError(tillErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const list = bookings.data;

  return (
    <Modal
      open
      onClose={onClose}
      title={BOOKING_DIALOG_TITLE}
      description={
        bookingId === undefined ? (
          'Choose a booking to use its deposit against this bill.'
        ) : (
          <>
            Attached now: <strong>{current?.name ?? 'Loading…'}</strong>. Choose another booking to replace it.
          </>
        )
      }
      size="md"
      dismissible={!busy}
      testId="booking-dialog"
      footer={
        <>
          {bookingId !== undefined && (
            <Button variant="dangerOutline" onClick={() => void detach()} disabled={busy}>
              Detach booking
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        {list === undefined && bookings.error === null && <p className={styles.muted}>Loading bookings…</p>}
        {list !== undefined && list.length === 0 && (
          <div className={styles.empty}>
            <p>No open bookings have a deposit balance.</p>
            <p className={styles.muted}>Take a deposit on the booking first, then attach it to the final bill.</p>
            <ButtonLink to="/bookings" variant="secondary">
              Go to bookings
            </ButtonLink>
          </div>
        )}
        {list !== undefined && list.length > 0 && (
          <ul className={styles.choiceList} aria-label="Open bookings with a deposit">
            {list.map((summary) => {
              const { booking } = summary;
              const attached = booking.id === bookingId;
              const detailId = `booking-detail-${booking.id}`;
              return (
                <li key={booking.id}>
                  <button
                    type="button"
                    className={`${styles.choice} ${attached ? styles.choiceCurrent : ''}`}
                    onClick={() => void attach(summary)}
                    disabled={busy}
                    aria-pressed={attached}
                    aria-label={booking.name}
                    aria-describedby={detailId}
                  >
                    <span className={styles.choiceMain}>
                      <span className={styles.choiceTitle}>{booking.name}</span>
                      <span id={detailId} className={styles.choiceMeta}>
                        {BOOKING_TYPE_LABELS[booking.type]} · {formatLocalDate(booking.date)}
                        <span className="visually-hidden">, deposit balance {formatPence(summary.balancePence)}</span>
                      </span>
                    </span>
                    <span className={styles.choiceAside}>
                      <span className={styles.choiceAsideLabel}>Balance</span>
                      <MoneyText pence={summary.balancePence} strong />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {bookings.error !== null && <Banner tone="danger">{bookings.error}</Banner>}
        {error !== null && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  );
}
