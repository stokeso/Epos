/**
 * Trading period (spec §6.3, §6.11; architecture §5.7, §5.8; D-040..D-047, D-061, D-066..D-068).
 *
 * - No open period: the shared NoPeriodPrompt (Open period -> float -> manager, D-067).
 * - Open period: when it opened, by whom, and the float; then
 *   - X read (supervisor+): requirePermission('xRead') -> runXRead -> the 'X read' document opens.
 *     The period stays open and nothing is written (except an override event, D-046).
 *   - Z close (manager): requirePermission('openClosePeriod') -> prepareZClose (empty basket; open
 *     tabs warned about) -> the ZCloseWizard (counted cash, variance, Confirm Z close).
 *     Refused while a Pay session has tenders, of either kind (D-130): a deposit payment leaves
 *     the basket empty, but its cash is already in the drawer and it could no longer be saved.
 * No figures are shown here: they appear only on the X/Z documents, which need permission (D-070).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { errorCode, errorMessage, NoPeriodPrompt, openDocument, requirePermission, useLoad } from '../../app';
import { Banner, Button, ButtonLink, MoneyText, Screen } from '../../components';
import { formatPence } from '../../rules/money';
import { formatDateTime } from '../../rules/time';
import { prepareZClose, runXRead, type ZCloseResult } from '../../services/periods';
import { listStaff } from '../../services/staff';
import { getCtx, toast, useAppStore, useBasketStore, usePayStore } from '../../store';
import { PAYMENT_IN_PROGRESS_Z_MESSAGE, paymentInProgress, varianceKind } from './periodText';
import { ZCloseWizard, type ZCloseStart } from './ZCloseWizard';
import styles from './PeriodScreen.module.css';

interface ScreenError {
  message: string;
  /** The way out offered with it: the till (the basket must be empty) or Pay (finish the payment). */
  action?: 'till' | 'pay';
}

function varianceSentence(variancePence: number): string {
  const kind = varianceKind(variancePence);
  if (kind === 'balanced') return 'the drawer balanced';
  return `${formatPence(Math.abs(variancePence))} ${kind}`;
}

