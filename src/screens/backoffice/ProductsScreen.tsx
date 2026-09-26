/**
 * Products (spec §6.9; D-051, D-087, D-105): every product grouped by category, with search and a
 * category filter. Tap a product to edit it; 'Add product' starts from the category defaults
 * (services/catalogue.newProductDefaults). Lists are visible to everyone; saving needs
 * 'editCatalogue' (a manager PIN for other roles, D-070).
 */
import { useId, useMemo, useState } from 'react';
import { Banner } from '../../components/Banner';
import { Button, ButtonLink } from '../../components/Button';
import { SelectField, TextField } from '../../components/FormField';
import { MoneyText } from '../../components/MoneyText';
import { Screen } from '../../components/Screen';
import { useDebouncedValue } from '../../components/hooks';
import { errorMessage } from '../../app/errors';
import { useLoad } from '../../app/useLoad';
import type { Category, Product } from '../../data/types';
import { formatPence } from '../../rules/money';
import { listCategories, listProducts, newProductDefaults } from '../../services/catalogue';
import type { ServiceContext } from '../../services/context';
import { getCtx, useAppStore } from '../../store/appStore';
import { useBasketStore } from '../../store/basketStore';
import { toast } from '../../store/uiStore';
import { ProductDialog, type ProductDraft } from './ProductDialog';
import { BackToMenu, Badge, PermissionNote, Swatch } from './parts';
import styles from './backoffice.module.css';

interface Catalogue {
  products: Product[];
  categories: Category[];
}

async function loadCatalogue(ctx: ServiceContext): Promise<Catalogue> {
  const [products, categories] = await Promise.all([listProducts(ctx), listCategories(ctx)]);
  return { products, categories };
}

