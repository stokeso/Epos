/** Presentational pieces shared by the bookings list and detail screens. */
import type { BookingStatus, BookingType, LocalDate } from '../../data/types';
import { BOOKING_TYPE_LABELS } from '../../rules/booking';
import { BOOKING_STATUS_LABELS, dateTileParts } from './bookingFormat';
import styles from './bookings.module.css';

const STATUS_CLASS: Record<BookingStatus, string | undefined> = {
  open: styles.status_open,
  settled: styles.status_settled,
  cancelled: styles.status_cancelled,
};

/** 'Open' / 'Settled' / 'Cancelled' pill. */
export function StatusBadge({ status, testId }: { status: BookingStatus; testId?: string }) {
  return (
    <span className={`${styles.status} ${STATUS_CLASS[status] ?? ''}`} data-testid={testId}>
      {BOOKING_STATUS_LABELS[status]}
    </span>
  );
}

/** A small calendar tile (decorative: the date is also given as text next to it). */
export function DateTile({ date, muted = false }: { date: LocalDate; muted?: boolean }) {
  const parts = dateTileParts(date);
  if (parts === null) return null;
  return (
    <span className={`${styles.tile} ${muted ? styles.tileMuted : ''}`} aria-hidden="true">
      <span className={styles.tileMonth}>{parts.month}</span>
      <span className={styles.tileDay}>{parts.day}</span>
      <span className={styles.tileYear}>{parts.year}</span>
    </span>
  );
}

const TYPE_ORDER: readonly BookingType[] = ['wedding', 'society', 'eventTicket', 'other'];

/** The booking type as native radios in a fieldset (e2e: getByRole('radio', { name: 'Wedding' })). */
export function TypeChoice({
  name,
  value,
  onChange,
  error,
  disabled = false,
}: {
  name: string;
  value: BookingType;
  onChange: (value: BookingType) => void;
  error?: string;
  disabled?: boolean;
}) {
  const errorId = `${name}-error`;
  return (
    <fieldset className={styles.choice} disabled={disabled} aria-describedby={error === undefined ? undefined : errorId}>
      <legend className={styles.choiceLegend}>Type</legend>
      <div className={styles.choiceOptions}>
        {TYPE_ORDER.map((type) => (
          <label key={type} className={`${styles.choiceOption} ${value === type ? styles.choiceChecked : ''}`}>
            <input
              type="radio"
              className={styles.choiceInput}
              name={name}
              value={type}
              checked={value === type}
              onChange={() => onChange(type)}
            />
            <span className={styles.choiceMark} aria-hidden="true" />
            <span>{BOOKING_TYPE_LABELS[type]}</span>
          </label>
        ))}
      </div>
      {error !== undefined && (
        <div id={errorId} className={styles.fieldError}>
          {error}
        </div>
      )}
    </fieldset>
  );
}

export function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BackChevron() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
