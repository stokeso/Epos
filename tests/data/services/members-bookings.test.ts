/**
 * Members (spec §6.5; D-019, D-104, D-105) and bookings, deposits and the final bill with a
 * deposit applied (spec §6.7, §7.4; D-023..D-028, D-031).
 */
import { describe, expect, it } from 'vitest';
import {
  cancelBooking,
  getBookingSummary,
  listAttachableBookings,
  listBookings,
  saveBooking,
  settleBooking,
} from '../../../src/services/bookings';
import { saveDraft } from '../../../src/services/draft';
import { listMembers, memberLabel, saveMember, searchMembers, setMemberActive } from '../../../src/services/members';
import { approveOverride } from '../../../src/services/override';
import { completePayment, openDepositPayment, openSalePayment } from '../../../src/services/pay';
import { buildReceiptModel, renderSaleDocument } from '../../../src/services/receipts';
import { viewBasket } from '../../../src/services/till';
import type { BookingInput } from '../../../src/rules/validation';
import { auth, basket, card, cash, expectAppError, PINS, registerCleanup, sell, setupTill, takeDeposit, tenderAll, type Till } from './harness';

registerCleanup();

const membersAuth = (t: Till) => auth(t.manager, 'manageMembersStaffSettings');

describe('members (D-104, D-105)', () => {
  async function withMembers(): Promise<Till> {
    const t = await setupTill();
    const add = (memberNumber: string, firstName: string, lastName: string, active = true) =>
      saveMember(t.h.ctx, membersAuth(t), null, { memberNumber, firstName, lastName, active });
    await add('1001', 'Ben', 'Birch');
    await add('1002', 'Clara', 'Chalmers');
    await add('1003', 'Dan', 'Archer', false);
    await add('1004', 'Amy', 'Archer');
    return t;
  }

  it('searches active members by number, first name, last name or full name, sorted by surname', async () => {
    const t = await withMembers();
    const labels = async (q: string) => (await searchMembers(t.h.ctx, q)).map(memberLabel);
    expect(await labels('arch')).toEqual(['1042 — Alice Archer', '1004 — Amy Archer']);
    expect(await labels('ARCH')).toEqual(['1042 — Alice Archer', '1004 — Amy Archer']);
    expect(await labels('100')).toEqual(['1004 — Amy Archer', '1001 — Ben Birch', '1002 — Clara Chalmers']);
    expect(await labels('alice arch')).toEqual(['1042 — Alice Archer']);
    expect(await labels('  ')).toEqual([]);
    expect(await labels('zzz')).toEqual([]);
  });

  it('caps search results at 20', async () => {
    const t = await setupTill();
    for (let i = 0; i < 25; i += 1) {
      await saveMember(t.h.ctx, membersAuth(t), null, { memberNumber: `S${i}`, firstName: `F${String(i).padStart(2, '0')}`, lastName: 'Smith', active: true });
    }
    const found = await searchMembers(t.h.ctx, 'smith');
    expect(found).toHaveLength(20);
    expect(found[0]?.firstName).toBe('F00');
  });

  it('lists every non-deleted member, inactive included, for the back office', async () => {
    const t = await withMembers();
    expect((await listMembers(t.h.ctx)).map((m) => `${m.lastName}, ${m.firstName}`)).toEqual([
      'Archer, Alice',
      'Archer, Amy',
      'Archer, Dan',
      'Birch, Ben',
      'Chalmers, Clara',
    ]);
  });

  it('normalises and validates member numbers and names, including uniqueness', async () => {
    const t = await setupTill();
    const saved = await saveMember(t.h.ctx, membersAuth(t), null, { memberNumber: ' ab-12 ', firstName: ' Jo ', lastName: 'Bloggs  Smith', active: true });
    expect(saved).toMatchObject({ memberNumber: 'AB-12', firstName: 'Jo', lastName: 'Bloggs Smith' });
    await expectAppError(saveMember(t.h.ctx, membersAuth(t), null, { memberNumber: 'AB-12', firstName: 'A', lastName: 'B', active: true }), 'VALIDATION', 'Another member already has that number');
    await expectAppError(saveMember(t.h.ctx, membersAuth(t), null, { memberNumber: 'X 1', firstName: 'A', lastName: 'B', active: true }), 'VALIDATION');
    const edited = await saveMember(t.h.ctx, membersAuth(t), saved.id, { ...saved, firstName: 'Joanne' });
    expect(edited).toMatchObject({ id: saved.id, memberNumber: 'AB-12', firstName: 'Joanne' });
    await expectAppError(saveMember(t.h.ctx, membersAuth(t), 'missing', { ...saved }), 'NOT_FOUND');
    await expectAppError(saveMember(t.h.ctx, auth(t.manager, 'editCatalogue'), null, { ...saved, memberNumber: 'Q1' }), 'PERMISSION_DENIED');
  });

  it('writes the override event when a supervisor is approved by a manager', async () => {
    const t = await setupTill({ floatPence: null });
    const approval = await approveOverride(t.h.ctx, t.supervisor, 'manageMembersStaffSettings', PINS.manager);
    if (approval === null) throw new Error('expected approval');
    await saveMember(t.h.ctx, approval, null, { memberNumber: '3000', firstName: 'New', lastName: 'Member', active: true });
    const [event] = await t.h.repos.auditEvents.list();
    expect(event).toMatchObject({ type: 'override', staffId: t.supervisor.staffId, approvedById: t.manager.staffId, detail: { action: 'manageMembersStaffSettings' } });
    expect(event).not.toHaveProperty('periodId');
  });

  it('hides deactivated members from search, but a member already attached keeps the discount (D-019)', async () => {
    const t = await setupTill();
    const b = basket([[t.c.bitter, 2]], { memberId: t.c.member.id });
    await setMemberActive(t.h.ctx, membersAuth(t), t.c.member.id, false);
    expect(await searchMembers(t.h.ctx, '1042')).toEqual([]);
    expect((await viewBasket(t.h.ctx, b)).priced.memberDiscountPence).toBe(126);
    const { sale } = await sell(t.h.ctx, t.staff, b, [card(null)]);
    expect(sale).toMatchObject({ memberId: t.c.member.id, memberDiscountPence: 126, totalPence: 714 });
    const reactivated = await setMemberActive(t.h.ctx, membersAuth(t), t.c.member.id, true);
    expect(reactivated.active).toBe(true);
  });
});

