/**
 * Builds receipt models from stored sales and renders them (spec §6.10; D-107, D-108).
 * X/Z documents are built in services/periods.ts.
 */
import type { Booking, LocalDate, Sale } from '../data/types';
import { renderReceipt, type ReceiptHeader, type ReceiptModel } from '../receipt';
import { londonDateOf } from '../rules/time';
import { tabDisplayLabel } from '../rules/validation';
import { vatSummary } from '../rules/vat';
import type { ServiceContext } from './context';
import { getSettings } from './settings';
import { describeError, fallbackDocument } from './shared';

/** Shown when a referenced record is missing (possible only after an unusual backup import). */
const UNKNOWN = 'Unknown';

async function staffName(ctx: ServiceContext, staffId: string): Promise<string> {
  return (await ctx.repos.staff.get(staffId))?.name ?? UNKNOWN;
}

/** The member number for a sale's memberId; a missing record still prints a member line (D-107). */
async function memberNumber(ctx: ServiceContext, memberId: string | undefined): Promise<string | undefined> {
  if (memberId === undefined) return undefined;
  return (await ctx.repos.members.get(memberId))?.memberNumber ?? UNKNOWN;
}

/**
 * The booking's unused balance immediately after `sale` (D-108 'Deposit balance now'): D-025 over
 * the booking's sales up to and including this one, so a reprint shows the historical figure.
 */
async function balanceAfter(ctx: ServiceContext, sale: Sale, bookingId: string): Promise<number> {
  const sales = await ctx.repos.sales.listByBooking(bookingId);
  let balance = 0;
  for (const s of sales) {
    if (s.kind === 'deposit') balance += s.totalPence;
    else if (s.kind === 'sale') balance -= s.depositAppliedPence;
    if (s.id === sale.id) break;
  }
  return balance;
}

function bookingDetails(booking: Booking | undefined, fallbackDate: LocalDate): { name: string; type: Booking['type']; date: LocalDate } {
  return booking === undefined ? { name: UNKNOWN, type: 'other', date: fallbackDate } : { name: booking.name, type: booking.type, date: booking.date };
}

/**
 * Resolves names for a stored sale of any kind: club name and footer (Settings), staff name,
 * member number, tab display label, booking name/type/date (deposit and final bill), the booking
 * balance after a deposit, the original receipt number for a refund, and vatSummary(lines).
 */
export async function buildReceiptModel(ctx: ServiceContext, sale: Sale): Promise<ReceiptModel> {
  const settings = await getSettings(ctx);
  const header: ReceiptHeader = {
    clubName: settings.clubName,
    footer: settings.receiptFooter,
    createdAt: sale.createdAt,
    receiptNumber: sale.receiptNumber,
    staffName: await staffName(ctx, sale.staffId),
  };

  switch (sale.kind) {
    case 'deposit': {
      const bookingId = sale.bookingId ?? '';
      const booking = await ctx.repos.bookings.get(bookingId);
      return {
        ...header,
        kind: 'deposit',
        booking: bookingDetails(booking, londonDateOf(sale.createdAt)),
        amountPence: sale.totalPence,
        tenders: sale.tenders,
        changePence: sale.changePence,
        balanceAfterPence: await balanceAfter(ctx, sale, bookingId),
      };
    }
    case 'refund': {
      const original = sale.refundOfSaleId === undefined ? undefined : await ctx.repos.sales.get(sale.refundOfSaleId);
      const number = await memberNumber(ctx, sale.memberId);
      return {
        ...header,
        kind: 'refund',
        originalReceiptNumber: original?.receiptNumber ?? UNKNOWN,
        lines: sale.lines,
        ...(number === undefined ? {} : { memberNumber: number }),
        memberDiscountPence: sale.memberDiscountPence,
        totalPence: sale.totalPence,
        tenders: sale.tenders,
        vatSummary: vatSummary(sale.lines),
      };
    }
    case 'sale': {
      const number = await memberNumber(ctx, sale.memberId);
      const tab = sale.tabId === undefined ? undefined : await ctx.repos.tabs.get(sale.tabId);
      const booking = sale.bookingId === undefined ? undefined : await ctx.repos.bookings.get(sale.bookingId);
      return {
        ...header,
        kind: 'sale',
        lines: sale.lines,
        dealLines: sale.dealLines,
        ...(number === undefined ? {} : { memberNumber: number }),
        memberDiscountPence: sale.memberDiscountPence,
        depositAppliedPence: sale.depositAppliedPence,
        ...(sale.tabId === undefined ? {} : { tabLabel: tab === undefined ? UNKNOWN : tabDisplayLabel(tab) }),
        ...(sale.bookingId === undefined ? {} : { bookingName: booking?.name ?? UNKNOWN }),
        totalPence: sale.totalPence,
        tenders: sale.tenders,
        changePence: sale.changePence,
        vatSummary: vatSummary(sale.lines),
      };
    }
  }
}

/** buildReceiptModel + renderReceipt. */
export async function renderSaleDocument(ctx: ServiceContext, sale: Sale): Promise<string> {
  return renderReceipt(await buildReceiptModel(ctx, sale));
}

/**
 * The receipt for a sale that has ALREADY been committed. Never throws: if building or rendering
 * fails, a minimal document says the sale was saved (see shared.fallbackDocument), because a
 * throw here would make the UI offer "Try again" and record the sale twice (D-034).
 */
export async function receiptAfterCommit(ctx: ServiceContext, sale: Sale): Promise<string> {
  try {
    return await renderSaleDocument(ctx, sale);
  } catch (error) {
    return fallbackDocument(
      `Receipt ${sale.receiptNumber}`,
      `Receipt ${sale.receiptNumber} was saved, but the receipt could not be printed.`,
      describeError(error),
    );
  }
}
