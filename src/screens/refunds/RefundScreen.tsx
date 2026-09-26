/**
 * Refunds (spec §6.8; architecture §5.5; D-035..D-039, D-122, D-125; docs/ui-plan.md §7).
 *
 * 1. Receipt number -> services/refunds.findSaleForRefund (normalised: '3f9c-42' finds
 *    3F9C-000042). Deposits and refunds can't be refunded.
 * 2. Per line: a stepper 0..refundable (sold minus refunded already) and, for stock-tracked
 *    products, Return to stock (default) or Waste. The refund total shown is rules/refund's.
 * 3. Tender: Cash (default) or Card.
 * 4. Refund -> requirePermission('refund') (manager; others get the Manager PIN override) ->
 *    commitRefund -> the refund receipt opens (openDocument, with the on-screen fallback).
 * Looking a sale up needs no permission and no open period; the commit needs both (D-068).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errorCode, errorMessage, OpenPeriodDialog, openDocument, requirePermission } from '../../app';
import { Banner, Button, MoneyText, Screen, TextField } from '../../components';
import type { Sale, TenderType } from '../../data/types';
import { formatPence } from '../../rules/money';
import { refundMagnitude } from '../../rules/refund';
import { normaliseReceiptQuery } from '../../rules/sale';
import { formatDateTime } from '../../rules/time';
import type { ServiceContext } from '../../services/context';
import { listMembers, memberLabel } from '../../services/members';
import { commitRefund, findSaleForRefund, type RefundableLine } from '../../services/refunds';
import { listStaff } from '../../services/staff';
import { getCtx, useAppStore, useHasOpenPeriod } from '../../store';
import { ChoiceToggle } from './ChoiceToggle';
import { RefundLineRow, type StockChoice } from './RefundLineRow';
import { refundTotalPence } from './refundPreview';
import styles from './RefundScreen.module.css';

type Lookup =
  | { status: 'idle' }
  | { status: 'notFound'; receiptNumber: string }
  | { status: 'notRefundable'; sale: Sale }
  | { status: 'found'; sale: Sale; lines: RefundableLine[]; staffName: string | null; memberText: string | null };

interface Done {
  refundReceiptNumber: string;
  originalReceiptNumber: string;
  amountPence: number;
  tender: TenderType;
}

const TENDER_OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
] as const satisfies readonly { value: TenderType; label: string }[];

const TENDER_NAMES: Record<TenderType, string> = { cash: 'Cash', card: 'Card' };

const KIND_NOTES: Record<Sale['kind'], string> = {
  sale: '',
  deposit: 'It is a deposit taken for a booking. Deposits are not refunded here.',
  refund: 'It is itself a refund.',
};

async function describeSale(ctx: ServiceContext, sale: Sale): Promise<{ staffName: string | null; memberText: string | null }> {
  const [staff, members] = await Promise.all([listStaff(ctx), sale.memberId === undefined ? Promise.resolve([]) : listMembers(ctx)]);
  const member = members.find((m) => m.id === sale.memberId);
  return {
    staffName: staff.find((s) => s.id === sale.staffId)?.name ?? null,
    memberText: member === undefined ? null : memberLabel(member),
  };
}

export function RefundScreen() {
  const hasPeriod = useHasOpenPeriod();
  const devicePrefix = useAppStore((s) => s.settings?.devicePrefix);
  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const [quantities, setQuantities] = useState<ReadonlyMap<number, number>>(new Map());
  const [stock, setStock] = useState<ReadonlyMap<number, StockChoice>>(new Map());
  const [tender, setTender] = useState<TenderType>('cash');
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [periodDialog, setPeriodDialog] = useState(false);
  const request = useRef(0);
  const committingRef = useRef(false);
  const doneRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const resultsHeadingId = useId();
  const summaryHeadingId = useId();

  /** Looks the receipt up and resets the choices. Ignores answers overtaken by a newer search. */
  const load = async (text: string): Promise<void> => {
    const mine = ++request.current;
    const ctx = getCtx();
    const result = await findSaleForRefund(ctx, text);
    let next: Lookup;
    if (result.status === 'found') next = { ...result, ...(await describeSale(ctx, result.sale)) };
    else if (result.status === 'notFound') next = { status: 'notFound', receiptNumber: normaliseReceiptQuery(text) ?? text.trim() };
    else next = result;
    if (mine !== request.current) return;
    setLookup(next);
    setQuantities(new Map());
    setStock(new Map());
    setTender('cash');
  };

  const find = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (searching || committing) return;
    setError(null);
    setDone(null);
    if (normaliseReceiptQuery(query) === null) {
      setQueryError('Enter a receipt number');
      return;
    }
    setQueryError(null);
    setSearching(true);
    try {
      await load(query);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSearching(false);
    }
  };

  const found = lookup.status === 'found' ? lookup : null;
  const qtyOf = (line: RefundableLine): number => quantities.get(line.lineIndex) ?? 0;
  const stockOf = (line: RefundableLine): StockChoice => stock.get(line.lineIndex) ?? 'return';
  const refundableLines = found === null ? [] : found.lines.filter((line) => line.refundableQty > 0);
  const chosenUnits = found === null ? 0 : found.lines.reduce((sum, line) => sum + qtyOf(line), 0);
  const totalPence = found === null ? 0 : refundTotalPence(found.lines, quantities);
  const allSelected = refundableLines.length > 0 && refundableLines.every((line) => qtyOf(line) === line.refundableQty);

  const setQty = (line: RefundableLine, qty: number): void => {
    const next = new Map(quantities);
    next.set(line.lineIndex, Math.min(Math.max(qty, 0), line.refundableQty));
    setQuantities(next);
  };

  const setStockChoice = (line: RefundableLine, choice: StockChoice): void => {
    const next = new Map(stock);
    next.set(line.lineIndex, choice);
    setStock(next);
  };

  const selectAll = (): void => {
    if (found === null) return;
    setQuantities(new Map(found.lines.map((line) => [line.lineIndex, allSelected ? 0 : line.refundableQty])));
  };

  const commit = async (): Promise<void> => {
    // The ref also stops a fast double tap that lands before the re-render disables the button.
    if (found === null || committingRef.current || chosenUnits === 0) return;
    committingRef.current = true;
    setError(null);
    setDone(null);
    const auth = await requirePermission('refund');
    if (auth === null) {
      committingRef.current = false;
      return;
    }
    setCommitting(true);
    const original = found.sale;
    try {
      const result = await commitRefund(getCtx(), auth, {
        originalSaleId: original.id,
        lines: found.lines
          .filter((line) => qtyOf(line) > 0)
          .map((line) => ({ lineIndex: line.lineIndex, qty: qtyOf(line), returnToStock: stockOf(line) === 'return' })),
        tenderType: tender,
      });
      openDocument(result.document);
      setDone({
        refundReceiptNumber: result.sale.receiptNumber,
        originalReceiptNumber: original.receiptNumber,
        amountPence: refundMagnitude(result.sale),
        tender,
      });
      // Show what is left to refund; a failed reload must not read as a failed refund.
      await load(original.receiptNumber).catch(() => undefined);
    } catch (caught) {
      const code = errorCode(caught);
      setError(errorMessage(caught));
      if (code === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
      if (code === 'REFUND_EXCEEDS_AVAILABLE' || code === 'NOT_FOUND' || code === 'NOT_REFUNDABLE') {
        await load(original.receiptNumber).catch(() => undefined);
      }
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  };

  // The Refund button may be far down the page: bring the result (how much to give back) into view.
  useEffect(() => {
    if (done === null) return;
    doneRef.current?.focus({ preventScroll: true });
    doneRef.current?.scrollIntoView({ block: 'nearest' });
  }, [done]);
  useEffect(() => {
    if (error !== null) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const example = `${devicePrefix ?? '3F9C'}-42`;

  return (
    <Screen title="Refunds" description="Find the original sale by its receipt number, choose what to give back, then refund it in cash or by card.">
      {!hasPeriod && (
        <Banner
          tone="warning"
          role="none"
          testId="refund-no-period"
          action={
            <Button size="sm" onClick={() => setPeriodDialog(true)}>
              Open period
            </Button>
          }
        >
          No trading period open. You can look up a sale, but a refund needs an open period.
        </Banner>
      )}

      <form className={styles.search} onSubmit={(event) => void find(event)} role="search" aria-label="Find a sale" noValidate>
        <TextField
          label="Receipt number"
          value={query}
          onChange={(value) => {
            setQuery(value);
            if (queryError !== null) setQueryError(null);
          }}
          hint={`As printed on the receipt. Leading zeros can be left out, e.g. ${example}.`}
          error={queryError}
          className={styles.searchField}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="search"
        />
        <Button type="submit" variant="primary" size="lg" busy={searching} disabled={committing} className={styles.searchButton}>
          Find sale
        </Button>
      </form>

      {done !== null && (
        <div ref={doneRef} tabIndex={-1} className={styles.doneFocus}>
          <Banner tone="success" title="Refund complete" role="status" onDismiss={() => setDone(null)} testId="refund-complete">
            Receipt <span className="tabular">{done.refundReceiptNumber}</span> for {done.originalReceiptNumber}.{' '}
            {done.tender === 'cash'
              ? `Give the customer ${formatPence(done.amountPence)} in cash.`
              : `Refund ${formatPence(done.amountPence)} on the card machine.`}
          </Banner>
        </div>
      )}

      {error !== null && (
        <div ref={errorRef} className={styles.doneFocus}>
          <Banner tone="danger" onDismiss={() => setError(null)} testId="refund-error">
            {error}
          </Banner>
        </div>
      )}

      {lookup.status === 'idle' && (
        <div className={styles.empty}>
          <ReceiptIcon />
          <p>Enter the receipt number printed on the customer&apos;s receipt to see what can be refunded.</p>
        </div>
      )}

      {lookup.status === 'notFound' && (
        <Banner tone="warning" title="No sale found" role="status" testId="refund-not-found">
          There is no receipt <span className="tabular">{lookup.receiptNumber}</span> on this till. Check the number and try again.
        </Banner>
      )}

      {lookup.status === 'notRefundable' && (
        <Banner tone="warning" title="This receipt can't be refunded" role="status" testId="refund-not-refundable">
          <span className="tabular">{lookup.sale.receiptNumber}</span>: {KIND_NOTES[lookup.sale.kind]}
        </Banner>
      )}

      {found !== null && (
        <div className={styles.layout}>
          <section className={styles.sale} aria-labelledby={resultsHeadingId} data-testid="refund-sale">
            <header className={styles.saleHead}>
              <div className={styles.saleTitle}>
                <p className={styles.eyebrow}>Original sale</p>
                <h2 id={resultsHeadingId} className={styles.receipt}>
                  {found.sale.receiptNumber}
                </h2>
                <p className={styles.saleMeta}>
                  {formatDateTime(found.sale.createdAt)}
                  {found.staffName !== null && <> · {found.staffName}</>}
                </p>
                {found.memberText !== null && <p className={styles.saleMeta}>Member {found.memberText}</p>}
              </div>
              <div className={styles.saleTotal}>
                <span className={styles.saleTotalLabel}>Total</span>
                <MoneyText pence={found.sale.totalPence} size="xl" strong testId="refund-sale-total" />
                <span className={styles.saleTenders}>
                  {found.sale.tenders.length === 0
                    ? 'Nothing paid'
                    : found.sale.tenders.map((t) => `${TENDER_NAMES[t.type]} ${formatPence(t.amountPence)}`).join(' · ')}
                </span>
              </div>
            </header>

            {found.sale.depositAppliedPence > 0 && (
              <p className={styles.note}>
                A deposit of {formatPence(found.sale.depositAppliedPence)} was applied to this bill. A refund pays the item value back in the tender
                you choose; the deposit is not returned to the booking.
              </p>
            )}

            <div className={styles.linesHead}>
              <h3 className={styles.linesTitle}>Items</h3>
              {refundableLines.length > 0 && (
                <Button size="sm" variant="ghost" onClick={selectAll} disabled={committing}>
                  {allSelected ? 'Select none' : 'Select all'}
                </Button>
              )}
            </div>
            <ul className={styles.lines} aria-label="Items on this receipt">
              {found.lines.map((line) => (
                <RefundLineRow
                  key={line.lineIndex}
                  line={line}
                  qty={qtyOf(line)}
                  onQtyChange={(qty) => setQty(line, qty)}
                  stock={stockOf(line)}
                  onStockChange={(choice) => setStockChoice(line, choice)}
                  disabled={committing}
                />
              ))}
            </ul>
          </section>

          {refundableLines.length === 0 ? (
            <Banner tone="info" role="status" testId="refund-all-done" className={styles.allDone}>
              Everything on this receipt has already been refunded.
            </Banner>
          ) : (
            <aside className={styles.summary} aria-labelledby={summaryHeadingId}>
              <h2 id={summaryHeadingId} className={styles.summaryTitle}>
                Refund
              </h2>
              <p className={styles.summaryCount} data-testid="refund-units">
                {chosenUnits === 0 ? 'No items chosen yet' : `${chosenUnits} ${chosenUnits === 1 ? 'item' : 'items'} to refund`}
              </p>
              <ChoiceToggle legend="Refund by" name="refund-tender" value={tender} onChange={setTender} options={TENDER_OPTIONS} size="lg" disabled={committing} />
              <div className={styles.totalRow}>
                <span className={styles.totalLabel}>Refund total</span>
                <MoneyText pence={totalPence} size="2xl" strong testId="refund-total" />
              </div>
              <Button
                variant="primary"
                size="xl"
                block
                onClick={() => void commit()}
                busy={committing}
                disabled={chosenUnits === 0 || !hasPeriod}
              >
                {chosenUnits === 0 ? (
                  'Refund'
                ) : (
                  <>
                    Refund <span className="tabular">{formatPence(totalPence)}</span>
                  </>
                )}
              </Button>
              <p className={styles.summaryHint}>
                {!hasPeriod
                  ? 'Open a trading period to make a refund.'
                  : chosenUnits === 0
                    ? 'Use + to choose the items to refund.'
                    : tender === 'cash'
                      ? 'Paid out of the till drawer. The refund receipt opens in a new tab.'
                      : 'Refund it on the card machine. The refund receipt opens in a new tab.'}
              </p>
            </aside>
          )}
        </div>
      )}

      <OpenPeriodDialog open={periodDialog} onClose={() => setPeriodDialog(false)} />
    </Screen>
  );
}

function ReceiptIcon() {
  return (
    <svg className={styles.emptyIcon} viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
      <path
        d="M12 6h24v36l-4-3-4 3-4-3-4 3-4-3-4 3V6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M18 16h12M18 23h12M18 30h7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