const smithWedding: BookingInput = { type: 'wedding', name: ' Smith   wedding ', date: '2026-10-26', notes: ' Evening reception ' };

describe('bookings (D-025, D-026, D-028)', () => {
  it('creates and edits open bookings without an open period', async () => {
    const t = await setupTill({ floatPence: null });
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, smithWedding);
    expect(booking).toMatchObject({ type: 'wedding', name: 'Smith wedding', date: '2026-10-26', notes: 'Evening reception', status: 'open' });
    const edited = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), booking.id, { ...smithWedding, date: '2026-10-27', notes: '' });
    expect(edited).toMatchObject({ id: booking.id, date: '2026-10-27', notes: '', status: 'open' });
    await expectAppError(saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, { ...smithWedding, date: '2026-02-30' }), 'VALIDATION', 'Enter a valid date');
    await expectAppError(saveBooking(t.h.ctx, auth(t.staff, 'bookings'), 'missing', smithWedding), 'NOT_FOUND');
  });

  it('lists bookings by date then name with balances and the allowed actions', async () => {
    const t = await setupTill();
    const staff = auth(t.staff, 'bookings');
    const late = await saveBooking(t.h.ctx, staff, null, { type: 'society', name: 'Seniors', date: '2026-11-01', notes: '' });
    const early = await saveBooking(t.h.ctx, staff, null, { type: 'other', name: 'Quiz', date: '2026-10-01', notes: '' });
    const alsoEarly = await saveBooking(t.h.ctx, staff, null, { type: 'eventTicket', name: 'Awards', date: '2026-10-01', notes: '' });
    await takeDeposit(t.h.ctx, t.staff, late.id, 2500, [cash(2500)]);

    const list = await listBookings(t.h.ctx);
    expect(list.map((s) => [s.booking.name, s.balancePence, s.canTakeDeposit, s.canSettle, s.canCancel])).toEqual([
      ['Awards', 0, true, true, true],
      ['Quiz', 0, true, true, true],
      ['Seniors', 2500, true, false, false],
    ]);
    expect((await listAttachableBookings(t.h.ctx)).map((s) => s.booking.id)).toEqual([late.id]);
    expect((await getBookingSummary(t.h.ctx, early.id))?.balancePence).toBe(0);
    expect(await getBookingSummary(t.h.ctx, 'missing')).toBeUndefined();
    expect(alsoEarly.status).toBe('open');
  });

  it('settles or cancels only at a zero balance, and closed bookings are read-only (D-026)', async () => {
    const t = await setupTill();
    const staff = auth(t.staff, 'bookings');
    const never = await saveBooking(t.h.ctx, staff, null, { ...smithWedding, name: 'Never paid' });
    expect((await cancelBooking(t.h.ctx, staff, never.id)).status).toBe('cancelled');
    await expectAppError(settleBooking(t.h.ctx, staff, never.id), 'BOOKING_NOT_OPEN');
    await expectAppError(saveBooking(t.h.ctx, staff, never.id, smithWedding), 'BOOKING_NOT_OPEN', 'Only open bookings can be edited');
    await expectAppError(openDepositPayment(t.h.ctx, never.id, 1000), 'BOOKING_NOT_OPEN');

    const paid = await saveBooking(t.h.ctx, staff, null, smithWedding);
    await takeDeposit(t.h.ctx, t.staff, paid.id, 1000, [cash(1000)]);
    await expectAppError(settleBooking(t.h.ctx, staff, paid.id), 'VALIDATION', 'The deposit balance must be used before the booking can be settled');
    await expectAppError(cancelBooking(t.h.ctx, staff, paid.id), 'VALIDATION');
    expect((await t.h.repos.bookings.get(paid.id))?.status).toBe('open');
  });
});

