/**
 * The till (spec §6.3; architecture §5.1, §5.3, §5.4, §5.6, §7; docs/ui-plan.md §7 "till").
 *
 * Layout: category tabs and the product grid, with an action bar (Member, Tab, Booking, Void,
 * No sale) under them. At >= 900 px the basket is a side panel with Pay; below that it is a
 * bottom sheet whose bar shows the item count, the total (basket-bar-total) and Pay. Only one
 * BasketPanel is rendered at a time, so basket-total / member-badge / deposit-line stay unique.
 * The header (app shell) owns the only Menu and Lock buttons.
 *
 * Every basket change goes through basketStore (viewBasket + saveDraft); every figure shown is
 * what the services return. Permission-gated actions use requirePermission (D-070).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { NoPeriodPrompt, requirePermission, useLoad, type LoadState } from '../../app';
import {
  Banner,
  BasketPanel,
  BottomSheet,
  Button,
  ButtonLink,
  CategoryTabs,
  categoryTabId,
  keepFocusWhenRemoved,
  MoneyText,
  ProductButton,
  Screen,
  useIsWide,
} from '../../components';
import type { BasketState } from '../../rules/basket';
import { formatPence } from '../../rules/money';
import type { PricedLine } from '../../rules/pricing';
import { tabDisplayLabel } from '../../rules/validation';
import { loadTillCatalogue, recordNoSale, type BasketView, type TillCatalogue } from '../../services/till';
import { basketUnitCount, getCtx, isBasketFrozen, toast, useAppStore, useBasketStore, useHasOpenPeriod, usePayStore } from '../../store';
import { BookingDialog } from './BookingDialog';
import { BookingIcon, MemberIcon, MinusIcon, NoSaleIcon, PlusIcon, TabIcon, VoidIcon } from './icons';
import { MemberDialog } from './MemberDialog';
import { isNoPeriodError, tillErrorMessage } from './tillErrors';
import { TabDialog } from './TabDialog';
import { VoidDialog } from './VoidDialog';
import styles from './TillScreen.module.css';

type DialogKind = 'member' | 'tab' | 'booking' | 'void';

/** id of the product grid (role="tabpanel"). One till is mounted at a time. */
const PRODUCTS_PANEL_ID = 'till-products';

