/**
 * Categories (spec §6.9; D-051, D-105): the till's tabs, their order and colours. A category can
 * be deleted only when no product uses it (canDeleteCategory; the service checks again).
 * Saving and deleting need 'editCatalogue'.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { TextField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { Screen } from '../../components/Screen';
import { useLoad } from '../../app/useLoad';
import type { Category, NewCategory, Product } from '../../data/types';
import { canDeleteCategory, validateCategory } from '../../rules/validation';
import { deleteCategory, listCategories, listProducts, saveCategory } from '../../services/catalogue';
import type { ServiceContext } from '../../services/context';
import { getCtx } from '../../store/appStore';
import { useBasketStore } from '../../store/basketStore';
import { confirmDialog, toast } from '../../store/uiStore';
import { parseWholeNumber, useFocusFirstError, useGatedForm } from './formHelpers';
import { BackToMenu, ColourField, FormError, PermissionNote, Swatch } from './parts';
import styles from './backoffice.module.css';

interface Data {
  categories: Category[];
  products: Product[];
}

async function loadData(ctx: ServiceContext): Promise<Data> {
  const [categories, products] = await Promise.all([listCategories(ctx), listProducts(ctx)]);
  return { categories, products };
}

/** Colour offered for a new category. */
const NEW_CATEGORY_COLOUR = '#0f766e';

interface Draft {
  id: string | null;
  values: NewCategory;
}

export function CategoriesScreen() {
  const load = useLoad(loadData, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const data = load.data;

  const countFor = (categoryId: string): number => data?.products.filter((p) => p.categoryId === categoryId).length ?? 0;

  const startAdd = (): void => {
    const highest = Math.max(0, ...(data?.categories.map((c) => c.sortOrder) ?? []));
    setDraft({ id: null, values: { name: '', sortOrder: highest + 1, colour: NEW_CATEGORY_COLOUR } });
  };

  const done = (message: string): void => {
    setDraft(null);
    load.reload();
    void useBasketStore.getState().refresh();
    toast(message, { tone: 'success' });
  };

  return (
    <Screen
      title="Categories"
      description="Each category is a tab on the till. Lower positions come first."
      actions={
        <>
          <BackToMenu />
          <Button variant="primary" onClick={startAdd} disabled={data === undefined} className={styles.titleAction}>
            Add category
          </Button>
        </>
      }
    >
      <PermissionNote action="editCatalogue" />
      {load.error !== null && <Banner tone="danger">{load.error}</Banner>}
      {data === undefined && load.error === null && <p className={styles.muted}>Loading categories…</p>}
      {data !== undefined && data.categories.length === 0 && <p className={styles.empty}>No categories yet. Add the first one.</p>}
      {data !== undefined && data.categories.length > 0 && (
        <ul className={styles.gridList} aria-label="Categories">
          {data.categories.map((category) => (
            <li key={category.id}>
              <CategoryRow category={category} productCount={countFor(category.id)} onEdit={() => setDraft({ id: category.id, values: { name: category.name, sortOrder: category.sortOrder, colour: category.colour } })} />
            </li>
          ))}
        </ul>
      )}

      {draft !== null && data !== undefined && (
        <CategoryDialog
          draft={draft}
          categories={data.categories}
          products={data.products}
          onClose={() => setDraft(null)}
          onSaved={(saved) => done(draft.id === null ? `${saved.name} added` : `${saved.name} saved`)}
          onDeleted={(deleted) => done(`${deleted.name} deleted`)}
        />
      )}
    </Screen>
  );
}

function CategoryRow({ category, productCount, onEdit }: { category: Category; productCount: number; onEdit: () => void }) {
  const metaId = useId();
  return (
    <button type="button" className={styles.rowButton} onClick={onEdit} aria-label={`Edit ${category.name}`} aria-describedby={metaId} data-testid="category-row">
      <Swatch colour={category.colour} size="lg" />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{category.name}</span>
        <span id={metaId} className={styles.rowMeta}>
          {productCount === 1 ? '1 product' : `${productCount} products`} · position {category.sortOrder}
        </span>
      </span>
      <svg className={styles.chevron} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

interface CategoryDialogProps {
  draft: Draft;
  categories: readonly Category[];
  products: readonly Product[];
  onClose: () => void;
  onSaved: (saved: Category) => void;
  onDeleted: (deleted: Category) => void;
}

function CategoryDialog({ draft, categories, products, onClose, onSaved, onDeleted }: CategoryDialogProps) {
  const adding = draft.id === null;
  const [name, setName] = useState(draft.values.name);
  const [sortText, setSortText] = useState(String(draft.values.sortOrder));
  const [colour, setColour] = useState(draft.values.colour);
  const form = useGatedForm(['name', 'sortOrder', 'colour']);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);
  const formId = adding ? 'category-add-form' : 'category-edit-form';
  const inUse = draft.id === null ? 0 : products.filter((p) => p.categoryId === draft.id).length;
  const deletable = draft.id !== null && canDeleteCategory(draft.id, products);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input: NewCategory = { name, sortOrder: parseWholeNumber(sortText), colour: colour.trim() };
    const check = validateCategory(input, { categories, ...(draft.id === null ? {} : { editingId: draft.id }) });
    if (!check.ok) {
      form.showErrors(check.errors);
      return;
    }
    const saved = await form.run('editCatalogue', (auth) => saveCategory(getCtx(), auth, draft.id, input));
    if (saved !== null) onSaved(saved);
  };

  const remove = async (): Promise<void> => {
    if (draft.id === null) return;
    const id = draft.id;
    const sure = await confirmDialog({
      title: 'Delete category?',
      message: `${draft.values.name} will be removed from the till. Past sales are not affected.`,
      confirmLabel: 'Delete category',
      tone: 'danger',
    });
    if (!sure) return;
    const deleted = await form.run('editCatalogue', (auth) => deleteCategory(getCtx(), auth, id));
    if (deleted !== null) onDeleted(deleted);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={adding ? 'Add category' : 'Edit category'}
      description={adding ? undefined : draft.values.name}
      dismissible={!form.busy}
      testId="category-dialog"
      footer={
        <>
          {!adding && (
            <Button variant="dangerOutline" onClick={() => void remove()} disabled={form.busy || !deletable} className={styles.footerStart}>
              Delete category
            </Button>
          )}
          <Button onClick={onClose} disabled={form.busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={form.busy}>
            {adding ? 'Add category' : 'Save'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <FormError message={form.formError} />
        <TextField label="Name" value={name} onChange={setName} error={form.fieldErrors.name} maxLength={30} autoComplete="off" data-autofocus={adding ? true : undefined} />
        <TextField
          label="Position"
          hint="Tabs are shown in this order on the till"
          value={sortText}
          onChange={setSortText}
          inputMode="numeric"
          maxLength={6}
          error={form.fieldErrors.sortOrder}
        />
        <ColourField label="Colour" value={colour} onChange={setColour} error={form.fieldErrors.colour} previewText={name} />
        {!adding && !deletable && (
          <p className={`${styles.muted} ${styles.small}`}>
            {inUse === 1 ? 'This category has 1 product.' : `This category has ${inUse} products.`} Move them to another category before deleting it.
          </p>
        )}
      </form>
    </Modal>
  );
}
