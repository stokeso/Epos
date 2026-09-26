/**
 * Stock (spec §6.9, §8; D-079..D-082): the low-stock list (items at or below their low-stock
 * level, negative stock included; data-testid="low-stock-list"), every tracked product's level,
 * goods in, adjustments / waste, and each product's history. Levels and the low-stock list come
 * from services/stock; writes need 'stockControl'.
 */
import { useMemo, useState } from 'react';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { DataTable } from '../../components/DataTable';
import { TextField } from '../../components/FormField';
import { Screen } from '../../components/Screen';
import { useDebouncedValue } from '../../components/hooks';
import { useLoad } from '../../app/useLoad';
import type { StockMovement } from '../../data/types';
import type { ServiceContext } from '../../services/context';
import { listLowStock, listStockLevels } from '../../services/stock';
import { toast } from '../../store/uiStore';
import { AdjustStockDialog, GoodsInDialog, StockHistoryDialog, type StockLevel } from './StockDialogs';
import { BackToMenu, Badge, PermissionNote, Panel } from './parts';
import styles from './backoffice.module.css';
import stockStyles from './StockScreen.module.css';

interface Data {
  levels: StockLevel[];
  low: StockLevel[];
}

async function loadData(ctx: ServiceContext): Promise<Data> {
  const [levels, low] = await Promise.all([listStockLevels(ctx), listLowStock(ctx)]);
  return { levels, low };
}

type Dialog = { kind: 'goodsIn' | 'adjust'; productId: string } | { kind: 'history'; productId: string } | null;

