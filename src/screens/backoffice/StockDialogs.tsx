/**
 * Stock dialogs (spec §6.9; D-080, D-081, D-082): goods in, adjustment / waste, and one product's
 * movement history. Writes need 'stockControl'. Quantities are checked with the rules'
 * validateGoodsIn / validateStockAdjustment before permission is asked for.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { DataTable } from '../../components/DataTable';
import { SelectField, TextField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useLoad } from '../../app/useLoad';
import type { StockMovement, StockReason } from '../../data/types';
import { formatDateTime } from '../../rules/time';
import { MAX_STOCK_QTY, validateGoodsIn, validateStockAdjustment } from '../../rules/validation';
import type { ServiceContext } from '../../services/context';
import { listStaff } from '../../services/staff';
import { recordGoodsIn, recordStockAdjustment, stockHistory, type listStockLevels } from '../../services/stock';
import { getCtx } from '../../store/appStore';
import { digitsOnly, parseWholeNumber, useFocusFirstError, useGatedForm } from './formHelpers';
import { AffixField, Badge, ChoiceGroup, FormError } from './parts';
import styles from './backoffice.module.css';
import stockStyles from './StockScreen.module.css';

/** One row of services/stock.listStockLevels: a tracked product and its on-hand count. */
export type StockLevel = Awaited<ReturnType<typeof listStockLevels>>[number];

const REASON_LABELS: Record<StockReason, string> = {
  sale: 'Sale',
  refund: 'Refund',
  goodsIn: 'Goods in',
  adjustment: 'Adjustment',
  waste: 'Waste',
};

/** '+20' / '-2' / '0'. */
function signed(qty: number): string {
  return qty > 0 ? `+${qty}` : String(qty);
}

function productOptions(levels: readonly StockLevel[]) {
  return levels.map((level) => ({ value: level.product.id, label: level.product.active ? level.product.name : `${level.product.name} (inactive)` }));
}

/** On hand now -> after the change (display only; the list reloads from the service). */
function OnHandPreview({ level, change }: { level: StockLevel | undefined; change: number | null }) {
  if (level === undefined) return null;
  const after = change === null ? null : level.onHand + change;
  return (
    <div className={stockStyles.preview} aria-live="polite">
      <div className={stockStyles.previewItem}>
        <span className={stockStyles.previewLabel}>On hand now</span>
        <span className={`${stockStyles.previewValue} tabular ${level.onHand < 0 ? styles.negative : ''}`}>{level.onHand}</span>
      </div>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" className={stockStyles.previewArrow}>
        <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className={stockStyles.previewItem}>
        <span className={stockStyles.previewLabel}>After</span>
        <span className={`${stockStyles.previewValue} tabular ${after !== null && after < 0 ? styles.negative : ''}`}>{after ?? '–'}</span>
      </div>
      <span className={stockStyles.previewUnit}>{level.product.stockUnit}</span>
    </div>
  );
}

export interface GoodsInDialogProps {
  levels: readonly StockLevel[];
  initialProductId: string;
  onClose: () => void;
  onSaved: (movement: StockMovement, productName: string) => void;
}

