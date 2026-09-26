import { useEffect, useRef, type ReactNode } from 'react';
import { isFocusLost } from './focus';
import styles from './Screen.module.css';

export interface ScreenProps {
  /** The page's <h1> and document title ('{title} · Club EPOS'). */
  title: string;
  /** Keep the <h1> for screen readers but hide it visually (e.g. the till). */
  hideTitle?: boolean;
  /** Short text under the title. */
  description?: ReactNode;
  /** Buttons at the right of the title row. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Content width: narrow 640 px (forms), default 1120 px, full (till). */
  width?: 'narrow' | 'default' | 'full';
  className?: string;
}

/**
 * The standard page layout inside the app shell: title row + content with page gutters.
 * Every screen renders exactly one Screen (one <h1>).
 */
export function Screen({ title, hideTitle = false, description, actions, children, width = 'default', className }: ScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Club EPOS`;
  }, [title]);
  // A control inside the last screen that changed the route (Pay, Back to basket, a booking link,
  // a dialog's Continue to Pay) went with that screen, so focus fell to <body>, or to <main> when a
  // dialog closed with it. Move focus to this screen's heading: keyboard users keep their place and
  // screen readers announce the new screen (D-136). Focus that is still somewhere (the header's
  // Menu button after the menu, a field with autoFocus, a screen's own initial focus) is left alone.
  useEffect(() => {
    if (isFocusLost() || document.activeElement === document.getElementById('main')) headingRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className={`${styles.screen} ${styles[width] ?? ''} ${className ?? ''}`}>
      <div className={hideTitle ? 'visually-hidden' : styles.titleRow}>
        <div className={styles.titleText}>
          <h1 ref={headingRef} className={styles.title} tabIndex={-1}>
            {title}
          </h1>
          {description !== undefined && <div className={styles.description}>{description}</div>}
        </div>
        {actions !== undefined && !hideTitle && <div className={styles.actions}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}
