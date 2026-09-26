import { useEffect, useId, useRef } from 'react';
import { formatPence, pressMoneyKey, type MoneyKey } from '../rules/money';
import { canReceiveGlobalKeys, isTextEntryTarget } from './modalStack';
import styles from './Keypad.module.css';

export interface NumericKeypadProps {
  /** Current value in pence (0..9,999,999). */
  valuePence: number;
  /** Receives the next value after a key press (rules/money.pressMoneyKey, D-006). */
  onChange: (pence: number) => void;
  /** Names the keypad group and labels the display, e.g. 'Float' or 'Amount'. */
  label: string;
  disabled?: boolean;
  /** Hide the amount display (the screen shows it elsewhere). The 'Delete last digit' key moves into the grid. */
  hideDisplay?: boolean;
  /**
   * Physical keys too: 0-9, Backspace (delete last digit), Delete (clear). Ignored while a text
   * field has focus or the keypad is behind a modal. Default false.
   */
  captureKeyboard?: boolean;
  size?: 'md' | 'lg';
  /**
   * Enter pressed while the keypad group itself has focus (its initial focus in a dialog), e.g.
   * the dialog's primary action. Enter on a focused key still presses that key. Needs
   * captureKeyboard.
   */
  onEnter?: () => void;
  /** data-testid for the amount display. */
  displayTestId?: string;
  className?: string;
}

const DIGIT_ROWS: readonly MoneyKey[] = ['7', '8', '9', '4', '5', '6', '1', '2', '3'];

/**
 * The money keypad (D-006): digits enter pence (2,0,0,0 -> £20.00), '00' adds two zeros, at most
 * 7 digits. Keys are real buttons named '0'..'9', '00', 'Delete last digit' and 'Clear'
 * (e2e: getByRole('button', { name: '5', exact: true })).
 *
 * Focus (D-134, as D-132 for the PIN keypad): the group itself is focusable (tabIndex -1) and is a
 * Modal's initial focus (data-autofocus), so a dialog never opens on 'Delete last digit' and
 * Enter after typing an amount can't delete a digit.
 */
export function NumericKeypad({
  valuePence,
  onChange,
  label,
  disabled = false,
  hideDisplay = false,
  captureKeyboard = false,
  size = 'md',
  onEnter,
  displayTestId,
  className,
}: NumericKeypadProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const latest = useRef({ valuePence, onChange, disabled, onEnter });

  useEffect(() => {
    latest.current = { valuePence, onChange, disabled, onEnter };
  });

  const press = (key: MoneyKey): void => {
    if (disabled) return;
    onChange(pressMoneyKey(valuePence, key));
  };

  useEffect(() => {
    if (!captureKeyboard) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (latest.current.disabled || isTextEntryTarget(event.target) || !canReceiveGlobalKeys(rootRef.current)) return;
      if (event.key === 'Enter') {
        // Only with focus on the group itself: Enter on a focused key or button presses that one.
        const enter = latest.current.onEnter;
        if (enter === undefined || event.target !== rootRef.current) return;
        event.preventDefault();
        enter();
        return;
      }
      let key: MoneyKey | null = null;
      if (/^[0-9]$/.test(event.key)) key = event.key as MoneyKey;
      else if (event.key === 'Backspace') key = 'backspace';
      else if (event.key === 'Delete') key = 'clear';
      if (key === null) return;
      event.preventDefault();
      latest.current.onChange(pressMoneyKey(latest.current.valuePence, key));
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [captureKeyboard]);

  const backspace = (
    <button type="button" className={hideDisplay ? styles.key : styles.iconKey} onClick={() => press('backspace')} disabled={disabled} aria-label="Delete last digit">
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <path d="M9 5h11a1 1 0 011 1v12a1 1 0 01-1 1H9l-6-7 6-7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M12 9.5l5 5M17 9.5l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
  );

  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={labelId}
      tabIndex={-1}
      data-autofocus
      className={`${styles.keypad} ${size === 'lg' ? styles.lg : ''} ${className ?? ''}`}
    >
      {hideDisplay ? (
        <span id={labelId} className="visually-hidden">
          {label}
        </span>
      ) : (
        <div className={styles.display}>
          <div className={styles.displayText}>
            <span id={labelId} className={styles.displayLabel}>
              {label}
            </span>
            <output className={`money ${styles.amount}`} aria-live="polite" data-testid={displayTestId}>
              {formatPence(valuePence)}
            </output>
          </div>
          {backspace}
        </div>
      )}
      <div className={styles.grid}>
        {DIGIT_ROWS.map((key) => (
          <button key={key} type="button" className={styles.key} onClick={() => press(key)} disabled={disabled}>
            {key}
          </button>
        ))}
        <button type="button" className={styles.key} onClick={() => press('00')} disabled={disabled}>
          00
        </button>
        <button type="button" className={styles.key} onClick={() => press('0')} disabled={disabled}>
          0
        </button>
        {hideDisplay ? (
          backspace
        ) : (
          <button type="button" className={`${styles.key} ${styles.keySecondary}`} onClick={() => press('clear')} disabled={disabled} aria-label="Clear">
            C
          </button>
        )}
        {hideDisplay && (
          <button type="button" className={`${styles.key} ${styles.wide}`} onClick={() => press('clear')} disabled={disabled} aria-label="Clear">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