describe('deposits and the final bill (D-023, D-024, D-027, D-031)', () => {
  it('takes a deposit as its own sale with no lines, no member and no stock, leaving the basket draft alone', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, smithWedding);
    const tillBasket = basket([[t.c.lager, 1]], { memberId: t.c.member.id });
    await saveDraft(t.h.ctx, tillBasket);
    const draft = await t.h.repos.draft.get();

    const { sale, document } = await takeDeposit(t.h.ctx, t.staff, booking.id, 5000, [cash(2000), cash(5000)]);
    expect(sale).toMatchObject({
      kind: 'deposit',
      bookingId: booking.id,
      lines: [],
      dealLines: [],
      memberDiscountPence: 0,
      depositAppliedPence: 0,
      totalPence: 5000,
      tenders: [{ type: 'cash', amountPence: 2000 }, { type: 'cash', amountPence: 5000 }],
      changePence: 2000,
      receiptNumber: '3F9C-000001',
    });
    expect(sale).not.toHaveProperty('memberId');
    expect(await t.h.repos.stockMovements.listBySale(sale.id)).toEqual([]);
    expect(await t.h.repos.draft.get()).toEqual(draft);
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(5000);
    expect(document).toContain('Deposit balance now £50.00');
  });

  it('prints the balance after each deposit, net of bills in between, and a reprint keeps the historical figure (D-108, D-124)', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, smithWedding);
    const first = await takeDeposit(t.h.ctx, t.staff, booking.id, 5000, [cash(5000)]);
    expect(first.document).toContain('Deposit balance now £50.00');

    // A bill paid entirely from the deposit: Wine 2295 applied, total 0 (D-023, D-031).
    t.h.clock.advance(60_000);
    const bill = await sell(t.h.ctx, t.staff, basket([[t.c.wineBottle, 1]], { bookingId: booking.id }), []);
    expect(bill.sale).toMatchObject({ depositAppliedPence: 2295, totalPence: 0, tenders: [] });

    // Second deposit: 5000 − 2295 + 1000 = 3705.
    t.h.clock.advance(60_000);
    const second = await takeDeposit(t.h.ctx, t.staff, booking.id, 1000, [cash(1000)]);
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(3705);
    expect(second.document).toContain('Deposit balance now £37.05');
    expect(await buildReceiptModel(t.h.ctx, second.sale)).toMatchObject({ kind: 'deposit', amountPence: 1000, balanceAfterPence: 3705 });

    // Later activity on the booking never changes an earlier deposit's figure (D-124).
    t.h.clock.advance(60_000);
    await sell(t.h.ctx, t.staff, basket([[t.c.lager, 2]], { bookingId: booking.id }), []);
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(2805);

    const reprintFirst = await renderSaleDocument(t.h.ctx, first.sale);
    expect(reprintFirst).toContain('Deposit balance now £50.00');
    expect(reprintFirst).not.toContain('£37.05');
    expect(await buildReceiptModel(t.h.ctx, first.sale)).toMatchObject({ kind: 'deposit', amountPence: 5000, balanceAfterPence: 5000 });

    const reprintSecond = await renderSaleDocument(t.h.ctx, second.sale);
    expect(reprintSecond).toContain('Deposit balance now £37.05');
    expect(reprintSecond).not.toContain('£28.05');
  });

  it('validates the deposit amount, the booking, the period and the authorisation', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, smithWedding);
    await expectAppError(openDepositPayment(t.h.ctx, booking.id, 0), 'VALIDATION', 'A deposit must be £0.01 to £99,999.99');
    await expectAppError(openDepositPayment(t.h.ctx, booking.id, 10_000_000), 'VALIDATION');
    await expectAppError(openDepositPayment(t.h.ctx, 'missing', 100), 'NOT_FOUND');
    const session = tenderAll(await openDepositPayment(t.h.ctx, booking.id, 100), [card(null)]);
    await expectAppError(completePayment(t.h.ctx, auth(t.staff, 'sell'), session), 'PERMISSION_DENIED');
    const closed = await setupTill({ floatPence: null });
    const b2 = await saveBooking(closed.h.ctx, auth(closed.staff, 'bookings'), null, smithWedding);
    await expectAppError(openDepositPayment(closed.h.ctx, b2.id, 100), 'NO_OPEN_PERIOD');
  });

  it('applies a deposit smaller than the bill; the balance is used and the booking can be settled (D-023 5000)', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, smithWedding);
    await takeDeposit(t.h.ctx, t.staff, booking.id, 5000, [cash(5000)]);
    const b = basket([[t.c.wineBottle, 4]], { bookingId: booking.id });
    const view = await viewBasket(t.h.ctx, b);
    expect(view).toMatchObject({ bookingBalancePence: 5000, priced: { subtotalPence: 9180, depositAppliedPence: 5000, totalPence: 4180 } });

    const { sale, document } = await sell(t.h.ctx, t.staff, b, [card(3000), cash(1500)]);
    expect(sale).toMatchObject({ bookingId: booking.id, depositAppliedPence: 5000, totalPence: 4180, changePence: 320 });
    expect(sale.lines[0]).toMatchObject({ finalPence: 9180, vatPence: 1530 });
    expect(document).toContain('Deposit applied');
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(0);
    expect((await settleBooking(t.h.ctx, auth(t.staff, 'bookings'), booking.id)).status).toBe('settled');
  });

  it('takes a bill equal to the deposit to £0 with no tenders (D-023 9180, D-031)', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, smithWedding);
    await takeDeposit(t.h.ctx, t.staff, booking.id, 9180, [card(null)]);
    const session = await openSalePayment(t.h.ctx, basket([[t.c.wineBottle, 4]], { bookingId: booking.id }));
    expect(session.tender).toMatchObject({ totalPence: 0, complete: true });
    const { sale } = await completePayment(t.h.ctx, auth(t.staff, 'sell'), session);
    expect(sale).toMatchObject({ depositAppliedPence: 9180, totalPence: 0, tenders: [], changePence: 0 });
    expect(await t.h.repos.stockMovements.listBySale(sale.id)).toHaveLength(1);
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(0);
  });

  it('leaves the remainder on the booking when the deposit is larger than the bill (D-023 10000, D-026 example)', async () => {
    const t = await setupTill();
    const staff = auth(t.staff, 'bookings');
    const booking = await saveBooking(t.h.ctx, staff, null, smithWedding);
    await takeDeposit(t.h.ctx, t.staff, booking.id, 10000, [cash(10000)]);
    const { sale } = await sell(t.h.ctx, t.staff, basket([[t.c.wineBottle, 4]], { bookingId: booking.id }), []);
    expect(sale).toMatchObject({ depositAppliedPence: 9180, totalPence: 0, tenders: [] });
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(820);
    await expectAppError(settleBooking(t.h.ctx, staff, booking.id), 'VALIDATION');
    expect((await listAttachableBookings(t.h.ctx)).map((s) => s.balancePence)).toEqual([820]);

    // Apply the 820 to another bill for the same booking; then it can be settled.
    const second = await sell(t.h.ctx, t.staff, basket([[t.c.lager, 2]], { bookingId: booking.id }), [cash(100)]);
    expect(second.sale).toMatchObject({ depositAppliedPence: 820, totalPence: 80, changePence: 20 });
    expect(await t.h.repos.sales.bookingBalance(booking.id)).toBe(0);
    expect((await settleBooking(t.h.ctx, staff, booking.id)).status).toBe('settled');
  });

  it('re-checks the balance and booking status inside the commit (D-028)', async () => {
    const t = await setupTill();
    const staff = auth(t.staff, 'bookings');
    const booking = await saveBooking(t.h.ctx, staff, null, smithWedding);
    await takeDeposit(t.h.ctx, t.staff, booking.id, 5000, [cash(5000)]);
    const first = tenderAll(await openSalePayment(t.h.ctx, basket([[t.c.wineBottle, 4]], { bookingId: booking.id })), [card(null)]);
    const second = tenderAll(await openSalePayment(t.h.ctx, basket([[t.c.wineBottle, 3]], { bookingId: booking.id })), [card(null)]);
    await completePayment(t.h.ctx, auth(t.staff, 'sell'), first);
    const before = await t.h.repos.exportAll();
    await expectAppError(completePayment(t.h.ctx, auth(t.staff, 'sell'), second), 'DEPOSIT_EXCEEDS_BALANCE');
    expect(await t.h.repos.exportAll()).toEqual(before);

    const other = await saveBooking(t.h.ctx, staff, null, { ...smithWedding, name: 'Jones' });
    const deposit = tenderAll(await openDepositPayment(t.h.ctx, other.id, 1000), [cash(1000)]);
    await cancelBooking(t.h.ctx, staff, other.id);
    await expectAppError(completePayment(t.h.ctx, auth(t.staff, 'bookings'), deposit), 'BOOKING_NOT_OPEN');
  });
});
