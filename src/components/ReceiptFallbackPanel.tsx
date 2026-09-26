import { Button } from './Button';
import { Modal } from './Modal';
import styles from './ReceiptFallbackPanel.module.css';

export interface ReceiptFallbackPanelProps {
  /** The document HTML and its <title>; null hides the panel. */
  fallback: { html: string; title: string } | null;
  /** Tries window.open again (the app host closes the panel when that works, D-109). */
  onReprint: () => void;
  onClose: () => void;
}

/**
 * Shown when the browser blocks the receipt tab (spec §6.10, D-109): the same HTML in a
 * sandboxed iframe (srcdoc, empty sandbox: no scripts, no navigation), with Reprint and Close.
 * The app root mounts one (src/app/GlobalUi.tsx); screens just call openDocument().
 * Only Close and Reprint close it: Escape and a stray tap on the backdrop do not, since it may
 * hold the only copy of a receipt or Z report (D-135).
 */
export function ReceiptFallbackPanel({ fallback, onReprint, onClose }: ReceiptFallbackPanelProps) {
  return (
    <Modal
      open={fallback !== null}
      onClose={onClose}
      title={fallback?.title ?? 'Receipt'}
      description="The browser blocked the new tab, so the document is shown here."
      size="md"
      dismissible={false}
      testId="receipt-fallback"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={onReprint} data-autofocus>
            Reprint
          </Button>
        </>
      }
    >
      {fallback !== null && (
        <div className={styles.paper}>
          <iframe className={styles.frame} title={fallback.title} srcDoc={fallback.html} sandbox="" />
        </div>
      )}
    </Modal>
  );
}
