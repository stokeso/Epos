import { useEffect, type ReactNode } from 'react';
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
  useEffect(() => {
    document.title = `${title} · Club EPOS`;
  }, [title]);
  return (
    <div className={`${styles.screen} ${styles[width] ?? ''} ${className ?? ''}`}>
      <div className={hideTitle ? 'visually-hidden' : styles.titleRow}>
        <div className={styles.titleText}>
          <h1 className={styles.title}>{title}</h1>
          {description !== undefined && <div className={styles.description}>{description}</div>}
        </div>
        {actions !== undefined && !hideTitle && <div className={styles.actions}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}
