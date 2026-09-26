import { useId } from 'react';
import { BasketLineRow, MoneyText } from '../../components';
import type { Booking } from '../../data/types';
import { BOOKING_TYPE_LABELS } from '../../rules/booking';
import type { PricedBasket } from '../../rules/pricing';
import { formatLocalDate } from '../../rules/time';
import { tabDisplayLabel } from '../../rules/validation';
import { memberLabel } from '../../services/members';
import type { SalePaySession } from '../../services/pay';
import type { BasketView } from '../../services/till';
import { basketUnitCount } from '../../store';
import styles from './PayOrder.module.css';

export interface SaleOrderProps {
  session: SalePaySession;
  /**
   * The till's BasketView (basketStore.view), used only for the member, booking and tab names.
   * The figures always come from the session's frozen pricing (D-011).
   */
  view: BasketView | null;
  /** Phones: a collapsible 'Order details' disclosure. Tablet: an always-open panel. */
  collapsible: boolean;
}

/** What the customer is paying for: the frozen priced lines, deal lines, discount and deposit. */
export function SaleOrder({ session, view, collapsible }: SaleOrderProps) {
  const headingId = useId();
  const count = basketUnitCount(session.basket);
  const countText = `${count} ${count === 1 ? 'item' : 'items'}`;
  const context = orderContext(session, view);
  const body = (
    <OrderBody
      priced={session.priced}
      context={context}
      memberAttached={session.basket.memberId !== undefined}
      memberDiscountPercent={session.memberDiscountPercent ?? undefined}
    />
  );

  if (collapsible) {
    return (
      <details className={styles.disclosure}>
        <summary className={styles.summary}>
          <span className={styles.summaryText}>
            <span className={styles.summaryTitle}>Order details</span>
            <span className={styles.muted}>{countText}</span>
          </span>
          <svg className={styles.chevron} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <div className={styles.disclosureBody}>{body}</div>
      </details>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          Order
        </h2>
        <span className={styles.muted}>{countText}</span>
      </div>
      {body}
    </section>
  );
}

interface ContextRow {
  key: 'tab' | 'member' | 'booking';
  label: string;
  value: string;
}

/** Tab, member and booking names for the session's basket (only when the till view matches it). */
function orderContext(session: SalePaySession, view: BasketView | null): ContextRow[] {
  const { basket } = session;
  const rows: ContextRow[] = [];
  if (basket.tabId !== undefined && view?.tab?.id === basket.tabId) {
    rows.push({ key: 'tab', label: 'Tab', value: tabDisplayLabel(view.tab) });
  }
  if (basket.memberId !== undefined && view?.member?.id === basket.memberId) {
    rows.push({ key: 'member', label: 'Member', value: memberLabel(view.member) });
  }
  if (basket.bookingId !== undefined && view?.booking?.id === basket.bookingId) {
    rows.push({ key: 'booking', label: 'Booking', value: `${view.booking.name} · ${formatLocalDate(view.booking.date)}` });
  }
  return rows;
}

interface OrderBodyProps {
  priced: PricedBasket;
  context: ContextRow[];
  /** A member is attached: the discount row shows even at £0.00, as on the receipt (D-107). */
  memberAttached: boolean;
  /** The % the frozen pricing used (the session's, never live settings: D-011). */
  memberDiscountPercent?: number;
}

function OrderBody({ priced, context, memberAttached, memberDiscountPercent }: OrderBodyProps) {
  const hasMemberDiscount = memberAttached || priced.memberDiscountPence > 0;
  return (
    <div className={styles.body}>
      {context.length > 0 && (
        <ul className={styles.context} aria-label="Attached to this sale">
          {context.map((row) => (
            <li key={row.key} className={`${styles.chip} ${styles[row.key] ?? ''}`}>
              <span className={styles.chipLabel}>{row.label}</span>
              <span className={styles.chipValue}>{row.value}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className={styles.lines} aria-label="Order lines">
        {priced.lines.map((line) => (
          <BasketLineRow key={line.productId} line={line} />
        ))}
      </ul>
      {(priced.dealLines.length > 0 || hasMemberDiscount || priced.depositAppliedPence > 0) && (
        <ul className={styles.adjustments} aria-label="Discounts and deposits">
          {priced.dealLines.map((deal) => (
            <li key={deal.dealId} className={styles.adjustment}>
              <span>
                {deal.name}
                {deal.groupCount > 1 ? ` x${deal.groupCount}` : ''}
              </span>
              <MoneyText pence={deal.savingPence} asDeduction />
            </li>
          ))}
          {hasMemberDiscount && (
            <li className={styles.adjustment}>
              <span>Member discount{memberDiscountPercent === undefined ? '' : ` (${memberDiscountPercent}%)`}</span>
              <MoneyText pence={priced.memberDiscountPence} asDeduction />
            </li>
          )}
          {priced.depositAppliedPence > 0 && (
            <li className={styles.adjustment}>
              <span>Deposit taken</span>
              <MoneyText pence={priced.depositAppliedPence} asDeduction />
            </li>
          )}
        </ul>
      )}
      <div className={styles.total}>
        <span>Total</span>
        <MoneyText pence={priced.totalPence} size="lg" strong />
      </div>
    </div>
  );
}

export interface DepositBookingProps {
  booking: Booking;
}

/** The booking a deposit is being taken for (D-027). */
export function DepositBooking({ booking }: DepositBookingProps) {
  const headingId = useId();
  return (
    <section className={`${styles.panel} ${styles.bookingCard}`} aria-labelledby={headingId} data-testid="deposit-booking">
      <div className={styles.bookingBody}>
        <span className={styles.eyebrow}>Deposit for</span>
        <h2 id={headingId} className={styles.bookingName}>
          {booking.name}
        </h2>
        <p className={styles.bookingMeta}>
          {BOOKING_TYPE_LABELS[booking.type]} · {formatLocalDate(booking.date)}
        </p>
        <p className={styles.note}>A deposit is a prepayment: it has no VAT and comes off the final bill.</p>
      </div>
    </section>
  );
}
