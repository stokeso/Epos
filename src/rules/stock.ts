/**
 * Stock movements implied by a sale (spec §3.2, §6.8; D-039, D-079..D-082). Pure.
 * On-hand and the low-stock list are data queries (StockMovementRepo.onHand / lowStock, D-082).
 */
import type { NewSale, SaleStockMovementInput } from '../data/types';

/** Whether a product is stockTracked NOW (at commit time); unknown products -> false. */
export type IsStockTracked = (productId: string) => boolean;

/** Note on the waste half of a wasted refund line (D-039). */
export const REFUND_WASTE_NOTE = 'Refund - wasted';

/**
 * Movements for a sale about to be committed (D-079, D-039), in line order:
 * - 'sale': each tracked line -> { productId, qty: -line.qty, reason: 'sale', note: '' }.
 * - 'refund': each tracked line with q = -line.qty units -> { qty: +q, reason: 'refund', note: '' };
 *   when returnToStock === false also { qty: -q, reason: 'waste', note: REFUND_WASTE_NOTE }.
 * - 'deposit': none.
 */
export function stockMovementsForSale(sale: NewSale, isTracked: IsStockTracked): SaleStockMovementInput[] {
  if (sale.kind === 'deposit') return [];
  const movements: SaleStockMovementInput[] = [];
  for (const line of sale.lines) {
    if (!isTracked(line.productId)) continue;
    const units = Math.abs(line.qty);
    if (units === 0) continue;
    if (sale.kind === 'sale') {
      movements.push({ productId: line.productId, qty: -units, reason: 'sale', note: '' });
      continue;
    }
    movements.push({ productId: line.productId, qty: units, reason: 'refund', note: '' });
    if (line.returnToStock === false) {
      movements.push({ productId: line.productId, qty: -units, reason: 'waste', note: REFUND_WASTE_NOTE });
    }
  }
  return movements;
}
