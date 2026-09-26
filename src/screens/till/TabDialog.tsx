/**
 * Tabs from the till (spec §6.6; architecture §5.4; D-063..D-065):
 * - basket with lines, not a tab: open a new tab by Name or Table (the basket moves onto it), or
 *   add the basket to an open tab;
 * - a tab on the till: 'Save to tab' parks it (the lines go back on the tab and the till clears);
 *   with every line voided the button reads 'Remove tab', since parkTab then deletes the tab;
 * - empty basket: load an open tab onto the till.
 * Every operation goes through requirePermission('tabs') and one tabs service call.
 * A refused label (e.g. empty) is announced and its field focused; the field stays focusable
 * (read-only) while a tab opens, so focus never falls out of the dialog (D-134).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errorCode, fieldErrorsOf, requirePermission, useLoad } from '../../app';
import { Banner, Button, ButtonLink, Modal, MoneyText, TextField } from '../../components';
import type { TabLabelType } from '../../data/types';
import { hasNoLines, isBasketEmpty } from '../../rules/basket';
import { formatPence } from '../../rules/money';
import { tabDisplayLabel } from '../../rules/validation';
import type { Authorisation } from '../../services/override';
import { addBasketToTab, listOpenTabs, loadTab, openNewTab, parkTab, type TabSummary } from '../../services/tabs';
import { getCtx, toast, useBasketStore } from '../../store';
import { ChoiceGroup } from './ChoiceGroup';
import { tillErrorMessage } from './tillErrors';
import styles from './TillDialogs.module.css';

export const TAB_DIALOG_TITLE = 'Tab';

export interface TabDialogProps {
  open: boolean;
  onClose: () => void;
}

export function TabDialog({ open, onClose }: TabDialogProps) {
  if (!open) return null;
  return <TabDialogBody onClose={onClose} />;
}

const LABEL_TYPES = [
  { value: 'name', label: 'Name' },
  { value: 'table', label: 'Table' },
] as const satisfies readonly { value: TabLabelType; label: string }[];

function TabDialogBody({ onClose }: { onClose: () => void }) {
  const basket = useBasketStore((s) => s.basket);
  const tab = useBasketStore((s) => s.view?.tab);
  const tabs = useLoad((ctx) => listOpenTabs(ctx, useBasketStore.getState().basket), [basket.tabId]);
  const [labelType, setLabelType] = useState<TabLabelType>('name');
  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  /** Stops a second operation (e.g. Enter twice) before `busy` renders. */
  const running = useRef(false);

  const inTabMode = basket.tabId !== undefined;
  const noLines = hasNoLines(basket);
  const emptyBasket = isBasketEmpty(basket);
  const bookingAttached = basket.bookingId !== undefined;
  const canMove = !inTabMode && !noLines && !bookingAttached;
  const others = (tabs.data ?? []).filter((summary) => !summary.onTill);

  /** requirePermission('tabs') -> exactly one service call with that Authorisation (D-070). */
  const runWithAuth = async (key: string, operation: (auth: Authorisation) => Promise<string>): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setError(null);
    setLabelError(null);
    try {
      const auth = await requirePermission('tabs');
      if (auth === null) return;
      setBusy(key);
      toast(await operation(auth), { tone: 'success' });
      onClose();
    } catch (caught) {
      const fieldError = fieldErrorsOf(caught).label;
      if (fieldError !== undefined) setLabelError(fieldError);
      else setError(tillErrorMessage(caught));
      if (errorCode(caught) === 'TAB_NOT_OPEN') tabs.reload();
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  // A refused label: focus its field (as the back-office forms do), once the dialog is idle again.
  const isBusy = busy !== null;
  useEffect(() => {
    if (labelError === null || isBusy) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
  }, [labelError, isBusy]);

  const openTab = (event: FormEvent): void => {
    event.preventDefault();
    void runWithAuth('new', async (auth) => {
      const result = await openNewTab(getCtx(), auth, useBasketStore.getState().basket, labelType, label);
      await useBasketStore.getState().load(result.basket);
      return `Basket moved to new tab ${tabDisplayLabel(result.tab)}`;
    });
  };

  const addTo = (summary: TabSummary): void => {
    void runWithAuth(summary.tab.id, async (auth) => {
      const result = await addBasketToTab(getCtx(), auth, useBasketStore.getState().basket, summary.tab.id);
      await useBasketStore.getState().load(result.basket);
      return `Added to tab ${summary.displayLabel}`;
    });
  };

  const load = (summary: TabSummary): void => {
    void runWithAuth(summary.tab.id, async (auth) => {
      const next = await loadTab(getCtx(), auth, useBasketStore.getState().basket, summary.tab.id);
      await useBasketStore.getState().load(next);
      return `Tab ${summary.displayLabel} is on the till`;
    });
  };

  const park = (): void => {
    const label = tab === undefined ? null : tabDisplayLabel(tab);
    void runWithAuth('park', async (auth) => {
      const parked = useBasketStore.getState().basket;
      // With no lines left, parkTab deletes the tab instead of saving it (D-063 d): say so.
      const removing = hasNoLines(parked);
      const next = await parkTab(getCtx(), auth, parked);
      await useBasketStore.getState().load(next);
      if (removing) return `${label === null ? 'Tab' : `Tab ${label}`} removed (no items left)`;
      return `Saved to ${label ?? 'the tab'}`;
    });
  };

  let description: string;
  if (inTabMode && noLines) description = 'This tab has no items left. Remove the tab, or add items to keep it open.';
  else if (inTabMode) description = 'This tab is on the till. Add items, then save them to the tab, or press Pay to settle it.';
  else if (emptyBasket) description = 'The basket is empty. Load an open tab onto the till, or add items first to start a new tab.';
  else if (noLines) description = 'Add items to the basket first.';
  else description = 'Move the basket onto a new tab, or add it to a tab that is already open.';

  const footer = (
    <>
      {inTabMode && (
        <Button variant={noLines ? 'danger' : 'primary'} onClick={park} busy={busy === 'park'} disabled={isBusy || bookingAttached}>
          {noLines ? 'Remove tab' : 'Save to tab'}
        </Button>
      )}
      <Button variant="secondary" onClick={onClose} disabled={isBusy}>
        Cancel
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={TAB_DIALOG_TITLE} description={description} size="md" dismissible={!isBusy} testId="tab-dialog" footer={footer}>
      <div className={styles.stack}>
        {error !== null && <Banner tone="danger">{error}</Banner>}

        {inTabMode && (
          <div className={styles.current}>
            <div className={styles.currentText}>
              <span className={styles.currentLabel}>On the till</span>
              <span className={styles.currentValue}>{tab === undefined ? 'Loading…' : tabDisplayLabel(tab)}</span>
            </div>
          </div>
        )}
        {inTabMode && bookingAttached && (
          <Banner tone="warning" role="none">
            Detach the booking first: bookings are never stored on tabs. To use a deposit, press Pay with the booking attached.
          </Banner>
        )}

        {!inTabMode && !noLines && bookingAttached && (
          <Banner tone="warning" role="none">
            Detach the booking first: bookings are never stored on tabs.
          </Banner>
        )}

        {canMove && (
          <section className={styles.section} aria-labelledby={`${formId}-new`}>
            <h3 id={`${formId}-new`} className={styles.sectionHeading}>
              New tab
            </h3>
            <form ref={formRef} id={formId} className={styles.form} onSubmit={openTab} noValidate>
              <ChoiceGroup
                legend="Tab by"
                name={`${formId}-type`}
                value={labelType}
                onChange={(value) => {
                  setLabelType(value);
                  setLabelError(null);
                }}
                options={LABEL_TYPES}
                disabled={isBusy}
              />
              <TextField
                  key={labelType}
                  label={labelType === 'name' ? 'Tab name' : 'Table number'}
                  hint={labelType === 'name' ? 'Up to 30 characters, e.g. Smith' : 'Up to 10 letters, digits, spaces or hyphens'}
                  value={label}
                  onChange={(value) => {
                    setLabel(value);
                    setLabelError(null);
                  }}
                  error={labelError}
                  autoComplete="off"
                  maxLength={labelType === 'name' ? 60 : 20}
                  inputMode="text"
                  autoCapitalize={labelType === 'table' ? 'characters' : undefined}
                  readOnly={isBusy}
                  announceError
                  data-autofocus
                />
                <Button type="submit" variant="primary" size="lg" busy={busy === 'new'} disabled={isBusy} className={styles.formSubmit}>
                  Open tab
                </Button>
            </form>
          </section>
        )}

        {(canMove || (emptyBasket && !inTabMode)) && (
          <section className={styles.section} aria-labelledby={`${formId}-open`}>
            <h3 id={`${formId}-open`} className={styles.sectionHeading}>
              {canMove ? 'Add to an open tab' : 'Load an open tab'}
            </h3>
            {tabs.data === undefined && tabs.error === null && <p className={styles.muted}>Loading tabs…</p>}
            {tabs.data !== undefined && others.length === 0 && <p className={styles.muted}>No tabs are open.</p>}
            {others.length > 0 && (
              <ul className={styles.choiceList} aria-label="Open tabs">
                {others.map((summary) => {
                  const verb = canMove ? 'Add to' : 'Load';
                  const detailId = `tab-detail-${summary.tab.id}`;
                  return (
                    <li key={summary.tab.id}>
                      <button
                        type="button"
                        className={styles.choice}
                        onClick={() => (canMove ? addTo(summary) : load(summary))}
                        disabled={isBusy}
                        aria-busy={busy === summary.tab.id || undefined}
                        aria-label={`${verb} ${summary.displayLabel}`}
                        aria-describedby={detailId}
                      >
                        <span className={styles.choiceMain}>
                          <span className={styles.choiceTitle}>{summary.displayLabel}</span>
                          <span id={detailId} className={styles.choiceMeta}>
                            Open {summary.timeOpen}
                            <span className="visually-hidden">, total {formatPence(summary.totalPence)}</span>
                          </span>
                        </span>
                        <span className={styles.choiceAside}>
                          <MoneyText pence={summary.totalPence} strong />
                          <span className={styles.choiceVerb}>{verb}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {!canMove && (
              <ButtonLink to="/tabs" variant="ghost" className={styles.linkButton}>
                See all tabs
              </ButtonLink>
            )}
            {tabs.error !== null && <Banner tone="danger">{tabs.error}</Banner>}
          </section>
        )}

        {!inTabMode && noLines && !emptyBasket && (
          <p className={styles.muted}>A member or booking is attached but there are no items. Add items to open a tab.</p>
        )}
      </div>
    </Modal>
  );
}
