// @vitest-environment jsdom
/**
 * Shared components and the auto-lock hook in jsdom (React Testing Library).
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from '../../src/app/download';
import { errorMessage, fieldErrorsOf, STORAGE_ERROR_MESSAGE } from '../../src/app/errors';
import { useAutoLock } from '../../src/app/useAutoLock';
import { useLoad } from '../../src/app/useLoad';
import { AppError } from '../../src/data/errors';
import type { ServiceContext } from '../../src/services/context';
import { reloadWhenNoPaymentInFlight } from '../../src/app/updateReload';
import { Banner } from '../../src/components/Banner';
import { BasketPanel } from '../../src/components/BasketPanel';
import { BottomSheet } from '../../src/components/BottomSheet';
import { Button } from '../../src/components/Button';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { readableTextColour, contrastRatio } from '../../src/components/colour';
import { keepFocusWhenRemoved } from '../../src/components/focus';
import { Modal } from '../../src/components/Modal';
import { NumericKeypad } from '../../src/components/NumericKeypad';
import { PinKeypad } from '../../src/components/PinKeypad';
import { ProductButton } from '../../src/components/ProductButton';
import { ReceiptFallbackPanel } from '../../src/components/ReceiptFallbackPanel';
import { Screen } from '../../src/components/Screen';
import { SearchList } from '../../src/components/SearchList';
import type { Member, Settings } from '../../src/data/types';
import { priceBasket } from '../../src/rules/pricing';
import { resetAppStoreForTests, useAppStore } from '../../src/store/appStore';
import type { PaySession } from '../../src/services/pay';
import { usePayStore } from '../../src/store/payStore';
import { useSessionStore } from '../../src/store/sessionStore';
import { useUiStore } from '../../src/store/uiStore';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStore.getState().end();
  resetAppStoreForTests();
});

const key = (name: string): HTMLElement => screen.getByRole('button', { name });

function MoneyHarness({ initial = 0 }: { initial?: number }) {
  const [value, setValue] = useState(initial);
  return <NumericKeypad label="Amount" valuePence={value} onChange={setValue} captureKeyboard displayTestId="amount" />;
}

describe('NumericKeypad (D-006)', () => {
  it('enters digits as pence', () => {
    render(<MoneyHarness />);
    for (const d of ['2', '0', '0', '0']) fireEvent.click(key(d));
    expect(screen.getByTestId('amount').textContent).toBe('£20.00');
    fireEvent.click(key('Delete last digit'));
    expect(screen.getByTestId('amount').textContent).toBe('£2.00');
    fireEvent.click(key('00'));
    expect(screen.getByTestId('amount').textContent).toBe('£200.00');
    fireEvent.click(key('Clear'));
    expect(screen.getByTestId('amount').textContent).toBe('£0.00');
  });

  it('accepts at most 7 digits', () => {
    render(<MoneyHarness />);
    for (const d of ['9', '9', '9', '9', '9', '9', '9', '9']) fireEvent.click(key(d));
    expect(screen.getByTestId('amount').textContent).toBe('£99,999.99');
  });

  it('takes physical digits and Backspace when asked to', () => {
    render(<MoneyHarness />);
    fireEvent.keyDown(document, { key: '5' });
    fireEvent.keyDown(document, { key: '0' });
    expect(screen.getByTestId('amount').textContent).toBe('£0.50');
    fireEvent.keyDown(document, { key: 'Backspace' });
    expect(screen.getByTestId('amount').textContent).toBe('£0.05');
  });

  it('is a labelled group of real buttons', () => {
    render(<MoneyHarness />);
    expect(screen.getByRole('group', { name: 'Amount' })).toBeTruthy();
    expect(screen.getAllByRole('button').every((b) => b.tagName === 'BUTTON')).toBe(true);
  });
});

describe('NumericKeypad focus and Enter (D-134)', () => {
  function KeypadDialog({ onEnter }: { onEnter: () => void }) {
    const [value, setValue] = useState(0);
    return (
      <Modal open onClose={() => undefined} title="Open period">
        <NumericKeypad label="Float" valuePence={value} onChange={setValue} captureKeyboard onEnter={onEnter} displayTestId="float" />
      </Modal>
    );
  }

  it('is the dialog\'s initial focus, not the Delete last digit key; Enter there runs onEnter and keeps the amount', () => {
    const onEnter = vi.fn();
    render(<KeypadDialog onEnter={onEnter} />);
    const group = screen.getByRole('group', { name: 'Float' });
    expect(document.activeElement).toBe(group);
    for (const d of ['1', '0', '0', '0', '0']) fireEvent.keyDown(group, { key: d });
    expect(screen.getByTestId('float').textContent).toBe('£100.00');
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('float').textContent).toBe('£100.00');
  });

  it('leaves Enter on a focused key to that key', () => {
    const onEnter = vi.fn();
    render(<KeypadDialog onEnter={onEnter} />);
    const seven = key('7');
    seven.focus();
    // Not prevented: the browser's own activation of the key goes ahead.
    expect(fireEvent.keyDown(seven, { key: 'Enter' })).toBe(true);
    expect(onEnter).not.toHaveBeenCalled();
  });
});

describe('Button busy (D-134)', () => {
  it('stays focusable while busy: aria-disabled, clicks ignored, form not submitted', () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    function Harness({ busy }: { busy: boolean }) {
      return (
        <form onSubmit={onSubmit}>
          <Button onClick={onClick} busy={busy}>
            No sale
          </Button>
          <Button type="submit" busy={busy}>
            Run report
          </Button>
        </form>
      );
    }
    const { rerender } = render(<Harness busy={false} />);
    const noSale = key('No sale') as HTMLButtonElement;
    noSale.focus();
    rerender(<Harness busy />);
    expect(noSale.disabled).toBe(false);
    expect(noSale.getAttribute('aria-disabled')).toBe('true');
    expect(noSale.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(noSale);
    fireEvent.click(noSale);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(key('Run report'));
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(<Harness busy={false} />);
    expect(noSale.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(noSale);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.click(key('Run report'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('is still natively disabled when disabled and not busy', () => {
    render(<Button disabled>Pay</Button>);
    expect((key('Pay') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PinKeypad (D-073, D-076)', () => {
  it('needs 4 digits, submits on Enter and clears the entry', () => {
    const onSubmit = vi.fn();
    render(<PinKeypad label="Enter your PIN" onSubmit={onSubmit} />);
    const enter = key('Enter') as HTMLButtonElement;
    for (const d of ['1', '2', '3']) fireEvent.click(key(d));
    expect(enter.disabled).toBe(true);
    fireEvent.click(key('4'));
    expect(enter.disabled).toBe(false);
    fireEvent.click(enter);
    expect(onSubmit).toHaveBeenCalledWith('1234');
    expect(screen.getByText('No digits entered')).toBeTruthy();
  });

  it('ignores a seventh digit', () => {
    const onSubmit = vi.fn();
    render(<PinKeypad label="Enter your PIN" onSubmit={onSubmit} />);
    for (const d of ['1', '2', '3', '4', '5', '6', '7']) fireEvent.click(key(d));
    fireEvent.click(key('Enter'));
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('accepts physical digits, Backspace and Enter', () => {
    const onSubmit = vi.fn();
    render(<PinKeypad label="Enter your PIN" onSubmit={onSubmit} />);
    for (const k of ['2', '2', '2', '9', 'Backspace', '2', 'Enter']) fireEvent.keyDown(document, { key: k });
    expect(onSubmit).toHaveBeenCalledWith('2222');
  });

  it('lets Enter activate a focused key: Enter on Clear clears and never submits (D-132)', () => {
    const onSubmit = vi.fn();
    render(<PinKeypad label="Enter your PIN" onSubmit={onSubmit} />);
    for (const d of ['1', '1', '1', '1']) fireEvent.click(key(d));
    const clear = key('Clear');
    clear.focus();
    // Not prevented: the browser's own activation (a click on Clear) goes ahead.
    expect(fireEvent.keyDown(clear, { key: 'Enter' })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(clear);
    expect(screen.getByText('No digits entered')).toBeTruthy();
    // Enter with focus elsewhere (the body, or the keypad group) still submits (D-073).
    for (const k of ['2', '2', '2', '2']) fireEvent.keyDown(document, { key: k });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('2222');
  });

  it('keeps focus inside the keypad when the focused key becomes disabled (D-132)', () => {
    const onSubmit = vi.fn();
    render(<PinKeypad label="Approver's PIN" onSubmit={onSubmit} />);
    const group = screen.getByRole('group', { name: "Approver's PIN" });
    for (const d of ['9', '9', '9', '9']) fireEvent.click(key(d));
    const enter = key('Enter');
    enter.focus();
    fireEvent.click(enter);
    expect(onSubmit).toHaveBeenCalledWith('9999');
    expect(document.activeElement).toBe(group);

    fireEvent.click(key('5'));
    const clear = key('Clear');
    clear.focus();
    fireEvent.click(clear);
    expect(document.activeElement).toBe(group);
    // A tap on a key doesn't take focus from where it is (on-screen keypad).
    expect(fireEvent.mouseDown(key('7'))).toBe(false);
  });

  it('disables every key during a lockout and shows the status', () => {
    const onSubmit = vi.fn();
    render(<PinKeypad label="Enter your PIN" onSubmit={onSubmit} disabled status="Too many attempts. Try again in 30 s" />);
    expect((key('1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: '1' });
    expect(screen.getByText('No digits entered')).toBeTruthy();
    expect(screen.getByText('Too many attempts. Try again in 30 s')).toBeTruthy();
  });

  it('keeps the ticking countdown out of live regions and announces the lockout once (D-135)', () => {
    const announcement = 'Too many attempts. The keypad is locked for 30 seconds.';
    const { rerender } = render(
      <PinKeypad label="Enter your PIN" onSubmit={vi.fn()} disabled status="Too many attempts. Try again in 30 s" announcement={announcement} />,
    );
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('Too many attempts. Try again in 30 s');
    expect(timer.closest('[aria-live]')).toBeNull();
    expect(screen.getByText(announcement).getAttribute('aria-live')).toBe('polite');
    // The countdown ticks; the announced text does not change, so it is read out only once.
    rerender(<PinKeypad label="Enter your PIN" onSubmit={vi.fn()} disabled status="Too many attempts. Try again in 29 s" announcement={announcement} />);
    expect(screen.getByRole('timer').textContent).toBe('Too many attempts. Try again in 29 s');
    expect(screen.getByText(announcement).getAttribute('aria-live')).toBe('polite');
  });
});

describe('Modal', () => {
  function ModalHarness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Modal
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="Void Lager"
          description="Choose how many to remove."
        >
          <button type="button">Inside</button>
        </Modal>
      </>
    );
  }

  it('is a labelled modal dialog; Escape closes it and focus returns to the opener', () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const opener = key('Open');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Void Lager' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("gives focus to the opener's container, not <body>, when its action disabled the opener (D-135)", () => {
    function VoidHarness() {
      const [open, setOpen] = useState(false);
      const [lines, setLines] = useState(1);
      return (
        <main id="main" tabIndex={-1}>
          <button type="button" onClick={() => setOpen(true)} disabled={lines === 0}>
            Void
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Void item">
            <button
              type="button"
              onClick={() => {
                setLines(0);
                setOpen(false);
              }}
            >
              Confirm void
            </button>
          </Modal>
        </main>
      );
    }
    render(<VoidHarness />);
    const opener = key('Void');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm void' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((opener as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it("gives focus to the opener's container, not <body>, when the screen's reload after a save removes the opener (D-135, D-139)", async () => {
    function ListHarness() {
      const [open, setOpen] = useState(false);
      const [rows, setRows] = useState(['Bar', 'Temp']);
      return (
        <main id="main" tabIndex={-1}>
          <ul aria-label="Categories" tabIndex={-1}>
            {rows.map((row) => (
              <li key={row}>
                <button type="button" onClick={() => setOpen(true)}>
                  {`Edit ${row}`}
                </button>
              </li>
            ))}
          </ul>
          <Modal open={open} onClose={() => setOpen(false)} title="Edit category">
            <button
              type="button"
              onClick={() => {
                // The dialog closes first; the list reloads a moment later without the row.
                setOpen(false);
                setTimeout(() => setRows(['Bar']), 20);
              }}
            >
              Delete category
            </button>
          </Modal>
        </main>
      );
    }
    render(<ListHarness />);
    const opener = key('Edit Temp');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Delete category' }));
    expect(document.activeElement).toBe(opener);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Temp' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Categories' })));
  });
});

describe('keepFocusWhenRemoved (D-135)', () => {
  it('moves focus to the nearest focusable container when a focused control removes itself', async () => {
    function BannerHarness() {
      const [shown, setShown] = useState(true);
      return (
        <section aria-label="Basket" tabIndex={-1} data-testid="basket">
          {shown && (
            <Banner tone="warning" onDismiss={() => setShown(false)} dismissLabel="Dismiss storage warning">
              Storage may be cleared.
            </Banner>
          )}
          <button type="button">Pay</button>
        </section>
      );
    }
    render(<BannerHarness />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss storage warning' });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(screen.queryByRole('button', { name: 'Dismiss storage warning' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('basket')));
  });

  it('leaves focus alone when something else already has it', async () => {
    const other = document.createElement('button');
    document.body.append(other);
    function Harness() {
      const [shown, setShown] = useState(true);
      return (
        <div tabIndex={-1} data-testid="box">
          {shown && (
            <button
              type="button"
              onClick={(event) => {
                keepFocusWhenRemoved(event.currentTarget);
                other.focus();
                setShown(false);
              }}
            >
              Remove member
            </button>
          )}
        </div>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove member' })).toBeNull());
    await Promise.resolve();
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

describe('Screen focus after a route change (D-136)', () => {
  /** Stands in for the router: the old screen (with the focused button) unmounts and the new one mounts. */
  function RouteHarness({ other }: { other?: HTMLElement }) {
    const [route, setRoute] = useState<'till' | 'pay'>('till');
    return (
      <main id="main" tabIndex={-1}>
        {route === 'till' ? (
          <Screen key="till" title="Till" hideTitle>
            <button
              type="button"
              onClick={() => {
                other?.focus();
                setRoute('pay');
              }}
            >
              Pay
            </button>
          </Screen>
        ) : (
          <Screen key="pay" title="Pay">
            <p>Amount due</p>
          </Screen>
        )}
      </main>
    );
  }

  it('moves focus to the new screen’s heading when the button that changed screen went with the old one', async () => {
    render(<RouteHarness />);
    const pay = screen.getByRole('button', { name: 'Pay' });
    pay.focus();
    fireEvent.click(pay);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Pay' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('also takes focus from <main>, where a dialog that closed with the old screen leaves it', async () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.append(main);
    main.focus();
    render(<Screen title="Pay" />, { container: main });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Pay' })));
    main.remove();
  });

  it('leaves focus alone when something still has it (the header Menu button after the menu)', async () => {
    const menu = document.createElement('button');
    menu.textContent = 'Menu';
    document.body.append(menu);
    render(<RouteHarness other={menu} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    await screen.findByRole('heading', { level: 1, name: 'Pay' });
    await Promise.resolve();
    expect(document.activeElement).toBe(menu);
    menu.remove();
  });
});

