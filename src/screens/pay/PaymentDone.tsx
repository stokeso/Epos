import { useEffect, useId, useRef, useState } from 'react';
import { Button, MoneyText } from '../../components';
import type { Sale } from '../../data/types';
import { TENDER_LABELS } from './payLabels';
import styles from './PaymentDone.module.css';

/**
 * The buttons ignore taps this long after the screen appears, so the second tap of a double tap
 * on the tender key that finished the payment can't skip the change to hand back (D-134).
 */
const ARM_MS = 400;

export interface PaymentDoneProps {
  /** The committed sale or deposit (CompletedSale.sale). */
  sale: Sale;
  /** For a deposit: the booking's name. */
  bookingName?: string;
  /** 'New sale' (back to the till) or 'Back to booking'. */
  continueLabel: string;
  onContinue: () => void;
  /** Opens the same receipt again (a new tab, or the on-screen panel when blocked). */
  onPrintAgain: () => void;
}

/**
 * Shown after a payment that needs change handed back: the sale is already saved and the
 * receipt opened, so this only tells the cashier how much change to give. Test id: change-due.
 */
export function PaymentDone({ sale, bookingName, continueLabel, onContinue, onPrintAgain }: PaymentDoneProps) {
  const rootRef = useRef<HTMLElement>(null);
  const headingId = useId();
  const deposit = sale.kind === 'deposit';
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);

  useEffect(() => {
    // The tender button that finished the payment is gone: put focus on the next step.
    rootRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const timer = window.setTimeout(() => {
      armedRef.current = true;
      setArmed(true);
    }, ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <section ref={rootRef} className={styles.done} aria-labelledby={headingId} data-testid="payment-complete">
      <div className={styles.head}>
        <svg className={styles.icon} viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
          <circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.14" />
          <path d="M14 24.5l7 7 13-14" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h2 id={headingId} className={styles.heading}>
          {deposit ? 'Deposit taken' : 'Sale complete'}
        </h2>
        <p className={styles.meta}>
          Receipt <span className="tabular">{sale.receiptNumber}</span>
          {bookingName !== undefined && <> · {bookingName}</>}
        </p>
      </div>

      <div className={styles.change} role="status">
        <span className={styles.changeLabel}>Change due</span>
        <MoneyText pence={sale.changePence} strong testId="change-due" className={styles.changeAmount} />
      </div>

      <dl className={styles.figures}>
        <div className={styles.row}>
          <dt>{deposit ? 'Deposit' : 'Amount due'}</dt>
          <dd>
            <MoneyText pence={sale.totalPence} strong />
          </dd>
        </div>
        {sale.tenders.map((tender, index) => (
          <div key={index} className={styles.row}>
            <dt>{TENDER_LABELS[tender.type]}</dt>
            <dd>
              <MoneyText pence={tender.amountPence} />
            </dd>
          </div>
        ))}
      </dl>

      <div className={`${styles.actions} ${armed ? '' : styles.resting}`}>
        <Button variant="primary" size="xl" block onClick={() => armedRef.current && onContinue()} data-autofocus>
          {continueLabel}
        </Button>
        <Button variant="ghost" block onClick={() => armedRef.current && onPrintAgain()}>
          Print receipt again
        </Button>
      </div>
    </section>
  );
}