export function GoodsInDialog({ levels, initialProductId, onClose, onSaved }: GoodsInDialogProps) {
  const [productId, setProductId] = useState(initialProductId);
  const [qtyText, setQtyText] = useState('');
  const [note, setNote] = useState('');
  const form = useGatedForm(['productId', 'qty', 'note']);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);
  const level = levels.find((l) => l.product.id === productId);
  const qty = parseWholeNumber(qtyText);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input = { productId, qty, note };
    const check = validateGoodsIn(input);
    if (!check.ok) {
      form.showErrors(check.errors);
      return;
    }
    const movement = await form.run('stockControl', (auth) => recordGoodsIn(getCtx(), auth, input));
    if (movement !== null) onSaved(movement, level?.product.name ?? 'Product');
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Goods in"
      description="Stock delivered or brought in."
      dismissible={!form.busy}
      testId="goods-in-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={form.busy}>
            Cancel
          </Button>
          <Button type="submit" form="goods-in-form" variant="primary" busy={form.busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="goods-in-form" ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <FormError message={form.formError} />
        <SelectField
          label="Product"
          value={productId}
          onChange={setProductId}
          options={productOptions(levels)}
          placeholder="Choose a product"
          error={form.fieldErrors.productId}
          data-autofocus={initialProductId === '' ? true : undefined}
        />
        <AffixField
          label="Quantity"
          suffix={level?.product.stockUnit}
          value={qtyText}
          onChange={(v) => setQtyText(digitsOnly(v, 4))}
          hint={`1 to ${MAX_STOCK_QTY}`}
          maxLength={4}
          error={form.fieldErrors.qty}
          autoFocus={initialProductId !== ''}
        />
        <TextField label="Note" hint="Optional, e.g. a delivery note number" value={note} onChange={setNote} maxLength={100} error={form.fieldErrors.note} autoComplete="off" />
        <OnHandPreview level={level} change={Number.isSafeInteger(qty) && qty > 0 ? qty : null} />
      </form>
    </Modal>
  );
}

export interface AdjustDialogProps {
  levels: readonly StockLevel[];
  initialProductId: string;
  onClose: () => void;
  onSaved: (movement: StockMovement, productName: string) => void;
}

type Kind = 'adjustment' | 'waste';
type Direction = 'add' | 'remove';

export function AdjustStockDialog({ levels, initialProductId, onClose, onSaved }: AdjustDialogProps) {
  const [productId, setProductId] = useState(initialProductId);
  const [kind, setKind] = useState<Kind>('adjustment');
  const [direction, setDirection] = useState<Direction>('remove');
  const [qtyText, setQtyText] = useState('');
  const [note, setNote] = useState('');
  const form = useGatedForm(['productId', 'kind', 'qty', 'note']);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);
  const level = levels.find((l) => l.product.id === productId);
  const count = parseWholeNumber(qtyText);
  // Adjustments are stored signed as entered; waste is entered as a positive count (D-081).
  const qty = kind === 'adjustment' && direction === 'remove' ? -count : count;
  const change = Number.isSafeInteger(count) && count > 0 ? (kind === 'waste' ? -count : qty) : null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input = { productId, kind, qty, note };
    const check = validateStockAdjustment(input);
    if (!check.ok) {
      // The field takes a positive count (the direction is chosen above it), so say so in the
      // field's own terms rather than the rule's signed range.
      form.showErrors(check.errors.qty === undefined ? check.errors : { ...check.errors, qty: `Quantity must be 1 to ${MAX_STOCK_QTY}` });
      return;
    }
    const movement = await form.run('stockControl', (auth) => recordStockAdjustment(getCtx(), auth, input));
    if (movement !== null) onSaved(movement, level?.product.name ?? 'Product');
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Adjust stock"
      description="Correct a count, or record stock that was wasted."
      dismissible={!form.busy}
      testId="adjust-stock-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={form.busy}>
            Cancel
          </Button>
          <Button type="submit" form="adjust-stock-form" variant="primary" busy={form.busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="adjust-stock-form" ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <FormError message={form.formError} />
        <SelectField
          label="Product"
          value={productId}
          onChange={setProductId}
          options={productOptions(levels)}
          placeholder="Choose a product"
          error={form.fieldErrors.productId}
          data-autofocus={initialProductId === '' ? true : undefined}
        />
        <ChoiceGroup<Kind>
          legend="Type"
          name="adjust-kind"
          value={kind}
          onChange={setKind}
          error={form.fieldErrors.kind}
          options={[
            { value: 'adjustment', label: 'Adjustment', hint: 'Correct the count up or down' },
            { value: 'waste', label: 'Waste', hint: 'Spilt, broken or out of date' },
          ]}
        />
        {kind === 'adjustment' && (
          <ChoiceGroup<Direction>
            legend="Direction"
            name="adjust-direction"
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'add', label: 'Add to stock (+)' },
              { value: 'remove', label: 'Take off stock (−)' },
            ]}
          />
        )}
        <AffixField
          label="Quantity"
          prefix={kind === 'waste' || direction === 'remove' ? '−' : '+'}
          suffix={level?.product.stockUnit}
          value={qtyText}
          onChange={(v) => setQtyText(digitsOnly(v, 4))}
          hint={`1 to ${MAX_STOCK_QTY}`}
          maxLength={4}
          error={form.fieldErrors.qty}
          autoFocus={initialProductId !== ''}
        />
        <TextField
          label="Reason"
          hint={kind === 'waste' ? 'e.g. Spilt, Out of date' : 'e.g. Stock count'}
          value={note}
          onChange={setNote}
          maxLength={100}
          error={form.fieldErrors.note}
          autoComplete="off"
        />
        <OnHandPreview level={level} change={change} />
      </form>
    </Modal>
  );
}

