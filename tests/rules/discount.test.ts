import { describe, expect, it } from 'vitest';
import { memberDiscount, type MemberDiscountLine } from '../../src/rules/discount';

const e = (postDealPence: number): MemberDiscountLine => ({ postDealPence, eligible: true });
const x = (postDealPence: number): MemberDiscountLine => ({ postDealPence, eligible: false });

describe('memberDiscount (D-019, D-020)', () => {
  it('half-penny rounding with a deal and a 0% line', () => {
    // Lager postDeal 900 (after 3 for 2) + Crisps 250. Base 1150 x 15% = 172.5 -> 173.
    // Shares: 173*900/1150 = 135.39 -> 135; 173*250/1150 = 37.61 -> 38. Sum 173, no remainder.
    expect(memberDiscount([e(900), e(250)], 15)).toEqual({ basePence: 1150, discountPence: 173, perLine: [135, 38] });
  });

  it('without deals', () => {
    // Lager x2 @450 = 900 + Crisps 130. Base 1030 x 15% = 154.5 -> 155.
    // 155*900/1030 = 135.44 -> 135; 155*130/1030 = 19.56 -> 20.
    expect(memberDiscount([e(900), e(130)], 15)).toEqual({ basePence: 1030, discountPence: 155, perLine: [135, 20] });
  });

  it('spreads the rounding remainder onto the first largest line', () => {
    // Three lines of 410. Base 1230 x 15% = 184.5 -> 185. 61.67 -> 62 each = 186; diff -1 on line 0.
    expect(memberDiscount([e(410), e(410), e(410)], 15)).toEqual({ basePence: 1230, discountPence: 185, perLine: [61, 62, 62] });
  });

  it('puts the remainder on the largest line even when it is not first', () => {
    // Base 600 x 15% = 90. 90*150/600 = 22.5 -> 23 (x2); 90*300/600 = 45. Sum 91, diff -1.
    // Priority: postDeal DESC then index -> line 2 (300) first -> 44.
    expect(memberDiscount([e(150), e(150), e(300)], 15)).toEqual({ basePence: 600, discountPence: 90, perLine: [23, 23, 44] });
  });

  it('gives a member-ineligible item nothing', () => {
    // Lager x2 @450 (eligible) + Cigar 1200 (ineligible). Base 900 x 15% = 135, all on the Lager.
    expect(memberDiscount([e(900), x(1200)], 15)).toEqual({ basePence: 900, discountPence: 135, perLine: [135, 0] });
  });

  it('gives nothing when every line is ineligible', () => {
    expect(memberDiscount([x(900), x(1200)], 15)).toEqual({ basePence: 0, discountPence: 0, perLine: [0, 0] });
  });

  it('gives nothing to an eligible line whose post-deal amount is 0', () => {
    // Base 450 x 15% = 67.5 -> 68, all on the 450 line.
    expect(memberDiscount([e(0), e(450)], 15)).toEqual({ basePence: 450, discountPence: 68, perLine: [0, 68] });
  });

  it('is zero with no member attached (percent null) or a 0% setting', () => {
    expect(memberDiscount([e(900), e(250)], null)).toEqual({ basePence: 1150, discountPence: 0, perLine: [0, 0] });
    expect(memberDiscount([e(900), e(250)], 0)).toEqual({ basePence: 1150, discountPence: 0, perLine: [0, 0] });
  });

  it('uses the configured percentage', () => {
    // D-019: at 10% with base 1000 the discount is 100.
    expect(memberDiscount([e(1000)], 10)).toEqual({ basePence: 1000, discountPence: 100, perLine: [100] });
    // 100% discounts every eligible penny.
    expect(memberDiscount([e(900), x(100), e(250)], 100)).toEqual({ basePence: 1150, discountPence: 1150, perLine: [900, 0, 250] });
  });

  it('handles 1p lines', () => {
    // Base 3 x 15% = 0.45 -> 0.
    expect(memberDiscount([e(1), e(1), e(1)], 15).discountPence).toBe(0);
    // Base 10 x 15% = 1.5 -> 2. Shares 2*1/10 = 0.2 -> 0 each; diff +2 on lines 0 and 1.
    const tenPennies = Array.from({ length: 10 }, () => e(1));
    expect(memberDiscount(tenPennies, 15).perLine).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('handles an empty basket', () => {
    expect(memberDiscount([], 15)).toEqual({ basePence: 0, discountPence: 0, perLine: [] });
  });

  it('throws RangeError for an invalid percent or amount', () => {
    expect(() => memberDiscount([e(900)], 15.5)).toThrow(RangeError);
    expect(() => memberDiscount([e(900)], -1)).toThrow(RangeError);
    expect(() => memberDiscount([e(900)], 101)).toThrow(RangeError);
    expect(() => memberDiscount([e(-1)], 15)).toThrow(RangeError);
  });
});
