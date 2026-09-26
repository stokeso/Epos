import { useEffect, useRef, type FormEvent } from 'react';
import { Button, TextField } from '../../components';
import type { LocalDateRange } from '../../rules/time';
import type { ReportRun } from './useReportRun';
import styles from './reports.module.css';

export interface ReportRangeFormProps {
  state: ReportRun<{ range: LocalDateRange }>;
  /** Accessible name of the form, e.g. 'Product sales date range'. */
  label: string;
}

/**
 * From / To (inclusive London dates, D-103) and Run report. The service validates the range; a
 * refused range moves focus to the first invalid date, whose message is its description, as the
 * app's other forms do (WCAG 3.3.1; D-137).
 */
export function ReportRangeForm({ state, label }: ReportRangeFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const { fieldErrors } = state;
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fieldErrors]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void state.run();
  };
  return (
    <form ref={formRef} className={styles.rangeForm} onSubmit={submit} aria-label={label} noValidate>
      <TextField
        type="date"
        label="From"
        value={state.fromDate}
        onChange={state.setFromDate}
        error={fieldErrors.fromDate}
        className={styles.dateField}
      />
      <TextField type="date" label="To" value={state.toDate} onChange={state.setToDate} error={fieldErrors.toDate} className={styles.dateField} />
      <Button type="submit" variant="primary" size="lg" busy={state.busy} className={styles.runButton}>
        Run report
      </Button>
    </form>
  );
}
