import { describe, expect, it } from 'vitest';
import { expectedCash, periodFigures, zFigures, type PeriodFigures } from '../../src/rules/cashup';
import { auditEvent, d042Scenario, makePeriod, toStoredSale } from './fixtures';

const scenario = d042Scenario('period-6');
const { s1, s2, s3, s4 } = scenario.sales;

/** The D-042 reconciliation identities. */
function expectIdentities(f: PeriodFigures, sumOfFinals: number, sumOfSaleFinals: number): void {
  // (1) net = sum of finals over SL and RL
  expect(f.netTakingsPence).toBe(sumOfFinals);
  // (2) cash + card = net - deposits applied + deposits taken
  expect(f.cashTotalPence + f.cardTotalPence).toBe(f.netTakingsPence - f.depositsAppliedPence + f.depositsTakenPence);
  // (3) expected cash = float + cash total
  expect(f.expectedCashPence).toBe(f.floatPence + f.cashTotalPence);
  // (4) VAT gross = net, and net + vat = gross per rate
  expect(f.vatByRate.reduce((a, r) => a + r.grossPence, 0)).toBe(f.netTakingsPence);
  for (const r of f.vatByRate) expect(r.netPence + r.vatPence).toBe(r.grossPence);
  // (5) gross - deal - member = sum over SL of finals
  expect(f.grossSalesPence - f.dealDiscountsPence - f.memberDiscountsPence).toBe(sumOfSaleFinals);
}

describe('expectedCash (spec §7 cash-up formula)', () => {
  it('is float + cash tendered - change given - cash refunded', () => {
    // 10000 + 8500 - 1343 - 255 = 16902.
    expect(expectedCash({ floatPence: 10000, cashTenderedPence: 8500, changeGivenPence: 1343, cashRefundedPence: 255 })).toBe(16902);
    expect(expectedCash({ floatPence: 0, cashTenderedPence: 0, changeGivenPence: 0, cashRefundedPence: 0 })).toBe(0);
  });
});

