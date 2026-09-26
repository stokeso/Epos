/**
 * The PIN override dialog (spec §5; D-071, D-076). Rendered once by the root layout; opened by
 * requirePermission() through the ui store. A PIN of sufficient level approves that ONE action.
 */
import { useState } from 'react';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { PinKeypad } from '../components/PinKeypad';
import { ACTION_LABELS, overridePrompt } from '../rules/permissions';
import { approveOverride } from '../services/override';
import { getCtx } from '../store/appStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore, type OverrideRequest } from '../store/uiStore';
import { nowMs } from './clock';
import { lockoutMessage, useLockoutAnnouncement, useLockoutRemaining } from './useLockout';

export const OVERRIDE_REJECTED_MESSAGE = 'PIN not accepted';

export function OverrideDialog() {
  const request = useUiStore((s) => s.overrideRequest);
  if (request === null) return null;
  return <OverrideDialogBody key={request.id} request={request} />;
}

function OverrideDialogBody({ request }: { request: OverrideRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = useLockoutRemaining();
  const lockoutAnnouncement = useLockoutAnnouncement(remaining);
  const cancel = (): void => useUiStore.getState().settleOverride(null);

  const submit = async (pin: string): Promise<void> => {
    const session = useSessionStore.getState().session;
    if (session === null) {
      cancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const auth = await approveOverride(getCtx(), session, request.action, pin);
      if (useUiStore.getState().overrideRequest?.id !== request.id) return;
      if (auth === null) {
        useSessionStore.getState().pinFailed(nowMs());
        setError(OVERRIDE_REJECTED_MESSAGE);
        return;
      }
      useSessionStore.getState().pinSucceeded();
      useUiStore.getState().settleOverride(auth);
    } catch {
      setError(OVERRIDE_REJECTED_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  const locked = remaining > 0;
  return (
    <Modal
      open
      onClose={cancel}
      title={overridePrompt(request.action)}
      description={
        <>
          Approve: <strong>{ACTION_LABELS[request.action]}</strong>. The approval covers this one action only.
        </>
      }
      size="sm"
      testId="override-dialog"
      footer={
        <Button variant="secondary" onClick={cancel}>
          Cancel
        </Button>
      }
    >
      <PinKeypad
        label="Approver's PIN"
        onSubmit={(pin) => void submit(pin)}
        busy={busy}
        disabled={locked}
        error={locked ? null : error}
        status={locked ? lockoutMessage(remaining) : null}
        announcement={lockoutAnnouncement}
      />
    </Modal>
  );
}