export function StockScreen() {
  const load = useLoad(loadData, []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState('');
  const search = useDebouncedValue(query.trim().toLowerCase(), 120);
  const data = load.data;
  const lowIds = useMemo(() => new Set(data?.low.map((l) => l.product.id) ?? []), [data]);
  const rows = useMemo(() => (data?.levels ?? []).filter((l) => search === '' || l.product.name.toLowerCase().includes(search)), [data, search]);

  const saved = (movement: StockMovement, productName: string): void => {
    setDialog(null);
    load.reload();
    const qty = Math.abs(movement.qty);
    if (movement.reason === 'goodsIn') toast(`Goods in: ${qty} × ${productName}`, { tone: 'success' });
    else if (movement.reason === 'waste') toast(`Waste recorded: ${qty} × ${productName}`, { tone: 'success' });
    else toast(`${productName} adjusted by ${movement.qty > 0 ? '+' : '−'}${qty}`, { tone: 'success' });
  };

  const historyLevel = dialog?.kind === 'history' ? data?.levels.find((l) => l.product.id === dialog.productId) : undefined;

  return (
    <Screen
      title="Stock"
      description="Stock on hand is every delivery, sale, refund and adjustment added up."
      actions={
        <>
          <BackToMenu />
          <Button onClick={() => setDialog({ kind: 'adjust', productId: '' })} disabled={data === undefined} className={styles.titleAction}>
            Adjust stock
          </Button>
          <Button variant="primary" onClick={() => setDialog({ kind: 'goodsIn', productId: '' })} disabled={data === undefined} className={styles.titleAction}>
            Goods in
          </Button>
        </>
      }
    >
      <PermissionNote action="stockControl">You can look at stock levels. Recording goods in or an adjustment needs a manager PIN.</PermissionNote>
      {load.error !== null && <Banner tone="danger">{load.error}</Banner>}
      {data === undefined && load.error === null && <p className={styles.muted}>Loading stock…</p>}

      {data !== undefined && (
        <Panel
          title="Low stock"
          description="At or below the low-stock level, including anything below zero. Selling is never blocked."
          className={data.low.length > 0 ? stockStyles.lowPanel : undefined}
        >
          <div data-testid="low-stock-list">
            {data.low.length === 0 ? (
              <p className={styles.empty}>Nothing is low on stock.</p>
            ) : (
              <ul className={stockStyles.lowList} aria-label="Low stock">
                {data.low.map((level) => (
                  <li key={level.product.id} className={`${stockStyles.lowItem} ${level.onHand < 0 ? stockStyles.lowItemNegative : ''}`} data-testid="low-stock-item">
                    <div className={stockStyles.lowText}>
                      <span className={styles.rowTitle}>{level.product.name}</span>
                      <span className={styles.rowMeta}>
                        Low at {level.product.lowStockLevel} · per {level.product.stockUnit}
                      </span>
                    </div>
                    <div className={stockStyles.lowFigure}>
                      <span className={`${stockStyles.lowOnHand} tabular`} data-testid="low-stock-on-hand">
                        {level.onHand}
                      </span>
                      <span className={stockStyles.lowLabel}>on hand</span>
                    </div>
                    <Button onClick={() => setDialog({ kind: 'goodsIn', productId: level.product.id })} aria-label={`Goods in: ${level.product.name}`} className={stockStyles.lowAction}>
                      Goods in
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}

      {data !== undefined && (
        <Panel title="Stock levels" description="Tracked products only. Tap a product for its history.">
          <div className={styles.toolbar} role="search">
            <TextField label="Search stock" type="search" value={query} onChange={setQuery} placeholder="Product name" autoComplete="off" />
            <p className={styles.toolbarSummary} aria-live="polite">
              {rows.length === data.levels.length ? `${rows.length} tracked products` : `Showing ${rows.length} of ${data.levels.length}`}
            </p>
          </div>
          <DataTable
            caption="Stock levels table"
            hideCaption
            testId="stock-levels"
            columns={[
              {
                key: 'product',
                header: 'Product',
                rowHeader: true,
                render: (level: StockLevel) => (
                  <button
                    type="button"
                    className={stockStyles.productLink}
                    onClick={() => setDialog({ kind: 'history', productId: level.product.id })}
                    aria-label={`${level.product.name} history`}
                  >
                    <span className={stockStyles.productName}>{level.product.name}</span>
                    <span className={styles.rowMeta}>
                      per {level.product.stockUnit}
                      {level.product.active ? '' : ' · inactive'}
                    </span>
                  </button>
                ),
              },
              {
                key: 'onHand',
                header: 'On hand',
                numeric: true,
                render: (level: StockLevel) => (
                  <span className={stockStyles.onHandCell}>
                    {lowIds.has(level.product.id) && <Badge tone={level.onHand < 0 ? 'danger' : 'warning'}>{level.onHand < 0 ? 'Negative' : 'Low'}</Badge>}
                    <span className={`${stockStyles.onHand} ${level.onHand < 0 ? styles.negative : ''}`}>{level.onHand}</span>
                  </span>
                ),
              },
              { key: 'low', header: 'Low at', numeric: true, render: (level: StockLevel) => level.product.lowStockLevel },
            ]}
            rows={rows}
            getRowKey={(level) => level.product.id}
            emptyMessage={data.levels.length === 0 ? 'No products are stock-tracked' : 'No products match'}
          />
        </Panel>
      )}

      {data !== undefined && dialog?.kind === 'goodsIn' && (
        <GoodsInDialog levels={data.levels} initialProductId={dialog.productId} onClose={() => setDialog(null)} onSaved={saved} />
      )}
      {data !== undefined && dialog?.kind === 'adjust' && (
        <AdjustStockDialog levels={data.levels} initialProductId={dialog.productId} onClose={() => setDialog(null)} onSaved={saved} />
      )}
      {historyLevel !== undefined && (
        <StockHistoryDialog
          level={historyLevel}
          lowStock={lowIds.has(historyLevel.product.id)}
          onClose={() => setDialog(null)}
          onGoodsIn={() => setDialog({ kind: 'goodsIn', productId: historyLevel.product.id })}
          onAdjust={() => setDialog({ kind: 'adjust', productId: historyLevel.product.id })}
        />
      )}
    </Screen>
  );
}
