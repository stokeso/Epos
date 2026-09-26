/**
 * Date-range reports (spec §6.11; D-044, D-045, D-103). auth.action 'salesReports', checked when
 * Run is pressed. No open period is required. Writes nothing except the override audit event
 * when overridden.
 */
import type { LocalDate } from '../data/types';
import { productSalesReport, vatReport, type ProductSalesReport, type VatReport } from '../rules/reports';
import { isValidLocalDate, localDateRange, londonDateOf, type LocalDateRange } from '../rules/time';
import { nowIso, type ServiceContext } from './context';
import { assertAuthorised, overrideEvents, type Authorisation } from './override';
import { openPeriodId, validationError } from './shared';

/** The London date of ctx.now() (the default for both range ends). */
export function todayLocal(ctx: ServiceContext): LocalDate {
  return londonDateOf(nowIso(ctx));
}

/**
 * localDateRange or AppError('VALIDATION') (D-103). A valid, ordered range that localDateRange
 * still rejects ends on 31/12/9999, whose next day has no YYYY-MM-DD form (D-128, as D-126).
 */
function rangeOrThrow(fromDate: LocalDate, toDate: LocalDate): LocalDateRange {
  const range = localDateRange(fromDate, toDate);
  if (range !== null) return range;
  const tooLate = isValidLocalDate(fromDate) && isValidLocalDate(toDate) && fromDate <= toDate;
  throw validationError({
    toDate: tooLate ? 'End date must be 30/12/9999 or earlier' : 'Choose a valid date range: the end date must be on or after the start date',
  });
}

/** The override event of a read-only action, written once the report has been produced (D-072). */
async function recordOverride(ctx: ServiceContext, auth: Authorisation): Promise<void> {
  if (auth.approvedById === undefined) return;
  await ctx.repos.auditEvents.append(overrideEvents(auth, await openPeriodId(ctx)));
}

/**
 * localDateRange(from, to) (VALIDATION error if from > to) -> sales.listByDateRange ->
 * rules/reports.productSalesReport with all products and categories (deleted included).
 */
export async function runProductSalesReport(
  ctx: ServiceContext,
  auth: Authorisation,
  fromDate: LocalDate,
  toDate: LocalDate,
): Promise<ProductSalesReport> {
  assertAuthorised(auth, 'salesReports');
  const range = rangeOrThrow(fromDate, toDate);
  const report = productSalesReport({
    sales: await ctx.repos.sales.listByDateRange(range.fromInclusive, range.toExclusive),
    products: await ctx.repos.products.list({ includeDeleted: true }),
    categories: await ctx.repos.categories.list({ includeDeleted: true }),
    range,
  });
  await recordOverride(ctx, auth);
  return report;
}

/** Same range and selection -> rules/reports.vatReport. */
export async function runVatReport(ctx: ServiceContext, auth: Authorisation, fromDate: LocalDate, toDate: LocalDate): Promise<VatReport> {
  assertAuthorised(auth, 'salesReports');
  const range = rangeOrThrow(fromDate, toDate);
  const report = vatReport(await ctx.repos.sales.listByDateRange(range.fromInclusive, range.toExclusive), range);
  await recordOverride(ctx, auth);
  return report;
}
