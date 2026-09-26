/**
 * Take deposit (spec §6.7; D-024, D-027; architecture §5.2): enter the amount on the money keypad,
 * then Pay opens a deposit Pay session (payStore.openDeposit -> services/pay.openDepositPayment)
 * and the customer pays by cash or card on #/pay. The till basket is untouched.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorCode, errorMessage } from '../../app';
import { Banner, Button, Modal, NumericKeypad } from '../../components';
import type { Booking } from '../../data/types';
import { MAX_KEYPAD_PENCE } from '../../rules/money';
import { useAppStore, usePayStore } from '../../store';
import styles from './bookings.module.css';

export interface DepositDialogProps {
  booking: Booking;
  onClose: () => void;
}

export function DepositDialog({ booking, onClose }: DepositDialogProps) {
  const navigate = useNavigate();
  const [amountPence, setAmountPence] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const proceed = async (): Promise<void> => {
    if (busy || amountPence < 1 || amountPence > MAX_KEYPAD_PENCE) return;
    const pay = usePayStore.getState();
    // A payment with tenders taken can only be completed or cancelled (D-033): never replace it.
    if (pay.session !== null && pay.session.tender.tenders.length > 0) {
      setError('A payment is already in progress. Finish or cancel it on the Pay screen first.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await pay.openDeposit(booking.id, amountPence);
      navigate('/pay');
    } catch (caught) {
      if (errorCode(caught) === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Take deposit"
      description={
        <>
          For <strong>{booking.name}</strong>. Enter the amount, then take cash or card on the Pay screen.
        </>
      }
      size="sm"
      dismissible={!busy}
      testId="deposit-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} className={styles.footerNarrow}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void proceed()}
            busy={busy}
            disabled={amountPence < 1 || amountPence > MAX_KEYPAD_PENCE}
            className={styles.footerWide}
          >
            Continue to Pay
          </Button>
        </>
      }
    >
      <div className={styles.depositBody}>
        <NumericKeypad
          label="Deposit amount"
          valuePence={amountPence}
          onChange={(pence) => {
            setAmountPence(pence);
            setError(null);
          }}
          captureKeyboard
          onEnter={() => void proceed()}
          disabled={busy}
          displayTestId="deposit-amount"
        />
        {error !== null && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  );
}
