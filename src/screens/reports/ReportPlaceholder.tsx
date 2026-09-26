import styles from './reports.module.css';

/** Before the first Run: figures appear only after Run report (D-070). */
export function ReportPlaceholder() {
  return (
    <div className={styles.placeholder} data-testid="report-placeholder">
      <svg className={styles.placeholderIcon} viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
        <rect x="8" y="6" width="32" height="36" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M16 32v-6M24 32V18M32 32v-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <p>Choose the dates, then press Run report. Figures appear only after the report is run.</p>
    </div>
  );
}
