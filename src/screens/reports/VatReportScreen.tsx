/**
 * VAT report (spec §6.11, §7.5; D-021, D-045, D-070, D-103, D-128): the same date range and Run
 * flow as the product sales report -> requirePermission('salesReports') ->
 * services/reports.runVatReport. Net, VAT and gross per rate (highest rate first) with a totals
 * row. The figures are sums of the stored sale and refund lines; deposits have no lines, so they
 * carry no VAT here (it is charged on the final bill).
 */
import { useId } from 'react';
import { Banner, ButtonLink, DataTable, MoneyText, Screen, type DataTableColumn } from '../../components';
import type { VatReport } from '../../rules/reports';
import type { VatSummaryRow } from '../../rules/vat';
import { runVatReport } from '../../services/reports';
import { ReportPlaceholder } from './ReportPlaceholder';
import { ReportRangeForm } from './ReportRangeForm';
import { rangeText } from './reportText';
import { useReportRun } from './useReportRun';
import styles from './reports.module.css';

const VAT_COLUMNS: readonly DataTableColumn<VatSummaryRow>[] = [
  // The header may wrap ('VAT' / 'rate') so the three money columns fit a 390 px phone.
  { key: 'rate', header: <span className={styles.wrapHeader}>VAT rate</span>, render: (row) => `${row.vatRate}%`, rowHeader: true },
  { key: 'net', header: 'Net', render: (row) => <MoneyText pence={row.netPence} />, numeric: true },
  { key: 'vat', header: 'VAT', render: (row) => <MoneyText pence={row.vatPence} />, numeric: true },
  { key: 'gross', header: 'Gross', render: (row) => <MoneyText pence={row.grossPence} />, numeric: true },
];

export function VatReportScreen() {
  const state = useReportRun(runVatReport);
  return (
    <Screen
      title="VAT report"
      description="Net, VAT and gross takings per VAT rate for a date range."
      actions={
        <ButtonLink to="/reports/product-sales" variant="secondary">
          Product sales report
        </ButtonLink>
      }
    >
      <ReportRangeForm state={state} label="VAT report date range" />
      {state.error !== null && (
        <Banner tone="danger" testId="report-error">
          {state.error}
        </Banner>
      )}
      {state.report === null ? <ReportPlaceholder /> : <VatResults report={state.report} stale={state.stale} />}
    </Screen>
  );
}

function VatResults({ report, stale }: { report: VatReport; stale: boolean }) {
  const headingId = useId();
  const { totals } = report;
  return (
    <section className={styles.results} aria-labelledby={headingId} data-testid="report-results">
      <div className={styles.resultsHead}>
        <h2 id={headingId} className={styles.resultsTitle}>
          VAT for <span className="tabular">{rangeText(report.range)}</span>
        </h2>
        <p className={styles.resultsNote}>Gross is what customers paid after discounts, with refunds netted off. Deposits carry no VAT here: it is charged on the final bill.</p>
      </div>
      {stale && (
        <Banner tone="info" role="status" testId="report-stale">
          The dates have changed. Run the report again to update these figures.
        </Banner>
      )}
      <dl className={styles.kpis}>
        <div className={`${styles.kpi} ${styles.kpiMain}`}>
          <dt>VAT</dt>
          <dd>
            <MoneyText pence={totals.vatPence} size="2xl" strong testId="report-total-vat" />
          </dd>
        </div>
        <div className={styles.kpi}>
          <dt>Net</dt>
          <dd>
            <MoneyText pence={totals.netPence} size="lg" strong testId="report-total-net" />
          </dd>
        </div>
        <div className={styles.kpi}>
          <dt>Gross</dt>
          <dd>
            <MoneyText pence={totals.grossPence} size="lg" strong testId="report-total-gross" />
          </dd>
        </div>
      </dl>
      <DataTable
        caption="VAT by rate"
        columns={VAT_COLUMNS}
        rows={report.rows}
        getRowKey={(row) => String(row.vatRate)}
        emptyMessage="No sales in this date range."
        footer={{
          rate: 'Total',
          net: <MoneyText pence={totals.netPence} strong />,
          vat: <MoneyText pence={totals.vatPence} strong />,
          gross: <MoneyText pence={totals.grossPence} strong />,
        }}
        testId="vat-table"
        className={styles.compactTable}
      />
    </section>
  );
}
