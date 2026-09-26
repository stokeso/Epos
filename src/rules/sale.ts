/**
 * Sale invariants and receipt numbers (spec §4, §8; D-032, D-035, D-059, D-122).
 */
import type { NewSale, SaleLine } from '../data/types';
import { MAX_KEYPAD_PENCE, isPence } from './money';
import { tenderSequenceProblems } from './tender';
import { isValidVatRate, lineVat } from './vat';

const LINE_MONEY_FIELDS = ['unitPricePence', 'dealDiscountPence', 'memberDiscountPence', 'finalPence', 'vatPence'] as const;
const SALE_MONEY_FIELDS = ['memberDiscountPence', 'depositAppliedPence', 'totalPence', 'changePence'] as const;

/** Sums values already checked to be safe integers (a bad value makes the sum NaN, which never matches). */
function total(values: readonly number[]): number {
  return values.reduce((a, v) => a + v, 0);
}

/** Money and integer checks shared by every kind (D-001, D-003). */
function moneyProblems(sale: NewSale): string[] {
  const problems: string[] = [];
  for (const field of SALE_MONEY_FIELDS) {
    if (!isPence(sale[field])) problems.push(`${field} must be a whole number of pence (not -0)`);
  }
  sale.tenders.forEach((t, i) => {
    if (!isPence(t.amountPence)) problems.push(`Tender ${i + 1} amount must be a whole number of pence (not -0)`);
    if (t.type !== 'cash' && t.type !== 'card') problems.push(`Tender ${i + 1} has an unknown type`);
  });
  sale.lines.forEach((line, i) => {
    for (const field of LINE_MONEY_FIELDS) {
      if (!isPence(line[field])) problems.push(`Line ${i + 1} ${field} must be a whole number of pence (not -0)`);
    }
    if (!Number.isSafeInteger(line.qty)) problems.push(`Line ${i + 1} qty must be a whole number`);
    if (line.unitPricePence < 0) problems.push(`Line ${i + 1} unit price must not be negative`);
    if (!isValidVatRate(line.vatRate)) problems.push(`Line ${i + 1} VAT rate must be a whole number 0..100`);
  });
  sale.dealLines.forEach((d, i) => {
    if (!isPence(d.savingPence)) problems.push(`Deal line ${i + 1} saving must be a whole number of pence (not -0)`);
  });
  return problems;
}

function saleLineProblems(line: SaleLine, i: number): string[] {
  const problems: string[] = [];
  const n = i + 1;
  if (!(line.qty >= 1)) problems.push(`Line ${n} qty must be at least 1`);
  const gross = line.qty * line.unitPricePence;
  if (!(line.dealDiscountPence >= 0 && line.dealDiscountPence <= gross)) problems.push(`Line ${n} deal discount must be 0..gross`);
  if (!(line.memberDiscountPence >= 0 && line.memberDiscountPence <= gross - line.dealDiscountPence)) {
    problems.push(`Line ${n} member discount must be 0..gross - deal`);
  }
  if (line.finalPence !== gross - line.dealDiscountPence - line.memberDiscountPence) problems.push(`Line ${n} final must be gross - deal - member`);
  if (isValidVatRate(line.vatRate) && isPence(line.finalPence) && line.vatPence !== lineVat(line.finalPence, line.vatRate)) {
    problems.push(`Line ${n} VAT must be lineVat(final, rate)`);
  }
  if (line.refundOfLineIndex !== undefined || line.returnToStock !== undefined) problems.push(`Line ${n} must not carry refund fields`);
  return problems;
}

