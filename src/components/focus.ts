/**
 * Keeping keyboard focus on the page when the focused control goes away (WCAG 2.4.3; D-135).
 *
 * When the focused element is removed from the page, or a dialog closes and its opener is now
 * disabled, the browser drops focus to <body>: keyboard and screen-reader users lose their place,
 * and inside an open dialog (the phone's basket sheet) focus leaves the dialog. These helpers move
 * focus to the nearest container that takes focus from script (tabindex="-1": a dialog, the
 * basket, <main>), never to another button, so a repeated Enter can't press something else.
 */

/** The element's ancestors, nearest first. Recorded before the element may be removed. */
export function ancestorsOf(element: Element): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node = element.parentElement; node !== null; node = node.parentElement) chain.push(node);
  return chain;
}

/** True when `element` can take focus now: on the page, not disabled, not behind a modal. */
export function canTakeFocus(element: HTMLElement): boolean {
  return element.isConnected && !element.matches(':disabled') && element.closest('[inert]') === null;
}

/** True when nothing has focus (the browser's fallback after the focused element went away). */
export function isFocusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * The nearest of `ancestors` that is still on the page, not behind a modal and focusable from
 * script (tabindex="-1"), else <main>.
 */
export function focusFallback(ancestors: readonly HTMLElement[]): HTMLElement | null {
  const container = ancestors.find((el) => el.getAttribute('tabindex') === '-1' && el !== document.body && canTakeFocus(el));
  if (container !== undefined) return container;
  const main = document.getElementById('main');
  return main !== null && canTakeFocus(main) ? main : null;
}

/**
 * Call when a control is pressed that may remove itself ('Remove member', a banner's dismiss,
 * '−' on a line's last unit). Once `control` leaves the page, if focus fell to <body>, focus
 * moves to the nearest focusable container it was in (e.g. the basket or the open sheet), else
 * <main>. Stops watching after `timeoutMs` (the removal may wait for a PIN override).
 */
export function keepFocusWhenRemoved(control: HTMLElement | null, timeoutMs = 60_000): void {
  if (control === null || typeof MutationObserver === 'undefined') return;
  const ancestors = ancestorsOf(control);
  const observer = new MutationObserver(() => {
    if (control.isConnected) return;
    stop();
    if (isFocusLost()) focusFallback(ancestors)?.focus({ preventScroll: true });
  });
  const timer = setTimeout(stop, timeoutMs);
  function stop(): void {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
}
