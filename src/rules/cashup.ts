/**
 * X read / Z close figures and the cash-up formula (spec §6.11, §7; D-040..D-043).
 * Pure: sums stored sale and line figures; never reprices.
 */
import type { AuditEvent, Pence, Period, Sale, SaleLine, Tender } from '../data/types';
import { assertPence, negate, sumPence } from './money';
import { vatSummary, type VatSummaryRow } from './vat';

/**
 * X/Z report figures (D-041). SL = lines of kind 'sale' sales, RL = lines of kind 'refund' sales.
 * Deal discounts, member discounts and refunds are POSITIVE magnitudes here and print as negatives.
 */
export interface PeriodFigures {
  /** sum over SL of qty * unitPricePence */
  grossSalesPence: Pence;
  /** sum over SL of dealDiscountPence */
  dealDiscountsPence: Pence;
  /** sum over SL of memberDiscountPence */
  memberDiscountsPence: Pence;
  /** negate(sum over RL of finalPence) */
  refundsPence: Pence;
  /** gross - deal - member - refunds = sum of finalPence over SL and RL */
  netTakingsPence: Pence;
  /** sum of totalPence of kind 'deposit' */
  depositsTakenPence: Pence;
  /** sum of depositAppliedPence of kind 'sale' */
  depositsAppliedPence: Pence;
  /** sum of cash tenders on kinds 'sale' and 'deposit' */
  cashTenderedPence: Pence;
  /** sum of changePence */
  changeGivenPence: Pence;
  /** negate(sum of cash tenders on kind 'refund') */
  cashRefundedPence: Pence;
  /** cashTendered - changeGiven - cashRefunded */
  cashTotalPence: Pence;
  /** sum of card tenders on kinds 'sale' and 'deposit' */
  cardTenderedPence: Pence;
  /** negate(sum of card tenders on kind 'refund') */
  cardRefundedPence: Pence;
  /** cardTendered - cardRefunded */
  cardTotalPence: Pence;
  /** vatSummary over SL and RL (refunds net off) */
  vatByRate: VatSummaryRow[];
  /** period.floatPence */
  floatPence: Pence;
  /** float + cashTendered - changeGiven - cashRefunded */
  expectedCashPence: Pence;
  /** number of 'noSale' audit events with this periodId (D-043) */
  noSaleCount: number;
  /** number of 'void' audit events with this periodId (D-043) */
  voidCount: number;
}

/** Z-only additions (D-041). */
export interface ZFigures extends PeriodFigures {
  declaredCashPence: Pence;
  /** declared - expected: negative = short, positive = over. */
  variancePence: Pence;
}

export interface ExpectedCashInput {
  floatPence: Pence;
  cashTenderedPence: Pence;
  changeGivenPence: Pence;
  cashRefundedPence: Pence;
}

/** expected cash = float + cash tendered - change given - cash refunded (spec §7). 10000 + 8500 - 1343 - 255 = 16902. */
export function expectedCash(input: ExpectedCashInput): Pence {
  const { floatPence, cashTenderedPence, changeGivenPence, cashRefundedPence } = input;
  return sumPence([floatPence, cashTenderedPence, negate(changeGivenPence), negate(cashRefundedPence)]);
}

export interface PeriodFiguresInput {
  period: Period;
  /** Sales of every kind; only those with periodId === period.id are counted. */
  sales: readonly Sale[];
  /** Audit events; only those with periodId === period.id are counted. */
  auditEvents: readonly AuditEvent[];
}

const linesOf = (sales: readonly Sale[]): SaleLine[] => sales.flatMap((s) => s.lines);
const tendersOf = (sales: readonly Sale[], type: Tender['type']): Pence[] =>
  sales.flatMap((s) => s.tenders.filter((t) => t.type === type).map((t) => t.amountPence));

/**
 * All X/Z figures for a period (D-041). Must satisfy the reconciliation identities (D-042):
 * (1) net = sum of finals over SL and RL; (2) cashTotal + cardTotal = net - depositsApplied +
 * depositsTaken; (3) expectedCash = float + cashTotal; (4) sum(vatByRate.gross) = net and
 * net + vat = gross per rate; (5) gross - deal - member = sum over SL of finals.
 */
export function periodFigures(input: PeriodFiguresInput): PeriodFigures {
  const { period } = input;
  assertPence(period.floatPence, 'float');
  const inPeriod = input.sales.filter((s) => s.periodId === period.id);
  const sales = inPeriod.filter((s) => s.kind === 'sale');
  const deposits = inPeriod.filter((s) => s.kind === 'deposit');
  const refunds = inPeriod.filter((s) => s.kind === 'refund');
  const takings = [...sales, ...deposits];
  const SL = linesOf(sales);
  const RL = linesOf(refunds);

  const grossSalesPence = sumPence(SL.map((l) => l.qty * l.unitPricePence));
  const dealDiscountsPence = sumPence(SL.map((l) => l.dealDiscountPence));
  const memberDiscountsPence = sumPence(SL.map((l) => l.memberDiscountPence));
  const refundsPence = negate(sumPence(RL.map((l) => l.finalPence)));
  const netTakingsPence = sumPence([grossSalesPence, negate(dealDiscountsPence), negate(memberDiscountsPence), negate(refundsPence)]);

  const cashTenderedPence = sumPence(tendersOf(takings, 'cash'));
  const changeGivenPence = sumPence(inPeriod.map((s) => s.changePence));
  const cashRefundedPence = negate(sumPence(tendersOf(refunds, 'cash')));
  const cardTenderedPence = sumPence(tendersOf(takings, 'card'));
  const cardRefundedPence = negate(sumPence(tendersOf(refunds, 'card')));
  const floatPence = period.floatPence;

  const periodEvents = input.auditEvents.filter((e) => e.periodId === period.id);
  return {
    grossSalesPence,
    dealDiscountsPence,
    memberDiscountsPence,
    refundsPence,
    netTakingsPence,
    depositsTakenPence: sumPence(deposits.map((s) => s.totalPence)),
    depositsAppliedPence: sumPence(sales.map((s) => s.depositAppliedPence)),
    cashTenderedPence,
    changeGivenPence,
    cashRefundedPence,
    cashTotalPence: sumPence([cashTenderedPence, negate(changeGivenPence), negate(cashRefundedPence)]),
    cardTenderedPence,
    cardRefundedPence,
    cardTotalPence: sumPence([cardTenderedPence, negate(cardRefundedPence)]),
    vatByRate: vatSummary([...SL, ...RL]),
    floatPence,
    expectedCashPence: expectedCash({ floatPence, cashTenderedPence, changeGivenPence, cashRefundedPence }),
    noSaleCount: periodEvents.filter((e) => e.type === 'noSale').length,
    voidCount: periodEvents.filter((e) => e.type === 'void').length,
  };
}

/** Adds declared cash and variance = declared - expected (D-041). */
export function zFigures(figures: PeriodFigures, declaredCashPence: Pence): ZFigures {
  assertPence(declaredCashPence, 'declared cash');
  return {
    ...figures,
    declaredCashPence,
    variancePence: sumPence([declaredCashPence, negate(figures.expectedCashPence)]),
  };
}
