import type { FormEvent } from 'react';
import { Button, TextField } from '../../components';
import type { LocalDateRange } from '../../rules/time';
import type { ReportRun } from './useReportRun';
import styles from './reports.module.css';

export interface ReportRangeFormProps {
  state: ReportRun<{ range: LocalDateRange }>;
  /** Accessible name of the form, e.g. 'Product sales date range'. */
  label: string;
}

/** From / To (inclusive London dates, D-103) and Run report. The service validates the range. */
export function ReportRangeForm({ state, label }: ReportRangeFormProps) {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void state.run();
  };
  return (
    <form className={styles.rangeForm} onSubmit={submit} aria-label={label} noValidate>
      <TextField
        type="date"
        label="From"
        value={state.fromDate}
        onChange={state.setFromDate}
        error={state.fieldErrors.fromDate}
        className={styles.dateField}
      />
      <TextField type="date" label="To" value={state.toDate} onChange={state.setToDate} error={state.fieldErrors.toDate} className={styles.dateField} />
      <Button type="submit" variant="primary" size="lg" busy={state.busy} className={styles.runButton}>
        Run report
      </Button>
    </form>
  );
}

