/**
 * Open a trading period (spec §6.3; D-067): money keypad for the float (0..£99,999.99), then
 * 'Open period' -> requirePermission('openClosePeriod') (managers direct, others get the
 * 'Manager PIN' override) -> services/periods.openPeriod -> refresh the cached period.
 * Shared by the Till (NoPeriodPrompt) and the Period screen.
 */
import { useRef, useState } from 'react';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { NumericKeypad } from '../components/NumericKeypad';
import { isAppError } from '../data/errors';
import type { Period } from '../data/types';
import { formatPence } from '../rules/money';
import { openPeriod } from '../services/periods';
import { getCtx, useAppStore } from '../store/appStore';
import { toast } from '../store/uiStore';
import { requirePermission } from './requirePermission';

export interface OpenPeriodDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after the period is open and the app's cached period is refreshed. */
  onOpened?: (period: Period) => void;
}

export function OpenPeriodDialog({ open, onClose, onOpened }: OpenPeriodDialogProps) {
  if (!open) return null;
  return <OpenPeriodBody onClose={onClose} onOpened={onOpened} />;
}

function OpenPeriodBody({ onClose, onOpened }: Omit<OpenPeriodDialogProps, 'open'>) {
  const [floatPence, setFloatPence] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Stops a second Open period (a double tap, or Enter twice) before `busy` renders. */
  const running = useRef(false);

  const confirm = async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setError(null);
    const auth = await requirePermission('openClosePeriod');
    if (auth === null) {
      running.current = false;
      return;
    }
    setBusy(true);
    try {
      const period = await openPeriod(getCtx(), auth, floatPence);
      await useAppStore.getState().refreshPeriod();
      toast(`Period opened with a float of ${formatPence(period.floatPence)}`, { tone: 'success' });
      onOpened?.(period);
      onClose();
    } catch (caught) {
      if (isAppError(caught, 'PERIOD_ALREADY_OPEN')) await useAppStore.getState().refreshPeriod();
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Open period"
      description="Count the float into the drawer, then enter it here."
      size="sm"
      dismissible={!busy}
      testId="open-period-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void confirm()} busy={busy}>
            Open period
          </Button>
        </>
      }
    >
      <NumericKeypad
        label="Float"
        valuePence={floatPence}
        onChange={setFloatPence}
        captureKeyboard
        onEnter={() => void confirm()}
        disabled={busy}
        displayTestId="float-amount"
      />
      {error !== null && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      )}
    </Modal>
  );
}
