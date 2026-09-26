import { useId, useRef, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { MoneyText } from '../../components';
import { formatPence } from '../../rules/money';
import type { RefundableLine } from '../../services/refunds';
import { ChoiceToggle } from './ChoiceToggle';
import { lineRefundPence } from './refundPreview';
import styles from './RefundScreen.module.css';

export type StockChoice = 'return' | 'waste';

const STOCK_OPTIONS = [
  { value: 'return', label: 'Return to stock' },
  { value: 'waste', label: 'Waste' },
] as const satisfies readonly { value: StockChoice; label: string }[];

export interface RefundLineRowProps {
  line: RefundableLine;
  /** Units chosen to refund now (0..line.refundableQty). */
  qty: number;
  onQtyChange: (qty: number) => void;
  stock: StockChoice;
  onStockChange: (choice: StockChoice) => void;
  disabled?: boolean;
}

/**
 * One line of the original sale (D-036): what was sold, what has been refunded already, a stepper
 * capped at what is left, and — for stock-tracked products only — return to stock or waste (D-039).
 */
export function RefundLineRow({ line, qty, onQtyChange, stock, onStockChange, disabled = false }: RefundLineRowProps) {
  const nameId = useId();
  const name = line.line.nameAtSale;
  const max = line.refundableQty;
  const refundPence = lineRefundPence(line, qty);
  const selected = qty > 0;
  const decreaseRef = useRef<HTMLButtonElement>(null);
  const increaseRef = useRef<HTMLButtonElement>(null);

  /**
   * One step. When the pressed stepper reaches its limit it becomes disabled; if it had focus,
   * focus moves to the other stepper instead of falling to <body> (D-134).
   */
  const step = (delta: -1 | 1, event: MouseEvent<HTMLButtonElement>): void => {
    const pressed = event.currentTarget;
    const hadFocus = document.activeElement === pressed;
    flushSync(() => onQtyChange(qty + delta));
    if (hadFocus && pressed.disabled) (delta < 0 ? increaseRef : decreaseRef).current?.focus();
  };

  return (
    <li className={`${styles.line} ${selected ? styles.lineSelected : ''}`} aria-labelledby={nameId} data-testid="refund-line">
      <div className={styles.lineTop}>
        <div className={styles.lineInfo}>
          <p id={nameId} className={styles.lineName}>
            {name}
          </p>
          <p className={styles.lineMeta}>
            <span className="tabular">
              {line.soldQty} × {formatPence(line.line.unitPricePence)}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              paid <MoneyText pence={line.line.finalPence} />
            </span>
          </p>
          {line.refundedQty > 0 && (
            <p className={styles.lineRefunded} data-testid="refund-line-refunded">
              {line.refundedQty} already refunded
            </p>
          )}
        </div>
        {selected && (
          <p className={styles.lineAmount}>
            <span className={styles.lineAmountLabel}>Refund</span>
            <MoneyText pence={refundPence} strong testId="refund-line-amount" />
          </p>
        )}
      </div>

      {max === 0 ? (
        <p className={styles.fullyRefunded}>Fully refunded</p>
      ) : (
        <div className={styles.lineControls}>
          <div className={styles.stepper} role="group" aria-label={`Quantity to refund: ${name}`}>
            <button
              ref={decreaseRef}
              type="button"
              className={styles.stepButton}
              aria-label={`Decrease ${name}`}
              onClick={(event) => step(-1, event)}
              disabled={disabled || qty <= 0}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </button>
            <div className={styles.stepValue}>
              <output className={styles.stepQty} aria-live="polite" data-testid="refund-qty">
                {qty}
              </output>
              <span className={styles.stepMax}>of {max}</span>
            </div>
            <button
              ref={increaseRef}
              type="button"
              className={styles.stepButton}
              aria-label={`Increase ${name}`}
              onClick={(event) => step(1, event)}
              disabled={disabled || qty >= max}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M5 12h14M12 5v14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {line.stockTracked ? (
            <div className={styles.stockChoice}>
              <ChoiceToggle
                legend={`Stock for ${name}`}
                hideLegend
                name={`stock-${line.lineIndex}`}
                value={stock}
                onChange={onStockChange}
                options={STOCK_OPTIONS}
                disabled={disabled || !selected}
              />
            </div>
          ) : (
            <p className={styles.untracked}>Not stock-tracked</p>
          )}
        </div>
      )}
    </li>
  );
}
