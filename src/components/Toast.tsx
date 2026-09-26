import { createPortal } from 'react-dom';
import type { ToastItem } from '../store/uiStore';
import styles from './Toast.module.css';

export interface ToastViewProps {
  toast: ToastItem;
}

/** One toast. Toasts never take pointer events, so they can't block a tap on the button beneath. */
export function Toast({ toast }: ToastViewProps) {
  return (
    <div className={`${styles.toast} ${styles[toast.tone] ?? ''}`} data-testid="toast">
      {toast.message}
    </div>
  );
}

export interface ToasterProps {
  toasts: readonly ToastItem[];
}

/**
 * Renders the toast stack in live regions on document.body (outside #root, so they are still
 * announced while a modal makes the app inert). Mounted once by the app root; show toasts with
 * toast() from src/store.
 */
export function Toaster({ toasts }: ToasterProps) {
  const polite = toasts.filter((t) => t.tone !== 'danger');
  const urgent = toasts.filter((t) => t.tone === 'danger');
  return createPortal(
    <div className={styles.region}>
      <div role="status" aria-live="polite" className={styles.stack}>
        {polite.map((t) => (
          <Toast key={t.id} toast={t} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className={styles.stack}>
        {urgent.map((t) => (
          <Toast key={t.id} toast={t} />
        ))}
      </div>
    </div>,
    document.body,
  );
}
