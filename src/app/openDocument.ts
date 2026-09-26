/**
 * Simulated printing (spec §6.10; D-109): open a receipt / X / Z document in a new tab.
 *
 * Call it straight after the service resolves, inside the click handler's async chain, so the
 * browser still counts the tap as a user gesture:
 *
 *   const done = await usePayStore.getState().complete(auth);
 *   if (done !== null) openDocument(done.document);
 *
 * The HTML becomes a Blob URL opened with window.open(url, '_blank'); the new tab's opener is
 * cleared and the URL is revoked after 60 s. If the browser blocks the tab (window.open returns
 * null), the same HTML is shown in the on-screen ReceiptFallbackPanel with Reprint and Close.
 */
import { useUiStore } from '../store/uiStore';

export const DOCUMENT_URL_LIFETIME_MS = 60_000;

/** The document's <title> text (e.g. 'Receipt 3F9C-000042'), or 'Receipt'. */
export function documentTitle(html: string): string {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const raw = match?.[1]?.trim();
  if (raw === undefined || raw === '') return 'Receipt';
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

function openWindow(url: string): Window | null {
  try {
    return window.open(url, '_blank');
  } catch {
    return null;
  }
}

/** Tries to open the document in a new tab. true when the tab opened. */
export function tryOpenDocument(html: string): boolean {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win = openWindow(url);
  if (win === null) {
    URL.revokeObjectURL(url);
    return false;
  }
  try {
    win.opener = null;
  } catch {
    // Some browsers make opener read-only; the Blob document has no scripts anyway (D-110).
  }
  setTimeout(() => URL.revokeObjectURL(url), DOCUMENT_URL_LIFETIME_MS);
  return true;
}

/**
 * Opens the document, or shows it in the fallback panel when the tab is blocked (D-109).
 * Returns true when the tab opened.
 */
export function openDocument(html: string): boolean {
  if (tryOpenDocument(html)) return true;
  useUiStore.getState().showReceiptFallback({ html, title: documentTitle(html) });
  return false;
}

/** The panel's Reprint: try the tab again and close the panel if it opens. */
export function reprintFallback(): boolean {
  const ui = useUiStore.getState();
  const fallback = ui.receiptFallback;
  if (fallback === null) return false;
  const opened = tryOpenDocument(fallback.html);
  if (opened) ui.closeReceiptFallback();
  return opened;
}