interface HistoryData {
  movements: StockMovement[];
  staffNames: Record<string, string>;
}

async function loadHistory(ctx: ServiceContext, productId: string): Promise<HistoryData> {
  const [movements, staff] = await Promise.all([stockHistory(ctx, productId), listStaff(ctx)]);
  return { movements, staffNames: Object.fromEntries(staff.map((s) => [s.id, s.name])) };
}

export interface HistoryDialogProps {
  level: StockLevel;
  lowStock: boolean;
  onClose: () => void;
  onGoodsIn: () => void;
  onAdjust: () => void;
}

export function StockHistoryDialog({ level, lowStock, onClose, onGoodsIn, onAdjust }: HistoryDialogProps) {
  const productId = level.product.id;
  const history = useLoad((ctx) => loadHistory(ctx, productId), [productId]);
  return (
    <Modal
      open
      onClose={onClose}
      title="Stock history"
      description={level.product.name}
      size="lg"
      testId="stock-history-dialog"
      footer={
        <>
          <Button onClick={onAdjust}>Adjust stock</Button>
          <Button onClick={onGoodsIn}>Goods in</Button>
          <Button variant="primary" onClick={onClose} className={styles.footerFull}>
            Done
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={stockStyles.historySummary}>
          <div>
            <span className={stockStyles.previewLabel}>On hand</span>
            <span className={`${stockStyles.historyOnHand} tabular ${level.onHand < 0 ? styles.negative : ''}`}>{level.onHand}</span>
            <span className={styles.muted}> {level.product.stockUnit}</span>
          </div>
          <div>
            <span className={stockStyles.previewLabel}>Low at</span>
            <span className={`${stockStyles.historyLow} tabular`}>{level.product.lowStockLevel}</span>
          </div>
          {lowStock && <Badge tone={level.onHand < 0 ? 'danger' : 'warning'}>{level.onHand < 0 ? 'Negative' : 'Low'}</Badge>}
        </div>
        {history.error !== null && <Banner tone="danger">{history.error}</Banner>}
        {history.data === undefined && history.error === null && <p className={styles.muted}>Loading history…</p>}
        {history.data !== undefined && (
          <DataTable
            caption="Movements, newest first"
            columns={[
              { key: 'when', header: 'When', render: (m: StockMovement) => <span className="tabular">{formatDateTime(m.createdAt)}</span> },
              { key: 'reason', header: 'Reason', render: (m: StockMovement) => REASON_LABELS[m.reason] },
              { key: 'qty', header: 'Change', numeric: true, render: (m: StockMovement) => <span className={m.qty < 0 ? styles.negative : ''}>{signed(m.qty)}</span> },
              { key: 'note', header: 'Note', render: (m: StockMovement) => m.note },
              { key: 'by', header: 'By', render: (m: StockMovement) => history.data?.staffNames[m.staffId] ?? '' },
            ]}
            rows={history.data.movements}
            getRowKey={(m) => m.id}
            emptyMessage="No stock movements yet"
            dense
          />
        )}
      </div>
    </Modal>
  );
}
