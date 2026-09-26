/**
 * Deals (spec §4 Deal, §6.9, §7.2; D-012, D-013, D-051): multi-buy deals with their products,
 * status and dates. Add / edit in DealDialog; Deactivate / Reactivate with setDealActive.
 * Everything that saves needs 'editCatalogue'.
 */
import { useState } from 'react';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { useLoad } from '../../app/useLoad';
import type { Category, Deal, IsoInstant, Product } from '../../data/types';
import { isDealActiveAt } from '../../rules/deals';
import { formatPence } from '../../rules/money';
import { datesFromDealWindow, formatLocalDate } from '../../rules/time';
import { listCategories, listDeals, listProducts, setDealActive } from '../../services/catalogue';
import { nowIso, type ServiceContext } from '../../services/context';
import { getCtx } from '../../store/appStore';
import { useBasketStore } from '../../store/basketStore';
import { toast } from '../../store/uiStore';
import { DealDialog } from './DealDialog';
import { useGatedForm } from './formHelpers';
import { BackToMenu, Badge, FormError, PermissionNote, type BadgeTone } from './parts';
import styles from './backoffice.module.css';
import dealStyles from './DealsScreen.module.css';

interface Data {
  deals: Deal[];
  products: Product[];
  categories: Category[];
  /** When the list was loaded (for 'Applies now' / 'Ended'). */
  at: IsoInstant;
}

async function loadData(ctx: ServiceContext): Promise<Data> {
  const [deals, products, categories] = await Promise.all([listDeals(ctx), listProducts(ctx), listCategories(ctx)]);
  return { deals, products, categories, at: nowIso(ctx) };
}

/** '2 for £8.00' or '3 for 2'. */
function dealRule(deal: Deal): string {
  if (deal.type === 'nForPrice') return `${deal.n} for ${deal.pricePence === undefined ? '?' : formatPence(deal.pricePence)}`;
  return `${deal.n} for ${deal.m ?? '?'}`;
}

function dealDates(deal: Deal): string {
  const { startDate, endDate } = datesFromDealWindow(deal.startsAt, deal.endsAt);
  if (startDate !== undefined && endDate !== undefined) return `${formatLocalDate(startDate)} to ${formatLocalDate(endDate)}`;
  if (startDate !== undefined) return `From ${formatLocalDate(startDate)}`;
  if (endDate !== undefined) return `Until ${formatLocalDate(endDate)}`;
  return 'No start or end date';
}

function dealStatus(deal: Deal, at: IsoInstant): { label: string; tone: BadgeTone } {
  if (!deal.active) return { label: 'Inactive', tone: 'neutral' };
  if (isDealActiveAt(deal, at)) return { label: 'Applies now', tone: 'success' };
  if (deal.startsAt !== undefined && at < deal.startsAt) return { label: 'Not started', tone: 'info' };
  return { label: 'Ended', tone: 'warning' };
}

export function DealsScreen() {
  const load = useLoad(loadData, []);
  const [editing, setEditing] = useState<Deal | 'new' | null>(null);
  const toggleForm = useGatedForm();
  /** The deal whose Deactivate / Reactivate is saving: that button shows busy and keeps focus (D-134). */
  const [toggling, setToggling] = useState<string | null>(null);
  const data = load.data;

  const nameOf = (id: string): string | undefined => data?.products.find((p) => p.id === id)?.name;

  const afterChange = (message: string): void => {
    load.reload();
    // Baskets are priced with the deals in force now (D-011): reprice the open basket.
    void useBasketStore.getState().refresh();
    toast(message, { tone: 'success' });
  };

  const toggle = async (deal: Deal): Promise<void> => {
    if (toggleForm.busy) return;
    setToggling(deal.id);
    try {
      const saved = await toggleForm.run('editCatalogue', (auth) => setDealActive(getCtx(), auth, deal.id, !deal.active));
      if (saved !== null) afterChange(saved.active ? `${saved.name} reactivated` : `${saved.name} deactivated`);
    } finally {
      setToggling(null);
    }
  };

  return (
    <Screen
      title="Deals"
      description="The till applies whichever deals save the customer the most."
      actions={
        <>
          <BackToMenu />
          <Button variant="primary" onClick={() => setEditing('new')} disabled={data === undefined} className={styles.titleAction}>
            Add deal
          </Button>
        </>
      }
    >
      <PermissionNote action="editCatalogue" />
      {load.error !== null && <Banner tone="danger">{load.error}</Banner>}
      <FormError message={toggleForm.formError} />
      {data === undefined && load.error === null && <p className={styles.muted}>Loading deals…</p>}
      {data !== undefined && data.deals.length === 0 && <p className={styles.empty}>No deals yet. Add one such as “Any 2 bottles for £8”.</p>}

      {data !== undefined && data.deals.length > 0 && (
        <ul className={dealStyles.deals} aria-label="Deals">
          {data.deals.map((deal) => {
            const status = dealStatus(deal, data.at);
            const names = deal.productIds.map(nameOf).filter((n): n is string => n !== undefined);
            return (
              <li key={deal.id} className={`${dealStyles.deal} ${deal.active ? '' : dealStyles.dealInactive}`} data-testid="deal-row">
                <div className={dealStyles.dealHead}>
                  <span className={dealStyles.rule} aria-hidden="true">
                    {dealRule(deal)}
                  </span>
                  <div className={dealStyles.dealTitleBlock}>
                    <h2 className={dealStyles.dealName}>{deal.name}</h2>
                    <p className={dealStyles.dealMeta}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className={styles.rowMeta}>
                        <span className="visually-hidden">{dealRule(deal)}. </span>
                        {deal.type === 'nForPrice' ? 'Group price' : `Cheapest ${deal.n - (deal.m ?? 0)} free`} · {dealDates(deal)}
                      </span>
                    </p>
                  </div>
                </div>
                <p className={dealStyles.products}>
                  <span className={dealStyles.productsLabel}>{names.length === 1 ? '1 product: ' : `${names.length} products: `}</span>
                  {names.join(', ')}
                </p>
                <div className={dealStyles.dealActions}>
                  <Button onClick={() => setEditing(deal)} aria-label={`Edit ${deal.name}`} disabled={toggleForm.busy}>
                    Edit
                  </Button>
                  {/* The pressed toggle is busy (aria-disabled), not natively disabled, so it keeps
                      keyboard focus while it saves and afterwards, with its new label (D-134). */}
                  <Button
                    variant={deal.active ? 'dangerOutline' : 'secondary'}
                    onClick={() => void toggle(deal)}
                    aria-label={`${deal.active ? 'Deactivate' : 'Reactivate'} ${deal.name}`}
                    disabled={toggleForm.busy}
                    busy={toggling === deal.id}
                  >
                    {deal.active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing !== null && data !== undefined && (
        <DealDialog
          deal={editing === 'new' ? null : editing}
          products={data.products}
          categories={data.categories}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            afterChange(editing === 'new' ? `${saved.name} added` : `${saved.name} saved`);
          }}
        />
      )}
    </Screen>
  );
}