function kindSaleProblems(sale: NewSale): string[] {
  const problems: string[] = [];
  if (sale.lines.length === 0) problems.push('A sale needs at least one line');
  if (sale.refundOfSaleId !== undefined) problems.push('A sale must not reference a refunded sale');
  const ids = sale.lines.map((l) => l.productId);
  if (new Set(ids).size !== ids.length) problems.push('Sale lines must be unique by product');
  sale.lines.forEach((line, i) => problems.push(...saleLineProblems(line, i)));

  const finals = total(sale.lines.map((l) => l.finalPence));
  if (sale.memberDiscountPence !== total(sale.lines.map((l) => l.memberDiscountPence))) {
    problems.push('Member discount must equal the sum of the line member discounts');
  }
  sale.dealLines.forEach((d, i) => {
    if (!(d.savingPence >= 1)) problems.push(`Deal line ${i + 1} saving must be positive`);
    if (!Number.isInteger(d.groupCount) || d.groupCount < 1) problems.push(`Deal line ${i + 1} group count must be at least 1`);
  });
  if (total(sale.dealLines.map((d) => d.savingPence)) !== total(sale.lines.map((l) => l.dealDiscountPence))) {
    problems.push('Deal lines must sum to the line deal discounts');
  }
  if (!(sale.depositAppliedPence >= 0 && sale.depositAppliedPence <= finals)) problems.push('Deposit applied must be 0..sum of line finals');
  if (sale.depositAppliedPence > 0 && sale.bookingId === undefined) problems.push('A deposit applied needs a booking');
  if (sale.totalPence !== finals - sale.depositAppliedPence) problems.push('Total must be the sum of line finals minus the deposit applied');
  problems.push(...tenderSequenceProblems(sale.totalPence, sale.tenders, sale.changePence));
  return problems;
}

function kindDepositProblems(sale: NewSale): string[] {
  const problems: string[] = [];
  if (sale.lines.length > 0) problems.push('A deposit has no lines');
  if (sale.dealLines.length > 0) problems.push('A deposit has no deal lines');
  if (sale.bookingId === undefined) problems.push('A deposit needs a booking');
  if (sale.memberId !== undefined) problems.push('A deposit has no member');
  if (sale.tabId !== undefined) problems.push('A deposit has no tab');
  if (sale.refundOfSaleId !== undefined) problems.push('A deposit does not reference a refunded sale');
  if (sale.memberDiscountPence !== 0) problems.push('A deposit has no member discount');
  if (sale.depositAppliedPence !== 0) problems.push('A deposit has no deposit applied');
  if (!(sale.totalPence >= 1 && sale.totalPence <= MAX_KEYPAD_PENCE)) problems.push(`A deposit must be 1..${MAX_KEYPAD_PENCE}p`);
  problems.push(...tenderSequenceProblems(sale.totalPence, sale.tenders, sale.changePence));
  return problems;
}

function kindRefundProblems(sale: NewSale): string[] {
  const problems: string[] = [];
  if (sale.refundOfSaleId === undefined) problems.push('A refund must reference the original sale');
  if (sale.bookingId !== undefined) problems.push('A refund has no booking');
  if (sale.tabId !== undefined) problems.push('A refund has no tab');
  if (sale.lines.length === 0) problems.push('A refund needs at least one line');
  const indices = new Set<number>();
  sale.lines.forEach((line, i) => {
    const n = i + 1;
    if (!(line.qty <= -1)) problems.push(`Refund line ${n} qty must be -1 or less`);
    if (line.refundOfLineIndex === undefined || !Number.isInteger(line.refundOfLineIndex) || line.refundOfLineIndex < 0) {
      problems.push(`Refund line ${n} needs refundOfLineIndex`);
    } else if (indices.has(line.refundOfLineIndex)) {
      problems.push(`Refund line ${n} repeats original line ${line.refundOfLineIndex}`);
    } else {
      indices.add(line.refundOfLineIndex);
    }
    if (typeof line.returnToStock !== 'boolean') problems.push(`Refund line ${n} needs returnToStock`);
    if (line.finalPence !== line.qty * line.unitPricePence - line.dealDiscountPence - line.memberDiscountPence) {
      problems.push(`Refund line ${n} final must be qty x unit - deal - member`);
    }
    if (line.dealDiscountPence > 0 || line.memberDiscountPence > 0 || line.finalPence > 0 || line.vatPence > 0) {
      problems.push(`Refund line ${n} figures must not be positive`);
    }
  });
  if (sale.dealLines.length > 0) problems.push('A refund has no deal lines');
  if (sale.memberDiscountPence !== total(sale.lines.map((l) => l.memberDiscountPence))) {
    problems.push('Member discount must equal the sum of the line member discounts');
  }
  if (sale.depositAppliedPence !== 0) problems.push('A refund has no deposit applied');
  if (sale.totalPence !== total(sale.lines.map((l) => l.finalPence))) problems.push('A refund total must be the sum of line finals');
  if (sale.totalPence > 0) problems.push('A refund total must not be positive');
  if (sale.changePence !== 0) problems.push('A refund gives no change');
  if (sale.totalPence === 0) {
    if (sale.tenders.length > 0) problems.push('A zero refund has no tender');
  } else if (sale.tenders.length !== 1 || sale.tenders[0]?.amountPence !== sale.totalPence) {
    problems.push('A refund has exactly one tender equal to its total');
  }
  return problems;
}

