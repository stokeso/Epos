/**
 * Add / edit a deal (spec §4 Deal, §6.9; D-012, D-013, D-126): 'n for a price' or 'n for m',
 * the products it covers, active, and optional London start/end dates. The form checks itself
 * with rules/validation.validateDeal (the same messages the service returns) before asking for
 * permission; saving needs 'editCatalogue'.
 */
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { CheckboxField, TextField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import type { Category, Deal, DealType, Product } from '../../data/types';
import { MAX_PRICE_PENCE, formatPence, parsePoundsToPence, penceToPoundsText } from '../../rules/money';
import { datesFromDealWindow } from '../../rules/time';
import { validateDeal, type DealFormInput } from '../../rules/validation';
import { saveDeal } from '../../services/catalogue';
import { getCtx } from '../../store/appStore';
import { mergeErrors, parseWholeNumber, useFocusFirstError, useGatedForm, type FieldErrors } from './formHelpers';
import { AffixField, ChoiceGroup, FormError, Swatch } from './parts';
import styles from './backoffice.module.css';
import dealStyles from './DealsScreen.module.css';

const FIELDS = ['name', 'type', 'n', 'pricePence', 'm', 'productIds', 'active', 'startDate', 'endDate'] as const;

export interface DealDialogProps {
  /** null when adding. */
  deal: Deal | null;
  products: readonly Product[];
  categories: readonly Category[];
  onClose: () => void;
  onSaved: (saved: Deal) => void;
}

/** '2 for £8.00' / '3 for 2' from the form values, or null while they are incomplete. */
function summary(type: DealType, n: number, pricePence: number | null, m: number): string | null {
  if (!Number.isSafeInteger(n) || n < 2) return null;
  if (type === 'nForPrice') return pricePence === null ? null : `Any ${n} of the chosen products for ${formatPence(pricePence)}`;
  if (!Number.isSafeInteger(m) || m < 1 || m >= n) return null;
  const free = n - m;
  return `Buy any ${n}, pay for ${m}: the ${free === 1 ? 'cheapest one is' : `cheapest ${free} are`} free`;
}

export function DealDialog({ deal, products, categories, onClose, onSaved }: DealDialogProps) {
  const adding = deal === null;
  const dates = deal === null ? {} : datesFromDealWindow(deal.startsAt, deal.endsAt);
  const [name, setName] = useState(deal?.name ?? '');
  const [type, setType] = useState<DealType>(deal?.type ?? 'nForPrice');
  const [nText, setNText] = useState(deal === null ? '2' : String(deal.n));
  const [priceText, setPriceText] = useState(deal?.pricePence === undefined ? '' : penceToPoundsText(deal.pricePence));
  const [mText, setMText] = useState(deal?.m === undefined ? '' : String(deal.m));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(deal?.productIds ?? []));
  const [active, setActive] = useState(deal?.active ?? true);
  const [startDate, setStartDate] = useState(dates.startDate ?? '');
  const [endDate, setEndDate] = useState(dates.endDate ?? '');
  const [filter, setFilter] = useState('');
  const form = useGatedForm(FIELDS);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);
  const errors: FieldErrors = form.fieldErrors;
  const formId = adding ? 'deal-add-form' : 'deal-edit-form';

  const n = parseWholeNumber(nText);
  const price = parsePoundsToPence(priceText, MAX_PRICE_PENCE);
  const sentence = summary(type, n, price.ok && price.pence > 0 ? price.pence : null, parseWholeNumber(mText));

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const known = new Set(categories.map((c) => c.id));
    const list = categories.map((c) => ({
      key: c.id,
      name: c.name,
      colour: c.colour,
      products: products.filter((p) => p.categoryId === c.id && (needle === '' || p.name.toLowerCase().includes(needle))),
    }));
    const orphans = products.filter((p) => !known.has(p.categoryId) && (needle === '' || p.name.toLowerCase().includes(needle)));
    if (orphans.length > 0) list.push({ key: 'none', name: 'No category', colour: '#545b56', products: orphans });
    return list.filter((g) => g.products.length > 0);
  }, [categories, products, filter]);

  const toggle = (productId: string, on: boolean): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(productId);
      else next.delete(productId);
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const local: Record<string, string> = {};
    let pricePence: number | undefined;
    if (type === 'nForPrice') {
      if (price.ok) pricePence = price.pence;
      else local.pricePence = price.error;
    }
    const input: DealFormInput = {
      name,
      type,
      n,
      ...(type === 'nForPrice' ? (pricePence === undefined ? {} : { pricePence }) : { m: parseWholeNumber(mText) }),
      // Keep the products' display order; ids no longer in the catalogue are dropped.
      productIds: products.filter((p) => selected.has(p.id)).map((p) => p.id),
      active,
      ...(startDate === '' ? {} : { startDate }),
      ...(endDate === '' ? {} : { endDate }),
    };
    const check = validateDeal(input, { products });
    const problems = mergeErrors(local, check.ok ? {} : check.errors);
    if (Object.keys(problems).length > 0) {
      form.showErrors(problems);
      return;
    }
    const saved = await form.run('editCatalogue', (auth) => saveDeal(getCtx(), auth, deal?.id ?? null, input));
    if (saved !== null) onSaved(saved);
  };

  const selectedCount = products.filter((p) => selected.has(p.id)).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={adding ? 'Add deal' : 'Edit deal'}
      description={adding ? undefined : deal.name}
      size="lg"
      dismissible={!form.busy}
      testId="deal-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={form.busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={form.busy}>
            {adding ? 'Add deal' : 'Save'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <FormError message={form.formError} />
        <TextField label="Name" hint="Shown on the basket and receipt, e.g. Any 2 bottles for £8" value={name} onChange={setName} error={errors.name} maxLength={40} autoComplete="off" data-autofocus={adding ? true : undefined} />
        <ChoiceGroup<DealType>
          legend="Deal type"
          name="deal-type"
          value={type}
          onChange={setType}
          error={errors.type}
          options={[
            { value: 'nForPrice', label: 'Group price', hint: 'e.g. any 2 for £8' },
            { value: 'nForM', label: 'Some free', hint: 'e.g. 3 for 2' },
          ]}
        />
        <div className={styles.formGrid}>
          <AffixField label="Group size" suffix="items" value={nText} onChange={setNText} hint="2 to 99" maxLength={2} error={errors.n} />
          {type === 'nForPrice' ? (
            <AffixField
              label="Group price"
              prefix="£"
              value={priceText}
              onChange={setPriceText}
              inputMode="decimal"
              placeholder="0.00"
              hint="The price for the whole group"
              maxLength={10}
              error={errors.pricePence}
            />
          ) : (
            <AffixField label="Customer pays for" suffix="items" value={mText} onChange={setMText} hint="Fewer than the group size" maxLength={2} error={errors.m} />
          )}
        </div>
        <p className={dealStyles.sentence} aria-live="polite">
          {sentence ?? 'Fill in the group to see how the deal works.'}
        </p>

        <fieldset className={dealStyles.picker} aria-describedby={errors.productIds ? 'deal-products-error' : undefined}>
          <legend className={dealStyles.pickerLegend}>
            Products <span className={dealStyles.pickerCount}>{selectedCount} chosen</span>
          </legend>
          <TextField label="Find a product" type="search" value={filter} onChange={setFilter} autoComplete="off" />
          {errors.productIds ? (
            <div id="deal-products-error" className={styles.fieldError}>
              {errors.productIds}
            </div>
          ) : null}
          <div className={dealStyles.pickerList}>
            {groups.length === 0 && <p className={styles.muted}>No products match.</p>}
            {groups.map((group) => (
              <div key={group.key} className={dealStyles.pickerGroup} role="group" aria-label={group.name}>
                <p className={dealStyles.pickerGroupName} aria-hidden="true">
                  <Swatch colour={group.colour} size="sm" />
                  {group.name}
                </p>
                <ul className={dealStyles.pickerItems}>
                  {group.products.map((product) => (
                    <li key={product.id}>
                      <label className={`${dealStyles.pickerItem} ${selected.has(product.id) ? dealStyles.pickerItemOn : ''}`}>
                        <input
                          type="checkbox"
                          className={dealStyles.pickerCheck}
                          checked={selected.has(product.id)}
                          onChange={(event) => toggle(product.id, event.target.checked)}
                          aria-invalid={errors.productIds ? true : undefined}
                        />
                        <span className={dealStyles.pickerName}>
                          {product.name}
                          {!product.active && <span className={styles.muted}> (inactive)</span>}
                        </span>
                        <span className={`${dealStyles.pickerPrice} tabular`}>{formatPence(product.pricePence)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </fieldset>

        <section className={styles.formSection} aria-label="When it applies">
          <h3 className={styles.formSectionTitle}>When it applies</h3>
          <CheckboxField label="Active" hint="Inactive deals never apply" checked={active} onChange={setActive} error={errors.active} />
          <div className={styles.formGrid}>
            <TextField label="Start date" type="date" hint="Optional. From the start of this day" value={startDate} onChange={setStartDate} error={errors.startDate} />
            <TextField label="End date" type="date" hint="Optional. Until the end of this day" value={endDate} onChange={setEndDate} error={errors.endDate} />
          </div>
        </section>
      </form>
    </Modal>
  );
}
