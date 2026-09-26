import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { canReceiveGlobalKeys, isTextEntryTarget } from './modalStack';
import styles from './Keypad.module.css';

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

export interface PinKeypadProps {
  /** Called with the 4–6 digit PIN on Enter. The entry clears immediately (D-076). */
  onSubmit: (pin: string) => void;
  /** Visible prompt and the keypad group's name, e.g. 'Enter your PIN'. */
  label: string;
  /** Disables every key (e.g. during a lockout). */
  disabled?: boolean;
  /** While checking a PIN: keys disabled, Enter shows 'Checking…'. */
  busy?: boolean;
  /** Error under the dots (role=alert), e.g. 'PIN not recognised'. */
  error?: string | null;
  /**
   * Neutral status under the dots (e.g. the lockout countdown); shown when there is no error.
   * Not a live region (role="timer"), so a ticking countdown is not read out every second: put
   * what a screen reader should hear once in `announcement`.
   */
  status?: ReactNode;
  /**
   * Read out once by a polite live region (visually hidden) each time it changes, e.g. that a
   * lockout started ('… locked for 30 seconds') or ended.
   */
  announcement?: string;
  /** Physical digits, Backspace and Enter (D-073). Ignored behind a modal or in a text field. Default true. */
  captureKeyboard?: boolean;
  /** Default 'Enter'. */
  submitLabel?: string;
  /** 'dark' for the brand-green login screen. */
  tone?: 'light' | 'dark';
  className?: string;
  testId?: string;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * PIN entry (D-073): 4–6 digits with an explicit Enter key, no auto-submit. Keys are buttons
 * named '0'..'9', 'Clear', 'Delete last digit' and 'Enter'. Digits are never displayed.
 *
 * Focus (D-132): the group itself is focusable (tabIndex -1) and is a Modal's initial focus
 * (data-autofocus). Tapping a key does not move focus onto it, so physical digits and Enter keep
 * working after taps. Enter on a key reached with the keyboard activates that key, as on any
 * button; Enter anywhere else submits. When an action disables the focused key (Enter, Clear,
 * the last Delete), focus moves to the group, so it never falls out of a dialog.
 */
export function PinKeypad({
  onSubmit,
  label,
  disabled = false,
  busy = false,
  error,
  status,
  announcement = '',
  captureKeyboard = true,
  submitLabel = 'Enter',
  tone = 'light',
  className,
  testId,
}: PinKeypadProps) {
  const [pin, setPin] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const inactive = disabled || busy;
  const latest = useRef({ pin, inactive, onSubmit });

  useEffect(() => {
    latest.current = { pin, inactive, onSubmit };
  });

  const append = (digit: string): void => {
    if (inactive) return;
    setPin((current) => (current.length >= PIN_MAX_LENGTH ? current : current + digit));
  };
  const backspace = (): void => {
    if (inactive) return;
    if (pin.length <= 1) keepFocus(rootRef.current, 'digits');
    setPin((current) => current.slice(0, -1));
  };
  const clear = (): void => {
    if (inactive) return;
    keepFocus(rootRef.current, 'digits');
    setPin('');
  };
  const submit = (): void => {
    if (inactive || pin.length < PIN_MIN_LENGTH) return;
    keepFocus(rootRef.current, 'none');
    setPin('');
    onSubmit(pin);
  };

  useEffect(() => {
    if (!captureKeyboard) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isTextEntryTarget(event.target) || !canReceiveGlobalKeys(rootRef.current)) return;
      const { inactive: off, pin: current, onSubmit: send } = latest.current;
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        if (!off) setPin((value) => (value.length >= PIN_MAX_LENGTH ? value : value + event.key));
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        if (off) return;
        if (current.length <= 1) keepFocus(rootRef.current, 'digits');
        setPin((value) => value.slice(0, -1));
      } else if (event.key === 'Enter') {
        // Enter on a focused button activates it, as usual: Cancel, or one of this keypad's own
        // keys (Clear clears, '1' types 1, Enter submits). Anywhere else Enter submits.
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        if (!off && current.length >= PIN_MIN_LENGTH) {
          keepFocus(rootRef.current, 'none');
          setPin('');
          send(current);
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [captureKeyboard]);

  const slots = Math.max(PIN_MIN_LENGTH, pin.length);
  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={labelId}
      className={`${styles.keypad} ${tone === 'dark' ? styles.dark : ''} ${className ?? ''}`}
      data-testid={testId}
      tabIndex={-1}
      data-autofocus
      onMouseDown={keepPointerFocus}
    >
      <p id={labelId} className={styles.prompt}>
        {label}
      </p>
      <div className={styles.dots} aria-hidden="true">
        {Array.from({ length: slots }, (_, i) => (
          <span key={i} className={`${styles.dot} ${i < pin.length ? styles.dotFilled : ''}`} />
        ))}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {pin.length === 0 ? 'No digits entered' : `${pin.length} ${pin.length === 1 ? 'digit' : 'digits'} entered`}
      </p>
      <div className={`${styles.message} ${error ? styles.error : ''}`}>
        {error ? <span role="alert">{error}</span> : <span role="timer">{status}</span>}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      <div className={styles.grid}>
        {DIGITS.map((d) => (
          <button key={d} type="button" className={styles.key} onClick={() => append(d)} disabled={inactive} data-digit>
            {d}
          </button>
        ))}
        <button type="button" className={`${styles.key} ${styles.keySecondary}`} onClick={clear} disabled={inactive || pin.length === 0}>
          Clear
        </button>
        <button type="button" className={styles.key} onClick={() => append('0')} disabled={inactive} data-digit>
          0
        </button>
        <button type="button" className={styles.key} onClick={backspace} disabled={inactive || pin.length === 0} aria-label="Delete last digit">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path d="M9 5h11a1 1 0 011 1v12a1 1 0 01-1 1H9l-6-7 6-7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M12 9.5l5 5M17 9.5l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className={`${styles.key} ${styles.enter}`} onClick={submit} disabled={inactive || pin.length < PIN_MIN_LENGTH} aria-busy={busy || undefined}>
          {busy ? 'Checking…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Before an action disables the focused key (which would drop focus to <body>, outside any
 * dialog), move focus to the keypad group. 'digits': the digit keys stay enabled, so focus on
 * one of them is left alone.
 */
function keepFocus(root: HTMLElement | null, stayEnabled: 'digits' | 'none'): void {
  const active = document.activeElement;
  if (root === null || !(active instanceof HTMLElement) || active === root || !root.contains(active)) return;
  if (stayEnabled === 'digits' && active.dataset.digit !== undefined) return;
  root.focus({ preventScroll: true });
}

/** A tap or click on a key doesn't move focus onto it (on-screen keypad behaviour). */
function keepPointerFocus(event: MouseEvent<HTMLDivElement>): void {
  if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault();
}