/**
 * Every integrity rule a sale must satisfy before commitSale (D-032). Returns problem messages
 * (empty = valid). Services throw AppError('INVALID_SALE') when non-empty.
 * All kinds: every money field is a safe integer and not -0; sum(tenders) - changePence === totalPence.
 * 'sale': >= 1 line, lines unique by productId, each qty >= 1, 0 <= deal <= gross,
 *   0 <= member <= gross - deal, final = gross - deal - member, vat = lineVat(final, rate), no
 *   refund fields; memberDiscountPence = sum(line member); sum(dealLines.saving) = sum(line deal);
 *   0 <= depositApplied <= sum(finals); depositApplied > 0 requires bookingId; no refundOfSaleId;
 *   total = sum(finals) - depositApplied; tenderSequenceProblems() is empty.
 * 'deposit': lines [], dealLines [], bookingId set, no memberId/tabId/refundOfSaleId,
 *   memberDiscountPence 0, depositAppliedPence 0, total 1..MAX_KEYPAD_PENCE; tender sequence valid.
 * 'refund': refundOfSaleId set, no bookingId/tabId, >= 1 line, each qty <= -1 with a distinct
 *   refundOfLineIndex and returnToStock set, final = qty*unit - deal - member (deal, member,
 *   final and VAT all <= 0), dealLines [], memberDiscountPence = sum(line member),
 *   depositApplied 0, total = sum(finals) <= 0, changePence 0, tenders = [] when total is 0 else
 *   exactly one tender with amount = total.
 */
export function validateSale(sale: NewSale): string[] {
  const problems = moneyProblems(sale);
  const tendered = total(sale.tenders.map((t) => t.amountPence));
  if (tendered - sale.changePence !== sale.totalPence) problems.push('Tenders minus change must equal the total');
  switch (sale.kind) {
    case 'sale':
      problems.push(...kindSaleProblems(sale));
      break;
    case 'deposit':
      problems.push(...kindDepositProblems(sale));
      break;
    case 'refund':
      problems.push(...kindRefundProblems(sale));
      break;
    default:
      problems.push(`Unknown sale kind: ${String(sale.kind)}`);
  }
  return problems;
}

/** `${prefix}-${String(n).padStart(6, '0')}`; grows past 6 digits, never truncates (D-059). 'TILL1', 42 -> 'TILL1-000042'. */
export function formatReceiptNumber(devicePrefix: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Receipt number must be a whole number >= 1 (got ${String(n)})`);
  return `${devicePrefix}-${String(n).padStart(6, '0')}`;
}

const RECEIPT_QUERY_PATTERN = /^([A-Z0-9]{1,6})-(\d+)$/;

/**
 * Refund search normalisation (D-035, D-122): trim, upper-case; if it matches
 * /^([A-Z0-9]{1,6})-(\d+)$/ drop leading zeros from the digits and re-pad them to at least 6.
 * Returns null for empty input.
 * '3f9c-42' -> '3F9C-000042'; '3f9c-0000042' -> '3F9C-000042'.
 */
export function normaliseReceiptQuery(text: string): string | null {
  const query = text.trim().toUpperCase();
  if (query === '') return null;
  const match = RECEIPT_QUERY_PATTERN.exec(query);
  if (match === null) return query;
  const digits = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  return `${match[1] ?? ''}-${digits.padStart(6, '0')}`;
}
