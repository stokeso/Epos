import type { ReactNode } from 'react';
import { keepFocusWhenRemoved } from './focus';
import styles from './Banner.module.css';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

export interface BannerProps {
  tone?: BannerTone;
  /** Bold lead-in text. */
  title?: string;
  children?: ReactNode;
  /** Buttons or links shown at the end (e.g. 'Back up now'). */
  action?: ReactNode;
  /** Shows a 'Dismiss' button. */
  onDismiss?: () => void;
  /** Accessible name of the dismiss button. Default 'Dismiss'. */
  dismissLabel?: string;
  /** Default: 'alert' for danger, 'status' otherwise. 'none' for static notes. */
  role?: 'alert' | 'status' | 'none';
  testId?: string;
  className?: string;
}

const ICONS: Record<BannerTone, ReactNode> = {
  info: <path d="M12 8h.01M11 12h1v5h1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />,
  success: <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  warning: <path d="M12 7.5v5.5M12 16.5h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />,
  danger: <path d="M12 7.5v5.5M12 16.5h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />,
};

/**
 * An in-flow message strip. Banners never overlay content (architecture §7.4): they take
 * space in the layout, so buttons below simply move down.
 */
export function Banner({ tone = 'info', title, children, action, onDismiss, dismissLabel = 'Dismiss', role, testId, className }: BannerProps) {
  const ariaRole = role ?? (tone === 'danger' ? 'alert' : 'status');
  return (
    <div
      className={`${styles.banner} ${styles[tone] ?? ''} ${action !== undefined ? styles.hasAction : ''} ${className ?? ''}`}
      role={ariaRole === 'none' ? undefined : ariaRole}
      data-testid={testId}
    >
      <svg className={styles.icon} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
        {ICONS[tone]}
      </svg>
      <div className={styles.text}>
        {title !== undefined && <strong className={styles.title}>{title}</strong>}
        {children !== undefined && <span>{children}</span>}
      </div>
      {(action !== undefined || onDismiss !== undefined) && (
        <div className={styles.actions}>
          {action}
          {onDismiss !== undefined && (
            <button
              type="button"
              className={styles.dismiss}
              onClick={(event) => {
                // The banner goes away with its button: keep focus near it, not on <body> (D-135).
                keepFocusWhenRemoved(event.currentTarget);
                onDismiss();
              }}
              aria-label={dismissLabel}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
