import type { ReactNode } from 'react';
import type { PricedLine } from '../rules/pricing';
import { formatPence } from '../rules/money';
import { MoneyText } from './MoneyText';
import styles from './BasketPanel.module.css';

export interface BasketLineRowProps {
  /** A priced line from BasketView.priced.lines. */
  line: PricedLine;
  /** Highlights the row; with onSelect the row is a toggle button (aria-pressed). */
  selected?: boolean;
  /** Makes the row selectable (e.g. choose the line to void). */
  onSelect?: (productId: string) => void;
  /** Extra controls at the end of the row (e.g. an 'Add one' button). */
  trailing?: ReactNode;
  disabled?: boolean;
}

/**
 * One basket line: '{qty} × {name}', '@ £unit' and the line gross. Deal savings, the member
 * discount and the deposit are separate rows in BasketPanel (D-017, D-023), so the row shows
 * the gross, like the receipt (D-107). The name has the whole width of the row, with '@ £unit'
 * and the gross on the line under it, so the +/− steppers beside it never squeeze the name into
 * a column that splits words (D-138).
 */
export function BasketLineRow({ line, selected = false, onSelect, trailing, disabled = false }: BasketLineRowProps) {
  const content = (
    <>
      <span className={`${styles.qty} tabular`}>{line.qty} ×</span>
      <span className={styles.lineName}>{line.name}</span>
      <span className={styles.lineFigures}>
        <span className={`${styles.lineUnit} money`}>@ {formatPence(line.unitPricePence)}</span>
        <MoneyText pence={line.grossPence} className={styles.lineAmount} />
      </span>
    </>
  );
  return (
    <li className={`${styles.line} ${selected ? styles.lineSelected : ''}`} data-product-id={line.productId}>
      {onSelect === undefined ? (
        <div className={styles.lineBody}>{content}</div>
      ) : (
        <button
          type="button"
          className={`${styles.lineBody} ${styles.lineButton}`}
          aria-pressed={selected}
          aria-label={`${line.qty} × ${line.name}, ${formatPence(line.grossPence)}`}
          onClick={() => onSelect(line.productId)}
          disabled={disabled}
        >
          {content}
        </button>
      )}
      {trailing !== undefined && <div className={styles.lineTrailing}>{trailing}</div>}
    </li>
  );
}
