/**
 * Add / edit a product (spec §6.9; D-007, D-087, D-105, D-120). The price is typed as pounds
 * ('4.50') and parsed with parsePoundsToPence. Saving needs 'editCatalogue'; a price change
 * writes the priceChange audit event inside services/catalogue.saveProduct.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { CheckboxField, SelectField, TextField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import type { Category, NewProduct, Product } from '../../data/types';
import { MAX_PRICE_PENCE, formatPence, parsePoundsToPence, penceToPoundsText } from '../../rules/money';
import { validateProduct } from '../../rules/validation';
import { VAT_RATE_CHOICES } from '../../rules/vat';
import { newProductDefaults, saveProduct } from '../../services/catalogue';
import { getCtx } from '../../store/appStore';
import { mergeErrors, parseWholeNumber, useFocusFirstError, useGatedForm, type FieldErrors } from './formHelpers';
import { AffixField, ColourField, FormError } from './parts';
import styles from './backoffice.module.css';

export interface ProductDraft {
  /** null when adding. */
  id: string | null;
  values: NewProduct;
}

const FIELDS = [
  'name',
  'categoryId',
  'pricePence',
  'vatRate',
  'memberDiscountEligible',
  'stockTracked',
  'stockUnit',
  'lowStockLevel',
  'buttonColour',
  'sortOrder',
  'active',
] as const;

export interface ProductDialogProps {
  draft: ProductDraft;
  products: readonly Product[];
  categories: readonly Category[];
  memberDiscountPercent: number | undefined;
  onClose: () => void;
  onSaved: (saved: Product) => void;
}

