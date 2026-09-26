/**
 * The Zustand stores against the real services and LocalAdapter (fake-indexeddb).
 */
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BASKET } from '../../src/rules/basket';
import { INITIAL_PIN_ATTEMPTS, MAX_PIN_FAILURES, PIN_LOCKOUT_MS } from '../../src/rules/lockout';
import { useAppStore } from '../../src/store/appStore';
import { MAX_QTY_MESSAGE, NO_PERIOD_MESSAGE, PAYMENT_IN_PROGRESS_MESSAGE, basketUnitCount, useBasketStore } from '../../src/store/basketStore';
import { dropUntenderedPayment, isBasketFrozen, usePayStore } from '../../src/store/payStore';
import { useSessionStore } from '../../src/store/sessionStore';
import { useUiStore } from '../../src/store/uiStore';
import { direct, openTestPeriod, registerUiCleanup, setupUi } from './ui-harness';

registerUiCleanup();

const toastMessages = (): string[] => useUiStore.getState().toasts.map((t) => t.message);

describe('appStore', () => {
  it('loads boot state, settings and the open period', async () => {
    const h = await setupUi();
    const app = useAppStore.getState();
    expect(app.bootState).toBe('login');
    expect(app.settings?.clubName).toBe('Oakfield Golf Club');
    expect(app.openPeriod).toBeNull();
    await openTestPeriod(h, 5000);
    expect(useAppStore.getState().openPeriod?.floatPence).toBe(5000);
  });
});

describe('basketStore', () => {
  it('refuses to add items while no period is open (D-068)', async () => {
    const h = await setupUi();
    expect(await useBasketStore.getState().addProduct(h.lager.id)).toBe(false);
    expect(useBasketStore.getState().basket).toEqual(EMPTY_BASKET);
    expect(toastMessages()).toContain(NO_PERIOD_MESSAGE);
    expect(await useBasketStore.getState().attachMember(h.member.id)).toBe(false);
  });

  it('adds products, prices with viewBasket and saves the draft after every change', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    const basket = useBasketStore.getState();
    await basket.addProduct(h.lager.id);
    await basket.addProduct(h.crisps.id);
    await basket.addProduct(h.lager.id);
    const state = useBasketStore.getState();
    expect(state.basket.lines).toEqual([
      { productId: h.lager.id, qty: 2 },
      { productId: h.crisps.id, qty: 1 },
    ]);
    expect(basketUnitCount(state.basket)).toBe(3);
    expect(state.view?.priced.totalPence).toBe(2 * 450 + 125);
    expect(state.pricing).toBe(false);
    expect((await h.repos.draft.get())?.lines).toEqual(state.basket.lines);
  });

  it('attaches and detaches a member, repricing with the discount (D-019)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().addProduct(h.lager.id);
    await useBasketStore.getState().addProduct(h.lager.id);
    expect(await useBasketStore.getState().attachMember(h.member.id)).toBe(true);
    let state = useBasketStore.getState();
    expect(state.view?.member?.memberNumber).toBe('1042');
    expect(state.view?.priced.memberDiscountPence).toBe(135); // 900 x 15%
    expect(state.view?.priced.totalPence).toBe(765);
    expect((await h.repos.draft.get())?.memberId).toBe(h.member.id);

    await useBasketStore.getState().detachMember();
    state = useBasketStore.getState();
    expect(state.basket.memberId).toBeUndefined();
    expect(state.view?.priced.totalPence).toBe(900);
  });

  it('voids through the service and changes the basket only after the audit write', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    for (let i = 0; i < 3; i += 1) await useBasketStore.getState().addProduct(h.lager.id);
    await useBasketStore.getState().voidLine(direct(h.supervisor, 'voidLine'), h.lager.id, 2);
    expect(useBasketStore.getState().basket.lines).toEqual([{ productId: h.lager.id, qty: 1 }]);
    const events = await h.repos.auditEvents.listByPeriod(useAppStore.getState().openPeriod?.id ?? '');
    expect(events.map((e) => e.type)).toEqual(['void']);

    await useBasketStore.getState().voidLine(direct(h.supervisor, 'voidLine'), h.lager.id, 1);
    expect(useBasketStore.getState().basket).toEqual({ lines: [] });
    expect(useBasketStore.getState().view).toBeNull();
    expect(await h.repos.draft.get()).toBeUndefined();
  });

  it('ignores a tap at the maximum quantity with a toast (D-008)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().load({ lines: [{ productId: h.lager.id, qty: 999 }] });
    expect(await useBasketStore.getState().addProduct(h.lager.id)).toBe(false);
    expect(toastMessages()).toContain(MAX_QTY_MESSAGE);
  });

  it('runs overlapping voids one after another: two quick voids remove two units (D-085, D-130)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    for (let i = 0; i < 3; i += 1) await useBasketStore.getState().addProduct(h.lager.id);
    const auth = direct(h.supervisor, 'voidLine');
    // A double tap on '−': the second void starts before the first has written its audit event.
    await Promise.all([useBasketStore.getState().voidLine(auth, h.lager.id, 1), useBasketStore.getState().voidLine(auth, h.lager.id, 1)]);
    expect(useBasketStore.getState().basket.lines).toEqual([{ productId: h.lager.id, qty: 1 }]);
    expect((await h.repos.draft.get())?.lines).toEqual([{ productId: h.lager.id, qty: 1 }]);
    const events = await h.repos.auditEvents.listByPeriod(useAppStore.getState().openPeriod?.id ?? '');
    expect(events.filter((e) => e.type === 'void')).toHaveLength(2);
  });

  it('keeps a product tapped while a void is being written (D-095, D-130)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    for (let i = 0; i < 3; i += 1) await useBasketStore.getState().addProduct(h.lager.id);
    const voiding = useBasketStore.getState().voidLine(direct(h.supervisor, 'voidLine'), h.lager.id, 1);
    const adding = useBasketStore.getState().addProduct(h.crisps.id);
    await Promise.all([voiding, adding]);
    const expected = [
      { productId: h.lager.id, qty: 2 },
      { productId: h.crisps.id, qty: 1 },
    ];
    expect(useBasketStore.getState().basket.lines).toEqual(expected);
    expect((await h.repos.draft.get())?.lines).toEqual(expected);
    expect(useBasketStore.getState().view?.priced.totalPence).toBe(2 * 450 + 125);
  });

  it('restores the draft after a reset (as after a refresh, D-096)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().addProduct(h.crisps.id);
    await useBasketStore.getState().attachMember(h.member.id);
    useBasketStore.getState().reset();
    expect(useBasketStore.getState().basket).toEqual(EMPTY_BASKET);
    expect(await useBasketStore.getState().restoreDraft()).toBe(0);
    const state = useBasketStore.getState();
    expect(state.basket).toEqual({ lines: [{ productId: h.crisps.id, qty: 1 }], memberId: h.member.id });
    expect(state.view?.member?.id).toBe(h.member.id);
  });
});

