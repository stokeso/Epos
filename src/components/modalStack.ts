/**
 * The stack of open modal layers (Modal, BottomSheet, the menu drawer).
 * While any layer is open the app root (#root) is inert, and so is every layer below the top
 * one, so only the top dialog is interactive and keyboard handlers elsewhere stand down.
 */

const stack: HTMLElement[] = [];

function sync(): void {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('root');
  if (root !== null) root.inert = stack.length > 0;
  stack.forEach((layer, index) => {
    layer.inert = index < stack.length - 1;
  });
  document.body.classList.toggle('has-modal', stack.length > 0);
  document.body.style.overflow = stack.length > 0 ? 'hidden' : '';
}

export function pushLayer(layer: HTMLElement): void {
  stack.push(layer);
  sync();
}

export function removeLayer(layer: HTMLElement): void {
  const index = stack.indexOf(layer);
  if (index !== -1) stack.splice(index, 1);
  layer.inert = false;
  sync();
}

export function isTopLayer(layer: HTMLElement): boolean {
  return stack[stack.length - 1] === layer;
}

/**
 * True when `element` may react to global keyboard input: it is connected, not inside an inert
 * subtree (e.g. behind a modal) and not disabled. Used by the keypads' physical-key support.
 */
export function canReceiveGlobalKeys(element: Element | null): boolean {
  if (element === null || !element.isConnected) return false;
  return element.closest('[inert]') === null;
}

/** True when a keyboard event comes from a text-entry control (keypads ignore those). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type);
  }
  return false;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable, visible descendants in DOM order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
  );
}
