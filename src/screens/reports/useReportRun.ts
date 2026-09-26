/**
 * The date range + Run flow shared by the product sales and VAT reports (spec §6.11; D-044,
 * D-045, D-070, D-103, D-128): both dates default to today in Europe/London (todayLocal), and
 * figures appear only after Run, which is gated by requirePermission('salesReports') and passes
 * the Authorisation to exactly one report service call. The range is validated by the service
 * (AppError VALIDATION on field toDate).
 */
import { useState } from 'react';
import { errorMessage, fieldErrorsOf, requirePermission } from '../../app';
import type { LocalDate } from '../../data/types';
import type { ServiceContext } from '../../services/context';
import type { Authorisation } from '../../services/override';
import { todayLocal } from '../../services/reports';
import { getCtx } from '../../store';
import type { LocalDateRange } from '../../rules/time';

export type RunReport<T> = (ctx: ServiceContext, auth: Authorisation, fromDate: LocalDate, toDate: LocalDate) => Promise<T>;

export interface ReportRun<T> {
  fromDate: LocalDate;
  toDate: LocalDate;
  setFromDate: (date: LocalDate) => void;
  setToDate: (date: LocalDate) => void;
  /** The last successful run, or null before the first. */
  report: T | null;
  busy: boolean;
  /** A message that is not about one field. */
  error: string | null;
  fieldErrors: Readonly<Record<string, string>>;
  /** True when the dates no longer match the report shown. */
  stale: boolean;
  run: () => Promise<void>;
}

export function useReportRun<T extends { range: LocalDateRange }>(runReport: RunReport<T>): ReportRun<T> {
  const [today] = useState(() => todayLocal(getCtx()));
  const [fromDate, setFrom] = useState<LocalDate>(today);
  const [toDate, setTo] = useState<LocalDate>(today);
  const [report, setReport] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  const clearMessages = (): void => {
    setError(null);
    setFieldErrors({});
  };

  const run = async (): Promise<void> => {
    if (busy) return;
    clearMessages();
    const auth = await requirePermission('salesReports');
    if (auth === null) return;
    setBusy(true);
    try {
      setReport(await runReport(getCtx(), auth, fromDate, toDate));
    } catch (caught) {
      const fields = fieldErrorsOf(caught);
      if (Object.keys(fields).length > 0) setFieldErrors(fields);
      else setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return {
    fromDate,
    toDate,
    setFromDate: (date) => {
      setFrom(date);
      setFieldErrors({});
    },
    setToDate: (date) => {
      setTo(date);
      setFieldErrors({});
    },
    report,
    busy,
    error,
    fieldErrors,
    stale: report !== null && (report.range.fromDate !== fromDate || report.range.toDate !== toDate),
    run,
  };
}
