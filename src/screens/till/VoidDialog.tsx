/**
 * Void a basket line (spec §5, §6.3; architecture §5.6; D-085): choose the line and the quantity
 * to remove (1..line qty, default the whole line), then 'Confirm void' ->
 * requirePermission('voidLine') (staff get the supervisor/manager PIN override) ->
 * basketStore.voidLine, which changes the basket only after the void audit event commits.
 */
import { useId, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { requirePermission } from '../../app';
import { Banner, Button, Modal } from '../../components';
import { formatPence } from '../../rules/money';
import { can } from '../../rules/permissions';
import { toast, useBasketStore, useSession } from '../../store';
import { ChoiceGroup } from './ChoiceGroup';
import { MinusIcon, PlusIcon } from './icons';
import { tillErrorMessage } from './tillErrors';
import styles from './TillDialogs.module.css';

export const VOID_DIALOG_TITLE = 'Void item';

export interface VoidDialogProps {
  open: boolean;
  onClose: () => void;
  /** The line to preselect (the selected basket line); default the last line added. */
  initialProductId: string | null;
}

export function VoidDialog({ open, onClose, initialProductId }: VoidDialogProps) {
  if (!open) return null;
  return <VoidDialogBody onClose={onClose} initialProductId={initialProductId} />;
}

function VoidDialogBody({ onClose, initialProductId }: Omit<VoidDialogProps, 'open'>) {
  const lines = useBasketStore((s) => s.view?.priced.lines);
  const session = useSession();
  const stepperId = useId();
  const [productId, setProductId] = useState<string | null>(() => {
    const basketLines = useBasketStore.getState().basket.lines;
    if (initialProductId !== null && basketLines.some((l) => l.productId === initialProductId)) return initialProductId;
    return basketLines[basketLines.length - 1]?.productId ?? null;
  });
  const [qtyByLine, setQtyByLine] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const line = lines?.find((l) => l.productId === productId);
  const qty = line === undefined ? 0 : Math.min(qtyByLine[line.productId] ?? line.qty, line.qty);
  const needsOverride = session !== null && !can(session.role, 'voidLine');

  const setQty = (next: number): void => {
    if (line === undefined) return;
    setQtyByLine((current) => ({ ...current, [line.productId]: Math.max(1, Math.min(line.qty, next)) }));
  };

  const fewerRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  /**
   * One step. When the pressed stepper reaches its limit it becomes disabled; if it had focus,
   * focus moves to the other stepper instead of falling out of the dialog (D-134).
   */
  const step = (delta: -1 | 1, event: MouseEvent<HTMLButtonElement>): void => {
    const pressed = event.currentTarget;
    const hadFocus = document.activeElement === pressed;
    flushSync(() => setQty(qty + delta));
    if (hadFocus && pressed.disabled) (delta < 0 ? moreRef : fewerRef).current?.focus();
  };

  const confirm = async (): Promise<void> => {
    if (line === undefined || qty < 1) return;
    setError(null);
    const auth = await requirePermission('voidLine');
    if (auth === null) return;
    setBusy(true);
    try {
      await useBasketStore.getState().voidLine(auth, line.productId, qty);
      toast(`Voided ${qty} × ${line.name}`, { tone: 'success' });
      onClose();
    } catch (caught) {
      setError(tillErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={VOID_DIALOG_TITLE}
      description={
        needsOverride
          ? 'Choose the item and how many to remove. A supervisor or manager PIN is needed to void.'
          : 'Choose the item and how many to remove from the basket.'
      }
      size="md"
      dismissible={!busy}
      testId="void-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} busy={busy} disabled={line === undefined}>
            Confirm void
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        {lines === undefined || lines.length === 0 ? (
          <p className={styles.muted}>The basket has no items to void.</p>
        ) : (
          <ChoiceGroup
            legend="Item"
            name={`${stepperId}-line`}
            variant="list"
            value={productId}
            onChange={(value) => {
              setProductId(value);
              setError(null);
            }}
            options={lines.map((l) => ({
              value: l.productId,
              label: `${l.qty} × ${l.name}`,
              detail: formatPence(l.grossPence),
            }))}
            disabled={busy}
          />
        )}

        {line !== undefined && (
          <div className={styles.qtyRow} role="group" aria-labelledby={`${stepperId}-label`}>
            <span id={`${stepperId}-label`} className={styles.qtyLabel}>
              Quantity to void
            </span>
            <div className={styles.stepper}>
              <button ref={fewerRef} type="button" className={styles.stepperButton} onClick={(event) => step(-1, event)} disabled={busy || qty <= 1} aria-label="Void fewer">
                <MinusIcon />
              </button>
              <output className={styles.stepperValue} aria-live="polite" data-testid="void-qty">
                {qty}
              </output>
              <button ref={moreRef} type="button" className={styles.stepperButton} onClick={(event) => step(1, event)} disabled={busy || qty >= line.qty} aria-label="Void more">
                <PlusIcon />
              </button>
            </div>
            <span className={styles.qtyOf}>
              of {line.qty} at {formatPence(line.unitPricePence)} each
            </span>
          </div>
        )}

        {error !== null && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  );
}
