import { MoneyText } from '../../components';
import type { ProductSalesReport } from '../../rules/reports';
import styles from './reports.module.css';

/**
 * Every product with sales in the range, grouped under its category (D-044 order). One table with
 * a row group per category, so it reads as a till report at any width; on a phone it scrolls
 * sideways inside its own region if it has to, never the page.
 */
export function ProductSalesTable({ report }: { report: ProductSalesReport }) {
  return (
    <div className={styles.tableScroller} role="region" aria-label="Sales by product" tabIndex={0} data-testid="product-sales-table">
      <table className={styles.table}>
        <caption className={styles.caption}>By product</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" className={styles.num}>
              Qty
            </th>
            <th scope="col" className={styles.num}>
              Takings
            </th>
          </tr>
        </thead>
        {report.categories.map((category) => (
          <tbody key={category.categoryId} data-testid="product-sales-group">
            <tr className={styles.groupRow}>
              <th scope="rowgroup" colSpan={3}>
                {category.name}
              </th>
            </tr>
            {category.products.map((product) => (
              <tr key={product.productId} data-testid="product-sales-row">
                <th scope="row" className={styles.rowName}>
                  {product.name}
                </th>
                <td className={styles.num}>{product.qty}</td>
                <td className={styles.num}>
                  <MoneyText pence={product.takingsPence} />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className={styles.num} data-testid="product-sales-total-qty">
              {report.totalQty}
            </td>
            <td className={styles.num}>
              <MoneyText pence={report.totalTakingsPence} strong testId="product-sales-total" />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
