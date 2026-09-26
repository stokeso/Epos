import { describe, expect, it } from 'vitest';
import type { Tender } from '../../src/data/types';
import {
  QUICK_CASH_PENCE,
  applyTender,
  startTendering,
  tenderSequenceProblems,
  type TenderRequest,
  type TenderState,
} from '../../src/rules/tender';

function take(state: TenderState, request: TenderRequest): TenderState {
  const outcome = applyTender(state, request);
  if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.message}`);
  return outcome.state;
}
const cash = (amountPence: number | null): TenderRequest => ({ type: 'cash', amountPence });
const card = (amountPence: number | null): TenderRequest => ({ type: 'card', amountPence });

describe('QUICK_CASH_PENCE (D-030)', () => {
  it('is £5, £10, £20, £50', () => {
    expect([...QUICK_CASH_PENCE]).toEqual([500, 1000, 2000, 5000]);
  });
});

describe('startTendering', () => {
  it('starts with the whole amount due', () => {
    expect(startTendering(4180)).toEqual({ totalPence: 4180, tenders: [], remainingPence: 4180, complete: false, changePence: 0 });
  });

  it('is complete immediately for a zero total (D-031)', () => {
    expect(startTendering(0)).toEqual({ totalPence: 0, tenders: [], remainingPence: 0, complete: true, changePence: 0 });
  });

  it('throws RangeError for a negative or fractional total', () => {
    expect(() => startTendering(-1)).toThrow(RangeError);
    expect(() => startTendering(1.5)).toThrow(RangeError);
  });
});

describe('applyTender (D-029, D-030)', () => {
  it('split cash + card: card above balance rejected, then card, then cash with change', () => {
    // Due 4180. Card 5000 is rejected; card 3000 leaves 1180; cash 1500 completes with change 320.
    let s = startTendering(4180);
    const rejected = applyTender(s, card(5000));
    expect(rejected).toEqual({ ok: false, reason: 'cardExceedsBalance', message: "Card can't be more than the balance (£41.80)" });

    s = take(s, card(3000));
    expect(s).toMatchObject({ remainingPence: 1180, complete: false, changePence: 0 });
    s = take(s, cash(1500));
    expect(s).toEqual({
      totalPence: 4180,
      tenders: [
        { type: 'card', amountPence: 3000 },
        { type: 'cash', amountPence: 1500 },
      ],
      remainingPence: 0,
      complete: true,
      changePence: 320,
    });
  });

  it('change from cash: due 977, a £20 note gives 1023 change', () => {
    const s = take(startTendering(977), cash(2000));
    expect(s).toMatchObject({ complete: true, changePence: 1023, tenders: [{ type: 'cash', amountPence: 2000 }] });
  });

  it('card with an empty keypad takes the remaining balance', () => {
    // Due 4180: cash 1000, then Card (keypad empty) takes 3180; change 0.
    let s = take(startTendering(4180), cash(1000));
    s = take(s, card(null));
    expect(s).toMatchObject({
      complete: true,
      changePence: 0,
      tenders: [
        { type: 'cash', amountPence: 1000 },
        { type: 'card', amountPence: 3180 },
      ],
    });
  });

  it('card exactly equal to the balance completes with no change', () => {
    const s = take(startTendering(977), card(977));
    expect(s).toMatchObject({ complete: true, remainingPence: 0, changePence: 0 });
  });

  it('card can never create change, even by 1p', () => {
    const s = take(startTendering(977), cash(500));
    expect(applyTender(s, card(478))).toMatchObject({ ok: false, reason: 'cardExceedsBalance', message: "Card can't be more than the balance (£4.77)" });
    expect(take(s, card(477))).toMatchObject({ complete: true, changePence: 0 });
  });

  it('quick cash partial tenders then Exact (D-030)', () => {
    // Due 977: £5 leaves 477; Exact tenders 477 -> [{cash,500},{cash,477}], change 0.
    let s = take(startTendering(977), cash(500));
    expect(s.remainingPence).toBe(477);
    s = take(s, cash(s.remainingPence));
    expect(s).toMatchObject({
      complete: true,
      changePence: 0,
      tenders: [
        { type: 'cash', amountPence: 500 },
        { type: 'cash', amountPence: 477 },
      ],
    });
    // Due 320: £5 completes with change 180.
    expect(take(startTendering(320), cash(500))).toMatchObject({ complete: true, changePence: 180 });
  });

  it('keeps tenders separate and in order, never merged (D-029)', () => {
    let s = startTendering(1000);
    s = take(s, cash(100));
    s = take(s, cash(100));
    s = take(s, card(300));
    expect(s.tenders).toEqual([
      { type: 'cash', amountPence: 100 },
      { type: 'cash', amountPence: 100 },
      { type: 'card', amountPence: 300 },
    ]);
    expect(s.remainingPence).toBe(500);
  });

  it('rejects zero amounts and anything once complete, recording nothing', () => {
    const s = startTendering(977);
    expect(applyTender(s, cash(0))).toMatchObject({ ok: false, reason: 'amountTooSmall' });
    expect(applyTender(s, cash(null))).toMatchObject({ ok: false, reason: 'amountTooSmall' });
    expect(applyTender(s, card(0))).toMatchObject({ ok: false, reason: 'amountTooSmall' });
    expect(s.tenders).toEqual([]);
    expect(applyTender(startTendering(0), cash(500))).toMatchObject({ ok: false, reason: 'nothingDue' });
    const done = take(s, cash(977));
    expect(applyTender(done, card(null))).toMatchObject({ ok: false, reason: 'nothingDue' });
  });

  it('never mutates the previous state', () => {
    const s = startTendering(977);
    take(s, cash(500));
    expect(s).toEqual(startTendering(977));
  });

  it('has no upper limit on cash', () => {
    expect(take(startTendering(1), cash(9_999_999))).toMatchObject({ complete: true, changePence: 9_999_998 });
  });
});

describe('tenderSequenceProblems (D-032)', () => {
  const t = (type: Tender['type'], amountPence: number): Tender => ({ type, amountPence });

  it('accepts valid sequences', () => {
    expect(tenderSequenceProblems(4180, [t('card', 3000), t('cash', 1500)], 320)).toEqual([]);
    expect(tenderSequenceProblems(977, [t('cash', 2000)], 1023)).toEqual([]);
    expect(tenderSequenceProblems(977, [t('cash', 500), t('cash', 477)], 0)).toEqual([]);
    expect(tenderSequenceProblems(4180, [t('cash', 1000), t('card', 3180)], 0)).toEqual([]);
    expect(tenderSequenceProblems(0, [], 0)).toEqual([]);
  });

  it.each<[string, number, Tender[], number]>([
    ['a card above the remaining amount', 4180, [t('card', 5000)], 820],
    ['a later card above the remaining amount', 4180, [t('cash', 1000), t('card', 3181)], 1],
    ['change from a final card tender', 1000, [t('cash', 500), t('card', 600)], 100],
    ['a tender after the total was reached', 977, [t('cash', 977), t('cash', 100)], 100],
    ['tenders short of the total', 977, [t('cash', 500)], 0],
    ['wrong change', 977, [t('cash', 2000)], 1000],
    ['change equal to the last cash tender', 0, [t('cash', 500)], 500],
    ['tenders on a zero total', 0, [t('cash', 100)], 100],
    ['a zero tender', 977, [t('cash', 0), t('cash', 977)], 0],
    ['a negative tender', 977, [t('cash', -23), t('cash', 1000)], 0],
    ['no tenders on a non-zero total', 977, [], 0],
    ['negative change', 977, [t('cash', 977)], -1],
  ])('rejects %s', (_label, total, tenders, change) => {
    expect(tenderSequenceProblems(total, tenders, change).length).toBeGreaterThan(0);
  });
});
