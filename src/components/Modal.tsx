import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ancestorsOf, canTakeFocus, focusFallback, isFocusLost, keepFocusWhenRemoved } from './focus';
import { focusableWithin, isTopLayer, pushLayer, removeLayer } from './modalStack';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  /** Called on Escape and backdrop click (when dismissible) and by the optional close button. */
  onClose: () => void;
  /** The dialog's accessible name (aria-labelledby) and visible heading. */
  title: string;
  /** Keep the name but hide the heading visually. */
  hideTitle?: boolean;
  /** Shown under the title; referenced by aria-describedby. */
  description?: ReactNode;
  /**
   * id of an element inside the body that also describes the dialog (added to aria-describedby),
   * e.g. a confirmation's message.
   */
  describedBy?: string;
  children?: ReactNode;
  /** Action buttons, pinned under the scrolling body. */
  footer?: ReactNode;
  /** Panel width: sm 420, md 560, lg 800 px, full = viewport minus gutters. */
  size?: 'sm' | 'md' | 'lg' | 'full';
  /** 'bottom' slides up from the bottom edge (sheets); 'right' is a side drawer (menu). */
  placement?: 'center' | 'bottom' | 'right';
  /** Escape and backdrop click close it. Default true. Set false while saving. */
  dismissible?: boolean;
  /** Show an '×' button named 'Close' in the header. Default false (give the footer a Cancel). */
  showCloseButton?: boolean;
  /** With showCloseButton: focus the Close button on open (e.g. a sheet whose first control is destructive). */
  focusCloseButton?: boolean;
  /** Element to focus on open. Default: [data-autofocus], else the first focusable in the body. */
  initialFocus?: RefObject<HTMLElement | null>;
  testId?: string;
  className?: string;
}

/** How long a restored opener is watched for removal by the screen's reload after a save. */
const RELOAD_WATCH_MS = 10_000;

/**
 * Accessible modal dialog: role="dialog", aria-modal, labelled by its title. Focus moves in on
 * open, is trapped while open, and returns to the previously focused element on close. If that
 * element can no longer take focus (the dialog's action disabled or removed it, e.g. Void after
 * voiding the only line), or the screen removes it just after (a reload after a save), focus goes
 * to the nearest focusable container it was in, else <main>, rather than falling to <body>
 * (D-135, D-139). The rest of the app is inert while it is open.
 * Rendered in a portal on document.body.
 */
export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <ModalLayer {...props} />;
}

function ModalLayer({
  onClose,
  title,
  hideTitle = false,
  description,
  describedBy,
  children,
  footer,
  size = 'md',
  placement = 'center',
  dismissible = true,
  showCloseButton = false,
  focusCloseButton = false,
  initialFocus,
  testId,
  className,
}: ModalProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pointerDownOnBackdrop = useRef(false);
  const latest = useRef({ onClose, dismissible });
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    latest.current = { onClose, dismissible };
  });

  useEffect(() => {
    const layer = layerRef.current;
    const panel = panelRef.current;
    if (layer === null || panel === null) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousAncestors = previous === null ? [] : ancestorsOf(previous);
    pushLayer(layer);

    const body = bodyRef.current ?? panel;
    const target =
      initialFocus?.current ?? panel.querySelector<HTMLElement>('[data-autofocus]') ?? focusableWithin(body)[0] ?? focusableWithin(panel)[0] ?? panel;
    target.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent): void {
      if (layer === null || panel === null || !isTopLayer(layer)) return;
      if (event.key === 'Escape') {
        if (!latest.current.dismissible) return;
        event.preventDefault();
        event.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableWithin(panel);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (first === undefined || last === undefined) {
        event.preventDefault();
        panel.focus();
        return;
      }
      if (!(active instanceof Node) || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      removeLayer(layer);
      if (previous !== null && canTakeFocus(previous)) {
        previous.focus({ preventScroll: true });
        // The screen often reloads after a save and may then remove the opener's row (a member
        // moved to Inactive, a category deleted, a product off the low-stock list): focus then
        // goes to the nearest focusable container or <main>, not <body> (D-135, D-139).
        keepFocusWhenRemoved(previous, RELOAD_WATCH_MS);
      } else if (previous !== null && isFocusLost()) focusFallback(previousAncestors)?.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  const panelClass = [styles.panel, styles[size], styles[placement], className ?? ''].filter((c) => c !== '' && c !== undefined).join(' ');

  return createPortal(
    <div
      ref={layerRef}
      className={`${styles.layer} ${styles[`layer_${placement}`] ?? ''}`}
      onPointerDown={(event) => {
        pointerDownOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pointerDownOnBackdrop.current && dismissible) onClose();
        pointerDownOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={[description === undefined ? '' : descriptionId, describedBy ?? ''].filter((id) => id !== '').join(' ') || undefined}
        tabIndex={-1}
        className={panelClass}
        data-testid={testId}
      >
        <div className={`${styles.header} ${hideTitle ? styles.headerHidden : ''}`}>
          <h2 id={titleId} className={hideTitle ? 'visually-hidden' : styles.title}>
            {title}
          </h2>
          {showCloseButton && (
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close" data-autofocus={focusCloseButton ? true : undefined}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        {description !== undefined && (
          <div id={descriptionId} className={styles.description}>
            {description}
          </div>
        )}
        <div ref={bodyRef} className={styles.body}>
          {children}
        </div>
        {footer !== undefined && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
