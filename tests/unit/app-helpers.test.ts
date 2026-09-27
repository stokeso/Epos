/**
 * src/app helpers: requirePermission, the ui store's dialogs and toasts, sign-in / lock /
 * import resets, and openDocument's popup fallback (D-070, D-071, D-078, D-090, D-096, D-109).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterBackupImport, homeRoute, lock, removedItemsMessage, signIn } from '../../src/app/auth';
import { DOCUMENT_URL_LIFETIME_MS, documentTitle, openDocument, reprintFallback } from '../../src/app/openDocument';
import { requirePermission } from '../../src/app/requirePermission';
import { EMPTY_BASKET } from '../../src/rules/basket';
import { useAppStore } from '../../src/store/appStore';
import { useBasketStore } from '../../src/store/basketStore';
import { usePayStore } from '../../src/store/payStore';
import { useSessionStore } from '../../src/store/sessionStore';
import { confirmDialog, toast, useUiStore } from '../../src/store/uiStore';
import { openTestPeriod, registerUiCleanup, setupUi } from './ui-harness';

registerUiCleanup();

describe('requirePermission', () => {
  it('returns null with nobody logged in', async () => {
    expect(await requirePermission('sell')).toBeNull();
  });

  it('authorises directly when the role suffices: no dialog, no approver (D-070)', async () => {
    useSessionStore.getState().start({ staffId: 'm1', name: 'Morgan Manager', role: 'manager' }, 0);
    expect(await requirePermission('refund')).toEqual({ action: 'refund', staffId: 'm1' });
    expect(useUiStore.getState().overrideRequest).toBeNull();
  });

  it('asks for an override when the role is too low and resolves with the approval (D-071)', async () => {
    useSessionStore.getState().start({ staffId: 's1', name: 'Sam Staff', role: 'staff' }, 0);
    const pending = requirePermission('voidLine');
    const request = useUiStore.getState().overrideRequest;
    expect(request?.action).toBe('voidLine');
    useUiStore.getState().settleOverride({ action: 'voidLine', staffId: 's1', approvedById: 'sup' });
    expect(await pending).toEqual({ action: 'voidLine', staffId: 's1', approvedById: 'sup' });
    expect(useUiStore.getState().overrideRequest).toBeNull();
  });

  it('a lock cancels the pending override (resolves null) and any confirm (resolves false)', async () => {
    useSessionStore.getState().start({ staffId: 's1', name: 'Sam Staff', role: 'staff' }, 0);
    const override = requirePermission('noSale');
    const confirm = confirmDialog({ title: 'Cancel payment?' });
    lock();
    expect(await override).toBeNull();
    expect(await confirm).toBe(false);
    expect(useSessionStore.getState().session).toBeNull();
    expect(useUiStore.getState().lockCount).toBe(1);
  });
});

describe('uiStore', () => {
  it('shows one confirmation at a time and up to two errors, and clears them (D-140)', () => {
    for (const message of ['one', 'two', 'three']) toast(message);
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['three']);
    for (const message of ['e1', 'e2', 'e3']) toast(message, { tone: 'danger' });
    toast('four', { tone: 'success' });
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['e2', 'e3', 'four']);
    useUiStore.getState().clearToasts();
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('a second confirm resolves the first as cancelled', async () => {
    const first = confirmDialog({ title: 'First?' });
    const second = confirmDialog({ title: 'Second?' });
    expect(await first).toBe(false);
    useUiStore.getState().settleConfirm(true);
    expect(await second).toBe(true);
  });
});

describe('sign-in, lock and import', () => {
  it('signIn restores the draft when the basket is empty and goes to the till (D-096)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await useBasketStore.getState().addProduct(h.lager.id);
    useBasketStore.getState().reset(); // as after a refresh
    const route = await signIn(h.staff);
    expect(route).toBe('/till');
    expect(useSessionStore.getState().session).toEqual(h.staff);
    expect(useBasketStore.getState().basket.lines).toEqual([{ productId: h.lager.id, qty: 1 }]);
  });

  it('signIn toasts the number of stale items dropped from the draft', async () => {
    const h = await setupUi();
    await h.repos.draft.save({ lines: [{ productId: h.lager.id, qty: 1 }, { productId: 'missing-product', qty: 2 }] });
    await signIn(h.manager);
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(removedItemsMessage(1));
    expect(removedItemsMessage(2)).toBe('2 items removed from the saved basket');
  });

  it('lock keeps the basket and the Pay session; the next sign-in returns to Pay (D-078)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await signIn(h.staff);
    await useBasketStore.getState().addProduct(h.lager.id);
    await usePayStore.getState().openSale();
    usePayStore.getState().tender({ type: 'cash', amountPence: 200 });
    lock();
    expect(useSessionStore.getState().session).toBeNull();
    expect(useBasketStore.getState().basket.lines).toHaveLength(1);
    expect(usePayStore.getState().session?.tender.tenders).toHaveLength(1);
    expect(homeRoute()).toBe('/pay');
    expect(await signIn(h.supervisor)).toBe('/pay');
    expect(useBasketStore.getState().basket.lines).toHaveLength(1);
  });

  it('managers get the storage banner when persistence was refused (D-112); staff do not', async () => {
    const h = await setupUi();
    useAppStore.setState({ storageStatus: 'notPersisted' });
    await signIn(h.staff);
    expect(useSessionStore.getState().banners.storageWarning).toBe(false);
    lock();
    await signIn(h.manager);
    expect(useSessionStore.getState().banners.storageWarning).toBe(true);
  });

  it('afterBackupImport ends the session and clears the basket and Pay (D-090)', async () => {
    const h = await setupUi();
    await openTestPeriod(h);
    await signIn(h.manager);
    await useBasketStore.getState().addProduct(h.lager.id);
    await usePayStore.getState().openSale();
    await afterBackupImport();
    expect(useSessionStore.getState().session).toBeNull();
    expect(useBasketStore.getState().basket).toEqual(EMPTY_BASKET);
    expect(usePayStore.getState().session).toBeNull();
    expect(useAppStore.getState().bootState).toBe('login');
  });
});

describe('openDocument (D-109)', () => {
  const html = '<!doctype html><html><head><title>Receipt 3F9C-000042</title></head><body>Receipt</body></html>';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads the document title', () => {
    expect(documentTitle(html)).toBe('Receipt 3F9C-000042');
    expect(documentTitle('<title>Z report 7</title>')).toBe('Z report 7');
    expect(documentTitle('<p>no title</p>')).toBe('Receipt');
    expect(documentTitle('<title>A &amp; B</title>')).toBe('A & B');
  });

  it('opens a Blob URL in a new tab, clears the opener and revokes the URL after 60 s', () => {
    vi.useFakeTimers();
    const tab = { opener: {} as unknown };
    const open = vi.fn(() => tab);
    vi.stubGlobal('window', { open });
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    expect(openDocument(html)).toBe(true);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), '_blank');
    expect(tab.opener).toBeNull();
    expect(useUiStore.getState().receiptFallback).toBeNull();
    vi.advanceTimersByTime(DOCUMENT_URL_LIFETIME_MS);
    expect(revoke).toHaveBeenCalled();
    revoke.mockRestore();
  });

  it('shows the fallback panel when the popup is blocked; Reprint closes it once a tab opens', () => {
    const open = vi.fn<(url: string, target: string) => unknown>(() => null);
    vi.stubGlobal('window', { open });
    expect(openDocument(html)).toBe(false);
    expect(useUiStore.getState().receiptFallback).toEqual({ html, title: 'Receipt 3F9C-000042' });

    expect(reprintFallback()).toBe(false);
    expect(useUiStore.getState().receiptFallback).not.toBeNull();

    open.mockImplementation(() => ({ opener: null }));
    expect(reprintFallback()).toBe(true);
    expect(useUiStore.getState().receiptFallback).toBeNull();
  });

  it('a lock keeps the blocked document for the next login, since it may be the only copy (D-135)', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    expect(openDocument(html)).toBe(false);
    lock();
    expect(useUiStore.getState().receiptFallback).toEqual({ html, title: 'Receipt 3F9C-000042' });
    useUiStore.getState().closeReceiptFallback();
    expect(useUiStore.getState().receiptFallback).toBeNull();
  });
});
