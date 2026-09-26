import { useId, type ReactNode } from 'react';
import { Modal } from './Modal';
import styles from './BottomSheet.module.css';

export interface BottomSheetProps {
  /** The expanded sheet's dialog title, e.g. 'Basket'. */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Always-visible bar content inside the toggle button (e.g. item count and total). */
  summary: ReactNode;
  /**
   * Start of the toggle button's accessible name, visually hidden. The visible summary follows it,
   * so the name contains what the bar shows (WCAG 2.5.3): 'View basket 3 items £12.90'.
   * Default `View ${title.toLowerCase()}` ('View basket').
   */
  toggleLabel?: string;
  /** Extra buttons at the right of the bar (e.g. Pay). */
  barActions?: ReactNode;
  /** The expanded content (e.g. BasketPanel). */
  children: ReactNode;
  /** Pinned under the expanded content (e.g. action buttons). */
  footer?: ReactNode;
  testId?: string;
}

/**
 * Portrait layout (< 900 px): a bar fixed to the bottom of the screen that expands into a
 * sheet. The component also renders an in-flow spacer the height of the bar, so page content
 * never hides under it. The expanded sheet is a modal dialog (focus moves in and is restored).
 */
export function BottomSheet({ title, open, onOpenChange, summary, toggleLabel, barActions, children, footer, testId }: BottomSheetProps) {
  const labelId = useId();
  const summaryId = useId();
  return (
    <>
      <div className={styles.spacer} aria-hidden="true" />
      <div className={styles.bar} data-testid={testId}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-labelledby={`${labelId} ${summaryId}`}
          onClick={() => onOpenChange(!open)}
        >
          <span id={labelId} className="visually-hidden">
            {toggleLabel ?? `View ${title.toLowerCase()}`}
          </span>
          <svg className={styles.chevron} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span id={summaryId} className={styles.summary}>
            {summary}
          </span>
        </button>
        {barActions !== undefined && <div className={styles.barActions}>{barActions}</div>}
      </div>
      {/* Focus starts on Close: the first control in a basket is a line's '−' (a void). */}
      <Modal open={open} onClose={() => onOpenChange(false)} title={title} placement="bottom" showCloseButton focusCloseButton footer={footer}>
        {children}
      </Modal>
    </>
  );
}