describe('ReceiptFallbackPanel (D-109, D-135)', () => {
  it('only Close or Reprint closes it: not Escape, since it may hold the only copy of the document', () => {
    const onClose = vi.fn();
    render(<ReceiptFallbackPanel fallback={{ html: '<p>Z</p>', title: 'Z report 1' }} onReprint={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Z report 1' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('dialog focus and descriptions', () => {
  function SearchHarness() {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Member
        </button>
        <Modal open={open} onClose={() => setOpen(false)} title="Attach member">
          <SearchList label="Search members" query={query} onQueryChange={setQuery} results={[]} getKey={(x: string) => x} renderItem={(x) => x} onSelect={() => undefined} autoFocus />
        </Modal>
      </>
    );
  }

  it('a SearchList with autoFocus in a Modal gets focus, and focus returns to the opener on close', () => {
    render(<SearchHarness />);
    const opener = key('Member');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Search members'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("ConfirmDialog's message describes the dialog (aria-describedby)", () => {
    render(
      <ConfirmDialog
        open
        title="Cancel this payment?"
        message="Already taken: cash £5.00. Hand back the cash, then cancel."
        tone="danger"
        cancelLabel="Keep paying"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Cancel this payment?' });
    const ids = (dialog.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain('Hand back the cash');
    expect(document.activeElement).toBe(key('Keep paying'));
  });

  it("BottomSheet's toggle is named by its label and the visible summary (WCAG 2.5.3)", () => {
    render(
      <BottomSheet
        title="Basket"
        open={false}
        onOpenChange={() => undefined}
        summary={
          <>
            <span>2 items</span> <span>£8.40</span>
          </>
        }
      >
        <p>Lines</p>
      </BottomSheet>,
    );
    expect(screen.getByRole('button', { name: 'View basket 2 items £8.40' })).toBeTruthy();
  });
});

describe('reload onto a new build (D-133)', () => {
  const withTenders = { kind: 'sale', tender: { tenders: [{ type: 'cash', amountPence: 500 }] } } as unknown as PaySession;

  afterEach(() => {
    usePayStore.setState({ session: null, committing: false });
    useUiStore.getState().closeReceiptFallback();
    window.location.hash = '';
  });

  it('reloads at once when no payment is in flight', () => {
    const reload = vi.fn();
    window.location.hash = '#/till';
    reloadWhenNoPaymentInFlight(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits while a payment has tenders or Pay is on screen, then reloads once', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    window.location.hash = '#/pay';
    usePayStore.setState({ session: withTenders });
    reloadWhenNoPaymentInFlight(reload, 100);
    vi.advanceTimersByTime(500);
    expect(reload).not.toHaveBeenCalled();
    usePayStore.setState({ session: null });
    expect(reload).not.toHaveBeenCalled(); // still on #/pay (e.g. the change to hand back)
    window.location.hash = '#/till';
    vi.advanceTimersByTime(100);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    usePayStore.setState({ committing: false });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits while the receipt fallback panel is open, e.g. a blocked Z report, then reloads once it is closed (D-134)', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    window.location.hash = '#/period';
    useUiStore.getState().showReceiptFallback({ html: '<p>Z</p>', title: 'Z report 1' });
    reloadWhenNoPaymentInFlight(reload, 100);
    vi.advanceTimersByTime(1000);
    expect(reload).not.toHaveBeenCalled();
    expect(useUiStore.getState().receiptFallback).not.toBeNull();
    useUiStore.getState().closeReceiptFallback();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits for a receipt shown in the panel straight after a sale with no change, back on the till (D-134)', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    window.location.hash = '#/pay';
    usePayStore.setState({ session: withTenders });
    reloadWhenNoPaymentInFlight(reload, 100);
    // The sale commits, the receipt is blocked (panel shown) and Pay returns to the till.
    useUiStore.getState().showReceiptFallback({ html: '<p>Receipt</p>', title: 'Receipt 3F9C-000001' });
    usePayStore.setState({ session: null });
    window.location.hash = '#/till';
    vi.advanceTimersByTime(500);
    expect(reload).not.toHaveBeenCalled();
    useUiStore.getState().closeReceiptFallback();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('ProductButton and colours', () => {
  it('is named exactly by the product and describes its price', () => {
    const onPress = vi.fn();
    render(<ProductButton product={{ id: 'p1', name: 'Club Bitter', pricePence: 420, buttonColour: '#b45309' }} onPress={onPress} qtyInBasket={2} />);
    const button = screen.getByRole('button', { name: 'Club Bitter' });
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(button.textContent).toContain('£4.20');
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledWith('p1');
  });

  it('picks a text colour meeting AA on every sample category colour', () => {
    for (const colour of ['#b45309', '#a16207', '#7c3aed', '#9f1239', '#0369a1', '#15803d', '#475569', '#fde047', '#e2e8f0']) {
      expect(contrastRatio(colour, readableTextColour(colour))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks a text colour meeting AA on any colour a manager can choose, including mid-tones', () => {
    // Regression: a near-black option left mid-luminance colours below 4.5:1 (#7b7b7b gave 4.26:1).
    for (const colour of ['#7a7a7a', '#7b7b7b', '#7b7e51', '#777777', '#808080']) {
      expect(contrastRatio(colour, readableTextColour(colour)), colour).toBeGreaterThanOrEqual(4.5);
    }
    const hex = (n: number): string => n.toString(16).padStart(2, '0');
    let worst = 21;
    for (let r = 0; r <= 255; r += 5) {
      for (let g = 0; g <= 255; g += 5) {
        for (let b = 0; b <= 255; b += 5) {
          const colour = `#${hex(r)}${hex(g)}${hex(b)}`;
          worst = Math.min(worst, contrastRatio(colour, readableTextColour(colour)));
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});

describe('BasketPanel', () => {
  it('shows lines, deal, member and deposit rows and the total with stable test ids', () => {
    const priced = priceBasket({
      lines: [{ productId: 'lager', name: 'Lager', qty: 2, unitPricePence: 450, vatRate: 20, memberDiscountEligible: true }],
      deals: [],
      at: '2026-09-26T12:00:00.000Z',
      memberDiscountPercent: 15,
      depositBalancePence: 100,
    });
    const member: Member = {
      id: 'm1',
      deviceId: 'd',
      createdAt: '2026-09-26T12:00:00.000Z',
      updatedAt: '2026-09-26T12:00:00.000Z',
      memberNumber: '1042',
      firstName: 'Alice',
      lastName: 'Archer',
      active: true,
    };
    const onRemoveMember = vi.fn();
    render(<BasketPanel view={{ priced, member }} basket={{ lines: [{ productId: 'lager', qty: 2 }], memberId: 'm1' }} memberDiscountPercent={15} onRemoveMember={onRemoveMember} />);
    expect(screen.getByTestId('basket-total').textContent).toBe('£6.65'); // 900 - 135 - 100
    expect(screen.getByTestId('member-badge').textContent).toContain('1042 — Alice Archer');
    expect(screen.getByTestId('deposit-line').textContent).toContain('-£1.00');
    expect(screen.getByTestId('member-discount-line').textContent).toContain('-£1.35');
    fireEvent.click(key('Remove member'));
    expect(onRemoveMember).toHaveBeenCalled();
  });
});

describe('useAutoLock (D-078)', () => {
  const settings = (autoLockMinutes: number): Settings => ({
    id: 'dev',
    deviceId: 'dev',
    createdAt: '2026-09-26T12:00:00.000Z',
    updatedAt: '2026-09-26T12:00:00.000Z',
    clubName: 'Oakfield Golf Club',
    receiptFooter: '',
    autoLockMinutes,
    memberDiscountPercent: 15,
    devicePrefix: 'DEV',
    receiptCounter: 0,
  });

  it('locks after autoLockMinutes without a tap; activity restarts the count', () => {
    vi.useFakeTimers();
    useAppStore.setState({ settings: settings(2) });
    useSessionStore.getState().start({ staffId: 's1', name: 'Sam Staff', role: 'staff' }, Date.now());
    renderHook(() => useAutoLock());

    act(() => vi.advanceTimersByTime(90_000));
    fireEvent.pointerDown(document);
    act(() => vi.advanceTimersByTime(90_000));
    expect(useSessionStore.getState().session).not.toBeNull();

    act(() => vi.advanceTimersByTime(31_000));
    expect(useSessionStore.getState().session).toBeNull();
  });
});

describe('useLoad', () => {
  it('loads on mount and on reload, reports errors, and follows its deps', async () => {
    useAppStore.setState({ ctx: {} as ServiceContext });
    let calls = 0;
    const load = vi.fn(async (_ctx: ServiceContext) => {
      calls += 1;
      if (calls === 3) throw new AppError('NOT_FOUND', 'That booking no longer exists');
      return calls;
    });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useLoad((ctx) => load(ctx), [id]), { initialProps: { id: 'a' } });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(1));
    expect(result.current.loading).toBe(false);

    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(2));

    rerender({ id: 'b' });
    await waitFor(() => expect(result.current.error).toBe('That booking no longer exists'));
    expect(result.current.data).toBe(2);
    expect(result.current.loading).toBe(false);
  });
});

describe('errors and downloads', () => {
  it('maps thrown values to UI text and field errors', () => {
    const error = new AppError('VALIDATION', 'Check the details', { name: 'Enter a name' });
    expect(errorMessage(error)).toBe('Check the details');
    expect(fieldErrorsOf(error)).toEqual({ name: 'Enter a name' });
    expect(fieldErrorsOf(new Error('x'))).toEqual({});
    expect(errorMessage('weird')).toBe('Something went wrong. Try again.');
  });

  it('shows plain words for a failure of the device storage, never its technical text (D-138)', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(errorMessage(new DOMException('boom', 'UnknownError'))).toBe(STORAGE_ERROR_MESSAGE);
    // Dexie's wrapper errors carry the same names.
    expect(errorMessage(Object.assign(new Error('Transaction aborted: QuotaExceededError'), { name: 'AbortError' }))).toBe(STORAGE_ERROR_MESSAGE);
    expect(errorMessage(Object.assign(new Error('Database has been closed'), { name: 'DatabaseClosedError' }))).toBe(STORAGE_ERROR_MESSAGE);
    expect(quiet).toHaveBeenCalledTimes(3);
    // A service's AppError and any other error keep their own message.
    expect(errorMessage(new AppError('NO_OPEN_PERIOD', 'No trading period is open'))).toBe('No trading period is open');
    expect(errorMessage(new Error('Maximum quantity is 999'))).toBe('Maximum quantity is 999');
    expect(errorMessage(new DOMException('The file could not be read', 'NotReadableError'))).toBe('The file could not be read');
    quiet.mockRestore();
  });

  it('downloads text through a Blob URL and an <a download> click', () => {
    const create = vi.fn(() => 'blob:backup');
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(`${this.download} ${this.href}`);
    });
    downloadTextFile('club-epos-backup-2026-09-26-1405.json', '{}');
    expect(create).toHaveBeenCalled();
    expect(clicked).toEqual(['club-epos-backup-2026-09-26-1405.json blob:backup']);
    expect(document.querySelector('a[download]')).toBeNull();
    click.mockRestore();
  });
});
