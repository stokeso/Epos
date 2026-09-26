/**
 * BLIND full-shift scenario test (spec §1.1, §6, §7, §10.3; decisions D-001..D-124).
 *
 * Written from docs/design-spec.md, docs/decisions.md and the exported service signatures only.
 * Every expected figure below was computed by hand from the spec rules; the arithmetic is in
 * the comments. Nothing here is copied from the implementation or the seed catalogue.
 *
 * The shift runs through the services against the LocalAdapter on fake-indexeddb, with a
 * controlled clock (all instants on 26/09/2026, London = UTC+1) and sequential UUID v4 ids
 * that all start with '3f9c', so the device prefix is '3F9C' (D-057, D-119).
 *
 * Own catalogue (all 20% unless stated; "elig" = member-discount eligible):
 *   Beer    (sort 1): Heathland Bitter 430 (pint, tracked, low 10), Greenside Lager 490 (pint, tracked, low 10)
 *   Snacks  (sort 2): Sea Salt Crisps 135 (tracked, low 6), Honey Nuts 165 (tracked, low 20)
 *   Wine    (sort 3): Clubhouse Red (bottle) 2150 (tracked, low 4)
 *   Events  (sort 4): Charity Raffle 200, 0% VAT, NOT eligible, NOT tracked
 *   Deal D1 "Pints 2 for £8.50": nForPrice n=2, 850, {Bitter, Lager}   (created first)
 *   Deal D2 "Snacks 3 for 2":    nForM n=3 m=2,      {Crisps, Nuts}
 *   Members: 2001 Fiona Fairway, 2002 Gary Green. Member discount 15% (default).
 *
 * VAT @20% = roundHalfUp(final × 20 / 120) = roundHalfUp(final / 6) (D-021, D-002).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalAdapter, deleteLocalDatabase } from '../../../src/data/local';
import type { Repos } from '../../../src/data/repos';
import type {
  Action,
  AuditEvent,
  Booking,
  Category,
  Deal,
  Member,
  Period,
  Product,
  Sale,
  SaleLine,
  Tab,
  TenderType,
} from '../../../src/data/types';
import { EMPTY_BASKET, type BasketState } from '../../../src/rules/basket';
import { createServiceContext, type ServiceContext } from '../../../src/services/context';
import { completeFirstRun, getBootState } from '../../../src/services/setup';
import { login, type Session } from '../../../src/services/auth';
import { approveOverride, authoriseDirect, type Authorisation } from '../../../src/services/override';
import { createStaff, listStaff } from '../../../src/services/staff';
import { saveCategory, saveDeal, saveProduct } from '../../../src/services/catalogue';
import { saveMember, searchMembers } from '../../../src/services/members';
import {
  getBookingSummary,
  listAttachableBookings,
  saveBooking,
  settleBooking,
} from '../../../src/services/bookings';
import {
  listLowStock,
  listStockLevels,
  recordGoodsIn,
  recordStockAdjustment,
} from '../../../src/services/stock';
import {
  confirmZClose,
  getOpenPeriod,
  openPeriod,
  prepareZClose,
  previewZClose,
  runXRead,
} from '../../../src/services/periods';
import { recordNoSale, viewBasket, voidLine } from '../../../src/services/till';
import {
  completePayment,
  openDepositPayment,
  openSalePayment,
  takeTender,
  type PaySession,
} from '../../../src/services/pay';
import { addBasketToTab, listOpenTabs, loadTab, openNewTab } from '../../../src/services/tabs';
import { commitRefund, findSaleForRefund } from '../../../src/services/refunds';
import { runProductSalesReport, runVatReport, todayLocal } from '../../../src/services/reports';

// ---------------------------------------------------------------------------------------------
// Controlled clock and ids
// ---------------------------------------------------------------------------------------------

let clockMs = Date.parse('2026-09-26T09:00:00.000Z');
const now = (): Date => new Date(clockMs);
/** Sets the clock to 26/09/2026 hh:mm UTC and returns that ISO instant. */
function at(hhmm: string): string {
  clockMs = Date.parse(`2026-09-26T${hhmm}:00.000Z`);
  return new Date(clockMs).toISOString();
}

let idSeq = 0;
/** Sequential UUID v4 ids; the first one (the deviceId) gives devicePrefix '3F9C'. */
const newId = (): string => `3f9c2a01-7b4d-4e8a-9c1f-${(++idSeq).toString(16).padStart(12, '0')}`;

const dbName = `blind-shift-${crypto.randomUUID()}`;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function direct(session: Session, action: Action): Authorisation {
  const auth = authoriseDirect(session, action);
  if (!auth) throw new Error(`${session.name} (${session.role}) cannot ${action} directly`);
  return auth;
}

function tender(session: PaySession, type: TenderType, amountPence: number | null): PaySession {
  const result = takeTender(session, { type, amountPence });
  if (!result.ok) throw new Error(`tender rejected: ${result.message}`);
  return result.session;
}

/** Expected sale-kind line. Self-checks the hand arithmetic: final = qty·unit − deal − member. */
function saleLine(p: Product, qty: number, deal: number, member: number, final: number, vat: number): SaleLine {
  if (qty * p.pricePence - deal - member !== final) throw new Error(`hand arithmetic wrong: ${p.name}`);
  return {
    productId: p.id,
    nameAtSale: p.name,
    qty,
    unitPricePence: p.pricePence,
    vatRate: p.vatRate,
    dealDiscountPence: deal,
    memberDiscountPence: member,
    finalPence: final,
    vatPence: vat,
  };
}

/** Expected refund line (negated figures, D-037). Self-checks final = qty·unit − deal − member. */
function refundLine(
  p: Product,
  qty: number,
  deal: number,
  member: number,
  final: number,
  vat: number,
  refundOfLineIndex: number,
  returnToStock: boolean,
): SaleLine {
  return { ...saleLine(p, qty, deal, member, final, vat), refundOfLineIndex, returnToStock };
}

function ofType<T extends AuditEvent['type']>(events: readonly AuditEvent[], type: T): Extract<AuditEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AuditEvent, { type: T }> => e.type === type);
}

// ---------------------------------------------------------------------------------------------
// The shift
// ---------------------------------------------------------------------------------------------