describe('payStore', () => {
  it('opens Pay with frozen pricing, rejects a card above the balance and completes a sale', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().addProduct(h.lager.id);
    await useBasketStore.getState().addProduct(h.crisps.id);
    const session = await usePayStore.getState().openSale();
    expect(session.kind).toBe('sale');
    expect(session.tender.totalPence).toBe(575);

    const rejected = usePayStore.getState().tender({ type: 'card', amountPence: 1000 });
    expect(rejected?.ok).toBe(false);
    expect(usePayStore.getState().error).toBe("Card can't be more than the balance (£5.75)");

    usePayStore.getState().pressKey('5');
    usePayStore.getState().pressKey('0');
    usePayStore.getState().pressKey('0');
    expect(usePayStore.getState().keypadPence).toBe(500);
    const partial = usePayStore.getState().tender({ type: 'cash', amountPence: usePayStore.getState().keypadPence });
    expect(partial?.ok).toBe(true);
    expect(usePayStore.getState().keypadPence).toBe(0);
    expect(isBasketFrozen(usePayStore.getState().session)).toBe(true);

    // The basket is frozen while tenders exist (D-033).
    expect(await useBasketStore.getState().addProduct(h.lager.id)).toBe(false);
    expect(toastMessages()).toContain(PAYMENT_IN_PROGRESS_MESSAGE);

    const last = usePayStore.getState().tender({ type: 'cash', amountPence: 1000 });
    expect(last?.ok && last.session.tender.complete).toBe(true);
    const done = await usePayStore.getState().complete(direct(h.staff, 'sell'));
    expect(done?.sale.totalPence).toBe(575);
    expect(done?.sale.changePence).toBe(925);
    expect(done?.document).toContain(`<title>Receipt ${done?.sale.receiptNumber}</title>`);
    expect(usePayStore.getState().session).toBeNull();
    expect(useBasketStore.getState().basket).toEqual(EMPTY_BASKET);
    expect(await h.repos.draft.get()).toBeUndefined();
  });

  it('drops a Pay session with no tenders when the basket changes (D-011)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().addProduct(h.lager.id);
    await usePayStore.getState().openSale();
    expect(await useBasketStore.getState().addProduct(h.lager.id)).toBe(true);
    expect(usePayStore.getState().session).toBeNull();
  });

  it('refuses a product tapped while Pay is opening, so Pay covers exactly the basket (D-130)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().addProduct(h.lager.id);
    const opening = usePayStore.getState().openSale();
    expect(usePayStore.getState().opening).toBe(true);
    expect(await useBasketStore.getState().addProduct(h.crisps.id)).toBe(false);
    expect(toastMessages()).toContain(PAYMENT_IN_PROGRESS_MESSAGE);
    const session = await opening;
    expect(usePayStore.getState().opening).toBe(false);
    expect(session.tender.totalPence).toBe(450);
    expect(useBasketStore.getState().basket.lines).toEqual([{ productId: h.lager.id, qty: 1 }]);
    expect((await h.repos.draft.get())?.lines).toEqual([{ productId: h.lager.id, qty: 1 }]);
  });

  it('opens Pay only after a basket change already under way has finished (D-130)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    for (let i = 0; i < 3; i += 1) await useBasketStore.getState().addProduct(h.lager.id);
    const voiding = useBasketStore.getState().voidLine(direct(h.supervisor, 'voidLine'), h.lager.id, 1);
    const session = await usePayStore.getState().openSale();
    await voiding;
    expect(session.tender.totalPence).toBe(900);
    expect(useBasketStore.getState().basket.lines).toEqual([{ productId: h.lager.id, qty: 2 }]);
    expect(usePayStore.getState().session?.id).toBe(session.id);
  });

  it('keeps the session and tenders when the commit fails (D-034)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().addProduct(h.lager.id);
    await usePayStore.getState().openSale();
    usePayStore.getState().tender({ type: 'cash', amountPence: 450 });
    // Wrong action: completePayment asserts 'sell'.
    const result = await usePayStore.getState().complete(direct(h.staff, 'tabs'));
    expect(result).toBeNull();
    expect(usePayStore.getState().error).toMatch(/^Sale not saved: /);
    expect(usePayStore.getState().session?.tender.tenders).toHaveLength(1);
    expect(useBasketStore.getState().basket.lines).toHaveLength(1);
  });

  it('a failed deposit says so, and a closed period refreshes the cached period (D-131)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    const booking = await h.repos.bookings.create({ name: 'Smith & Jones Wedding', type: 'wedding', date: '2026-10-10', notes: '', status: 'open' });
    await usePayStore.getState().openDeposit(booking.id, 2500);
    usePayStore.getState().tender({ type: 'cash', amountPence: 2500 });
    // The period closes underneath the payment: the commit fails with NO_OPEN_PERIOD.
    const period = useAppStore.getState().openPeriod;
    await h.repos.periods.close({ periodId: period?.id ?? '', closedBy: h.manager.staffId, declaredCashPence: 10_000 });
    expect(await usePayStore.getState().complete(direct(h.manager, 'bookings'))).toBeNull();
    expect(usePayStore.getState().error).toMatch(/^Deposit not saved: /);
    expect(usePayStore.getState().session?.tender.tenders).toHaveLength(1);
    await vi.waitFor(() => expect(useAppStore.getState().openPeriod).toBeNull());
  });

  it('drops a Pay session only while no tender is taken, and only the one asked for (D-134)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    const wedding = await h.repos.bookings.create({ name: 'Smith & Jones Wedding', type: 'wedding', date: '2026-10-10', notes: '', status: 'open' });
    const seniors = await h.repos.bookings.create({ name: 'Seniors Society Day', type: 'society', date: '2026-10-12', notes: '', status: 'open' });
    const forWedding = (session: { kind: string; booking?: { id: string } }): boolean => session.kind === 'deposit' && session.booking?.id === wedding.id;

    await usePayStore.getState().openDeposit(seniors.id, 5000);
    // Another booking's deposit is left alone.
    expect(dropUntenderedPayment(forWedding)).toBe(false);
    expect(usePayStore.getState().session).not.toBeNull();
    // With money taken it is never dropped (D-033).
    usePayStore.getState().tender({ type: 'cash', amountPence: 2000 });
    expect(dropUntenderedPayment()).toBe(false);
    expect(usePayStore.getState().session?.tender.tenders).toHaveLength(1);

    usePayStore.getState().clear();
    await usePayStore.getState().openDeposit(wedding.id, 5000);
    expect(dropUntenderedPayment(forWedding)).toBe(true);
    expect(usePayStore.getState().session).toBeNull();
    // With no filter (after a Z close) any session with nothing taken goes.
    await usePayStore.getState().openDeposit(seniors.id, 5000);
    expect(dropUntenderedPayment()).toBe(true);
    expect(usePayStore.getState().session).toBeNull();
  });
});

