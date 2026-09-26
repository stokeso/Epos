/**
 * Product sales report (spec §6.11; D-044, D-070, D-103, D-128): a date range of London dates,
 * both inclusive (default today), then Run report -> requirePermission('salesReports') ->
 * services/reports.runProductSalesReport. Shows quantity and takings per category and per
 * product; takings are VAT-inclusive, after deal and member discounts, with refunds netted off.
 * Deposits are not product sales. The total equals the VAT report's gross for the same range.
 */
import { useId } from 'react';
import { Banner, ButtonLink, DataTable, MoneyText, Screen, type DataTableColumn } from '../../components';
import type { CategorySalesRow, ProductSalesReport } from '../../rules/reports';
import { runProductSalesReport } from '../../services/reports';
import { ProductSalesTable } from './ProductSalesTable';
import { ReportPlaceholder } from './ReportPlaceholder';
import { ReportRangeForm } from './ReportRangeForm';
import { rangeText } from './reportText';
import { useReportRun } from './useReportRun';
import styles from './reports.module.css';

const CATEGORY_COLUMNS: readonly DataTableColumn<CategorySalesRow>[] = [
  { key: 'name', header: 'Category', render: (row) => row.name, rowHeader: true },
  { key: 'qty', header: 'Qty', render: (row) => row.qty, numeric: true, width: '6rem' },
  { key: 'takings', header: 'Takings', render: (row) => <MoneyText pence={row.takingsPence} />, numeric: true, width: '8rem' },
];

export function ProductSalesReportScreen() {
  const state = useReportRun(runProductSalesReport);
  return (
    <Screen
      title="Product sales report"
      description="Quantity sold and takings per product and per category for a date range."
      actions={
        <ButtonLink to="/reports/vat" variant="secondary">
          VAT report
        </ButtonLink>
      }
    >
      <ReportRangeForm state={state} label="Product sales date range" />
      {state.error !== null && (
        <Banner tone="danger" testId="report-error">
          {state.error}
        </Banner>
      )}
      {state.report === null ? (
        <ReportPlaceholder />
      ) : (
        <ProductSalesResults report={state.report} stale={state.stale} />
      )}
    </Screen>
  );
}

function ProductSalesResults({ report, stale }: { report: ProductSalesReport; stale: boolean }) {
  const headingId = useId();
  const productCount = report.categories.reduce((sum, category) => sum + category.products.length, 0);
  return (
    <section className={styles.results} aria-labelledby={headingId} data-testid="report-results">
      <div className={styles.resultsHead}>
        <h2 id={headingId} className={styles.resultsTitle}>
          Sales for <span className="tabular">{rangeText(report.range)}</span>
        </h2>
        <p className={styles.resultsNote}>Takings include VAT and are after deal and member discounts, with refunds netted off. Deposits are not product sales.</p>
      </div>
      {stale && (
        <Banner tone="info" role="status" testId="report-stale">
          The dates have changed. Run the report again to update these figures.
        </Banner>
      )}
      <dl className={styles.kpis}>
        <div className={`${styles.kpi} ${styles.kpiMain}`}>
          <dt>Total takings</dt>
          <dd>
            <MoneyText pence={report.totalTakingsPence} size="2xl" strong testId="report-total-takings" />
          </dd>
        </div>
        <div className={styles.kpi}>
          <dt>Items sold</dt>
          <dd className="tabular" data-testid="report-total-qty">
            {report.totalQty}
          </dd>
        </div>
        <div className={styles.kpi}>
          <dt>Products</dt>
          <dd className="tabular">{productCount}</dd>
        </div>
      </dl>
      {report.categories.length === 0 ? (
        <p className={styles.noSales} data-testid="report-empty">
          No sales in this date range.
        </p>
      ) : (
        <div className={styles.tables}>
          <DataTable
            caption="By category"
            columns={CATEGORY_COLUMNS}
            rows={report.categories}
            getRowKey={(row) => row.categoryId}
            footer={{ name: 'Total', qty: report.totalQty, takings: <MoneyText pence={report.totalTakingsPence} strong /> }}
            testId="category-sales-table"
          />
          <ProductSalesTable report={report} />
        </div>
      )}
    </section>
  );
}
