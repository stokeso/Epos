import { useId } from 'react';
import type { Product } from '../data/types';
import { formatPence } from '../rules/money';
import { readableTextColour, safeColour } from './colour';
import styles from './ProductButton.module.css';

export interface ProductButtonProps {
  product: Pick<Product, 'id' | 'name' | 'pricePence' | 'buttonColour'>;
  onPress: (productId: string) => void;
  disabled?: boolean;
  /** Shows a quantity badge when > 0. */
  qtyInBasket?: number;
}

/**
 * A till product button (spec §6.3): the product's buttonColour with a readable text colour,
 * at least 88 px tall. Its accessible name is exactly the product name (e2e:
 * getByRole('button', { name: 'Club Bitter', exact: true })); the price is its description.
 */
export function ProductButton({ product, onPress, disabled = false, qtyInBasket = 0 }: ProductButtonProps) {
  const priceId = useId();
  const qtyId = useId();
  const background = safeColour(product.buttonColour);
  const foreground = readableTextColour(background);
  return (
    <button
      type="button"
      className={`${styles.button} ${qtyInBasket > 0 ? styles.withBadge : ''} ${qtyInBasket >= 100 ? styles.wideBadge : ''}`}
      style={{ background, color: foreground }}
      aria-label={product.name}
      aria-describedby={qtyInBasket > 0 ? `${priceId} ${qtyId}` : priceId}
      onClick={() => onPress(product.id)}
      disabled={disabled}
    >
      <span className={styles.name}>{product.name}</span>
      <span id={priceId} className={`money ${styles.price}`}>
        {formatPence(product.pricePence)}
      </span>
      {qtyInBasket > 0 && (
        <span id={qtyId} className={styles.badge}>
          <span className="visually-hidden">In basket: </span>
          {qtyInBasket}
        </span>
      )}
    </button>
  );
}
