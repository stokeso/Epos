import { useId, type ReactNode } from 'react';
import styles from './SearchList.module.css';

export interface SearchListProps<T> {
  /** Label of the search box, e.g. 'Search members'. */
  label: string;
  query: string;
  onQueryChange: (query: string) => void;
  results: readonly T[];
  getKey: (item: T) => string;
  /** Visible content of a result button. */
  renderItem: (item: T) => ReactNode;
  /** Accessible name of a result button (default: its text content). */
  getItemLabel?: (item: T) => string;
  onSelect: (item: T) => void;
  placeholder?: string;
  hint?: ReactNode;
  /** Shown when the query is not empty and there are no results. Default 'No matches'. */
  emptyMessage?: string;
  /** Shown while the query is empty. */
  idleMessage?: string;
  loading?: boolean;
  /**
   * Inside a Modal: the search box is the dialog's initial focus (rendered as data-autofocus, so
   * the Modal still records the element to restore focus to on close).
   */
  autoFocus?: boolean;
  /** aria-label of the results list. Default 'Results'. */
  resultsLabel?: string;
  /** Marks a result as the current choice (aria-pressed). */
  isSelected?: (item: T) => boolean;
  disabled?: boolean;
}

/**
 * A search box with a list of tappable results (members, bookings, tabs, products).
 * The caller owns the query and runs the search (debounce with useDebouncedValue).
 */
export function SearchList<T>({
  label,
  query,
  onQueryChange,
  results,
  getKey,
  renderItem,
  getItemLabel,
  onSelect,
  placeholder,
  hint,
  emptyMessage = 'No matches',
  idleMessage,
  loading = false,
  autoFocus = false,
  resultsLabel = 'Results',
  isSelected,
  disabled = false,
}: SearchListProps<T>) {
  const inputId = useId();
  const hintId = useId();
  const statusId = useId();
  const trimmed = query.trim();
  let status: string | null = null;
  if (loading) status = 'Searching…';
  else if (trimmed === '') status = idleMessage ?? null;
  else if (results.length === 0) status = emptyMessage;

  return (
    <div className={styles.search}>
      <label htmlFor={inputId} className={styles.label}>
        {label}
      </label>
      {hint !== undefined && (
        <div id={hintId} className={styles.hint}>
          {hint}
        </div>
      )}
      <div className={styles.inputWrap}>
        <svg className={styles.icon} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          id={inputId}
          type="search"
          className={styles.input}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          data-autofocus={autoFocus ? true : undefined}
          aria-describedby={[hint !== undefined ? hintId : '', statusId].filter((x) => x !== '').join(' ')}
          disabled={disabled}
        />
      </div>
      <p id={statusId} className={styles.status} aria-live="polite">
        {status}
      </p>
      {results.length > 0 && (
        <ul className={styles.results} aria-label={resultsLabel}>
          {results.map((item) => {
            const selected = isSelected?.(item);
            return (
              <li key={getKey(item)}>
                <button
                  type="button"
                  className={styles.result}
                  onClick={() => onSelect(item)}
                  aria-label={getItemLabel?.(item)}
                  aria-pressed={selected === undefined ? undefined : selected}
                  disabled={disabled}
                >
                  {renderItem(item)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
