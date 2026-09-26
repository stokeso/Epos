import type { LocalDate } from '../../data/types';
import { formatLocalDate, isValidLocalDate } from '../../rules/time';

/** '26/09/2026', or '26/09/2026 to 30/09/2026' for a longer range (D-102 date format). */
export function rangeText(range: { fromDate: LocalDate; toDate: LocalDate }): string {
  const show = (date: LocalDate): string => (isValidLocalDate(date) ? formatLocalDate(date) : date);
  return range.fromDate === range.toDate ? show(range.fromDate) : `${show(range.fromDate)} to ${show(range.toDate)}`;
}