export function ProductDialog({ draft, products, categories, memberDiscountPercent, onClose, onSaved }: ProductDialogProps) {
  const initial = draft.values;
  const adding = draft.id === null;
  const [name, setName] = useState(initial.name);
  const [categoryId, setCategoryId] = useState(initial.categoryId);
  const [priceText, setPriceText] = useState(adding && initial.pricePence === 0 ? '' : penceToPoundsText(initial.pricePence));
  const [vatRate, setVatRate] = useState(String(initial.vatRate));
  const [colour, setColour] = useState(initial.buttonColour);
  const [colourTouched, setColourTouched] = useState(false);
  const [sortText, setSortText] = useState(String(initial.sortOrder));
  const [sortTouched, setSortTouched] = useState(false);
  const [eligible, setEligible] = useState(initial.memberDiscountEligible);
  const [tracked, setTracked] = useState(initial.stockTracked);
  const [stockUnit, setStockUnit] = useState(initial.stockUnit);
  const [lowText, setLowText] = useState(String(initial.lowStockLevel));
  const [active, setActive] = useState(initial.active);
  const form = useGatedForm(FIELDS);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);
  const errors: FieldErrors = form.fieldErrors;
  const formId = adding ? 'product-add-form' : 'product-edit-form';

  const changeCategory = (next: string): void => {
    setCategoryId(next);
    // A new product takes its colour and position from its category (D-105) unless typed in.
    if (!adding || next === '') return;
    newProductDefaults(getCtx(), next).then(
      (defaults) => {
        if (!colourTouched) setColour(defaults.buttonColour);
        if (!sortTouched) setSortText(String(defaults.sortOrder));
      },
      () => undefined,
    );
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const price = parsePoundsToPence(priceText, MAX_PRICE_PENCE);
    const input: NewProduct = {
      name,
      categoryId,
      pricePence: price.ok ? price.pence : 0,
      vatRate: Number(vatRate),
      memberDiscountEligible: eligible,
      stockTracked: tracked,
      stockUnit,
      lowStockLevel: tracked ? parseWholeNumber(lowText) : 0,
      buttonColour: colour.trim(),
      sortOrder: parseWholeNumber(sortText),
      active,
    };
    const check = validateProduct(input, { products, categories, ...(draft.id === null ? {} : { editingId: draft.id }) });
    const problems = mergeErrors(price.ok ? {} : { pricePence: price.error }, check.ok ? {} : check.errors);
    if (Object.keys(problems).length > 0) {
      form.showErrors(problems);
      return;
    }
    const saved = await form.run('editCatalogue', (auth) => saveProduct(getCtx(), auth, draft.id, input));
    if (saved !== null) onSaved(saved);
  };

  const priceForPreview = parsePoundsToPence(priceText, MAX_PRICE_PENCE);
  const categoryOptions = categories.map((c) => ({ value: c.id, label: c.name }));
  if (!categories.some((c) => c.id === categoryId) && categoryId !== '') {
    categoryOptions.push({ value: categoryId, label: 'Deleted category' });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={adding ? 'Add product' : 'Edit product'}
      description={adding ? undefined : initial.name}
      size="lg"
      dismissible={!form.busy}
      testId="product-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={form.busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={form.busy}>
            {adding ? 'Add product' : 'Save'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <FormError message={form.formError} />
        <div className={styles.formGrid}>
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            error={errors.name}
            maxLength={40}
            autoComplete="off"
            className={styles.span2}
            data-autofocus={adding ? true : undefined}
          />
          <SelectField
            label="Category"
            value={categoryId}
            onChange={changeCategory}
            options={categoryOptions}
            placeholder={categoryId === '' ? 'Choose a category' : undefined}
            error={errors.categoryId}
          />
          <AffixField
            label="Price"
            prefix="£"
            value={priceText}
            onChange={setPriceText}
            inputMode="decimal"
            placeholder="0.00"
            hint="Including VAT, e.g. 4.50"
            maxLength={10}
            error={errors.pricePence}
          />
          <SelectField
            label="VAT rate"
            value={vatRate}
            onChange={setVatRate}
            options={VAT_RATE_CHOICES.map((rate) => ({ value: String(rate), label: `${rate}%` }))}
            error={errors.vatRate}
          />
          <TextField
            label="Position in category"
            hint="Lower numbers come first on the till"
            value={sortText}
            onChange={(value) => {
              setSortText(value);
              setSortTouched(true);
            }}
            inputMode="numeric"
            maxLength={6}
            error={errors.sortOrder}
          />
          <div className={styles.span2}>
            <ColourField
              label="Button colour"
              value={colour}
              onChange={(value) => {
                setColour(value);
                setColourTouched(true);
              }}
              error={errors.buttonColour}
              previewText={name}
              previewDetail={priceForPreview.ok ? formatPence(priceForPreview.pence) : undefined}
            />
          </div>
        </div>

        <section className={styles.formSection} aria-label="Stock">
          <h3 className={styles.formSectionTitle}>Stock</h3>
          <CheckboxField
            label="Track stock"
            hint="Sales take tracked products off the stock level"
            checked={tracked}
            onChange={setTracked}
            error={errors.stockTracked}
          />
          <div className={styles.formGrid}>
            <TextField label="Stock unit" hint="e.g. pint, bottle, measure" value={stockUnit} onChange={setStockUnit} maxLength={20} error={errors.stockUnit} />
            <TextField
              label="Low-stock level"
              hint={tracked ? 'Listed as low at or below this' : 'Only for tracked products'}
              value={tracked ? lowText : '0'}
              onChange={setLowText}
              inputMode="numeric"
              maxLength={4}
              disabled={!tracked}
              error={errors.lowStockLevel}
            />
          </div>
        </section>

        <section className={styles.formSection} aria-label="On the till">
          <h3 className={styles.formSectionTitle}>On the till</h3>
          <CheckboxField
            label="Member discount applies"
            hint={memberDiscountPercent === undefined ? 'Members get their discount on this product' : `Members get ${memberDiscountPercent}% off this product`}
            checked={eligible}
            onChange={setEligible}
            error={errors.memberDiscountEligible}
          />
          <CheckboxField
            label="Active"
            hint="Inactive products are hidden from the till but kept on past receipts"
            checked={active}
            onChange={setActive}
            error={errors.active}
          />
        </section>
      </form>
    </Modal>
  );
}
