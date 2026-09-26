/**
 * Dev-only gallery of the shared components (#/dev/components, `npm run dev` only).
 * Used for visual checks at both viewports; never shipped in production builds.
 */
import { useMemo, useState } from 'react';
import { Banner } from '../../components/Banner';
import { BasketPanel } from '../../components/BasketPanel';
import { BottomSheet } from '../../components/BottomSheet';
import { Button } from '../../components/Button';
import { CategoryTabs } from '../../components/CategoryTabs';
import { categoryTabId } from '../../components/categoryTabId';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable } from '../../components/DataTable';
import { CheckboxField, SelectField, TextAreaField, TextField } from '../../components/FormField';
import { useIsWide } from '../../components/hooks';
import { Modal } from '../../components/Modal';
import { MoneyText } from '../../components/MoneyText';
import { NumericKeypad } from '../../components/NumericKeypad';
import { PinKeypad } from '../../components/PinKeypad';
import { ProductButton } from '../../components/ProductButton';
import { Screen } from '../../components/Screen';
import { SearchList } from '../../components/SearchList';
import type { Booking, Deal, Member, Product, Tab } from '../../data/types';
import { priceBasket } from '../../rules/pricing';
import type { BasketState } from '../../rules/basket';
import type { BasketView } from '../../services/till';
import { confirmDialog, toast, useUiStore } from '../../store/uiStore';
import { nowIso } from '../clock';
import { requirePermission } from '../requirePermission';
import styles from './ComponentGallery.module.css';

const BASE = { deviceId: 'dev', createdAt: '2026-09-26T09:00:00.000Z', updatedAt: '2026-09-26T09:00:00.000Z' };

const CATEGORIES = [
  { id: 'draught', name: 'Draught', colour: '#b45309' },
  { id: 'bottles', name: 'Bottles & Cans', colour: '#a16207' },
  { id: 'spirits', name: 'Spirits', colour: '#7c3aed' },
  { id: 'wine', name: 'Wine', colour: '#9f1239' },
  { id: 'soft', name: 'Soft Drinks', colour: '#0369a1' },
  { id: 'snacks', name: 'Snacks', colour: '#15803d' },
  { id: 'events', name: 'Events', colour: '#475569' },
];

function product(id: string, name: string, pricePence: number, categoryId: string, vatRate = 20): Product {
  const colour = CATEGORIES.find((c) => c.id === categoryId)?.colour ?? '#166534';
  return {
    ...BASE,
    id,
    name,
    categoryId,
    pricePence,
    vatRate,
    memberDiscountEligible: categoryId !== 'events',
    stockTracked: true,
    stockUnit: 'unit',
    lowStockLevel: 0,
    buttonColour: colour,
    sortOrder: 1,
    active: true,
  };
}

const PRODUCTS: Product[] = [
  product('bitter', 'Club Bitter', 420, 'draught'),
  product('lager', 'Fairway Lager', 480, 'draught'),
  product('ipa', 'Links IPA', 520, 'draught'),
  product('stout', 'Old Caddie Stout', 500, 'draught'),
  product('cider', 'Orchard Cider', 460, 'draught'),
  product('shandy', 'Shandy', 380, 'draught'),
  product('birdie', 'Birdie Pale Ale', 450, 'bottles'),
  product('zero', 'Zero Lager (alcohol-free)', 350, 'bottles'),
  product('malt', 'Single Malt Whisky', 550, 'spirits'),
  product('prosecco', 'Prosecco (bottle)', 2600, 'wine'),
  product('cola', 'Cola', 250, 'soft'),
  product('crisps', 'Ready Salted Crisps', 120, 'snacks'),
  product('raffle', 'Raffle Ticket', 100, 'events', 0),
];

const MEMBERS: Member[] = [
  { ...BASE, id: 'm1', memberNumber: '1001', firstName: 'Alice', lastName: 'Archer', active: true },
  { ...BASE, id: 'm2', memberNumber: '1002', firstName: 'Ben', lastName: 'Birch', active: true },
  { ...BASE, id: 'm3', memberNumber: '1003', firstName: 'Clara', lastName: 'Chalmers', active: true },
];