export function ProductsScreen() {
  const catalogue = useLoad(loadCatalogue, []);
  const memberDiscountPercent = useAppStore((s) => s.settings?.memberDiscountPercent);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [starting, setStarting] = useState(false);
  const search = useDebouncedValue(query.trim().toLowerCase(), 120);

  const data = catalogue.data;
  const groups = useMemo(() => {
    if (data === undefined) return [];
    const matches = data.products.filter(
      (p) => (categoryFilter === '' || p.categoryId === categoryFilter) && (search === '' || p.name.toLowerCase().includes(search)),
    );
    const byCategory = data.categories
      .map((category) => ({ key: category.id, name: category.name, colour: category.colour, products: matches.filter((p) => p.categoryId === category.id) }))
      .filter((group) => group.products.length > 0);
    const known = new Set(data.categories.map((c) => c.id));
    const orphans = matches.filter((p) => !known.has(p.categoryId));
    if (orphans.length > 0) byCategory.push({ key: 'none', name: 'No category', colour: '#545b56', products: orphans });
    return byCategory;
  }, [data, categoryFilter, search]);
  const shown = groups.reduce((n, g) => n + g.products.length, 0);

  const startAdd = async (): Promise<void> => {
    if (data === undefined || data.categories.length === 0) return;
    const categoryId = categoryFilter !== '' ? categoryFilter : (data.categories[0]?.id ?? '');
    setStarting(true);
    try {
      const values = await newProductDefaults(getCtx(), categoryId);
      setDraft({ id: null, values });
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setStarting(false);
    }
  };

  const startEdit = (product: Product): void => {
    const { id, name, categoryId, pricePence, vatRate, memberDiscountEligible, stockTracked, stockUnit, lowStockLevel, buttonColour, sortOrder, active } = product;
    setDraft({ id, values: { name, categoryId, pricePence, vatRate, memberDiscountEligible, stockTracked, stockUnit, lowStockLevel, buttonColour, sortOrder, active } });
  };

  const saved = (product: Product): void => {
    const previous = draft?.id === null ? undefined : data?.products.find((p) => p.id === draft?.id);
    setDraft(null);
    catalogue.reload();
    // Open baskets and tabs are priced from the current product (D-009).
    void useBasketStore.getState().refresh();
    if (previous === undefined) toast(`${product.name} added`, { tone: 'success' });
    else if (previous.pricePence !== product.pricePence) {
      toast(`${product.name}: price changed from ${formatPence(previous.pricePence)} to ${formatPence(product.pricePence)}`, { tone: 'success' });
    } else toast(`${product.name} saved`, { tone: 'success' });
  };

  const noCategories = data !== undefined && data.categories.length === 0;

  return (
    <Screen
      title="Products"
      description="Prices include VAT. Tap a product to change it."
      actions={
        <>
          <BackToMenu />
          <Button variant="primary" onClick={() => void startAdd()} busy={starting} disabled={data === undefined || noCategories} className={styles.titleAction}>
            Add product
          </Button>
        </>
      }
    >
      <PermissionNote action="editCatalogue" />
      {catalogue.error !== null && <Banner tone="danger">{catalogue.error}</Banner>}
      {noCategories && (
        <Banner tone="info" action={<ButtonLink to="/backoffice/categories">Categories</ButtonLink>}>
          Add a category before adding products.
        </Banner>
      )}

      {data !== undefined && data.products.length > 0 && (
        <div className={styles.toolbar} role="search">
          <TextField label="Search products" type="search" value={query} onChange={setQuery} placeholder="Name" autoComplete="off" />
          <SelectField
            label="Category"
            value={categoryFilter}
            onChange={setCategoryFilter}
            options={[{ value: '', label: 'All categories' }, ...data.categories.map((c) => ({ value: c.id, label: c.name }))]}
          />
          <p className={styles.toolbarSummary} aria-live="polite">
            {shown === data.products.length ? `${shown} products` : `Showing ${shown} of ${data.products.length}`}
          </p>
        </div>
      )}

      {data === undefined && catalogue.error === null && <p className={styles.muted}>Loading products…</p>}
      {data !== undefined && data.products.length === 0 && !noCategories && <p className={styles.empty}>No products yet. Add the first one.</p>}
      {data !== undefined && data.products.length > 0 && shown === 0 && <p className={styles.empty}>No products match.</p>}

      {groups.map((group) => (
        <section key={group.key} className={styles.group} aria-label={group.name}>
          <h2 className={styles.groupHead}>
            <Swatch colour={group.colour} size="sm" />
            {group.name}
            <span className={styles.groupCount}>{group.products.length}</span>
          </h2>
          <ul className={styles.gridList}>
            {group.products.map((product) => (
              <li key={product.id}>
                <ProductRow product={product} onEdit={startEdit} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {draft !== null && data !== undefined && (
        <ProductDialog
          draft={draft}
          products={data.products}
          categories={data.categories}
          memberDiscountPercent={memberDiscountPercent}
          onClose={() => setDraft(null)}
          onSaved={saved}
        />
      )}
    </Screen>
  );
}

function productMeta(product: Product): string {
  const parts = [`VAT ${product.vatRate}%`, `per ${product.stockUnit}`];
  parts.push(product.stockTracked ? `low at ${product.lowStockLevel}` : 'stock not tracked');
  return parts.join(' · ');
}

function ProductRow({ product, onEdit }: { product: Product; onEdit: (product: Product) => void }) {
  const metaId = useId();
  return (
    <button
      type="button"
      className={`${styles.rowButton} ${product.active ? '' : styles.rowInactive}`}
      onClick={() => onEdit(product)}
      aria-label={`Edit ${product.name}`}
      aria-describedby={metaId}
      data-testid="product-row"
    >
      <Swatch colour={product.buttonColour} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitleLine}>
          <span className={styles.rowTitle}>{product.name}</span>
          {!product.active && <Badge>Inactive</Badge>}
          {!product.memberDiscountEligible && <Badge tone="info">No member discount</Badge>}
        </span>
        <span id={metaId} className={styles.rowMeta}>
          <span className="visually-hidden">
            {formatPence(product.pricePence)}
            {product.active ? '' : ', inactive'}
            {product.memberDiscountEligible ? '' : ', no member discount'},{' '}
          </span>
          {productMeta(product)}
        </span>
      </span>
      <span className={styles.rowEnd}>
        <MoneyText pence={product.pricePence} size="lg" strong />
        <svg className={styles.chevron} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
}
