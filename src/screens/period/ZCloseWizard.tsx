/**
 * The Z close wizard (spec §6.11; architecture §5.8; D-047, D-061, D-066).
 *
 * The screen asks requirePermission('openClosePeriod') and runs prepareZClose before opening it;
 * the wizard holds that Authorisation and hands it to confirmZClose, its ONE service call.
 * 1. Open tabs (only when there are any): "N tabs are open and will carry over…" Continue / Cancel.
 * 2. Counted cash on the money keypad. The expected cash is not shown before this step.
 * 3. previewZClose: expected, declared and variance, then Confirm Z close / Back.
 * 4. confirmZClose closes the period, assigns the Z number and returns the Z report, which opens
 *    straight away (openDocument) before the cached period is refreshed.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { errorCode, errorMessage, openDocument, requirePermission } from '../../app';
import { Banner, Button, Modal, MoneyText, NumericKeypad } from '../../components';
import type { Authorisation } from '../../services/override';
import { confirmZClose, previewZClose, type ZClosePreview, type ZCloseResult } from '../../services/periods';
import { dropUntenderedPayment, getCtx, useAppStore, useBasketStore, usePayStore } from '../../store';
import { openTabsWarning, PAYMENT_IN_PROGRESS_Z_MESSAGE, paymentInProgress, VARIANCE_LABELS, varianceKind } from './periodText';
import styles from './PeriodScreen.module.css';

export interface ZCloseStart {
  /** From requirePermission('openClosePeriod') when the wizard started (D-047). */
  auth: Authorisation;
  /** From prepareZClose: open tabs that carry over. */
  openTabCount: number;
}

export interface ZCloseWizardProps {
  start: ZCloseStart | null;
  onCancel: () => void;
  /** After the close has committed and its report has been opened. */
  onClosed: (result: ZCloseResult) => void;
}

type Step = 'tabs' | 'count' | 'confirm';

export const Z_CLOSE_TITLE = 'Z close';

/**
 * Confirm Z close sits where Continue was, so it stays disabled briefly after the figures appear:
 * a double tap on Continue can't close the period by accident.
 */
const CONFIRM_ARM_MS = 400;

export function ZCloseWizard({ start, onCancel, onClosed }: ZCloseWizardProps) {
  if (start === null) return null;
  return <WizardBody start={start} onCancel={onCancel} onClosed={onClosed} />;
}