describe('blind full shift: own catalogue through the services (LocalAdapter + fake-indexeddb)', () => {
  let repos: Repos;
  let ctx: ServiceContext;

  let maggie: Session; // manager (first run)
  let sam: Session; // staff
  let sally: Session; // supervisor

  const cat: Record<'beer' | 'snacks' | 'wine' | 'events', Category> = {} as never;
  const P: Record<'bitter' | 'lager' | 'crisps' | 'nuts' | 'wine' | 'raffle', Product> = {} as never;
  const D: Record<'pints' | 'snacks', Deal> = {} as never;
  const M: Record<'fiona' | 'gary', Member> = {} as never;
  const B: Record<'patel' | 'fairway', Booking> = {} as never;
  let period: Period;
  let tabA: Tab; // name "Hendry"
  let tabB: Tab; // table "7"

  // Sales in commit order (receipt numbers 3F9C-000001 .. 000010).
  let s1: Sale; // 000001 deal sale (after override void)
  let s2: Sale; // 000002 member sale, half-penny, split card + cash with change
  let dep1: Sale; // 000003 deposit Patel £100 by card
  let dep2: Sale; // 000004 deposit Fairway £60 in cash, change £10
  let saleTabA: Sale; // 000005 settle tab "Hendry"
  let saleTabB: Sale; // 000006 settle tab "Table 7" (member)
  let bill1: Sale; // 000007 Patel final bill > deposit
  let bill2: Sale; // 000008 Fairway final bill < deposit (total 0)
  let ref1: Sale; // 000009 refund of 000006, return to stock, card
  let ref2: Sale; // 000010 refund of 000001, waste, cash

  const onHand = (p: Product): Promise<number> => repos.stockMovements.onHand(p.id);

  beforeAll(async () => {
    repos = await createLocalAdapter({ dbName, now, newId });
    ctx = createServiceContext({ repos, now, newId });
  });

  afterAll(async () => {
    await repos.close();
    await deleteLocalDatabase(dbName);
  });

  // ---------------------------------------------------------------------------------------------
  it('1. first run creates the manager and Settings (D-057, D-111)', async () => {
    at('09:00');
    expect(await getBootState(ctx)).toBe('setup');
    maggie = await completeFirstRun(ctx, {
      clubName: 'Brackenridge Golf Club',
      managerName: 'Maggie Manager',
      pin: '4321',
      confirmPin: '4321',
      loadSampleData: false,
    });
    expect(maggie).toMatchObject({ name: 'Maggie Manager', role: 'manager' });
    expect(await getBootState(ctx)).toBe('login');

    const settings = must(await repos.settings.get(), 'settings');
    expect.soft(settings).toMatchObject({
      clubName: 'Brackenridge Golf Club',
      receiptFooter: 'Thank you for your custom',
      autoLockMinutes: 5,
      memberDiscountPercent: 15,
      devicePrefix: '3F9C', // first 4 chars of the first generated id, upper-cased
      receiptCounter: 0,
    });
    expect.soft(await login(ctx, '4321')).toEqual(maggie);
    // No sample data: no categories or products.
    expect.soft(await repos.products.list()).toEqual([]);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('2. manager creates a staff member and a supervisor who can log in', async () => {
    at('09:05');
    await createStaff(ctx, direct(maggie, 'manageMembersStaffSettings'), {
      name: 'Sam Server',
      role: 'staff',
      pin: '1357',
      confirmPin: '1357',
    });
    await createStaff(ctx, direct(maggie, 'manageMembersStaffSettings'), {
      name: 'Sally Supervisor',
      role: 'supervisor',
      pin: '2468',
      confirmPin: '2468',
    });
    sam = must(await login(ctx, '1357'), 'Sam session');
    sally = must(await login(ctx, '2468'), 'Sally session');
    expect(sam).toMatchObject({ name: 'Sam Server', role: 'staff' });
    expect(sally).toMatchObject({ name: 'Sally Supervisor', role: 'supervisor' });
    expect.soft(await login(ctx, '9999')).toBeNull();

    const staff = await listStaff(ctx);
    expect.soft(staff.map((s) => s.name).sort()).toEqual(['Maggie Manager', 'Sally Supervisor', 'Sam Server']);
    for (const s of staff) expect.soft('pinHash' in s || 'pinSalt' in s).toBe(false);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('3. manager builds the catalogue, deals and members', async () => {
    at('09:10');
    const edit = (): Authorisation => direct(maggie, 'editCatalogue');
    cat.beer = await saveCategory(ctx, edit(), null, { name: 'Beer', sortOrder: 1, colour: '#b45309' });
    cat.snacks = await saveCategory(ctx, edit(), null, { name: 'Snacks', sortOrder: 2, colour: '#15803d' });
    cat.wine = await saveCategory(ctx, edit(), null, { name: 'Wine', sortOrder: 3, colour: '#9f1239' });
    cat.events = await saveCategory(ctx, edit(), null, { name: 'Events', sortOrder: 4, colour: '#475569' });

    const product = (
      name: string,
      category: Category,
      pricePence: number,
      sortOrder: number,
      extra: Partial<Pick<Product, 'vatRate' | 'memberDiscountEligible' | 'stockTracked' | 'stockUnit' | 'lowStockLevel'>>,
    ): Promise<Product> =>
      saveProduct(ctx, edit(), null, {
        name,
        categoryId: category.id,
        pricePence,
        vatRate: 20,
        memberDiscountEligible: true,
        stockTracked: true,
        stockUnit: 'unit',
        lowStockLevel: 0,
        buttonColour: category.colour,
        sortOrder,
        active: true,
        ...extra,
      });

    P.bitter = await product('Heathland Bitter', cat.beer, 430, 1, { stockUnit: 'pint', lowStockLevel: 10 });
    P.lager = await product('Greenside Lager', cat.beer, 490, 2, { stockUnit: 'pint', lowStockLevel: 10 });
    P.crisps = await product('Sea Salt Crisps', cat.snacks, 135, 1, { stockUnit: 'packet', lowStockLevel: 6 });
    P.nuts = await product('Honey Nuts', cat.snacks, 165, 2, { stockUnit: 'packet', lowStockLevel: 20 });
    P.wine = await product('Clubhouse Red (bottle)', cat.wine, 2150, 1, { stockUnit: 'bottle', lowStockLevel: 4 });
    P.raffle = await product('Charity Raffle', cat.events, 200, 1, {
      vatRate: 0,
      memberDiscountEligible: false,
      stockTracked: false,
      stockUnit: 'ticket',
      lowStockLevel: 0,
    });
    expect.soft(P.raffle).toMatchObject({ vatRate: 0, memberDiscountEligible: false, stockTracked: false });

    D.pints = await saveDeal(ctx, edit(), null, {
      name: 'Pints 2 for £8.50',
      type: 'nForPrice',
      n: 2,
      pricePence: 850,
      productIds: [P.bitter.id, P.lager.id],
      active: true,
    });
    at('09:11'); // D2 created after D1: canonical deal order is D1, D2 (D-018)
    D.snacks = await saveDeal(ctx, edit(), null, {
      name: 'Snacks 3 for 2',
      type: 'nForM',
      n: 3,
      m: 2,
      productIds: [P.crisps.id, P.nuts.id],
      active: true,
    });
    expect.soft(D.pints).toMatchObject({ type: 'nForPrice', n: 2, pricePence: 850, active: true });
    expect.soft(D.snacks).toMatchObject({ type: 'nForM', n: 3, m: 2, active: true });

    at('09:15');
    const members = (): Authorisation => direct(maggie, 'manageMembersStaffSettings');
    M.fiona = await saveMember(ctx, members(), null, { memberNumber: '2001', firstName: 'Fiona', lastName: 'Fairway', active: true });
    M.gary = await saveMember(ctx, members(), null, { memberNumber: '2002', firstName: 'Gary', lastName: 'Green', active: true });
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('4. opening stock by goods in (no period needed, D-068)', async () => {
    at('09:20');
    const opening: [Product, number][] = [
      [P.bitter, 40],
      [P.lager, 40],
      [P.crisps, 24],
      [P.nuts, 24],
      [P.wine, 12],
    ];
    for (const [p, qty] of opening) {
      const mv = await recordGoodsIn(ctx, direct(maggie, 'stockControl'), { productId: p.id, qty, note: 'Opening stock' });
      expect.soft(mv).toMatchObject({ productId: p.id, qty, reason: 'goodsIn', staffId: maggie.staffId, note: 'Opening stock' });
    }
    expect.soft(await onHand(P.bitter)).toBe(40);
    expect.soft(await onHand(P.wine)).toBe(12);
    expect.soft(await onHand(P.raffle)).toBe(0); // untracked: no movements
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('5. two bookings are created open with no deposit', async () => {
    at('09:30');
    B.patel = await saveBooking(ctx, direct(sam, 'bookings'), null, {
      type: 'wedding',
      name: 'Patel Wedding',
      date: '2026-10-17',
      notes: 'Evening reception',
    });
    B.fairway = await saveBooking(ctx, direct(sam, 'bookings'), null, {
      type: 'society',
      name: 'Fairway Society Day',
      date: '2026-10-03',
      notes: '',
    });
    expect.soft(B.patel).toMatchObject({ status: 'open', name: 'Patel Wedding', type: 'wedding', date: '2026-10-17' });
    expect.soft(B.fairway).toMatchObject({ status: 'open', notes: '' });
    expect.soft(await repos.sales.bookingBalance(B.patel.id)).toBe(0);
    // Balance 0 -> not attachable (D-028).
    expect.soft(await listAttachableBookings(ctx)).toEqual([]);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('6. selling is blocked until the manager opens a period with a £150 float', async () => {
    at('10:00');
    await expect(openSalePayment(ctx, { lines: [{ productId: P.bitter.id, qty: 1 }] })).rejects.toMatchObject({
      code: 'NO_OPEN_PERIOD',
    });
    expect(authoriseDirect(sally, 'openClosePeriod')).toBeNull(); // manager only
    period = await openPeriod(ctx, direct(maggie, 'openClosePeriod'), 15000);
    expect.soft(period).toMatchObject({
      openedBy: maggie.staffId,
      openedAt: '2026-09-26T10:00:00.000Z',
      floatPence: 15000,
    });
    expect.soft(period.closedAt).toBeUndefined();
    expect.soft((await getOpenPeriod(ctx))?.id).toBe(period.id);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('7. S1: staff void needs a supervisor PIN override; deal sale paid in cash with change', async () => {
    at('10:05');
    let basket: BasketState = {
      lines: [
        { productId: P.bitter.id, qty: 3 },
        { productId: P.lager.id, qty: 1 },
      ],
    };
    // Staff cannot void directly; Sam's own PIN cannot approve (staff role); Sally's can.
    expect(authoriseDirect(sam, 'voidLine')).toBeNull();
    expect.soft(await approveOverride(ctx, sam, 'voidLine', '1357')).toBeNull();
    const voidAuth = must(await approveOverride(ctx, sam, 'voidLine', '2468'), 'override');
    expect.soft(voidAuth).toEqual({ action: 'voidLine', staffId: sam.staffId, approvedById: sally.staffId });

    basket = await voidLine(ctx, voidAuth, basket, P.bitter.id, 1);
    expect.soft(basket.lines).toEqual([
      { productId: P.bitter.id, qty: 2 },
      { productId: P.lager.id, qty: 1 },
    ]);

    // D-072: one override event AND one void event, both recording requester and approver.
    const events = await repos.auditEvents.listByPeriod(period.id);
    const overrides = ofType(events, 'override');
    const voids = ofType(events, 'void');
    expect.soft(overrides).toHaveLength(1);
    expect.soft(voids).toHaveLength(1);
    expect.soft(overrides[0]).toMatchObject({
      type: 'override',
      staffId: sam.staffId,
      approvedById: sally.staffId,
      periodId: period.id,
      detail: { action: 'voidLine' },
    });
    expect.soft(voids[0]).toMatchObject({
      type: 'void',
      staffId: sam.staffId,
      approvedById: sally.staffId,
      periodId: period.id,
    });
    expect.soft(voids[0]?.detail).toEqual({
      productId: P.bitter.id,
      productName: 'Heathland Bitter',
      qty: 1,
      unitPricePence: 430, // current price
    });

    at('10:06');
    // Pricing, Bitter ×2 @430 + Lager ×1 @490 with D1 (n=2 for 850):
    //   units sorted: Lager 490, Bitter 430 (u0), Bitter 430 (u1)
    //   group {490, 430} = 920, saving 920 − 850 = 70; Bitter u1 left over
    //   spread 70 over [490, 430] (W 920): 70·490/920 = 37.28 → 37; 70·430/920 = 32.72 → 33; sum 70
    //   Bitter: gross 860, deal 33, final 827, VAT 827/6 = 137.83 → 138
    //   Lager:  gross 490, deal 37, final 453, VAT 453/6 = 75.5 → 76 (half up)
    //   total 827 + 453 = 1280 (= 1350 − 70)
    const pay = await openSalePayment(ctx, basket);
    expect.soft(pay.priced.totalPence).toBe(1280);
    const paid = tender(pay, 'cash', 2000); // £20 note: change 2000 − 1280 = 720
    expect.soft(paid.tender).toMatchObject({ complete: true, changePence: 720 });

    const done = await completePayment(ctx, direct(sam, 'sell'), paid);
    s1 = done.sale;
    expect.soft(s1).toMatchObject({
      receiptNumber: '3F9C-000001',
      periodId: period.id,
      staffId: sam.staffId,
      kind: 'sale',
      memberDiscountPence: 0,
      depositAppliedPence: 0,
      totalPence: 1280,
      tenders: [{ type: 'cash', amountPence: 2000 }],
      changePence: 720,
      createdAt: '2026-09-26T10:06:00.000Z',
    });
    expect.soft(s1.lines).toEqual([saleLine(P.bitter, 2, 33, 0, 827, 138), saleLine(P.lager, 1, 37, 0, 453, 76)]);
    expect.soft(s1.dealLines).toEqual([{ dealId: D.pints.id, name: 'Pints 2 for £8.50', groupCount: 1, savingPence: 70 }]);
    expect.soft('memberId' in s1 || 'bookingId' in s1 || 'tabId' in s1).toBe(false);
    expect.soft(done.document).toContain('Receipt 3F9C-000001');

    const moves = await repos.stockMovements.listBySale(s1.id);
    expect.soft(moves.map((m) => [m.productId, m.qty, m.reason, m.staffId]).sort()).toEqual(
      [
        [P.bitter.id, -2, 'sale', sam.staffId],
        [P.lager.id, -1, 'sale', sam.staffId],
      ].sort(),
    );
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('8. S2: manager voids directly; member discount with a half-penny; card above balance rejected; split card + cash with change', async () => {
    at('10:10');
    const found = await searchMembers(ctx, '2001');
    expect.soft(found.map((m) => m.id)).toEqual([M.fiona.id]);

    let basket: BasketState = {
      lines: [
        { productId: P.wine.id, qty: 1 },
        { productId: P.crisps.id, qty: 2 },
        { productId: P.nuts.id, qty: 1 },
        { productId: P.raffle.id, qty: 1 },
      ],
      memberId: M.fiona.id,
    };
    // Manager voids 1 crisps directly: no override event (D-070), one void event.
    basket = await voidLine(ctx, direct(maggie, 'voidLine'), basket, P.crisps.id, 1);
    expect.soft(basket).toEqual({
      lines: [
        { productId: P.wine.id, qty: 1 },
        { productId: P.crisps.id, qty: 1 },
        { productId: P.nuts.id, qty: 1 },
        { productId: P.raffle.id, qty: 1 },
      ],
      memberId: M.fiona.id,
    });
    const voids = ofType(await repos.auditEvents.listByPeriod(period.id), 'void');
    const managerVoid = voids.find((v) => v.staffId === maggie.staffId);
    expect.soft(voids).toHaveLength(2);
    expect.soft(managerVoid?.detail).toEqual({ productId: P.crisps.id, productName: 'Sea Salt Crisps', qty: 1, unitPricePence: 135 });
    expect.soft(managerVoid !== undefined && 'approvedById' in managerVoid).toBe(false);
    expect.soft(ofType(await repos.auditEvents.listByPeriod(period.id), 'override')).toHaveLength(1);

    at('10:11');
    // Pricing: Wine 2150, Crisps 135, Nuts 165, Raffle 200 (0%, ineligible); member at 15%.
    //   D2 needs 3 snack units; only 2 (crisps 1 + nuts 1) -> no deal.
    //   base = 2150 + 135 + 165 = 2450 (raffle excluded); 2450 × 15 / 100 = 367.5 → 368 (half up)
    //   spread 368 over [2150, 135, 165] (W 2450):
    //     wine 368·2150/2450 = 322.94 → 323; crisps 368·135/2450 = 20.28 → 20; nuts 368·165/2450 = 24.78 → 25
    //     sum 368, no remainder
    //   Wine:   final 2150 − 323 = 1827, VAT 1827/6 = 304.5 → 305 (half up)
    //   Crisps: final 135 − 20 = 115,   VAT 115/6 = 19.17 → 19
    //   Nuts:   final 165 − 25 = 140,   VAT 140/6 = 23.33 → 23
    //   Raffle: final 200, VAT 0
    //   total 1827 + 115 + 140 + 200 = 2282 (= 2650 − 368)
    const pay = await openSalePayment(ctx, basket);
    expect.soft(pay.priced).toMatchObject({ grossPence: 2650, dealDiscountPence: 0, memberDiscountPence: 368, totalPence: 2282 });

    const rejected = takeTender(pay, { type: 'card', amountPence: 3000 }); // 3000 > 2282
    expect.soft(rejected.ok).toBe(false);
    if (!rejected.ok) expect.soft(rejected.reason).toBe('cardExceedsBalance');

    let session = tender(pay, 'card', 1500); // remaining 2282 − 1500 = 782
    expect.soft(session.tender).toMatchObject({ complete: false, remainingPence: 782 });
    session = tender(session, 'cash', 1000); // 1000 − 782 = 218 change
    expect.soft(session.tender).toMatchObject({ complete: true, changePence: 218 });

    const done = await completePayment(ctx, direct(maggie, 'sell'), session);
    s2 = done.sale;
    // Receipt (D-107): member line with the member number at −368, TOTAL 2282, change 218.
    expect.soft(done.document).toContain('Member discount (#2001)');
    expect.soft(done.document).toContain('-£3.68');
    expect.soft(done.document).toContain('£22.82');
    expect.soft(done.document).toContain('£2.18');
    expect.soft(s2).toMatchObject({
      receiptNumber: '3F9C-000002',
      staffId: maggie.staffId,
      kind: 'sale',
      memberId: M.fiona.id,
      memberDiscountPence: 368,
      depositAppliedPence: 0,
      totalPence: 2282,
      tenders: [
        { type: 'card', amountPence: 1500 },
        { type: 'cash', amountPence: 1000 },
      ],
      changePence: 218,
      dealLines: [],
    });
    expect.soft(s2.lines).toEqual([
      saleLine(P.wine, 1, 0, 323, 1827, 305),
      saleLine(P.crisps, 1, 0, 20, 115, 19),
      saleLine(P.nuts, 1, 0, 25, 140, 23),
      saleLine(P.raffle, 1, 0, 0, 200, 0),
    ]);
    // Untracked raffle writes no movement (D-079).
    const moves = await repos.stockMovements.listBySale(s2.id);
    expect.soft(moves.map((m) => [m.productId, m.qty]).sort()).toEqual(
      [
        [P.wine.id, -1],
        [P.crisps.id, -1],
        [P.nuts.id, -1],
      ].sort(),
    );
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('9. tab by name "Hendry" and tab by table "7" are opened', async () => {
    at('10:20');
    const a = await openNewTab(ctx, direct(sam, 'tabs'), { lines: [{ productId: P.bitter.id, qty: 2 }] }, 'name', 'Hendry');
    tabA = a.tab;
    expect.soft(a.basket.lines).toEqual([]);
    expect.soft(tabA).toMatchObject({
      labelType: 'name',
      label: 'Hendry',
      status: 'open',
      openedBy: sam.staffId,
      openedAt: '2026-09-26T10:20:00.000Z',
      lines: [{ productId: P.bitter.id, qty: 2 }],
    });
    expect.soft('memberId' in tabA).toBe(false);

    at('10:25');
    // D-064: name labels are unique case-insensitively among open tabs.
    await expect
      .soft(openNewTab(ctx, direct(sam, 'tabs'), { lines: [{ productId: P.nuts.id, qty: 1 }] }, 'name', ' hendry '))
      .rejects.toMatchObject({ code: 'VALIDATION' });

    const b = await openNewTab(
      ctx,
      direct(sam, 'tabs'),
      {
        lines: [
          { productId: P.crisps.id, qty: 1 },
          { productId: P.nuts.id, qty: 1 },
        ],
        memberId: M.gary.id,
      },
      'table',
      '7',
    );
    tabB = b.tab;
    expect.soft(b.basket.lines).toEqual([]);
    expect.soft(b.basket.memberId).toBeUndefined();
    expect.soft(tabB).toMatchObject({
      labelType: 'table',
      label: '7',
      status: 'open',
      memberId: M.gary.id,
      lines: [
        { productId: P.crisps.id, qty: 1 },
        { productId: P.nuts.id, qty: 1 },
      ],
    });
    // Tabs move no stock until settlement (D-062).
    expect.soft(await onHand(P.bitter)).toBe(38); // 40 − 2 (S1)
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('10. deposit of £100 for the Patel wedding, taken by card', async () => {
    at('10:30');
    const dp = await openDepositPayment(ctx, B.patel.id, 10000);
    const paid = tender(dp, 'card', null); // card with an empty keypad takes the full 10000
    expect.soft(paid.tender).toMatchObject({ complete: true, changePence: 0 });
    const done = await completePayment(ctx, direct(sam, 'bookings'), paid);
    dep1 = done.sale;
    expect.soft(dep1).toMatchObject({
      receiptNumber: '3F9C-000003',
      kind: 'deposit',
      bookingId: B.patel.id,
      staffId: sam.staffId,
      lines: [],
      dealLines: [],
      memberDiscountPence: 0,
      depositAppliedPence: 0,
      totalPence: 10000,
      tenders: [{ type: 'card', amountPence: 10000 }],
      changePence: 0,
    });
    expect.soft('memberId' in dep1 || 'tabId' in dep1).toBe(false);
    expect.soft(await repos.stockMovements.listBySale(dep1.id)).toEqual([]);
    expect.soft(await repos.sales.bookingBalance(B.patel.id)).toBe(10000);
    expect.soft(done.document).toContain('Receipt 3F9C-000003');
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('11. first additions to both tabs', async () => {
    at('10:40');
    const a = await addBasketToTab(ctx, direct(sam, 'tabs'), { lines: [{ productId: P.lager.id, qty: 2 }] }, tabA.id);
    tabA = a.tab;
    expect.soft(a.basket.lines).toEqual([]);
    expect.soft(tabA.lines).toEqual([
      { productId: P.bitter.id, qty: 2 },
      { productId: P.lager.id, qty: 2 },
    ]);

    at('10:45');
    const b = await addBasketToTab(ctx, direct(sam, 'tabs'), { lines: [{ productId: P.crisps.id, qty: 1 }] }, tabB.id);
    tabB = b.tab;
    expect.soft(tabB.lines).toEqual([
      { productId: P.crisps.id, qty: 2 },
      { productId: P.nuts.id, qty: 1 },
    ]);
    expect.soft(tabB.memberId).toBe(M.gary.id);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('12. no sale by the supervisor (staff cannot do it directly)', async () => {
    at('10:50');
    expect(authoriseDirect(sam, 'noSale')).toBeNull();
    await recordNoSale(ctx, direct(sally, 'noSale'));
    const noSales = ofType(await repos.auditEvents.listByPeriod(period.id), 'noSale');
    expect.soft(noSales).toHaveLength(1);
    expect.soft(noSales[0]).toMatchObject({ staffId: sally.staffId, periodId: period.id, detail: {} });
    expect.soft(noSales[0] !== undefined && 'approvedById' in noSales[0]).toBe(false);
    // A no sale takes no receipt number (D-060).
    expect.soft((await repos.settings.get())?.receiptCounter).toBe(3);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('13. deposit of £60 for the Fairway society day in cash, £50 + £20 notes, £10 change', async () => {
    at('11:00');
    const dp = await openDepositPayment(ctx, B.fairway.id, 6000);
    let session = tender(dp, 'cash', 5000); // remaining 1000
    expect.soft(session.tender).toMatchObject({ complete: false, remainingPence: 1000 });
    session = tender(session, 'cash', 2000); // 7000 − 6000 = 1000 change
    const done = await completePayment(ctx, direct(sally, 'bookings'), session);
    dep2 = done.sale;
    // Deposit receipt (D-108): 'Deposit balance now' = 6000 after this deposit; no VAT summary.
    expect.soft(done.document).toContain('Deposit balance now');
    expect.soft(done.document).toContain('£60.00');
    expect.soft(done.document).toContain('No VAT');
    expect.soft(dep2).toMatchObject({
      receiptNumber: '3F9C-000004',
      kind: 'deposit',
      bookingId: B.fairway.id,
      staffId: sally.staffId,
      totalPence: 6000,
      tenders: [
        { type: 'cash', amountPence: 5000 },
        { type: 'cash', amountPence: 2000 },
      ],
      changePence: 1000,
    });
    expect.soft(await repos.sales.bookingBalance(B.fairway.id)).toBe(6000);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('14. second additions to both tabs; the Tabs list reprices them', async () => {
    at('11:15');
    tabA = (
      await addBasketToTab(
        ctx,
        direct(sam, 'tabs'),
        {
          lines: [
            { productId: P.crisps.id, qty: 2 },
            { productId: P.bitter.id, qty: 1 },
          ],
        },
        tabA.id,
      )
    ).tab;
    // mergeLines: Bitter summed in place (2 + 1), Crisps appended.
    expect.soft(tabA.lines).toEqual([
      { productId: P.bitter.id, qty: 3 },
      { productId: P.lager.id, qty: 2 },
      { productId: P.crisps.id, qty: 2 },
    ]);

    at('11:20');
    tabB = (
      await addBasketToTab(
        ctx,
        direct(sam, 'tabs'),
        {
          lines: [
            { productId: P.wine.id, qty: 1 },
            { productId: P.lager.id, qty: 1 },
          ],
        },
        tabB.id,
      )
    ).tab;
    expect.soft(tabB.lines).toEqual([
      { productId: P.crisps.id, qty: 2 },
      { productId: P.nuts.id, qty: 1 },
      { productId: P.wine.id, qty: 1 },
      { productId: P.lager.id, qty: 1 },
    ]);
    expect.soft(tabB.memberId).toBe(M.gary.id);

    at('11:45');
    // Totals are worked out in steps 15 and 16: Hendry 2400, Table 7 2499.
    // Time open: Hendry 10:20 -> 11:45 = 1h 25m; Table 7 10:25 -> 11:45 = 1h 20m.
    const list = await listOpenTabs(ctx, EMPTY_BASKET);
    expect.soft(list.map((t) => [t.tab.id, t.displayLabel, t.totalPence, t.timeOpen, t.onTill])).toEqual([
      [tabA.id, 'Hendry', 2400, '1h 25m', false],
      [tabB.id, 'Table 7', 2499, '1h 20m', false],
    ]);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('15. settle tab "Hendry" by card', async () => {
    at('11:50');
    const basket = await loadTab(ctx, direct(sam, 'tabs'), EMPTY_BASKET, tabA.id);
    expect.soft(basket).toEqual({ lines: tabA.lines, tabId: tabA.id });

    // Pricing, Bitter ×3 @430, Lager ×2 @490, Crisps ×2 @135:
    //   D1 units sorted: L 490, L 490, B 430, B 430, B 430
    //     group {490, 490} = 980, saving 130 → 65 / 65
    //     group {430, 430} = 860, saving 10  → 5 / 5
    //     one Bitter left over. D1 x2, saving 140.
    //   D2 has only 2 crisps (< 3): no candidate.
    //   Bitter: gross 1290, deal 10,  final 1280, VAT 1280/6 = 213.33 → 213
    //   Lager:  gross 980,  deal 130, final 850,  VAT 850/6 = 141.67 → 142
    //   Crisps: gross 270,  deal 0,   final 270,  VAT 45
    //   total 1280 + 850 + 270 = 2400 (= 2540 − 140)
    const pay = await openSalePayment(ctx, basket);
    expect.soft(pay.priced.totalPence).toBe(2400);
    const paid = tender(pay, 'card', null);
    saleTabA = (await completePayment(ctx, direct(sam, 'sell'), paid)).sale;
    expect.soft(saleTabA).toMatchObject({
      receiptNumber: '3F9C-000005',
      kind: 'sale',
      tabId: tabA.id,
      totalPence: 2400,
      memberDiscountPence: 0,
      tenders: [{ type: 'card', amountPence: 2400 }],
      changePence: 0,
    });
    expect.soft('memberId' in saleTabA).toBe(false);
    expect.soft(saleTabA.lines).toEqual([
      saleLine(P.bitter, 3, 10, 0, 1280, 213),
      saleLine(P.lager, 2, 130, 0, 850, 142),
      saleLine(P.crisps, 2, 0, 0, 270, 45),
    ]);
    expect.soft(saleTabA.dealLines).toEqual([{ dealId: D.pints.id, name: 'Pints 2 for £8.50', groupCount: 2, savingPence: 140 }]);

    const settled = must(await repos.tabs.get(tabA.id), 'tab A');
    expect.soft(settled.status).toBe('settled');
    expect.soft(settled.lines).toEqual([
      { productId: P.bitter.id, qty: 3 },
      { productId: P.lager.id, qty: 2 },
      { productId: P.crisps.id, qty: 2 },
    ]);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('16. settle tab "Table 7": member stays attached; deal + member remainder; cash then card', async () => {
    at('11:55');
    const basket = await loadTab(ctx, direct(sam, 'tabs'), EMPTY_BASKET, tabB.id);
    expect.soft(basket).toEqual({ lines: tabB.lines, memberId: M.gary.id, tabId: tabB.id });

    // Pricing, Crisps ×2 @135, Nuts ×1 @165, Wine ×1 @2150, Lager ×1 @490; member 15%.
    //   D1: one Lager only (< 2) -> no candidate.
    //   D2 units sorted: Nuts 165, Crisps 135, Crisps 135; cheapest 1 free: saving 135
    //     spread [165, 135, 135] (W 435): 135·165/435 = 51.21 → 51; 135·135/435 = 41.90 → 42, 42; sum 135
    //     Crisps deal 84, Nuts deal 51.
    //   post-deal: Crisps 186, Nuts 114, Wine 2150, Lager 490; base 2940; 2940 × 15% = 441 exactly
    //   spread 441 over [186, 114, 2150, 490] (W 2940), priority Wine, Lager, Crisps, Nuts:
    //     Crisps 441·186/2940 = 27.9 → 28; Nuts 441·114/2940 = 17.1 → 17
    //     Wine 441·2150/2940 = 322.5 → 323; Lager 441·490/2940 = 73.5 → 74
    //     sum 442, diff −1 → taken from Wine (largest): Wine 322
    //   Crisps: 270 − 84 − 28 = 158, VAT 158/6 = 26.33 → 26
    //   Nuts:   165 − 51 − 17 = 97,  VAT 97/6 = 16.17 → 16
    //   Wine:   2150 − 322 = 1828,   VAT 1828/6 = 304.67 → 305
    //   Lager:  490 − 74 = 416,      VAT 416/6 = 69.33 → 69
    //   total 158 + 97 + 1828 + 416 = 2499 (= 3075 − 135 − 441)
    const pay = await openSalePayment(ctx, basket);
    expect.soft(pay.priced).toMatchObject({ grossPence: 3075, dealDiscountPence: 135, memberDiscountPence: 441, totalPence: 2499 });
    let session = tender(pay, 'cash', 2000); // remaining 499
    session = tender(session, 'card', null); // card takes the 499 balance
    expect.soft(session.tender).toMatchObject({ complete: true, changePence: 0 });
    saleTabB = (await completePayment(ctx, direct(sam, 'sell'), session)).sale;
    expect.soft(saleTabB).toMatchObject({
      receiptNumber: '3F9C-000006',
      kind: 'sale',
      tabId: tabB.id,
      memberId: M.gary.id,
      memberDiscountPence: 441,
      totalPence: 2499,
      tenders: [
        { type: 'cash', amountPence: 2000 },
        { type: 'card', amountPence: 499 },
      ],
      changePence: 0,
    });
    expect.soft(saleTabB.lines).toEqual([
      saleLine(P.crisps, 2, 84, 28, 158, 26),
      saleLine(P.nuts, 1, 51, 17, 97, 16),
      saleLine(P.wine, 1, 0, 322, 1828, 305),
      saleLine(P.lager, 1, 0, 74, 416, 69),
    ]);
    expect.soft(saleTabB.dealLines).toEqual([{ dealId: D.snacks.id, name: 'Snacks 3 for 2', groupCount: 1, savingPence: 135 }]);
    expect.soft((await repos.tabs.get(tabB.id))?.status).toBe('settled');
    expect.soft(await listOpenTabs(ctx, EMPTY_BASKET)).toEqual([]);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('17. Patel final bill is larger than the deposit: deposit fully applied, balance paid, booking settled', async () => {
    at('12:30');
    // Attachable: open with balance > 0, by date: Fairway (03/10) 6000, Patel (17/10) 10000.
    const attachable = await listAttachableBookings(ctx);
    expect.soft(attachable.map((b) => [b.booking.id, b.balancePence])).toEqual([
      [B.fairway.id, 6000],
      [B.patel.id, 10000],
    ]);

    const basket: BasketState = {
      lines: [
        { productId: P.wine.id, qty: 5 },
        { productId: P.bitter.id, qty: 4 },
      ],
      bookingId: B.patel.id,
    };
    // Pricing: Wine ×5 @2150 = 10750 (no deal), VAT 10750/6 = 1791.67 → 1792
    //   Bitter ×4 @430: D1 two groups {430,430} saving 10 each (5/5) → deal 20, final 1700, VAT 283.33 → 283
    //   subtotal 10750 + 1700 = 12450; deposit applied min(10000, 12450) = 10000; total 2450
    const view = await viewBasket(ctx, basket);
    expect.soft(view.bookingBalancePence).toBe(10000);
    expect.soft(view.priced).toMatchObject({ subtotalPence: 12450, depositAppliedPence: 10000, totalPence: 2450 });

    const pay = await openSalePayment(ctx, basket);
    let session = tender(pay, 'card', 2000); // remaining 450
    session = tender(session, 'cash', 500); // change 50
    expect.soft(session.tender).toMatchObject({ complete: true, changePence: 50 });
    const done = await completePayment(ctx, direct(maggie, 'sell'), session);
    bill1 = done.sale;
    // Receipt (D-107): 'Deposit applied' at −10000; TOTAL £24.50.
    expect.soft(done.document).toContain('Deposit applied');
    expect.soft(done.document).toContain('-£100.00');
    expect.soft(done.document).toContain('£24.50');
    expect.soft(bill1).toMatchObject({
      receiptNumber: '3F9C-000007',
      kind: 'sale',
      bookingId: B.patel.id,
      depositAppliedPence: 10000,
      totalPence: 2450,
      memberDiscountPence: 0,
      tenders: [
        { type: 'card', amountPence: 2000 },
        { type: 'cash', amountPence: 500 },
      ],
      changePence: 50,
    });
    expect.soft(bill1.lines).toEqual([saleLine(P.wine, 5, 0, 0, 10750, 1792), saleLine(P.bitter, 4, 20, 0, 1700, 283)]);
    expect.soft(bill1.dealLines).toEqual([{ dealId: D.pints.id, name: 'Pints 2 for £8.50', groupCount: 2, savingPence: 20 }]);

    // Balance 10000 − 10000 = 0 → can be marked settled (D-026).
    expect.soft(await repos.sales.bookingBalance(B.patel.id)).toBe(0);
    at('12:35');
    const settled = await settleBooking(ctx, direct(maggie, 'bookings'), B.patel.id);
    expect.soft(settled.status).toBe('settled');
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('18. Fairway final bill is smaller than the deposit: bill goes to £0 and the remainder stays', async () => {
    at('13:00');
    const basket: BasketState = {
      lines: [
        { productId: P.lager.id, qty: 3 },
        { productId: P.crisps.id, qty: 3 },
      ],
      bookingId: B.fairway.id,
    };
    // Pricing: Lager ×3 @490: D1 one group {490,490} saving 130 (65/65), one left over
    //   → deal 130, final 1470 − 130 = 1340, VAT 1340/6 = 223.33 → 223
    //   Crisps ×3 @135: D2 one group, 1 free: saving 135 (45/45/45) → final 405 − 135 = 270, VAT 45
    //   Both orders of D1/D2 save 265 (no shared products) → identity order; dealLines D1, D2.
    //   subtotal 1340 + 270 = 1610; deposit applied min(6000, 1610) = 1610; total 0
    const pay = await openSalePayment(ctx, basket);
    expect.soft(pay.priced).toMatchObject({ subtotalPence: 1610, depositAppliedPence: 1610, totalPence: 0 });
    expect.soft(pay.tender).toMatchObject({ complete: true, tenders: [], changePence: 0 });

    bill2 = (await completePayment(ctx, direct(sally, 'sell'), pay)).sale;
    expect.soft(bill2).toMatchObject({
      receiptNumber: '3F9C-000008',
      kind: 'sale',
      bookingId: B.fairway.id,
      staffId: sally.staffId,
      depositAppliedPence: 1610,
      totalPence: 0,
      tenders: [],
      changePence: 0,
    });
    expect.soft(bill2.lines).toEqual([saleLine(P.lager, 3, 130, 0, 1340, 223), saleLine(P.crisps, 3, 135, 0, 270, 45)]);
    expect.soft(bill2.dealLines).toEqual([
      { dealId: D.pints.id, name: 'Pints 2 for £8.50', groupCount: 1, savingPence: 130 },
      { dealId: D.snacks.id, name: 'Snacks 3 for 2', groupCount: 1, savingPence: 135 },
    ]);

    // Remainder 6000 − 1610 = 4390 stays on the booking, which cannot be settled yet.
    expect.soft(await repos.sales.bookingBalance(B.fairway.id)).toBe(4390);
    const summary = must(await getBookingSummary(ctx, B.fairway.id), 'Fairway summary');
    expect.soft(summary).toMatchObject({ balancePence: 4390, canSettle: false, canCancel: false });
    expect.soft(summary.booking.status).toBe('open');
    await expect
      .soft(settleBooking(ctx, direct(sally, 'bookings'), B.fairway.id))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    const attachable = await listAttachableBookings(ctx);
    expect.soft(attachable.map((b) => [b.booking.id, b.balancePence])).toEqual([[B.fairway.id, 4390]]);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('19. goods in and a stock adjustment', async () => {
    at('14:00');
    const delivery = await recordGoodsIn(ctx, direct(maggie, 'stockControl'), { productId: P.wine.id, qty: 6, note: 'Delivery' });
    expect.soft(delivery).toMatchObject({ productId: P.wine.id, qty: 6, reason: 'goodsIn', staffId: maggie.staffId, note: 'Delivery' });
    // Wine: 12 − 1 (S2) − 1 (tab B) − 5 (Patel bill) + 6 = 11
    expect.soft(await onHand(P.wine)).toBe(11);

    at('14:10');
    const adj = await recordStockAdjustment(ctx, direct(maggie, 'stockControl'), {
      productId: P.nuts.id,
      kind: 'adjustment',
      qty: -2,
      note: 'Count correction',
    });
    expect.soft(adj).toMatchObject({ productId: P.nuts.id, qty: -2, reason: 'adjustment', staffId: maggie.staffId, note: 'Count correction' });
    // Nuts: 24 − 1 (S2) − 1 (tab B) − 2 = 20
    expect.soft(await onHand(P.nuts)).toBe(20);

    const adjusts = ofType(await repos.auditEvents.list(), 'stockAdjust');
    expect.soft(adjusts).toHaveLength(1);
    expect.soft(adjusts[0]).toMatchObject({ staffId: maggie.staffId, periodId: period.id });
    expect.soft(adjusts[0]?.detail).toEqual({
      stockMovementId: adj.id,
      productId: P.nuts.id,
      productName: 'Honey Nuts',
      qty: -2,
      reason: 'adjustment',
      note: 'Count correction',
    });
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('20. manager partial refund of tab "Table 7" by card, returned to stock (stock restored)', async () => {
    at('15:00');
    expect(authoriseDirect(sally, 'refund')).toBeNull(); // manager only

    // Deposits cannot be refunded (D-035).
    const deposit = await findSaleForRefund(ctx, '3F9C-000003');
    expect.soft(deposit.status).toBe('notRefundable');

    const lookup = await findSaleForRefund(ctx, '3f9c-6'); // normalised to 3F9C-000006 (D-035)
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect.soft(lookup.sale.id).toBe(saleTabB.id);
    expect.soft(lookup.lines.map((l) => [l.lineIndex, l.soldQty, l.refundedQty, l.refundableQty, l.stockTracked])).toEqual([
      [0, 2, 0, 2, true],
      [1, 1, 0, 1, true],
      [2, 1, 0, 1, true],
      [3, 1, 0, 1, true],
    ]);

    // Stock before: Crisps 24 − 1 − 2 − 2 − 3 = 16; Wine 11 (step 19).
    expect.soft(await onHand(P.crisps)).toBe(16);
    expect.soft(await onHand(P.wine)).toBe(11);

    // Refund maths (D-037), cumulative share with r = 0, q = 1:
    //   Crisps line 0 (Q 2, deal 84, member 28, VAT 26): deal 84·1/2 = 42, member 14, VAT 13
    //     gross 135, final 135 − 42 − 14 = 79 → stored −1, −42, −14, −79, VAT −13
    //   Wine line 2 (Q 1, deal 0, member 322, VAT 305): whole line
    //     final 2150 − 322 = 1828 → stored −1, 0, −322, −1828, VAT −305
    //   total −79 − 1828 = −1907; member −14 − 322 = −336; one card tender −1907
    const done = await commitRefund(ctx, direct(maggie, 'refund'), {
      originalSaleId: saleTabB.id,
      lines: [
        { lineIndex: 0, qty: 1, returnToStock: true },
        { lineIndex: 2, qty: 1, returnToStock: true },
      ],
      tenderType: 'card',
    });
    ref1 = done.sale;
    expect.soft(ref1).toMatchObject({
      receiptNumber: '3F9C-000009',
      kind: 'refund',
      refundOfSaleId: saleTabB.id,
      memberId: M.gary.id,
      staffId: maggie.staffId,
      periodId: period.id,
      dealLines: [],
      memberDiscountPence: -336,
      depositAppliedPence: 0,
      totalPence: -1907,
      tenders: [{ type: 'card', amountPence: -1907 }],
      changePence: 0,
    });
    expect.soft('bookingId' in ref1 || 'tabId' in ref1).toBe(false);
    const byIndex = (i: number): SaleLine | undefined => ref1.lines.find((l) => l.refundOfLineIndex === i);
    expect.soft(ref1.lines).toHaveLength(2);
    expect.soft(byIndex(0)).toEqual(refundLine(P.crisps, -1, -42, -14, -79, -13, 0, true));
    expect.soft(byIndex(2)).toEqual(refundLine(P.wine, -1, 0, -322, -1828, -305, 2, true));

    // Stock restored: Crisps 16 + 1 = 17; Wine 11 + 1 = 12.
    expect.soft(await onHand(P.crisps)).toBe(17);
    expect.soft(await onHand(P.wine)).toBe(12);
    const moves = await repos.stockMovements.listBySale(ref1.id);
    expect.soft(moves.map((m) => [m.productId, m.qty, m.reason, m.note]).sort()).toEqual(
      [
        [P.crisps.id, 1, 'refund', ''],
        [P.wine.id, 1, 'refund', ''],
      ].sort(),
    );

    const refundEvents = ofType(await repos.auditEvents.listByPeriod(period.id), 'refund');
    expect.soft(refundEvents).toHaveLength(1);
    expect.soft(refundEvents[0]).toMatchObject({ staffId: maggie.staffId, periodId: period.id });
    expect.soft(refundEvents[0]?.detail).toMatchObject({
      refundSaleId: ref1.id,
      refundReceiptNumber: '3F9C-000009',
      originalSaleId: saleTabB.id,
      originalReceiptNumber: '3F9C-000006',
      totalPence: -1907,
      tender: 'card',
    });
    expect.soft(
      [...(refundEvents[0]?.detail.lines ?? [])].sort((a, b) => a.productId.localeCompare(b.productId)),
    ).toEqual(
      [
        { productId: P.crisps.id, qty: 1, returnToStock: true },
        { productId: P.wine.id, qty: 1, returnToStock: true },
      ].sort((a, b) => a.productId.localeCompare(b.productId)),
    );

    // Refundable quantities now: Crisps 2 − 1 = 1; Wine 1 − 1 = 0 (D-036).
    const again = await findSaleForRefund(ctx, '3F9C-000006');
    if (again.status === 'found') {
      expect.soft(again.lines.map((l) => [l.lineIndex, l.refundedQty, l.refundableQty])).toEqual([
        [0, 1, 1],
        [1, 0, 1],
        [2, 1, 0],
        [3, 0, 1],
      ]);
    } else {
      expect.soft(again.status).toBe('found');
    }
    expect.soft(done.document).toContain('Receipt 3F9C-000009');
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('21. manager partial refund of S1 in cash as waste (stock net unchanged)', async () => {
    at('15:10');
    // Bitter before: 40 − 2 (S1) − 3 (tab A) − 4 (Patel bill) = 31
    expect.soft(await onHand(P.bitter)).toBe(31);

    // S1 Bitter line 0: Q 2, deal 33, member 0, VAT 138. Refund 1 (r 0, c 1):
    //   deal 33·1/2 = 16.5 → 17 (half up); member 0; VAT 138·1/2 = 69
    //   gross 430, final 430 − 17 = 413 → stored −1, −17, 0, −413, VAT −69; total −413 cash
    ref2 = (
      await commitRefund(ctx, direct(maggie, 'refund'), {
        originalSaleId: s1.id,
        lines: [{ lineIndex: 0, qty: 1, returnToStock: false }],
        tenderType: 'cash',
      })
    ).sale;
    expect.soft(ref2).toMatchObject({
      receiptNumber: '3F9C-000010',
      kind: 'refund',
      refundOfSaleId: s1.id,
      memberDiscountPence: 0,
      depositAppliedPence: 0,
      totalPence: -413,
      tenders: [{ type: 'cash', amountPence: -413 }],
      changePence: 0,
    });
    expect.soft(ref2.memberDiscountPence).toBe(0); // never −0 (D-003)
    expect.soft('memberId' in ref2).toBe(false); // S1 had no member
    expect.soft(ref2.lines).toEqual([refundLine(P.bitter, -1, -17, 0, -413, -69, 0, false)]);

    // Waste: +1 refund and −1 waste, net 0 (D-039).
    const moves = await repos.stockMovements.listBySale(ref2.id);
    expect.soft(moves.map((m) => [m.productId, m.qty, m.reason, m.note]).sort()).toEqual(
      [
        [P.bitter.id, 1, 'refund', ''],
        [P.bitter.id, -1, 'waste', 'Refund - wasted'],
      ].sort(),
    );
    expect.soft(await onHand(P.bitter)).toBe(31);

    const refundEvent = ofType(await repos.auditEvents.listByPeriod(period.id), 'refund').find(
      (e) => e.detail.refundSaleId === ref2.id,
    );
    expect.soft(refundEvent?.detail).toEqual({
      refundSaleId: ref2.id,
      refundReceiptNumber: '3F9C-000010',
      originalSaleId: s1.id,
      originalReceiptNumber: '3F9C-000001',
      totalPence: -413,
      tender: 'cash',
      lines: [{ productId: P.bitter.id, qty: 1, returnToStock: false }],
    });
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  /*
   * Period figures (D-041), by hand. Sales in the period:
   *
   *   sale      kind     gross  deal  member  total  cash-in  card-in  change  depApplied
   *   000001    sale      1350    70       0   1280     2000        0     720           0
   *   000002    sale      2650     0     368   2282     1000     1500     218           0
   *   000003    deposit      -     -       -  10000        0    10000       0           -
   *   000004    deposit      -     -       -   6000     7000        0    1000           -
   *   000005    sale      2540   140       0   2400        0     2400       0           0
   *   000006    sale      3075   135     441   2499     2000      499       0           0
   *   000007    sale     12470    20       0   2450      500     2000      50       10000
   *   000008    sale      1875   265       0      0        0        0       0        1610
   *   000009    refund  (finals −79 −1828 = −1907)   −1907  card −1907
   *   000010    refund  (final −413)                  −413  cash −413
   *
   *   grossSales      1350 + 2650 + 2540 + 3075 + 12470 + 1875 = 23960
   *   dealDiscounts   70 + 0 + 140 + 135 + 20 + 265 = 630
   *   memberDiscounts 368 + 441 = 809
   *   refunds         1907 + 413 = 2320
   *   netTakings      23960 − 630 − 809 − 2320 = 20201
   *                   (Σ sale finals 1280 + 2282 + 2400 + 2499 + 12450 + 1610 = 22521; − 2320 = 20201)
   *   depositsTaken   10000 + 6000 = 16000
   *   depositsApplied 10000 + 1610 = 11610
   *   cashTendered    2000 + 1000 + 7000 + 2000 + 500 = 12500
   *   changeGiven     720 + 218 + 1000 + 50 = 1988
   *   cashRefunded    413
   *   cashTotal       12500 − 1988 − 413 = 10099
   *   cardTendered    1500 + 10000 + 2400 + 499 + 2000 = 16399
   *   cardRefunded    1907
   *   cardTotal       16399 − 1907 = 14492
   *   float           15000
   *   expectedCash    15000 + 12500 − 1988 − 413 = 25099
   *   noSaleCount 1; voidCount 2 (Sam's overridden void + Maggie's direct void; overrides not counted)
   *
   *   VAT 20% gross: 827 + 453 + 1827 + 115 + 140 + 1280 + 850 + 270 + 158 + 97 + 1828 + 416
   *                  + 10750 + 1700 + 1340 + 270 = 22321; refunds −79 − 1828 − 413 → 20001
   *   VAT 20% vat:   138 + 76 + 305 + 19 + 23 + 213 + 142 + 45 + 26 + 16 + 305 + 69 + 1792 + 283
   *                  + 223 + 45 = 3720; refunds −13 − 305 − 69 = −387 → 3333; net 20001 − 3333 = 16668
   *   VAT 0%:        raffle 200, VAT 0, net 200
   *
   *   D-042 checks: 10099 + 14492 = 24591 = 20201 − 11610 + 16000; 25099 = 15000 + 10099;
   *                 20001 + 200 = 20201; 23960 − 630 − 809 = 22521 = Σ sale finals.
   */
  const expectedFigures = {
    grossSalesPence: 23960,
    dealDiscountsPence: 630,
    memberDiscountsPence: 809,
    refundsPence: 2320,
    netTakingsPence: 20201,
    depositsTakenPence: 16000,
    depositsAppliedPence: 11610,
    cashTenderedPence: 12500,
    changeGivenPence: 1988,
    cashRefundedPence: 413,
    cashTotalPence: 10099,
    cardTenderedPence: 16399,
    cardRefundedPence: 1907,
    cardTotalPence: 14492,
    vatByRate: [
      { vatRate: 20, grossPence: 20001, vatPence: 3333, netPence: 16668 },
      { vatRate: 0, grossPence: 200, vatPence: 0, netPence: 200 },
    ],
    floatPence: 15000,
    expectedCashPence: 25099,
    noSaleCount: 1,
    voidCount: 2,
  };

  it('22. X read by the supervisor shows the period so far and writes nothing', async () => {
    at('16:00');
    // Sanity check of the hand arithmetic itself (D-042 identities on the expected numbers).
    const f = expectedFigures;
    expect(f.grossSalesPence - f.dealDiscountsPence - f.memberDiscountsPence - f.refundsPence).toBe(f.netTakingsPence);
    expect(f.cashTotalPence + f.cardTotalPence).toBe(f.netTakingsPence - f.depositsAppliedPence + f.depositsTakenPence);
    expect(f.floatPence + f.cashTotalPence).toBe(f.expectedCashPence);
    expect(f.vatByRate.reduce((s, r) => s + r.grossPence, 0)).toBe(f.netTakingsPence);
    for (const r of f.vatByRate) expect(r.netPence + r.vatPence).toBe(r.grossPence);

    expect(authoriseDirect(sam, 'xRead')).toBeNull(); // supervisor+
    const eventsBefore = (await repos.auditEvents.list()).length;
    const counterBefore = (await repos.settings.get())?.receiptCounter;

    const x = await runXRead(ctx, direct(sally, 'xRead'));
    expect.soft(x.period.id).toBe(period.id);
    expect.soft(x.figures).toEqual(expectedFigures);
    expect.soft(x.document).toContain('X read');

    expect.soft((await repos.auditEvents.list()).length).toBe(eventsBefore);
    expect.soft((await repos.settings.get())?.receiptCounter).toBe(counterBefore);
    expect.soft(counterBefore).toBe(10);
    expect.soft((await getOpenPeriod(ctx))?.id).toBe(period.id);
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('23. Z close with a declared-cash variance (short 49p)', async () => {
    at('22:00');
    // A non-empty basket blocks the Z close (D-047).
    await expect
      .soft(prepareZClose(ctx, { lines: [{ productId: P.bitter.id, qty: 1 }] }))
      .rejects.toMatchObject({ code: 'BASKET_NOT_EMPTY' });
    const pre = await prepareZClose(ctx, EMPTY_BASKET);
    expect.soft(pre.period.id).toBe(period.id);
    expect.soft(pre.openTabCount).toBe(0);

    // Declared 25050; expected 25099; variance 25050 − 25099 = −49 (short).
    expect.soft(await previewZClose(ctx, 25050)).toEqual({ expectedCashPence: 25099, declaredCashPence: 25050, variancePence: -49 });

    const z = await confirmZClose(ctx, direct(maggie, 'openClosePeriod'), EMPTY_BASKET, 25050);
    expect.soft(z.figures).toEqual({ ...expectedFigures, declaredCashPence: 25050, variancePence: -49 });
    expect.soft(z.period).toMatchObject({
      id: period.id,
      closedAt: '2026-09-26T22:00:00.000Z',
      closedBy: maggie.staffId,
      declaredCashPence: 25050,
      zNumber: 1,
      floatPence: 15000,
    });
    expect.soft(z.document).toContain('Z report 1');

    const zEvents = ofType(await repos.auditEvents.listByPeriod(period.id), 'zClose');
    expect.soft(zEvents).toHaveLength(1);
    expect.soft(zEvents[0]).toMatchObject({ staffId: maggie.staffId, periodId: period.id });
    expect.soft(zEvents[0]?.detail).toEqual({
      zNumber: 1,
      floatPence: 15000,
      expectedCashPence: 25099,
      declaredCashPence: 25050,
      variancePence: -49,
    });

    expect.soft(await getOpenPeriod(ctx)).toBeUndefined();
    await expect
      .soft(openSalePayment(ctx, { lines: [{ productId: P.bitter.id, qty: 1 }] }))
      .rejects.toMatchObject({ code: 'NO_OPEN_PERIOD' });

    // Audit trail of the period: 1 override, 2 voids, 1 no sale, 1 stock adjust, 2 refunds, 1 zClose.
    const events = await repos.auditEvents.listByPeriod(period.id);
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    expect.soft(counts).toEqual({ override: 1, void: 2, noSale: 1, stockAdjust: 1, refund: 2, zClose: 1 });

    // Every sale of the shift belongs to this period (D-040).
    const periodSales = await repos.sales.listByPeriod(period.id);
    expect.soft(periodSales.map((s) => s.receiptNumber).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `3F9C-${String(i + 1).padStart(6, '0')}`),
    );
    // D-042 identity 6 on every stored sale: Σ tenders − change = total.
    for (const s of periodSales) {
      expect.soft(s.tenders.reduce((sum, t) => sum + t.amountPence, 0) - s.changePence).toBe(s.totalPence);
    }
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('24. product sales and VAT reports for the day match the Z figures', async () => {
    at('22:05'); // 23:05 London, still 26/09/2026
    expect.soft(todayLocal(ctx)).toBe('2026-09-26');

    /*
     * Product rows (qty and takings net of refunds; finals before deposits, D-044):
     *   Bitter  qty 2 + 3 + 4 − 1 = 8;   takings 827 + 1280 + 1700 − 413 = 3394
     *   Lager   qty 1 + 2 + 1 + 3 = 7;   takings 453 + 850 + 416 + 1340 = 3059
     *   Crisps  qty 1 + 2 + 2 + 3 − 1 = 7; takings 115 + 270 + 158 + 270 − 79 = 734
     *   Nuts    qty 1 + 1 = 2;           takings 140 + 97 = 237
     *   Wine    qty 1 + 1 + 5 − 1 = 6;   takings 1827 + 1828 + 10750 − 1828 = 12577
     *   Raffle  qty 1;                   takings 200
     * Categories: Beer 15 / 6453; Snacks 9 / 971; Wine 6 / 12577; Events 1 / 200
     * Totals: qty 31; takings 6453 + 971 + 12577 + 200 = 20201 = net takings = VAT total gross.
     */
    const report = await runProductSalesReport(ctx, direct(maggie, 'salesReports'), '2026-09-26', '2026-09-26');
    expect.soft(report.totalQty).toBe(31);
    expect.soft(report.totalTakingsPence).toBe(20201);
    expect.soft(
      report.categories.map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        qty: c.qty,
        takingsPence: c.takingsPence,
        products: c.products.map((p) => [p.productId, p.name, p.qty, p.takingsPence]),
      })),
    ).toEqual([
      {
        categoryId: cat.beer.id,
        name: 'Beer',
        qty: 15,
        takingsPence: 6453,
        products: [
          [P.bitter.id, 'Heathland Bitter', 8, 3394],
          [P.lager.id, 'Greenside Lager', 7, 3059],
        ],
      },
      {
        categoryId: cat.snacks.id,
        name: 'Snacks',
        qty: 9,
        takingsPence: 971,
        products: [
          [P.crisps.id, 'Sea Salt Crisps', 7, 734],
          [P.nuts.id, 'Honey Nuts', 2, 237],
        ],
      },
      {
        categoryId: cat.wine.id,
        name: 'Wine',
        qty: 6,
        takingsPence: 12577,
        products: [[P.wine.id, 'Clubhouse Red (bottle)', 6, 12577]],
      },
      {
        categoryId: cat.events.id,
        name: 'Events',
        qty: 1,
        takingsPence: 200,
        products: [[P.raffle.id, 'Charity Raffle', 1, 200]],
      },
    ]);

    // VAT report: same rows as the Z; totals gross 20201, VAT 3333, net 16668 + 200 = 16868.
    const vat = await runVatReport(ctx, direct(maggie, 'salesReports'), '2026-09-26', '2026-09-26');
    expect.soft(vat.rows).toEqual(expectedFigures.vatByRate);
    expect.soft(vat.totals).toEqual({ grossPence: 20201, vatPence: 3333, netPence: 16868 });

    // The previous day has no sales.
    const yesterday = await runVatReport(ctx, direct(maggie, 'salesReports'), '2026-09-25', '2026-09-25');
    expect.soft(yesterday.rows).toEqual([]);
    expect.soft(yesterday.totals).toEqual({ grossPence: 0, vatPence: 0, netPence: 0 });
  }, 30_000);

  // ---------------------------------------------------------------------------------------------
  it('25. closing stock levels and the low-stock list', async () => {
    /*
     * On hand (Σ movements):
     *   Bitter 40 − 2 − 3 − 4 + 1 − 1 = 31
     *   Lager  40 − 1 − 2 − 1 − 3 = 33
     *   Crisps 24 − 1 − 2 − 2 − 3 + 1 = 17
     *   Nuts   24 − 1 − 1 − 2 = 20
     *   Wine   12 − 1 − 1 − 5 + 6 + 1 = 12
     * Low stock (onHand ≤ lowStockLevel): only Nuts (20 ≤ 20). Bitter 31 > 10, Lager 33 > 10,
     * Crisps 17 > 6, Wine 12 > 4. Raffle is untracked and never listed.
     */
    const levels = await listStockLevels(ctx);
    expect.soft(levels.map((l) => [l.product.id, l.onHand])).toEqual([
      [P.bitter.id, 31],
      [P.lager.id, 33],
      [P.crisps.id, 17],
      [P.nuts.id, 20],
      [P.wine.id, 12],
    ]);
    const low = await listLowStock(ctx);
    expect.soft(low.map((l) => [l.product.id, l.onHand])).toEqual([[P.nuts.id, 20]]);
  }, 30_000);
});