describe('sessionStore', () => {
  it('locks the PIN keypad for 30 s after five failures and resets on success (D-076)', () => {
    const store = useSessionStore.getState();
    for (let i = 1; i < MAX_PIN_FAILURES; i += 1) store.pinFailed(1000);
    expect(useSessionStore.getState().lockoutRemaining(1000)).toBe(0);
    useSessionStore.getState().pinFailed(1000);
    expect(useSessionStore.getState().lockoutRemaining(1000)).toBe(PIN_LOCKOUT_MS);
    expect(useSessionStore.getState().lockoutRemaining(1000 + PIN_LOCKOUT_MS)).toBe(0);
    useSessionStore.getState().pinSucceeded();
    expect(useSessionStore.getState().pinAttempts).toEqual(INITIAL_PIN_ATTEMPTS);
  });

  it('starts and ends a session; banners are per login', () => {
    const store = useSessionStore.getState();
    store.start({ staffId: 's1', name: 'Sam Staff', role: 'staff' }, 5000);
    useSessionStore.getState().setBanners({ storageWarning: true });
    useSessionStore.getState().dismissBanner('storageWarning');
    expect(useSessionStore.getState().dismissed.storageWarning).toBe(true);
    expect(useSessionStore.getState().lastActivityMs).toBe(5000);
    useSessionStore.getState().end();
    expect(useSessionStore.getState().session).toBeNull();
    expect(useSessionStore.getState().dismissed.storageWarning).toBe(false);
  });
});
