// @vitest-environment jsdom
/**
 * The refund quantity stepper keeps keyboard focus when the pressed button reaches its limit and
 * becomes disabled (D-134): focus moves to the other stepper instead of falling to <body>.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RefundableLine } from '../../src/services/refunds';
import { RefundLineRow, type StockChoice } from '../../src/screens/refunds/RefundLineRow';

afterEach(() => cleanup());

const LINE: RefundableLine = {
  lineIndex: 0,
  line: {
    productId: 'p1',
    nameAtSale: 'Club Bitter',
    qty: 2,
    unitPricePence: 420,
    vatRate: 20,
    dealDiscountPence: 0,
    memberDiscountPence: 0,
    finalPence: 840,
    vatPence: 140,
  },
  soldQty: 2,
  refundedQty: 0,
  refundableQty: 2,
  stockTracked: true,
};

function Harness() {
  const [qty, setQty] = useState(0);
  const [stock, setStock] = useState<StockChoice>('return');
  return (
    <ul>
      <RefundLineRow line={LINE} qty={qty} onQtyChange={setQty} stock={stock} onStockChange={setStock} />
    </ul>
  );
}

describe('RefundLineRow stepper focus (D-134)', () => {
  it('hands focus to the other stepper when the pressed one reaches its limit', () => {
    render(<Harness />);
    const increase = screen.getByRole('button', { name: 'Increase Club Bitter' }) as HTMLButtonElement;
    const decrease = screen.getByRole('button', { name: 'Decrease Club Bitter' }) as HTMLButtonElement;
    increase.focus();
    fireEvent.click(increase);
    expect(screen.getByTestId('refund-qty').textContent).toBe('1');
    // Not at the limit yet: focus stays where it was.
    expect(document.activeElement).toBe(increase);
    fireEvent.click(increase);
    expect(screen.getByTestId('refund-qty').textContent).toBe('2');
    expect(increase.disabled).toBe(true);
    expect(document.activeElement).toBe(decrease);

    fireEvent.click(decrease);
    fireEvent.click(decrease);
    expect(screen.getByTestId('refund-qty').textContent).toBe('0');
    expect(decrease.disabled).toBe(true);
    expect(document.activeElement).toBe(increase);
  });

  it('leaves focus alone when the stepper was tapped without having focus', () => {
    render(<Harness />);
    const increase = screen.getByRole('button', { name: 'Increase Club Bitter' });
    fireEvent.click(increase);
    fireEvent.click(increase);
    expect(document.activeElement).toBe(document.body);
  });
});