function WizardBody({ start, onCancel, onClosed }: { start: ZCloseStart; onCancel: () => void; onClosed: (result: ZCloseResult) => void }) {
  const hasTabsStep = start.openTabCount > 0;
  const [step, setStep] = useState<Step>(hasTabsStep ? 'tabs' : 'count');
  const [declaredPence, setDeclaredPence] = useState(0);
  const [preview, setPreview] = useState<ZClosePreview | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Single use (D-071): consumed by the first confirm; a retry after a failure asks again.
  const heldAuth = useRef<Authorisation | null>(start.auth);
  const confirming = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusedStep = useRef<Step>(step);

  // Move focus into each new step (the Modal focuses the first one): its [data-autofocus] element
  // (the counted-cash keypad, D-134), else the step itself.
  useEffect(() => {
    if (focusedStep.current === step) return;
    focusedStep.current = step;
    const body = bodyRef.current;
    (body?.querySelector<HTMLElement>('[data-autofocus]') ?? body)?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    if (step !== 'confirm') return undefined;
    const timer = window.setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [step]);

  const goTo = (next: Step): void => {
    setError(null);
    setArmed(false);
    setStep(next);
  };

  const steps: { key: Step; label: string }[] = [
    ...(hasTabsStep ? [{ key: 'tabs' as const, label: 'Open tabs' }] : []),
    { key: 'count', label: 'Count cash' },
    { key: 'confirm', label: 'Check and close' },
  ];
  const stepIndex = steps.findIndex((s) => s.key === step);

  const showVariance = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      setPreview(await previewZClose(getCtx(), declaredPence));
      goTo('confirm');
    } catch (caught) {
      setError(errorMessage(caught));
      if (errorCode(caught) === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    // The ref also stops a fast double tap that lands before the re-render disables the button.
    if (confirming.current || !armed) return;
    // Checked again here: the tenders of a payment taken meanwhile would miss this Z (D-130).
    if (paymentInProgress(usePayStore.getState().session)) {
      setError(PAYMENT_IN_PROGRESS_Z_MESSAGE);
      return;
    }
    confirming.current = true;
    setError(null);
    const auth = heldAuth.current ?? (await requirePermission('openClosePeriod'));
    heldAuth.current = null;
    if (auth === null) {
      confirming.current = false;
      return;
    }
    setBusy(true);
    try {
      const result = await confirmZClose(getCtx(), auth, useBasketStore.getState().basket, declaredPence);
      openDocument(result.document);
      // A Pay session with no tenders (a deposit started and left) can't be saved now: drop it, or
      // the next login would open Pay with no period (D-134).
      dropUntenderedPayment();
      await useAppStore.getState().refreshPeriod();
      onClosed(result);
    } catch (caught) {
      setError(errorMessage(caught));
      if (errorCode(caught) === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
      confirming.current = false;
      setBusy(false);
    }
  };

  let body;
  let footer;
  if (step === 'tabs') {
    body = (
      <Banner tone="warning" role="none" title={`${openTabsWarning(start.openTabCount)}.`} testId="z-open-tabs">
        They stay open and count in the period in which they are settled.
      </Banner>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => goTo('count')} data-autofocus>
          Continue
        </Button>
      </>
    );
  } else if (step === 'count') {
    body = (
      <>
        <p className={styles.wizardText}>Count all the cash in the drawer, including the float, and enter the total.</p>
        <NumericKeypad
          label="Counted cash"
          valuePence={declaredPence}
          onChange={setDeclaredPence}
          captureKeyboard
          onEnter={() => void showVariance()}
          disabled={busy}
          displayTestId="counted-cash"
        />
      </>
    );
    footer = (
      <>
        {hasTabsStep ? (
          <Button variant="secondary" onClick={() => goTo('tabs')} disabled={busy}>
            Back
          </Button>
        ) : (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button variant="primary" onClick={() => void showVariance()} busy={busy}>
          Continue
        </Button>
      </>
    );
  } else {
    const kind = preview === null ? 'balanced' : varianceKind(preview.variancePence);
    body = (
      <>
        {preview !== null && (
          <dl className={styles.cashUp} data-testid="z-preview">
            <div className={styles.cashUpRow}>
              <dt>Expected cash</dt>
              <dd>
                <MoneyText pence={preview.expectedCashPence} size="lg" testId="z-expected" />
              </dd>
            </div>
            <div className={styles.cashUpRow}>
              <dt>Declared cash</dt>
              <dd>
                <MoneyText pence={preview.declaredCashPence} size="lg" testId="z-declared" />
              </dd>
            </div>
            <div className={`${styles.cashUpRow} ${styles.varianceRow} ${styles[kind] ?? ''}`}>
              <dt>
                Variance
                <span className={styles.varianceTag} data-testid="z-variance-kind">
                  {VARIANCE_LABELS[kind]}
                </span>
              </dt>
              <dd>
                <MoneyText pence={preview.variancePence} size="xl" strong testId="z-variance" />
              </dd>
            </div>
          </dl>
        )}
        <p className={styles.wizardText}>Confirming closes this period, gives it the next Z number and prints the Z report. It can&apos;t be undone.</p>
      </>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={() => goTo('count')} disabled={busy}>
          Back
        </Button>
        <Button variant="primary" onClick={() => void confirm()} busy={busy} disabled={!armed} className={styles.confirmButton}>
          Confirm Z close
        </Button>
      </>
    );
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={Z_CLOSE_TITLE}
      description={`Step ${stepIndex + 1} of ${steps.length}: ${steps[stepIndex]?.label ?? ''}`}
      size="sm"
      dismissible={!busy}
      testId="z-close-dialog"
      footer={<Fragment key={step}>{footer}</Fragment>}
    >
      <ol className={styles.steps} aria-label="Z close steps">
        {steps.map((s, index) => (
          <li
            key={s.key}
            className={`${styles.stepItem} ${index < stepIndex ? styles.stepDone : ''} ${index === stepIndex ? styles.stepCurrent : ''}`}
            aria-current={index === stepIndex ? 'step' : undefined}
          >
            <span className={styles.stepNumber} aria-hidden="true">
              {index < stepIndex ? '✓' : index + 1}
            </span>
            <span className={styles.stepLabel}>{s.label}</span>
          </li>
        ))}
      </ol>
      <div ref={bodyRef} className={styles.wizardStack} tabIndex={-1} key={step} data-testid={`z-step-${step}`}>
        {body}
      </div>
      {error !== null && (
        <div className={styles.wizardError}>
          <Banner tone="danger" testId="z-close-error">
            {error}
          </Banner>
        </div>
      )}
    </Modal>
  );
}