export function TillScreen() {
  const hasPeriod = useHasOpenPeriod();
  const wide = useIsWide();
  const navigate = useNavigate();
  const basket = useBasketStore((s) => s.basket);
  const view = useBasketStore((s) => s.view);
  const pricing = useBasketStore((s) => s.pricing);
  const basketError = useBasketStore((s) => s.error);
  const paySession = usePayStore((s) => s.session);
  const discountPercent = useAppStore((s) => s.settings?.memberDiscountPercent);
  const catalogue = useLoad(loadTillCatalogue, []);

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pay' | 'noSale' | null>(null);

  useEffect(() => {
    // Back on the till with a sale payment that took no tenders: its frozen pricing is stale
    // (D-011), so drop it — the same as 'Back to basket'. Then re-price the basket at now.
    const pay = usePayStore.getState();
    if (pay.session?.kind === 'sale' && pay.session.tender.tenders.length === 0) pay.clear();
    void useBasketStore.getState().refresh();
  }, []);

  const frozen = isBasketFrozen(paySession);
  const paymentInProgress = paySession !== null && paySession.tender.tenders.length > 0;
  const canSell = hasPeriod && !frozen;
  const hasLines = basket.lines.length > 0;
  const selected = selectedLine !== null && basket.lines.some((l) => l.productId === selectedLine) ? selectedLine : null;
  const unitCount = basketUnitCount(basket);
  const totalPence = view?.priced.totalPence ?? 0;

  /** Shows a service error inline (the basket is never touched by a failed action). */
  const fail = (caught: unknown): void => {
    const message = tillErrorMessage(caught);
    if (isNoPeriodError(caught)) {
      // The period was closed elsewhere: the till now shows the 'Open period' prompt.
      setSheetOpen(false);
      toast(message, { tone: 'warning' });
      return;
    }
    setActionError(message);
  };

  const addOne = (productId: string): void => {
    setActionError(null);
    void useBasketStore.getState().addProduct(productId);
  };

  /** '−' on a basket line: a void of one unit (D-085), so it needs 'voidLine' (supervisor+). */
  const voidOne = async (line: PricedLine): Promise<void> => {
    setActionError(null);
    const auth = await requirePermission('voidLine');
    if (auth === null) return;
    try {
      await useBasketStore.getState().voidLine(auth, line.productId, 1);
      toast(`Voided 1 × ${line.name}`, { tone: 'success' });
    } catch (caught) {
      fail(caught);
    }
  };

  const noSale = async (): Promise<void> => {
    setActionError(null);
    const auth = await requirePermission('noSale');
    if (auth === null) return;
    setBusy('noSale');
    try {
      await recordNoSale(getCtx(), auth);
      toast('Drawer opened', { tone: 'success' });
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  const pay = async (): Promise<void> => {
    setActionError(null);
    setBusy('pay');
    try {
      await usePayStore.getState().openSale();
      setSheetOpen(false);
      navigate('/pay');
    } catch (caught) {
      // VALIDATION, NOT_FOUND, BOOKING_NOT_OPEN, TAB_NOT_OPEN, NO_OPEN_PERIOD (D-124): the basket is kept.
      fail(caught);
      setBusy(null);
    }
  };

  const detachMember = (): void => {
    void useBasketStore
      .getState()
      .detachMember()
      .then(() => toast('Member removed from the basket'));
  };

  const detachBooking = (): void => {
    void useBasketStore
      .getState()
      .detachBooking()
      .then(() => toast('Booking removed from the basket'));
  };

  const openDialog = (kind: DialogKind): void => {
    setActionError(null);
    setDialog(kind);
  };

  const payDisabled = !hasPeriod || !hasLines || paymentInProgress;

  const notices = (
    <>
      {paymentInProgress && (
        <Banner
          tone="warning"
          title="Payment in progress."
          action={
            <ButtonLink to="/pay" variant="secondary" size="sm">
              Return to payment
            </ButtonLink>
          }
        >
          {frozen ? 'The basket is locked until the payment is finished or cancelled.' : 'Finish or cancel the deposit payment before taking another payment.'}
        </Banner>
      )}
      {actionError !== null && (
        <Banner tone="danger" onDismiss={() => setActionError(null)} testId="till-error">
          {actionError}
        </Banner>
      )}
      {basketError !== null && (
        <Banner
          tone="danger"
          title="The basket could not be updated."
          action={
            <Button size="sm" onClick={() => void useBasketStore.getState().refresh()}>
              Try again
            </Button>
          }
        >
          {basketError}
        </Banner>
      )}
    </>
  );
  const hasNotices = paymentInProgress || actionError !== null || basketError !== null;

  const panel = (
    <BasketPanel
      view={view}
      basket={basket}
      memberDiscountPercent={discountPercent}
      selectedProductId={selected}
      onSelectLine={wide && canSell ? (id) => setSelectedLine((current) => (current === id ? null : id)) : undefined}
      lineTrailing={canSell ? (line) => <LineStepper line={line} onAdd={addOne} onVoid={(l) => void voidOne(l)} /> : undefined}
      onRemoveMember={frozen ? undefined : detachMember}
      onRemoveBooking={frozen ? undefined : detachBooking}
      pricing={pricing}
      hideHeading={!wide}
      disabled={frozen}
      className={wide ? styles.panel : styles.sheetPanel}
      actions={
        wide ? (
          <Button variant="primary" size="xl" block onClick={() => void pay()} busy={busy === 'pay'} disabled={payDisabled}>
            Pay
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <Screen title="Till" hideTitle width="full">
      <div className={`${styles.till} ${wide ? styles.wide : styles.narrow}`}>
        <div className={styles.main}>
          {hasNotices && !(sheetOpen && !wide) && <div className={styles.notices}>{notices}</div>}
          {hasPeriod ? (
            <ProductArea catalogue={catalogue} basket={basket} disabled={!canSell} onAdd={addOne} />
          ) : (
            <div className={styles.noPeriod}>
              <NoPeriodPrompt />
            </div>
          )}
          <ActionBar
            basket={basket}
            canSell={canSell}
            canVoid={canSell && hasLines}
            canNoSale={hasPeriod}
            noSaleBusy={busy === 'noSale'}
            onMember={() => openDialog('member')}
            onTab={() => openDialog('tab')}
            onBooking={() => openDialog('booking')}
            onVoid={() => openDialog('void')}
            onNoSale={() => void noSale()}
          />
        </div>

        {wide ? (
          <aside className={styles.side} aria-label="Basket">
            {panel}
          </aside>
        ) : (
          <BottomSheet
            title="Basket"
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            summary={<SheetSummary view={view} unitCount={unitCount} totalPence={totalPence} />}
            barActions={
              <Button variant="primary" size="lg" onClick={() => void pay()} busy={busy === 'pay'} disabled={payDisabled} className={styles.barPay}>
                Pay
              </Button>
            }
            footer={
              <Button variant="primary" size="lg" block onClick={() => void pay()} busy={busy === 'pay'} disabled={payDisabled}>
                Pay <span className="tabular">{formatPence(totalPence)}</span>
              </Button>
            }
          >
            {hasNotices && <div className={styles.sheetNotices}>{notices}</div>}
            {panel}
          </BottomSheet>
        )}
      </div>

      <MemberDialog open={dialog === 'member'} onClose={() => setDialog(null)} />
      <BookingDialog open={dialog === 'booking'} onClose={() => setDialog(null)} />
      <TabDialog open={dialog === 'tab'} onClose={() => setDialog(null)} />
      <VoidDialog open={dialog === 'void'} onClose={() => setDialog(null)} initialProductId={selected} />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Product area: category tabs + product grid
// ---------------------------------------------------------------------------

interface ProductAreaProps {
  catalogue: LoadState<TillCatalogue>;
  basket: BasketState;
  disabled: boolean;
  onAdd: (productId: string) => void;
}

function ProductArea({ catalogue, basket, disabled, onAdd }: ProductAreaProps) {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const data = catalogue.data;

  if (data === undefined) {
    return (
      <div className={styles.placeholder}>
        {catalogue.error !== null ? (
          <Banner
            tone="danger"
            title="The products could not be loaded."
            action={
              <Button size="sm" onClick={catalogue.reload}>
                Reload products
              </Button>
            }
          >
            {catalogue.error}
          </Banner>
        ) : (
          <p className={styles.muted}>Loading products…</p>
        )}
      </div>
    );
  }

  const { categories, products } = data;
  if (categories.length === 0 || products.length === 0) {
    return (
      <div className={styles.placeholder}>
        <div className={styles.emptyCatalogue}>
          <h2>No products yet</h2>
          <p className={styles.muted}>A manager can add categories and products in the back office.</p>
          <ButtonLink to="/backoffice/products" variant="secondary">
            Go to products
          </ButtonLink>
        </div>
      </div>
    );
  }

  const active = categories.find((c) => c.id === categoryId) ?? categories[0];
  const shown = active === undefined ? [] : products.filter((p) => p.categoryId === active.id);
  const qtyOf = new Map(basket.lines.map((line) => [line.productId, line.qty]));

  return (
    <>
      <div className={styles.categories}>
        <CategoryTabs categories={categories} selectedId={active?.id ?? null} onSelect={setCategoryId} panelId={PRODUCTS_PANEL_ID} />
      </div>
      <div
        id={PRODUCTS_PANEL_ID}
        role="tabpanel"
        aria-labelledby={active === undefined ? undefined : categoryTabId(PRODUCTS_PANEL_ID, active.id)}
        className={styles.grid}
      >
        {shown.length === 0 ? (
          <p className={styles.muted}>No products in this category.</p>
        ) : (
          shown.map((product) => (
            <ProductButton key={product.id} product={product} onPress={onAdd} disabled={disabled} qtyInBasket={qtyOf.get(product.id) ?? 0} />
          ))
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

interface ActionBarProps {
  basket: BasketState;
  canSell: boolean;
  canVoid: boolean;
  canNoSale: boolean;
  noSaleBusy: boolean;
  onMember: () => void;
  onTab: () => void;
  onBooking: () => void;
  onVoid: () => void;
  onNoSale: () => void;
}

/**
 * Member, Tab, Booking, Void, No sale (architecture §7.4 names). Void and No sale are visible
 * to every role; staff get the PIN override when they use them (D-070).
 */
function ActionBar({ basket, canSell, canVoid, canNoSale, noSaleBusy, onMember, onTab, onBooking, onVoid, onNoSale }: ActionBarProps) {
  return (
    <div className={styles.actionBar} role="group" aria-label="Till actions">
      <Button className={styles.action} onClick={onMember} disabled={!canSell} aria-haspopup="dialog">
        <MemberIcon />
        <span className={styles.actionLabel}>Member</span>
        {basket.memberId !== undefined && <span className={styles.actionDot} aria-hidden="true" />}
      </Button>
      <Button className={styles.action} onClick={onTab} disabled={!canSell} aria-haspopup="dialog">
        <TabIcon />
        <span className={styles.actionLabel}>Tab</span>
        {basket.tabId !== undefined && <span className={styles.actionDot} aria-hidden="true" />}
      </Button>
      <Button className={styles.action} onClick={onBooking} disabled={!canSell} aria-haspopup="dialog">
        <BookingIcon />
        <span className={styles.actionLabel}>Booking</span>
        {basket.bookingId !== undefined && <span className={styles.actionDot} aria-hidden="true" />}
      </Button>
      <Button className={styles.action} variant="dangerOutline" onClick={onVoid} disabled={!canVoid} aria-haspopup="dialog">
        <VoidIcon />
        <span className={styles.actionLabel}>Void</span>
      </Button>
      <Button className={styles.action} onClick={onNoSale} disabled={!canNoSale} busy={noSaleBusy}>
        {!noSaleBusy && <NoSaleIcon />}
        <span className={styles.actionLabel}>No sale</span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Basket line +/- and the phone basket bar
// ---------------------------------------------------------------------------

interface LineStepperProps {
  line: PricedLine;
  onAdd: (productId: string) => void;
  onVoid: (line: PricedLine) => void;
}

function LineStepper({ line, onAdd, onVoid }: LineStepperProps) {
  return (
    <div className={styles.stepper}>
      <button
        type="button"
        className={styles.stepButton}
        onClick={(event) => {
          // The last unit's void removes the line and this button: keep focus in the basket (D-135).
          if (line.qty === 1) keepFocusWhenRemoved(event.currentTarget);
          onVoid(line);
        }}
        aria-label={`Remove one ${line.name}`}
      >
        <MinusIcon />
      </button>
      <button type="button" className={styles.stepButton} onClick={() => onAdd(line.productId)} aria-label={`Add one ${line.name}`}>
        <PlusIcon />
      </button>
    </div>
  );
}

interface SheetSummaryProps {
  view: BasketView | null;
  unitCount: number;
  totalPence: number;
}

function SheetSummary({ view, unitCount, totalPence }: SheetSummaryProps) {
  const context = [
    view?.tab === undefined ? null : `Tab ${tabDisplayLabel(view.tab)}`,
    view?.member === undefined ? null : `${view.member.firstName} ${view.member.lastName}`,
    view?.booking === undefined ? null : view.booking.name,
  ].filter((part): part is string => part !== null);
  const count = `${unitCount} ${unitCount === 1 ? 'item' : 'items'}`;
  // The total's size is fitted to the room the count leaves (see .sheetTotal), so a four-figure
  // total never runs into the count.
  const fit = { '--count-chars': count.length, '--total-chars': formatPence(totalPence).length } as CSSProperties;
  return (
    <span className={styles.sheetSummary} style={fit}>
      <span className={styles.sheetText}>
        <span className={styles.sheetCount} data-testid="basket-bar-count">
          {count}
        </span>
        {context.length > 0 && <span className={styles.sheetContext}>{` ${context.join(' · ')}`}</span>}
      </span>{' '}
      <MoneyText pence={totalPence} size="xl" strong testId="basket-bar-total" className={styles.sheetTotal} />
    </span>
  );
}
