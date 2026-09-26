/**
 * Refunds (spec §6.8; D-035..D-039).
 */
import { AppError } from '../data/errors';
import type { Sale, SaleLine, TenderType } from '../data/types';
import { negate } from '../rules/money';
import {
  buildRefundSale,
  isRefundable,
  refundableQuantities,
  refundedQuantities,
  type RefundRequestLine,
} from '../rules/refund';
import { normaliseReceiptQuery } from '../rules/sale';
import type { ServiceContext } from './context';
import { assertAuthorised, auditActor, overrideEvents, type Authorisation } from './override';
import { assertValidSale, movementsFor, type CompletedSale } from './pay';
import { requireOpenPeriod } from './periods';
import { receiptAfterCommit } from './receipts';
import { productsById, validationError } from './shared';

export interface RefundableLine {
  lineIndex: number;
  line: SaleLine;
  soldQty: number;
  refundedQty: number;
  refundableQty: number;
  /** The product's CURRENT stockTracked; the return/waste choice is hidden when false. */
  stockTracked: boolean;
}

export type RefundLookup =
  | { status: 'found'; sale: Sale; lines: RefundableLine[] }
  | { status: 'notFound' }
  /** Deposit or refund receipt: 'This receipt can't be refunded'. */
  | { status: 'notRefundable'; sale: Sale };

/** normaliseReceiptQuery -> sales.getByReceiptNumber -> refundable quantities (D-035, D-036). Needs no permission. */
export async function findSaleForRefund(ctx: ServiceContext, query: string): Promise<RefundLookup> {
  const receiptNumber = normaliseReceiptQuery(query);
  if (receiptNumber === null) return { status: 'notFound' };
  const sale = await ctx.repos.sales.getByReceiptNumber(receiptNumber);
  if (sale === undefined) return { status: 'notFound' };
  if (!isRefundable(sale)) return { status: 'notRefundable', sale };
  const refunds = await ctx.repos.sales.listRefundsOf(sale.id);
  const refunded = refundedQuantities(sale, refunds);
  const refundable = refundableQuantities(sale, refunds);
  const products = await productsById(ctx);
  return {
    status: 'found',
    sale,
    lines: sale.lines.map((line, lineIndex) => ({
      lineIndex,
      line,
      soldQty: line.qty,
      refundedQty: refunded[lineIndex] ?? 0,
      refundableQty: refundable[lineIndex] ?? 0,
      stockTracked: products.get(line.productId)?.stockTracked === true,
    })),
  };
}

export interface RefundInput {
  originalSaleId: string;
  lines: readonly RefundRequestLine[];
  /** Default 'cash' in the UI. */
  tenderType: TenderType;
}

/**
 * Commits a refund (D-038). auth.action 'refund'; needs an open period. Loads the original, then
 * transact: its refunds so far, buildRefundSale, validateSale, stock movements (rules/stock),
 * commitSale({ clearDraft: false }) (re-checks availability) + auditEvents.append([
 * ...overrideEvents, refund { refundSaleId, refundReceiptNumber, originalSaleId,
 * originalReceiptNumber, totalPence, tender, lines }]) with periodId = sale.periodId.
 * Lines of products that are not stock-tracked always store returnToStock true (the choice is
 * hidden for them and nothing is wasted, D-039).
 */
export async function commitRefund(ctx: ServiceContext, auth: Authorisation, input: RefundInput): Promise<CompletedSale> {
  assertAuthorised(auth, 'refund');
  if (input.tenderType !== 'cash' && input.tenderType !== 'card') {
    throw validationError({ tenderType: 'Choose cash or card' });
  }
  await requireOpenPeriod(ctx);
  const original = await ctx.repos.sales.get(input.originalSaleId);
  if (original === undefined) throw new AppError('NOT_FOUND', 'That sale no longer exists');
  if (!isRefundable(original)) throw new AppError('NOT_REFUNDABLE', "This receipt can't be refunded");

  const products = await productsById(ctx);
  const lines = input.lines.map((line) => {
    const productId = original.lines[line.lineIndex]?.productId;
    const tracked = productId !== undefined && products.get(productId)?.stockTracked === true;
    return tracked ? line : { ...line, returnToStock: true };
  });

  const stored = await ctx.repos.transact(async () => {
    // The refunds already made are read in the commit transaction: the cumulative shares
    // (D-037, D-125) depend on them, and commitSale re-checks only the quantities.
    const built = buildRefundSale({
      original,
      existingRefunds: await ctx.repos.sales.listRefundsOf(original.id),
      lines,
      tenderType: input.tenderType,
      staffId: auth.staffId,
    });
    if (!built.ok) throw new AppError('VALIDATION', built.errors.join('; '), { lines: built.errors[0] ?? '' });
    const sale = built.sale;
    assertValidSale(sale);
    const stockMovements = await movementsFor(ctx, sale);
    const refund = await ctx.repos.commitSale({ sale, stockMovements, clearDraft: false });
    await ctx.repos.auditEvents.append([
      ...overrideEvents(auth, refund.periodId),
      {
        type: 'refund',
        ...auditActor(auth),
        periodId: refund.periodId,
        detail: {
          refundSaleId: refund.id,
          refundReceiptNumber: refund.receiptNumber,
          originalSaleId: original.id,
          originalReceiptNumber: original.receiptNumber,
          totalPence: refund.totalPence,
          tender: input.tenderType,
          lines: refund.lines.map((l) => ({ productId: l.productId, qty: negate(l.qty), returnToStock: l.returnToStock !== false })),
        },
      },
    ]);
    return refund;
  });
  return { sale: stored, document: await receiptAfterCommit(ctx, stored) };
}