const DEAL: Deal = { ...BASE, id: 'd1', name: 'Any 2 bottles for £8', type: 'nForPrice', n: 2, pricePence: 800, productIds: ['birdie'], active: true };
const BOOKING: Booking = { ...BASE, id: 'b1', type: 'wedding', name: 'Smith & Jones Wedding', date: '2026-10-26', notes: '', status: 'open' };
const TAB: Tab = { ...BASE, id: 't1', labelType: 'table', label: '5', openedAt: BASE.createdAt, openedBy: 'dev', status: 'open', lines: [] };

const SAMPLE_RECEIPT = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt DEV-000042</title>
<style>body{font-family:ui-monospace,monospace;width:72mm;margin:0 auto;padding:8px;font-size:12px}h1{font-size:14px;text-align:center}.r{display:flex;justify-content:space-between}</style>
</head><body><h1>Oakfield Golf Club</h1><p>26/09/2026 14:05<br>Receipt DEV-000042<br>Staff: Morgan Manager</p>
<div class="r"><span>2 x Birdie Pale Ale @ £4.50</span><span>£9.00</span></div><div class="r"><span>Any 2 bottles for £8</span><span>-£1.00</span></div>
<div class="r"><b>TOTAL</b><b>£8.00</b></div><div class="r"><span>Cash</span><span>£10.00</span></div><div class="r"><span>Change</span><span>£2.00</span></div><p>Thank you for your custom</p></body></html>`;

export function ComponentGallery() {
  const isWide = useIsWide();
  const [category, setCategory] = useState('draught');
  const [basketLines, setBasketLines] = useState<{ productId: string; qty: number }[]>([
    { productId: 'birdie', qty: 2 },
    { productId: 'lager', qty: 1 },
    { productId: 'raffle', qty: 3 },
  ]);
  const [selected, setSelected] = useState<string | null>(null);
  const [money, setMoney] = useState(2000);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [text, setText] = useState('Oakfield Golf Club');
  const [select, setSelect] = useState('20');
  const [checked, setChecked] = useState(true);
  const [notes, setNotes] = useState('');
  const [query, setQuery] = useState('');
  const [pricingAt] = useState(() => nowIso());

  const basket: BasketState = useMemo(() => ({ lines: basketLines, memberId: 'm1', bookingId: 'b1', tabId: 't1' }), [basketLines]);
  const view: BasketView = useMemo(() => {
    const lines = basketLines.flatMap((line) => {
      const p = PRODUCTS.find((x) => x.id === line.productId);
      return p === undefined
        ? []
        : [{ productId: p.id, name: p.name, qty: line.qty, unitPricePence: p.pricePence, vatRate: p.vatRate, memberDiscountEligible: p.memberDiscountEligible }];
    });
    const priced = priceBasket({ lines, deals: [DEAL], at: pricingAt, memberDiscountPercent: 15, depositBalancePence: 500 });
    const firstMember = MEMBERS[0];
    return { priced, booking: BOOKING, bookingBalancePence: 500, tab: TAB, ...(firstMember === undefined ? {} : { member: firstMember }) };
  }, [basketLines, pricingAt]);

  const addProduct = (id: string): void => {
    setBasketLines((lines) => (lines.some((l) => l.productId === id) ? lines.map((l) => (l.productId === id ? { ...l, qty: l.qty + 1 } : l)) : [...lines, { productId: id, qty: 1 }]));
  };
  const qtyOf = (id: string): number => basketLines.find((l) => l.productId === id)?.qty ?? 0;
  const results = query.trim() === '' ? [] : MEMBERS.filter((m) => `${m.memberNumber} ${m.firstName} ${m.lastName}`.toLowerCase().includes(query.trim().toLowerCase()));

  const panel = (
    <BasketPanel
      view={view}
      basket={basket}
      memberDiscountPercent={15}
      selectedProductId={selected}
      onSelectLine={(id) => setSelected((current) => (current === id ? null : id))}
      onRemoveMember={() => toast('Member removed (demo)')}
      onRemoveBooking={() => toast('Booking removed (demo)')}
      actions={
        <Button variant="primary" size="xl" block>
          Pay
        </Button>
      }
    />
  );

  return (
    <Screen title="Component gallery" description="Dev only. Every shared component in its main states.">
      <section className={styles.section}>
        <h2>Buttons</h2>
        <div className={styles.row}>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="dangerOutline">Danger outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" busy>
            Saving
          </Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className={styles.row}>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button size="xl" variant="primary">
            Extra large
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Money</h2>
        <div className={styles.row}>
          <MoneyText pence={5} />
          <MoneyText pence={123456} size="lg" strong />
          <MoneyText pence={173} asDeduction />
          <MoneyText pence={-255} size="xl" />
          <MoneyText pence={9999999} size="2xl" strong />
        </div>
      </section>

      <section className={styles.section}>
        <h2>Banners</h2>
        <Banner tone="info">The till is working offline. Everything is saved on this device.</Banner>
        <Banner tone="success" title="Saved">Product updated.</Banner>
        <Banner
          tone="warning"
          action={
            <Button size="sm" variant="secondary">
              Back up now
            </Button>
          }
          onDismiss={() => toast('Dismissed')}
        >
          No backup in the last 7 days
        </Banner>
        <Banner tone="danger">Sale not saved: No trading period open</Banner>
      </section>

      <section className={styles.section}>
        <h2>Category tabs and product buttons</h2>
        <CategoryTabs categories={CATEGORIES} selectedId={category} onSelect={setCategory} panelId="gallery-products" />
        <div id="gallery-products" role="tabpanel" aria-labelledby={categoryTabId('gallery-products', category)} className={styles.grid}>
          {PRODUCTS.filter((p) => p.categoryId === category || category === 'draught').map((p) => (
            <ProductButton key={p.id} product={p} onPress={addProduct} qtyInBasket={qtyOf(p.id)} />
          ))}
          <ProductButton product={{ id: 'x', name: 'Disabled product', pricePence: 100, buttonColour: '#0369a1' }} onPress={() => undefined} disabled />
        </div>
      </section>

      <section className={styles.section}>
        <h2>Basket panel</h2>
        <div className={styles.basketDemo}>{panel}</div>
        <div className={styles.basketDemoEmpty}>
          <BasketPanel view={null} basket={{ lines: [] }} actions={<Button variant="primary" size="xl" block disabled>Pay</Button>} />
        </div>
      </section>

      <section className={styles.section}>
        <h2>Keypads</h2>
        <div className={styles.keypads}>
          <NumericKeypad label="Amount" valuePence={money} onChange={setMoney} captureKeyboard />
          <NumericKeypad label="Amount (no display)" valuePence={money} onChange={setMoney} hideDisplay />
          <div className={styles.darkBox}>
            <PinKeypad label="Enter your PIN" tone="dark" onSubmit={(pin) => setPinMessage(`Submitted ${pin.length} digits`)} error={pinMessage} captureKeyboard={false} />
          </div>
          <PinKeypad label="Approver's PIN" onSubmit={() => undefined} status="Too many attempts. Try again in 27 s" disabled captureKeyboard={false} />
        </div>
      </section>

      <section className={styles.section}>
        <h2>Form fields</h2>
        <div className={styles.form}>
          <TextField label="Club name" value={text} onChange={setText} hint="1 to 40 characters" />
          <TextField label="Product name" value="" onChange={() => undefined} error="Enter a product name" />
          <SelectField
            label="VAT rate"
            value={select}
            onChange={setSelect}
            options={[
              { value: '20', label: '20%' },
              { value: '5', label: '5%' },
              { value: '0', label: '0%' },
            ]}
          />
          <CheckboxField label="Member discount applies" checked={checked} onChange={setChecked} hint="Members get 15% off this product." />
          <TextAreaField label="Notes" value={notes} onChange={setNotes} hint="Optional" />
        </div>
      </section>

      <section className={styles.section}>
        <h2>Search list</h2>
        <SearchList
          label="Search members"
          query={query}
          onQueryChange={setQuery}
          results={results}
          getKey={(m) => m.id}
          renderItem={(m) => (
            <>
              <strong className="tabular">{m.memberNumber}</strong> {m.firstName} {m.lastName}
            </>
          )}
          onSelect={(m) => toast(`Selected ${m.firstName} ${m.lastName}`, { tone: 'success' })}
          idleMessage="Type a name or member number"
        />
      </section>

      <section className={styles.section}>
        <h2>Data table</h2>
        <DataTable
          caption="VAT summary"
          columns={[
            { key: 'rate', header: 'Rate', render: (r: { rate: number; net: number; vat: number; gross: number }) => `${r.rate}%`, rowHeader: true },
            { key: 'net', header: 'Net', render: (r) => <MoneyText pence={r.net} />, numeric: true },
            { key: 'vat', header: 'VAT', render: (r) => <MoneyText pence={r.vat} />, numeric: true },
            { key: 'gross', header: 'Gross', render: (r) => <MoneyText pence={r.gross} />, numeric: true },
          ]}
          rows={[
            { rate: 20, net: 8075, vat: 1615, gross: 9690 },
            { rate: 0, net: 212, vat: 0, gross: 212 },
          ]}
          getRowKey={(r) => String(r.rate)}
          footer={{ rate: 'Total', net: <MoneyText pence={8287} />, vat: <MoneyText pence={1615} />, gross: <MoneyText pence={9902} /> }}
        />
        <DataTable caption="Low stock" columns={[{ key: 'name', header: 'Product', render: (r: string) => r }]} rows={[]} getRowKey={(r) => r} emptyMessage="Nothing is low on stock" />
      </section>

      <section className={styles.section}>
        <h2>Overlays</h2>
        <div className={styles.row}>
          <Button onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button onClick={() => setConfirmOpen(true)}>Open confirm</Button>
          <Button onClick={() => void confirmDialog({ title: 'Cancel payment?', message: 'Every tender taken so far is discarded.', confirmLabel: 'Cancel payment', cancelLabel: 'Keep paying', tone: 'danger' })}>
            App-wide confirm
          </Button>
          <Button onClick={() => useUiStore.getState().showReceiptFallback({ html: SAMPLE_RECEIPT, title: 'Receipt DEV-000042' })}>Receipt fallback</Button>
          <Button onClick={() => void requirePermission('refund')}>Override (needs a non-manager login)</Button>
        </div>
        <div className={styles.row}>
          <Button onClick={() => toast('Drawer opened')}>Toast</Button>
          <Button onClick={() => toast('Period opened with a float of £100.00', { tone: 'success' })}>Success toast</Button>
          <Button onClick={() => toast('Maximum quantity is 999', { tone: 'warning' })}>Warning toast</Button>
          <Button onClick={() => toast('The basket could not be saved as a draft', { tone: 'danger' })}>Danger toast</Button>
        </div>
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Void Fairway Lager"
        description="Choose how many to remove."
        showCloseButton
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setModalOpen(false)}>
              Void
            </Button>
          </>
        }
      >
        <NumericKeypad label="Quantity (demo)" valuePence={money} onChange={setMoney} />
      </Modal>
      <ConfirmDialog
        open={confirmOpen}
        title="Mark booking settled?"
        message="The deposit balance is £0.00, so the booking can be settled."
        confirmLabel="Mark settled"
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />
      {!isWide && (
        <BottomSheet
          title="Basket"
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          summary={
            <>
              <span>{basketLines.reduce((n, l) => n + l.qty, 0)} items</span>
              <MoneyText pence={view.priced.totalPence} size="lg" strong testId="basket-bar-total" />
            </>
          }
          barActions={
            <Button variant="primary" size="lg">
              Pay
            </Button>
          }
        >
          <BasketPanel view={view} basket={basket} memberDiscountPercent={15} hideHeading />
        </BottomSheet>
      )}
    </Screen>
  );
}
