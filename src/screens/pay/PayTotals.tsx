import { useEffect, useRef, type CSSProperties } from 'react';
import { MoneyText } from '../../components';
import { formatPence } from '../../rules/money';
import type { TenderState } from '../../rules/tender';
import { TENDER_LABELS } from './payLabels';
import styles from './PayTotals.module.css';

export interface PayTotalsProps {
  /** The Pay session's tender state (services/pay: frozen total, tenders, remaining, change). */
  tender: TenderState;
  /** 'Amount due' for a sale; 'Deposit' for a deposit. */
  dueLabel: string;
  /**
   * Narrow layouts, where the tender keys sit under this card: the tenders taken share one
   * fixed-height row (scrolling sideways inside itself) instead of adding a row each, so taking a
   * tender never moves the keys below (D-134).
   */
  compact?: boolean;
}

/**
 * The till's customer-display block: the remaining balance (hero), then the amount due, every
 * tender taken in order and the change due. Pure display of TenderState (D-029..D-031).
 * Test ids: amount-due, remaining, change-due.
 */
export function PayTotals({ tender, dueLabel, compact = false }: PayTotalsProps) {
  const settled = tender.complete;
  const takenRef = useRef<HTMLOListElement>(null);
  const count = tender.tenders.length;
  // Keep the latest tender in view in the compact row.
  useEffect(() => {
    const list = takenRef.current;
    if (list !== null) list.scrollLeft = list.scrollWidth;
  }, [count]);
  // The hero figure shrinks with its length so every digit stays inside the card (e.g. £1,040.00
  // on a 390 px phone, six-figure bills on the tablet); see .heroAmount.
  const heroStyle = { '--hero-chars': formatPence(tender.remainingPence).length } as CSSProperties;
  return (
    <section className={styles.totals} aria-label="Payment summary">
      <div className={`${styles.hero} ${settled ? styles.heroSettled : ''}`} style={heroStyle}>
        <span className={styles.heroLabel}>Remaining</span>
        <MoneyText pence={tender.remainingPence} size="3xl" strong testId="remaining" className={styles.heroAmount} />
      </div>
      <dl className={styles.figures}>
        <div className={styles.row}>
          <dt>{dueLabel}</dt>
          <dd>
            <MoneyText pence={tender.totalPence} size="lg" strong testId="amount-due" />
          </dd>
        </div>
        {compact ? (
          <div className={`${styles.row} ${styles.takenRow}`}>
            <dt>Taken</dt>
            <dd className={styles.takenValue}>
              {count === 0 ? (
                <span className={styles.takenNone}>Nothing yet</span>
              ) : (
                <ol ref={takenRef} className={styles.takenList} aria-label="Payments taken">
                  {tender.tenders.map((t, index) => (
                    <li key={index} className={styles.takenItem} data-testid="tender-row">
                      <span className={styles.tenderBadge}>{index + 1}</span>
                      {TENDER_LABELS[t.type]} <MoneyText pence={t.amountPence} />
                    </li>
                  ))}
                </ol>
              )}
            </dd>
          </div>
        ) : (
          tender.tenders.map((t, index) => (
            <div key={index} className={`${styles.row} ${styles.tender}`} data-testid="tender-row">
              <dt>
                <span className={styles.tenderBadge}>{index + 1}</span>
                {TENDER_LABELS[t.type]}
              </dt>
              <dd>
                <MoneyText pence={t.amountPence} />
              </dd>
            </div>
          ))
        )}
        <div className={`${styles.row} ${tender.changePence > 0 ? styles.changeDue : styles.changeNone}`}>
          <dt>Change due</dt>
          <dd>
            <MoneyText pence={tender.changePence} size="lg" strong={tender.changePence > 0} testId="change-due" />
          </dd>
        </div>
      </dl>
      {!compact && count === 0 && !settled && <p className={styles.hint}>No payment taken yet.</p>}
    </section>
  );
}
