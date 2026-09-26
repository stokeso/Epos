import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BasketLine } from '../../src/data/types';
import {
  EMPTY_BASKET,
  addProduct,
  hasNoLines,
  isBasketEmpty,
  mergeLines,
  reduceLine,
  type BasketState,
} from '../../src/rules/basket';

describe('addProduct (D-008)', () => {
  it('appends new products and adds 1 in place for existing ones', () => {
    // Tap Club Bitter, Fairway Lager, Club Bitter -> [Club Bitter x2, Fairway Lager x1].
    const b = ['bitter', 'lager', 'bitter'].reduce(addProduct, EMPTY_BASKET);
    expect(b.lines).toEqual([
      { productId: 'bitter', qty: 2 },
      { productId: 'lager', qty: 1 },
    ]);
  });

  it('keeps the member, booking and tab', () => {
    const b = addProduct({ lines: [], memberId: 'm', bookingId: 'b', tabId: 't' }, 'lager');
    expect(b).toEqual({ lines: [{ productId: 'lager', qty: 1 }], memberId: 'm', bookingId: 'b', tabId: 't' });
  });

  it('ignores a tap at the maximum quantity by returning the same basket', () => {
    const full: BasketState = { lines: [{ productId: 'lager', qty: 999 }] };
    expect(addProduct(full, 'lager')).toBe(full);
    expect(addProduct({ lines: [{ productId: 'lager', qty: 998 }] }, 'lager').lines).toEqual([{ productId: 'lager', qty: 999 }]);
  });

  it('never mutates its input', () => {
    const before: BasketState = { lines: [{ productId: 'lager', qty: 1 }] };
    const snapshot = structuredClone(before);
    addProduct(before, 'lager');
    addProduct(before, 'bitter');
    expect(before).toEqual(snapshot);
    expect(EMPTY_BASKET).toEqual({ lines: [] });
  });

  it('EMPTY_BASKET is frozen, and its type says the lines are read-only', () => {
    expect(Object.isFrozen(EMPTY_BASKET) && Object.isFrozen(EMPTY_BASKET.lines)).toBe(true);
    // Checked by the type-check: a caller cannot push onto the shared frozen array.
    expectTypeOf(EMPTY_BASKET.lines).toEqualTypeOf<readonly BasketLine[]>();
  });
});

describe('reduceLine (D-085)', () => {
  const b: BasketState = {
    lines: [
      { productId: 'lager', qty: 3 },
      { productId: 'crisps', qty: 1 },
    ],
    memberId: 'm',
  };

  it('removes some units', () => {
    // Fairway Lager x3 reduced to x1: a void of 2.
    expect(reduceLine(b, 'lager', 2)).toEqual({
      lines: [
        { productId: 'lager', qty: 1 },
        { productId: 'crisps', qty: 1 },
      ],
      memberId: 'm',
    });
  });

  it('removes the line when it reaches 0', () => {
    expect(reduceLine(b, 'lager', 3).lines).toEqual([{ productId: 'crisps', qty: 1 }]);
    expect(reduceLine(b, 'crisps', 1).lines).toEqual([{ productId: 'lager', qty: 3 }]);
  });

  it('throws RangeError for an unknown line or an out-of-range quantity', () => {
    expect(() => reduceLine(b, 'wine', 1)).toThrow(RangeError);
    expect(() => reduceLine(b, 'lager', 0)).toThrow(RangeError);
    expect(() => reduceLine(b, 'lager', 4)).toThrow(RangeError);
    expect(() => reduceLine(b, 'lager', 1.5)).toThrow(RangeError);
  });

  it('never mutates its input', () => {
    const snapshot = structuredClone(b);
    reduceLine(b, 'lager', 1);
    reduceLine(b, 'crisps', 1);
    expect(b).toEqual(snapshot);
  });
});

describe('isBasketEmpty and hasNoLines (D-031, D-047, D-095)', () => {
  it('is empty only with no lines, member, booking or tab', () => {
    expect(isBasketEmpty(EMPTY_BASKET)).toBe(true);
    expect(isBasketEmpty({ lines: [{ productId: 'x', qty: 1 }] })).toBe(false);
    expect(isBasketEmpty({ lines: [], memberId: 'm' })).toBe(false);
    expect(isBasketEmpty({ lines: [], bookingId: 'b' })).toBe(false);
    expect(isBasketEmpty({ lines: [], tabId: 't' })).toBe(false);
  });

  it('hasNoLines ignores the member, booking and tab', () => {
    expect(hasNoLines({ lines: [], memberId: 'm', bookingId: 'b', tabId: 't' })).toBe(true);
    expect(hasNoLines({ lines: [{ productId: 'x', qty: 1 }] })).toBe(false);
  });
});

describe('mergeLines (D-063 b)', () => {
  it('sums existing products in place and appends new ones in basket order', () => {
    // Smith: [Fairway Lager x2]; add [Ready Salted Crisps x1] -> [Lager x2, Crisps x1].
    expect(mergeLines([{ productId: 'lager', qty: 2 }], [{ productId: 'crisps', qty: 1 }])).toEqual([
      { productId: 'lager', qty: 2 },
      { productId: 'crisps', qty: 1 },
    ]);
    expect(
      mergeLines(
        [
          { productId: 'lager', qty: 2 },
          { productId: 'crisps', qty: 1 },
        ],
        [
          { productId: 'wine', qty: 1 },
          { productId: 'lager', qty: 1 },
          { productId: 'cola', qty: 2 },
        ],
      ),
    ).toEqual([
      { productId: 'lager', qty: 3 },
      { productId: 'crisps', qty: 1 },
      { productId: 'wine', qty: 1 },
      { productId: 'cola', qty: 2 },
    ]);
  });

  it('allows exactly 999 and rejects more', () => {
    expect(mergeLines([{ productId: 'lager', qty: 998 }], [{ productId: 'lager', qty: 1 }])).toEqual([{ productId: 'lager', qty: 999 }]);
    expect(() => mergeLines([{ productId: 'lager', qty: 998 }], [{ productId: 'lager', qty: 2 }])).toThrow(RangeError);
  });

  it('never mutates its inputs', () => {
    const tab = [{ productId: 'lager', qty: 2 }];
    const basket = [{ productId: 'lager', qty: 1 }];
    mergeLines(tab, basket);
    expect(tab).toEqual([{ productId: 'lager', qty: 2 }]);
    expect(basket).toEqual([{ productId: 'lager', qty: 1 }]);
  });
});