export function PeriodScreen() {
  const period = useAppStore((s) => s.openPeriod);
  const paying = usePayStore((s) => paymentInProgress(s.session));
  const staff = useLoad(listStaff, []);
  const [xBusy, setXBusy] = useState(false);
  const [zStarting, setZStarting] = useState(false);
  const [wizard, setWizard] = useState<ZCloseStart | null>(null);
  const [error, setError] = useState<ScreenError | null>(null);
  const [lastZ, setLastZ] = useState<ZCloseResult | null>(null);
  const statusHeadingId = useId();
  const xHeadingId = useId();
  const zHeadingId = useId();

  const closedRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // The buttons sit below the messages (far below on a phone): bring each new message into view.
  // After a Z close its buttons are gone, so focus moves to the result.
  useEffect(() => {
    if (lastZ === null) return;
    closedRef.current?.focus({ preventScroll: true });
    closedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [lastZ]);
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const openedBy = period === null ? undefined : staff.data?.find((s) => s.id === period.openedBy)?.name;

  const fail = (caught: unknown): void => {
    const code = errorCode(caught);
    if (code === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
    setError({ message: errorMessage(caught), ...(code === 'BASKET_NOT_EMPTY' ? { action: 'till' as const } : {}) });
  };

  const xRead = async (): Promise<void> => {
    if (xBusy) return;
    setError(null);
    const auth = await requirePermission('xRead');
    if (auth === null) return;
    setXBusy(true);
    try {
      const result = await runXRead(getCtx(), auth);
      openDocument(result.document);
      toast('X read printed. The period stays open.', { tone: 'success' });
    } catch (caught) {
      fail(caught);
    } finally {
      setXBusy(false);
    }
  };

  const startZClose = async (): Promise<void> => {
    if (zStarting) return;
    setError(null);
    setLastZ(null);
    if (paymentInProgress(usePayStore.getState().session)) {
      setError({ message: PAYMENT_IN_PROGRESS_Z_MESSAGE, action: 'pay' });
      return;
    }
    const auth = await requirePermission('openClosePeriod');
    if (auth === null) return;
    setZStarting(true);
    try {
      const check = await prepareZClose(getCtx(), useBasketStore.getState().basket);
      setWizard({ auth, openTabCount: check.openTabCount });
    } catch (caught) {
      fail(caught);
    } finally {
      setZStarting(false);
    }
  };

  const closed = (result: ZCloseResult): void => {
    setWizard(null);
    setLastZ(result);
    toast(`Period closed · Z report ${result.period.zNumber ?? ''}`, { tone: 'success' });
  };

  return (
    <Screen title="Period" description="Open a trading period with a float, take X reads during the day and close it with a Z report.">
      {lastZ !== null && (
        <div ref={closedRef} tabIndex={-1} className={styles.message}>
          <Banner tone="success" title={`Z report ${lastZ.period.zNumber ?? ''} printed.`} role="status" onDismiss={() => setLastZ(null)} testId="z-closed">
            Expected {formatPence(lastZ.figures.expectedCashPence)}, declared {formatPence(lastZ.figures.declaredCashPence)}:{' '}
            {varianceSentence(lastZ.figures.variancePence)}. Selling is disabled until a new period is opened.
          </Banner>
        </div>
      )}

      {error !== null && (
        <div ref={errorRef} className={styles.message}>
          <Banner
            tone="danger"
            onDismiss={() => setError(null)}
            testId="period-error"
            action={
              error.action === 'till' ? (
                <ButtonLink to="/till" size="sm">
                  Go to till
                </ButtonLink>
              ) : error.action === 'pay' ? (
                <ButtonLink to="/pay" size="sm">
                  Back to Pay
                </ButtonLink>
              ) : undefined
            }
          >
            {error.message}
          </Banner>
        </div>
      )}

      {period === null ? (
        <NoPeriodPrompt className={styles.noPeriod} />
      ) : (
        <>
          <section className={styles.status} aria-labelledby={statusHeadingId} data-testid="period-summary">
            <div className={styles.statusHead}>
              <span className={styles.statusDot} aria-hidden="true" />
              <h2 id={statusHeadingId} className={styles.statusTitle}>
                Period open
              </h2>
            </div>
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>Opened</dt>
                <dd className="tabular">{formatDateTime(period.openedAt)}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Opened by</dt>
                <dd>{openedBy ?? '…'}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Float</dt>
                <dd>
                  <MoneyText pence={period.floatPence} size="lg" strong testId="period-float" />
                </dd>
              </div>
            </dl>
          </section>

          <div className={styles.actions}>
            <article className={styles.actionCard} aria-labelledby={xHeadingId}>
              <div className={styles.actionHead}>
                <span className={styles.actionBadge} aria-hidden="true">
                  X
                </span>
                <div>
                  <h2 id={xHeadingId} className={styles.actionTitle}>
                    X read
                  </h2>
                  <p className={styles.actionWho}>Supervisor or manager</p>
                </div>
              </div>
              <p className={styles.actionText}>Takings, cash and card totals, VAT and expected cash for this period so far. It doesn&apos;t close the period.</p>
              <Button size="lg" block onClick={() => void xRead()} busy={xBusy} disabled={zStarting}>
                X read
              </Button>
            </article>

            <article className={styles.actionCard} aria-labelledby={zHeadingId}>
              <div className={styles.actionHead}>
                <span className={`${styles.actionBadge} ${styles.actionBadgeZ}`} aria-hidden="true">
                  Z
                </span>
                <div>
                  <h2 id={zHeadingId} className={styles.actionTitle}>
                    Z close
                  </h2>
                  <p className={styles.actionWho}>Manager</p>
                </div>
              </div>
              <p className={styles.actionText}>End of the day: count the drawer, check the variance and close the period. Open tabs carry over.</p>
              {paying && (
                <Banner tone="warning" role="none" testId="z-payment-in-progress" action={<ButtonLink to="/pay" size="sm">Back to Pay</ButtonLink>}>
                  {PAYMENT_IN_PROGRESS_Z_MESSAGE}
                </Banner>
              )}
              <Button variant="primary" size="lg" block onClick={() => void startZClose()} busy={zStarting} disabled={xBusy || paying}>
                Z close
              </Button>
            </article>
          </div>
        </>
      )}

      <ZCloseWizard start={wizard} onCancel={() => setWizard(null)} onClosed={closed} />
    </Screen>
  );
}
