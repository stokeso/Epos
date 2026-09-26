/**
 * Bookings list (spec §6.7; D-025, D-026; docs/ui-plan.md §7 "tabs-bookings-members").
 * Every booking with its type, name, date, status and unused deposit balance (all from
 * services/bookings.listBookings, sorted by date then name). Open bookings come first; settled
 * and cancelled ones are read-only and folded away below. Viewing needs no open period (D-068).
 */
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLoad } from '../../app';
import { Banner, Button, MoneyText, Screen } from '../../components';
import type { Booking, LocalDate } from '../../data/types';
import { BOOKING_TYPE_LABELS } from '../../rules/booking';
import { formatPence } from '../../rules/money';
import { formatLocalDate } from '../../rules/time';
import { listBookings, type BookingSummary } from '../../services/bookings';
import { todayLocal } from '../../services/reports';
import { toast } from '../../store';
import { BookingFormDialog } from './BookingFormDialog';
import { BOOKING_STATUS_LABELS, daysFromToday, relativeDayText } from './bookingFormat';
import { Chevron, DateTile, StatusBadge } from './parts';
import styles from './bookings.module.css';

function safeDate(date: LocalDate): string {
  try {
    return formatLocalDate(date);
  } catch {
    return date;
  }
}

function BookingRow({ summary, today }: { summary: BookingSummary; today: LocalDate }) {
  const { booking, balancePence } = summary;
  const metaId = useId();
  const days = daysFromToday(booking.date, today);
  const closed = booking.status !== 'open';
  return (
    <Link
      to={`/bookings/${booking.id}`}
      className={`${styles.row} ${closed ? styles.rowClosed : ''}`}
      aria-label={booking.name}
      aria-describedby={metaId}
      data-testid="booking-row"
    >
      <DateTile date={booking.date} muted={closed} />
      <span className={styles.rowMain}>
        <span className={styles.rowName}>{booking.name}</span>
        <span className={styles.rowMeta}>
          <span>{BOOKING_TYPE_LABELS[booking.type]}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="booking-row-date">{safeDate(booking.date)}</span>
          {days !== null && !closed && (
            <>
              <span aria-hidden="true">·</span>
              <span className={days < 0 ? styles.past : undefined}>{relativeDayText(days)}</span>
            </>
          )}
        </span>
        {booking.notes !== '' && <span className={styles.rowNotes}>{booking.notes}</span>}
      </span>
      <span className={styles.rowAside}>
        <StatusBadge status={booking.status} testId="booking-row-status" />
        <span className={styles.rowBalance}>
          <span className={styles.rowBalanceLabel}>Deposit balance</span>
          <MoneyText pence={balancePence} strong size="lg" testId="booking-row-balance" />
        </span>
      </span>
      <Chevron />
      <span id={metaId} className="visually-hidden">
        {BOOKING_TYPE_LABELS[booking.type]}, {safeDate(booking.date)}, {BOOKING_STATUS_LABELS[booking.status]}, deposit balance{' '}
        {formatPence(balancePence)}
      </span>
    </Link>
  );
}

export function BookingsScreen() {
  const navigate = useNavigate();
  const load = useLoad(async (ctx) => ({ bookings: await listBookings(ctx), today: todayLocal(ctx) }), []);
  const [creating, setCreating] = useState(false);

  const data = load.data;
  const open = (data?.bookings ?? []).filter((s) => s.booking.status === 'open');
  const closed = (data?.bookings ?? []).filter((s) => s.booking.status !== 'open');

  const created = (booking: Booking): void => {
    setCreating(false);
    toast(`Booking created: ${booking.name}`, { tone: 'success' });
    navigate(`/bookings/${booking.id}`);
  };

  return (
    <Screen
      title="Bookings"
      description="Weddings, society days and events, with their deposits."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          New booking
        </Button>
      }
    >
      {load.error !== null && <Banner tone="danger">{load.error}</Banner>}
      {data === undefined && load.error === null && <p className={styles.muted}>Loading bookings…</p>}

      {data !== undefined && (
        <div className={styles.listLayout}>
          <section aria-labelledby="open-bookings-heading" className={styles.group}>
            <h2 id="open-bookings-heading" className={styles.groupHeading}>
              Open bookings <span className={styles.count}>({open.length})</span>
            </h2>
            {open.length === 0 ? (
              <div className={styles.empty}>
                <p>No open bookings.</p>
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  Create a booking
                </Button>
              </div>
            ) : (
              <ul className={styles.rows} aria-label="Open bookings">
                {open.map((summary) => (
                  <li key={summary.booking.id}>
                    <BookingRow summary={summary} today={data.today} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {closed.length > 0 && (
            <details className={styles.closedGroup}>
              <summary className={styles.closedSummary}>
                <span>
                  Settled and cancelled <span className={styles.count}>({closed.length})</span>
                </span>
              </summary>
              <ul className={styles.rows} aria-label="Settled and cancelled bookings">
                {closed.map((summary) => (
                  <li key={summary.booking.id}>
                    <BookingRow summary={summary} today={data.today} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {creating && <BookingFormDialog booking={null} onClose={() => setCreating(false)} onSaved={created} />}
    </Screen>
  );
}