describe('periodFigures: the D-042 worked period', () => {
  const figures = periodFigures({
    period: scenario.period,
    sales: [s1, s2, s3, s4],
    auditEvents: scenario.auditEvents,
  });

  it('checks the scenario sales first', () => {
    expect([s1.totalPence, s2.totalPence, s3.totalPence, s4.totalPence]).toEqual([977, 5000, 4180, -255]);
    expect(s3.depositAppliedPence).toBe(5000);
    expect(s4.lines[0]!.vatPence).toBe(-43);
  });

  it('computes every X/Z figure', () => {
    expect(figures).toEqual({
      grossSalesPence: 10780, // 1350 + 250 + 9180
      dealDiscountsPence: 450,
      memberDiscountsPence: 173,
      refundsPence: 255,
      netTakingsPence: 9902, // 10780 - 450 - 173 - 255
      depositsTakenPence: 5000,
      depositsAppliedPence: 5000,
      cashTenderedPence: 8500, // 2000 + 5000 + 1500
      changeGivenPence: 1343, // 1023 + 320
      cashRefundedPence: 255,
      cashTotalPence: 6902, // 8500 - 1343 - 255
      cardTenderedPence: 3000,
      cardRefundedPence: 0,
      cardTotalPence: 3000,
      vatByRate: [
        { vatRate: 20, grossPence: 9690, vatPence: 1615, netPence: 8075 }, // 765 + 9180 - 255; 128 + 1530 - 43
        { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
      ],
      floatPence: 10000,
      expectedCashPence: 16902, // 10000 + 8500 - 1343 - 255
      noSaleCount: 1,
      voidCount: 2, // the override event is not counted
    });
  });

  it('satisfies the reconciliation identities', () => {
    // 6902 + 3000 = 9902 = 9902 - 5000 + 5000; 16902 = 10000 + 6902; 9690 + 212 = 9902;
    // 10780 - 450 - 173 = 10157 = 765 + 212 + 9180.
    expectIdentities(figures, 765 + 212 + 9180 - 255, 765 + 212 + 9180);
    // (6) every sale: tenders - change = total
    for (const s of [s1, s2, s3, s4]) {
      expect(s.tenders.reduce((a, t) => a + t.amountPence, 0) - s.changePence).toBe(s.totalPence);
    }
  });

  it('Z adds the declared cash and variance (short 2p)', () => {
    const z = zFigures(figures, 16900);
    expect(z).toEqual({ ...figures, declaredCashPence: 16900, variancePence: -2 });
    expect(zFigures(figures, 16902).variancePence).toBe(0);
    expect(zFigures(figures, 17000).variancePence).toBe(98); // over
  });

  it('D-047 example: expected 50300, declared 50000 -> variance -300', () => {
    const f = { ...figures, expectedCashPence: 50300 };
    expect(zFigures(f, 50000).variancePence).toBe(-300);
  });
});

describe('periodFigures: selection (D-040, D-043)', () => {
  it('counts only sales and audit events of this period', () => {
    const otherPeriodSale = toStoredSale(scenario.newSales.s1, {
      id: 'sale-9',
      periodId: 'period-5',
      createdAt: '2026-09-25T12:00:00.000Z',
      receiptNumber: '3F9C-000009',
    });
    const f = periodFigures({
      period: scenario.period,
      sales: [s1, s2, s3, s4, otherPeriodSale],
      auditEvents: [...scenario.auditEvents, auditEvent('void', 'period-5'), auditEvent('noSale', undefined)],
    });
    expect(f.grossSalesPence).toBe(10780);
    expect(f.voidCount).toBe(2);
    expect(f.noSaleCount).toBe(1);
  });

  it('a refund of an earlier period sale counts in the refunding period only', () => {
    const p7 = makePeriod('period-7', 5000);
    const refund = { ...s4, id: 'sale-10', periodId: 'period-7' };
    const f = periodFigures({ period: p7, sales: [s1, s2, s3, refund], auditEvents: [] });
    expect(f).toMatchObject({
      grossSalesPence: 0,
      refundsPence: 255,
      netTakingsPence: -255,
      cashRefundedPence: 255,
      cashTotalPence: -255,
      expectedCashPence: 4745, // 5000 - 255
      vatByRate: [{ vatRate: 20, grossPence: -255, vatPence: -43, netPence: -212 }],
    });
    expectIdentities(f, -255, 0);
  });

  it('card refunds reduce the card total, not the drawer', () => {
    const cardRefund = { ...s4, tenders: [{ type: 'card' as const, amountPence: -255 }] };
    const f = periodFigures({ period: scenario.period, sales: [s1, s2, s3, cardRefund], auditEvents: [] });
    expect(f).toMatchObject({ cashRefundedPence: 0, cardRefundedPence: 255, cardTotalPence: 2745, cashTotalPence: 7157 });
    expect(f.expectedCashPence).toBe(17157); // 10000 + 8500 - 1343
    expectIdentities(f, 9902, 10157);
  });

  it('an empty period has only its float', () => {
    const f = periodFigures({ period: makePeriod('period-8', 7500), sales: [], auditEvents: [] });
    expect(f).toEqual({
      grossSalesPence: 0,
      dealDiscountsPence: 0,
      memberDiscountsPence: 0,
      refundsPence: 0,
      netTakingsPence: 0,
      depositsTakenPence: 0,
      depositsAppliedPence: 0,
      cashTenderedPence: 0,
      changeGivenPence: 0,
      cashRefundedPence: 0,
      cashTotalPence: 0,
      cardTenderedPence: 0,
      cardRefundedPence: 0,
      cardTotalPence: 0,
      vatByRate: [],
      floatPence: 7500,
      expectedCashPence: 7500,
      noSaleCount: 0,
      voidCount: 0,
    });
    for (const v of Object.values(f)) {
      if (typeof v === 'number') expect(Object.is(v, -0)).toBe(false);
    }
  });
});
