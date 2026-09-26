import { useId, type ReactNode } from 'react';
import { Button, NumericKeypad } from '../../components';
import { formatPence } from '../../rules/money';
import { QUICK_CASH_PENCE } from '../../rules/tender';
import { quickCashLabel } from './payLabels';
import styles from './TenderPanel.module.css';

export interface TenderPanelProps {
  /** The balance still to pay (TenderState.remainingPence). */
  remainingPence: number;
  /** The custom-amount keypad value (payStore.keypadPence, D-006). */
  keypadPence: number;
  onKeypadChange: (pence: number) => void;
  /** Cash of a fixed amount: a quick cash note (D-030). */
  onQuickCash: (pence: number) => void;
  /** Cash equal to the remaining balance (D-030). */
  onExact: () => void;
  /** Cash of the keypad amount (disabled while it is 0, D-030). */
  onCash: () => void;
  /** Card of the keypad amount, or of the remaining balance when the keypad is empty (D-029). */
  onCard: () => void;
  /** Everything disabled (a commit is running). */
  disabled: boolean;
  /** Larger keypad keys on the tablet. */
  large: boolean;
  /**
   * A message about the last tender (e.g. a refused card), shown under the tender keys so it
   * never pushes a money key down under the finger (D-134).
   */
  notice?: ReactNode;
  /**
   * Briefly true after Pay opens and after each tender or refusal: taps on the panel are ignored
   * (pointer-events), so the second tap of a double tap never takes another tender (D-134).
   */
  resting?: boolean;
}

/** UK note colours, used only as a thin accent on the quick cash buttons. */
const NOTE_CLASS: Record<number, string | undefined> = {
  500: styles.note5,
  1000: styles.note10,
  2000: styles.note20,
  5000: styles.note50,
};

/**
 * Quick cash (£5 £10 £20 £50), the Exact / Cash / Card tender keys, then any notice, then the
 * custom-amount keypad (in that order, so the common one-tap tenders stay in view on a phone and
 * nothing above them changes height when a tender is taken or refused, D-134).
 * Button names are the stable e2e selectors of architecture §7.4; each key also shows the amount
 * it will tender, which screen readers get as the button's description.
 */
export function TenderPanel({
  remainingPence,
  keypadPence,
  onKeypadChange,
  onQuickCash,
  onExact,
  onCash,
  onCard,
  disabled,
  large,
  notice,
  resting = false,
}: TenderPanelProps) {
  const exactId = useId();
  const cashId = useId();
  const cardId = useId();
  const hasAmount = keypadPence > 0;
  const nothingDue = remainingPence <= 0;
  const cardPence = hasAmount ? keypadPence : remainingPence;

  return (
    <div className={`${styles.panel} ${resting ? styles.resting : ''}`} data-resting={resting || undefined}>
      <div className={styles.quick} role="group" aria-label="Quick cash">
        {QUICK_CASH_PENCE.map((pence) => (
          <Button
            key={pence}
            size="lg"
            className={`${styles.note} ${NOTE_CLASS[pence] ?? ''}`}
            onClick={() => onQuickCash(pence)}
            disabled={disabled || nothingDue}
          >
            {quickCashLabel(pence)}
          </Button>
        ))}
      </div>

      <div className={styles.tenders} role="group" aria-label="Take payment">
        <Button
          size="lg"
          className={styles.tenderKey}
          onClick={onExact}
          disabled={disabled || nothingDue}
          aria-describedby={exactId}
        >
          <span className={styles.tenderName}>Exact</span>
          <span id={exactId} className={`${styles.tenderAmount} money`} aria-hidden="true">
            {formatPence(remainingPence)}
          </span>
        </Button>
        <Button
          size="lg"
          className={`${styles.tenderKey} ${styles.cash}`}
          onClick={onCash}
          disabled={disabled || nothingDue || !hasAmount}
          aria-describedby={cashId}
        >
          <span className={styles.tenderName}>Cash</span>
          <span id={cashId} className={`${styles.tenderAmount} money`} aria-hidden="true">
            {hasAmount ? formatPence(keypadPence) : 'Enter amount'}
          </span>
        </Button>
        <Button
          size="lg"
          variant="primary"
          className={styles.tenderKey}
          onClick={onCard}
          disabled={disabled || nothingDue}
          aria-describedby={cardId}
        >
          <span className={styles.tenderName}>Card</span>
          <span id={cardId} className={`${styles.tenderAmount} money`} aria-hidden="true">
            {formatPence(cardPence)}
          </span>
        </Button>
      </div>

      {notice !== undefined && <div className={styles.notice}>{notice}</div>}

      <div className={styles.keypad}>
        <NumericKeypad
          label="Amount tendered"
          valuePence={keypadPence}
          onChange={onKeypadChange}
          captureKeyboard
          disabled={disabled || nothingDue}
          size={large ? 'lg' : 'md'}
          displayTestId="tender-amount"
          className={styles.keypadRoot}
        />
      </div>
    </div>
  );
}
