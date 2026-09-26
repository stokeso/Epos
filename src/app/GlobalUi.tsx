/**
 * App-wide overlays, mounted once by the root layout: toasts, the PIN override dialog, the
 * app-wide confirm dialog and the receipt fallback panel (D-109). The panel is hidden while the
 * till is locked and comes back after the next login: it may hold the only copy of a receipt,
 * X read or Z report (D-135).
 */
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ReceiptFallbackPanel } from '../components/ReceiptFallbackPanel';
import { Toaster } from '../components/Toast';
import { useSession } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { reprintFallback } from './openDocument';
import { OverrideDialog } from './OverrideDialog';

export function GlobalUi() {
  const toasts = useUiStore((s) => s.toasts);
  const confirmRequest = useUiStore((s) => s.confirmRequest);
  const receiptFallback = useUiStore((s) => s.receiptFallback);
  const signedIn = useSession() !== null;
  return (
    <>
      <Toaster toasts={toasts} />
      {confirmRequest !== null && (
        <ConfirmDialog
          key={confirmRequest.id}
          open
          title={confirmRequest.options.title}
          message={confirmRequest.options.message}
          confirmLabel={confirmRequest.options.confirmLabel}
          cancelLabel={confirmRequest.options.cancelLabel}
          tone={confirmRequest.options.tone}
          onConfirm={() => useUiStore.getState().settleConfirm(true)}
          onCancel={() => useUiStore.getState().settleConfirm(false)}
        />
      )}
      <ReceiptFallbackPanel
        fallback={signedIn ? receiptFallback : null}
        onReprint={() => {
          reprintFallback();
        }}
        onClose={() => useUiStore.getState().closeReceiptFallback()}
      />
      <OverrideDialog />
    </>
  );
}
